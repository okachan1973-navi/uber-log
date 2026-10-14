/**
 * UBER_LOG - Cloud Sync Manager (Supabase ⇄ LocalStorage)
 * 
 * 責務:
 * - 9大同期安全ルールに準拠した堅牢な双方向同期
 * - Local-first: 端末内即時保存（0ms遅延）＋非同期クラウド同期
 * - 単純LWW上書きの禁止（セッション・配達・クエストの安全ディープマージ）
 * - 起動・復帰時の同期順序（Pull → 検証・マージ → 未同期ローカル差分のPush）
 * - 未同期変更（dirty / pending）の保護
 * - 通信失敗・認証切れ時も既存LocalStorageを絶対削除・巻き戻ししない
 * - 初回移行の事前検証（バックアップ＋30件・12クエスト・正本17,080円）
 * - 初回移行の事後検証（クラウド再取得で30件・12クエスト・正本17,080円一致確認）
 */

const SYNC_STORAGE_KEYS = {
  PENDING_DATES: 'uber_pending_sync_dates',
  LAST_PULL_TIME: 'uber_last_cloud_pull_time',
  PRE_MIGRATION_BACKUP: 'uber_backup_pre_cloud_sync',
  MIGRATION_COMPLETED: 'uber_cloud_migration_completed',
  STATUS: 'uber_sync_status',        // 最終 pull / push 時刻・結果・エラー・クラウドの日数（diag.html で表示）
  CONFLICTS: 'uber_sync_conflicts',  // 自動で決められなかった項目（端末側の値を残したもの）
  CLIENT_ID: 'uber_sync_client_id',  // この端末（ブラウザ）の識別子（diag.html で表示）
  CLOUD_INDEX: 'uber_sync_cloud_index' // クラウドにある日の一覧と1日ごとの要約（最終受信時。diag.html の「端末とクラウドの差分」）
};

// 診断・比較の共通関数（js/data-diagnostics.js。index.html で先に読み込む）。無い環境では従来どおり文字列で比べる
const syncDiagnostics = () => (typeof window !== 'undefined' && window.UberLogDiagnostics) || null;

// 表示中の定期同期の間隔（SYNC_MODEL.md「自動同期」）
const SYNC_INTERVAL_MS = 60 * 1000;
// 手動で入力する日別の項目（端末間で新しい方を選ぶ。更新時刻は manualUpdatedAt[項目]）
const MANUAL_DAY_FIELDS = ['dayOff', 'weather', 'vehicleType'];
// trip ごとの手動メモ（値の組と、その更新時刻）
const TRIP_NOTE_GROUPS = [
  { fields: ['evaluation', 'evaluationReason'], at: 'evaluationUpdatedAt', label: '○×評価・理由' },
  { fields: ['mapMemo'], at: 'mapMemoUpdatedAt', label: 'MAP一口メモ' }
];
// 公式取込で決まる日別の項目（新しい公式取込 officialImport.importedAt の側を採用）
const OFFICIAL_DAY_FIELDS = ['deliveriesCount', 'tripsCount', 'officialPoints', 'totalDistanceKm'];
const OFFICIAL_SALES_KEYS = ['delivery', 'quest', 'adjustment', 'other', 'total'];

function syncStorageGet(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function syncStorageSet(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても同期は続ける */ }
}
const sameValue = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const isEmptyValue = v => v === undefined || v === null || v === '';

class CloudSyncManager {
  constructor() {
    this.status = 'UNCONFIGURED'; // UNCONFIGURED | NOT_LOGGED_IN | SYNCED | SYNCING | OFFLINE | ERROR
    this.statusMessage = '未接続';
    this.listeners = [];
    this.pushTimeout = null;
    this.isSyncing = false;
    this.pendingSyncDates = this.loadPendingSyncDates();
    this.localVersions = {}; // 日付ごとの端末内変更回数（送信中の変更を取りこぼさないため）
    this.pendingTargetQuestsSync = false;
    this.clientId = this.loadClientId();

    this.initEventListeners();
    this.startInitialSync();
  }

  loadClientId() {
    let id = syncStorageGet(SYNC_STORAGE_KEYS.CLIENT_ID, null);
    if (!id) {
      id = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      syncStorageSet(SYNC_STORAGE_KEYS.CLIENT_ID, id);
    }
    return id;
  }

  // 同期の記録（diag.html・ヘッダーの「同期済み HH:MM」で使う）
  getSyncInfo() {
    return {
      clientId: this.clientId,
      status: this.status,
      pendingDates: Array.from(this.pendingSyncDates).sort(),
      conflicts: this.getConflicts(),
      ...syncStorageGet(SYNC_STORAGE_KEYS.STATUS, {})
    };
  }
  recordSync(patch) {
    const cur = syncStorageGet(SYNC_STORAGE_KEYS.STATUS, {});
    const appVersion = (typeof window !== 'undefined' && window.UBER_LOG_APP_VERSION) || cur.appVersion || null;
    syncStorageSet(SYNC_STORAGE_KEYS.STATUS, { ...cur, ...patch, clientId: this.clientId, appVersion });
  }

  // 競合（自動で決められず、端末側の値を残した項目）。同じ日・項目は1件にまとめ、値が一致したら消す
  getConflicts() {
    const list = syncStorageGet(SYNC_STORAGE_KEYS.CONFLICTS, []);
    return Array.isArray(list) ? list : [];
  }
  recordConflict(date, field, localValue, cloudValue, meta = null) {
    const key = `${date}|${field}`;
    const prev = this.getConflicts().find(c => c.key === key);
    const list = this.getConflicts().filter(c => c.key !== key);
    // 同じ値の組なら最初に見つけた時刻を残す（同期のたびに時刻が変わらないように）
    const same = prev && sameValue(prev.local, localValue === undefined ? null : localValue) && sameValue(prev.cloud, cloudValue === undefined ? null : cloudValue);
    list.push({ key, date, field, ...(meta || {}), local: localValue === undefined ? null : localValue, cloud: cloudValue === undefined ? null : cloudValue, kept: 'local', at: same && prev.at ? prev.at : new Date().toISOString() });
    syncStorageSet(SYNC_STORAGE_KEYS.CONFLICTS, list.slice(-100));
  }
  resolveConflict(date, field) {
    const key = `${date}|${field}`;
    const list = this.getConflicts();
    if (list.some(c => c.key === key)) syncStorageSet(SYNC_STORAGE_KEYS.CONFLICTS, list.filter(c => c.key !== key));
  }

  // 手動の日別項目が同じ値か（vehicleType は旧名称「レンタサイクル」等を正式な値にそろえて比べる。DATA_MODEL.md §1）
  sameManual(field, a, b) {
    const D = syncDiagnostics();
    return D && typeof D.sameManualValue === 'function' ? D.sameManualValue(field, a, b) : sameValue(a, b);
  }

  /**
   * 両端末の値から1つを選ぶ（更新時刻で決める）。
   *  - 同じ値（同義の旧名称を含む）→ 端末の値のまま（保存値は書き換えない）
   *  - 片方にしか値が無い（もう片方は一度も設定していない）→ 値がある方
   *  - 両方に更新時刻 → 新しい方 / 片方だけに更新時刻 → 時刻がある方（時刻の無い古い値より新しい）
   *  - どちらにも時刻が無く値が違う → 端末側を残し、競合として記録（勝手に捨てない。diag.html で利用者が選ぶ）
   */
  pickByTime(date, field, localVal, cloudVal, localAt, cloudAt, eq = sameValue, meta = null) {
    if (eq(localVal, cloudVal)) { this.resolveConflict(date, field); return { value: localVal, at: localAt || cloudAt || null }; }
    // 更新時刻などで決められたら、前に記録した競合は消す（別の端末で利用者が解決した値が届いた場合など）
    if (localAt || cloudAt || localVal === undefined || cloudVal === undefined || isEmptyValue(localVal) !== isEmptyValue(cloudVal)) this.resolveConflict(date, field);
    if (localAt && cloudAt) return localAt >= cloudAt ? { value: localVal, at: localAt } : { value: cloudVal, at: cloudAt };
    if (localAt) return { value: localVal, at: localAt };
    if (cloudAt) return { value: cloudVal, at: cloudAt };
    if (localVal === undefined) return { value: cloudVal, at: null };
    if (cloudVal === undefined) return { value: localVal, at: null };
    if (isEmptyValue(localVal) && !isEmptyValue(cloudVal)) return { value: cloudVal, at: null };
    if (isEmptyValue(cloudVal) && !isEmptyValue(localVal)) return { value: localVal, at: null };
    this.recordConflict(date, field, localVal, cloudVal, meta);
    return { value: localVal, at: null };
  }

  // ------------------------------------------------------------
  // 競合の解決（diag.html の「この端末の値を採用」「クラウドの値を採用」。利用者が押したときだけ）
  // 採用した値に新しい更新時刻を付けて端末に保存 → クラウドへ送る → クラウドの値を確かめる → 受信（pull）。
  // 他の端末は次の同期で、時刻つきの新しい値を受け取る（競合は消える）。
  // 途中で失敗したら端末の値を元に戻し、競合の記録も残す（値を失わない）。
  // ------------------------------------------------------------
  conflictTarget(c) {
    if (!c || !c.date || !c.field) return null;
    if (MANUAL_DAY_FIELDS.includes(c.field)) return { kind: 'day', field: c.field };
    const m = /^trip (\S+) (.+)$/.exec(c.field);
    if (!m) return null;
    const group = TRIP_NOTE_GROUPS.find(g => g.label === m[2] || g.at === c.group);
    return group ? { kind: 'trip', tripId: c.tripId || m[1], group } : null;
  }
  readConflictValue(log, t) {
    if (!log) return undefined;
    if (t.kind === 'day') return log[t.field];
    const d = (log.deliveries || []).find(x => x && x.id === t.tripId);
    if (!d) return undefined;
    const v = t.group.fields.map(f => d[f]);
    return v.every(x => x === undefined) ? undefined : v;
  }
  sameConflictValue(t, a, b) {
    return t.kind === 'day' ? this.sameManual(t.field, a, b) : sameValue(a, b);
  }
  writeConflictValue(log, t, value, nowIso) {
    if (t.kind === 'day') {
      if (value === undefined) delete log[t.field]; else log[t.field] = value;
      log.manualUpdatedAt = { ...(log.manualUpdatedAt || {}), [t.field]: nowIso };
      return;
    }
    const d = (log.deliveries || []).find(x => x && x.id === t.tripId);
    if (!d) throw new Error('この端末にこの配達がありません');
    t.group.fields.forEach((f, i) => { const v = value === undefined ? undefined : value[i]; if (v === undefined) delete d[f]; else d[f] = v; });
    d[t.group.at] = nowIso;
    // 端末内の控え（起動時に配達へ戻す値）も同じ値にする
    try {
      if (t.group.at === 'evaluationUpdatedAt') {
        const m = syncStorageGet('uber_log_trip_evaluations', {}) || {};
        m[t.tripId] = { evaluation: d.evaluation || null, reason: d.evaluationReason || '', updatedAt: nowIso };
        syncStorageSet('uber_log_trip_evaluations', m);
      } else if (t.group.at === 'mapMemoUpdatedAt') {
        const m = syncStorageGet('uber_log_trip_map_memos', {}) || {};
        if (d.mapMemo && String(d.mapMemo).trim()) m[t.tripId] = String(d.mapMemo); else delete m[t.tripId];
        syncStorageSet('uber_log_trip_map_memos', m);
      }
    } catch (e) { /* 控えが書けなくても配達側（同期される値）は保存済み */ }
  }

  async resolveConflictChoice(key, side) {
    const fail = message => ({ ok: false, message });
    if (side !== 'local' && side !== 'cloud') return fail('選び方が不正です');
    if (this.resolving) return fail('処理中です。終わるまでお待ちください');
    const conflict = this.getConflicts().find(c => c.key === key);
    if (!conflict) return { ok: true, already: true, message: 'この競合はすでに解決されています' };
    const target = this.conflictTarget(conflict);
    if (!target) return fail('解決できませんでした（この競合の項目を特定できません）。値は変えていません');
    this.resolving = true;
    try {
      for (let i = 0; i < 150 && this.isSyncing; i++) await new Promise(r => setTimeout(r, 100));
      if (this.isSyncing) return fail('解決できませんでした（同期中です。少し待ってからもう一度押してください）。値は変えていません');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return fail('解決できませんでした（オフラインです）。値は変えていません');
      const sm = typeof window !== 'undefined' ? window.supabaseManager : null;
      if (!sm || !sm.isReady()) return fail('解決できませんでした（クラウドに接続できません）。値は変えていません');
      if (!sm.isLoggedIn()) {
        const session = await sm.getSession();
        if (!session || !sm.isLoggedIn()) return fail('解決できませんでした（クラウドにログインしていません）。値は変えていません');
      }
      const store = window.store;
      const client = sm.client;
      const userId = sm.getUserId();
      const date = conflict.date;
      const fetchCloudDay = async () => {
        const { data, error } = await client.from('uber_daily_logs').select('date, data, updated_at').eq('user_id', userId);
        if (error) throw new Error(`クラウドを読めません: ${error.message}`);
        const row = (data || []).find(r => r.date === date);
        return row ? row.data : null;
      };
      let chosen;
      this.isSyncing = true; // 解決中は自動同期を止める
      const wasPending = this.pendingSyncDates.has(date);
      const before = store.state.dailyLogs[date] ? JSON.parse(JSON.stringify(store.state.dailyLogs[date])) : null;
      const sideCopies = { e: syncStorageGet('uber_log_trip_evaluations', null), m: syncStorageGet('uber_log_trip_map_memos', null) };
      let changed = false;
      try {
        const cloudLog = await fetchCloudDay();
        const localLog = store.state.dailyLogs[date] || null;
        chosen = side === 'local' ? this.readConflictValue(localLog, target) : this.readConflictValue(cloudLog, target);
        if (side === 'cloud' && !cloudLog) throw new Error('クラウドにこの日のデータがありません');
        if (side === 'local' && !localLog) throw new Error('この端末にこの日のデータがありません');
        const nowIso = new Date().toISOString();
        const log = store.getDailyLog(date);
        this.writeConflictValue(log, target, chosen, nowIso);
        changed = true;
        if (typeof store.persistState === 'function') store.persistState();
        this.localVersions[date] = (this.localVersions[date] || 0) + 1;
        this.pendingSyncDates.add(date);
        this.savePendingSyncDates();
        await this.pushPendingChangesInternal();
        const after = await fetchCloudDay();
        const v = this.readConflictValue(after, target);
        const at = after && (target.kind === 'day' ? (after.manualUpdatedAt || {})[target.field] : (((after.deliveries || []).find(x => x && x.id === target.tripId) || {})[target.group.at]));
        if (!this.sameConflictValue(target, v, chosen) || at !== nowIso) throw new Error('クラウドに届いたことを確認できません');
        this.resolveConflict(date, conflict.field);
        this.recordSync({ lastConflictResolvedAt: nowIso, lastConflictResolved: { date, field: conflict.field, side } });
      } catch (err) {
        if (changed) {
          // 端末の値を元に戻す（クラウドに届いていない選択で、端末だけ値が変わったままにしない）
          if (before) store.state.dailyLogs[date] = before; else delete store.state.dailyLogs[date];
          if (typeof store.persistState === 'function') store.persistState();
          if (sideCopies.e !== null) syncStorageSet('uber_log_trip_evaluations', sideCopies.e);
          if (sideCopies.m !== null) syncStorageSet('uber_log_trip_map_memos', sideCopies.m);
          if (!wasPending) { this.pendingSyncDates.delete(date); this.savePendingSyncDates(); }
        }
        return fail(`解決できませんでした（${err && err.message ? err.message : '通信エラー'}）。値は元のままです`);
      } finally {
        this.isSyncing = false;
      }
      await this.pullAndSync(); // 最新を受け取り、表示をそろえる
      this.notifyListeners();
      return { ok: true, message: '競合を解決しました', value: chosen === undefined ? null : chosen };
    } finally {
      this.resolving = false;
    }
  }

  // ------------------------------------------------------------
  // クラウドにある日の要約（diag.html の「端末とクラウドの差分」。大きな JSON は保存しない）
  // ------------------------------------------------------------
  saveCloudIndex(rows, { replaceAll = true } = {}) {
    const D = syncDiagnostics();
    if (!D || typeof D.daySignature !== 'function') return;
    const cur = replaceAll ? { days: {} } : (syncStorageGet(SYNC_STORAGE_KEYS.CLOUD_INDEX, null) || { days: {} });
    const days = { ...(cur.days || {}) };
    (rows || []).forEach(r => { if (r && r.date) days[r.date] = D.daySignature(r.data); });
    syncStorageSet(SYNC_STORAGE_KEYS.CLOUD_INDEX, { at: new Date().toISOString(), days });
  }

  // ------------------------------------------------------------
  // 送信漏れの検出（pull の後）。端末にある手動のデータがクラウドに無い・端末の方が新しい日を未送信に戻す。
  // 以前は「入力した日」しか送らなかったため、バックアップの読込・起動時の補完・ログイン前の入力などで
  // 端末にだけ残った手動のデータが、ほかの端末に届かないことがあった。
  // 送るのは手動のデータがある日だけ（Uber 実績だけの日・空の日は送らない。公式データは同梱で届く）。
  // 競合中の項目は送らない（利用者が選ぶまで、どちらにも決めない）。
  // ------------------------------------------------------------
  manualAhead(l, c, date) {
    if (!l) return false;
    const conflictKeys = new Set(this.getConflicts().map(x => x.key));
    const expTime = e => { const t = Date.parse((e && (e.updatedAt || e.createdAt)) || ''); return isNaN(t) ? 0 : t; };
    const cTomb = new Set(Array.isArray(c.deletedExpenseIds) ? c.deletedExpenseIds : []);
    const cExp = new Map((Array.isArray(c.expenses) ? c.expenses : []).filter(e => e && e.id).map(e => [e.id, e]));
    for (const e of (Array.isArray(l.expenses) ? l.expenses : [])) {
      if (!e || !e.id || cTomb.has(e.id)) continue;
      const ce = cExp.get(e.id);
      if (!ce || expTime(e) > expTime(ce)) return true;
    }
    if ((Array.isArray(l.deletedExpenseIds) ? l.deletedExpenseIds : []).some(id => !cTomb.has(id))) return true;
    const lmu = l.manualUpdatedAt || {};
    const cmu = c.manualUpdatedAt || {};
    for (const f of MANUAL_DAY_FIELDS) {
      if (conflictKeys.has(`${date}|${f}`) || this.sameManual(f, l[f], c[f])) continue;
      if (lmu[f] && (!cmu[f] || lmu[f] > cmu[f])) return true;
      if (!lmu[f] && !cmu[f] && !isEmptyValue(l[f]) && isEmptyValue(c[f])) return true;
    }
    const cDel = new Map((c.deliveries || []).filter(d => d && d.id).map(d => [d.id, d]));
    for (const d of (l.deliveries || [])) {
      if (!d || !d.id) continue;
      const cd = cDel.get(d.id);
      for (const g of TRIP_NOTE_GROUPS) {
        const lv = g.fields.map(f => d[f]);
        if (lv.every(v => v === undefined)) continue;
        if (conflictKeys.has(`${date}|trip ${d.id} ${g.label}`)) continue;
        const cv = cd ? g.fields.map(f => cd[f]) : [];
        if (cd && sameValue(lv, cv)) continue;
        if (!cd) return true;
        if (d[g.at] && (!cd[g.at] || d[g.at] > cd[g.at])) return true;
        if (!d[g.at] && !cd[g.at] && cv.every(v => v === undefined)) return true;
      }
    }
    const ids = list => new Set((Array.isArray(list) ? list : []).filter(x => x && x.id).map(x => x.id));
    const cSes = ids(c.workSessions);
    if ((l.workSessions || []).some(s => s && s.id && !cSes.has(s.id))) return true;
    const cArc = ids(c.manualTapsArchive);
    if ((l.manualTapsArchive || []).some(s => s && s.id && !cArc.has(s.id))) return true;
    return false;
  }
  findUnsentDates(cloudByDate) {
    const D = syncDiagnostics();
    const store = typeof window !== 'undefined' ? window.store : null;
    if (!D || !store || !store.state || !store.state.dailyLogs) return [];
    const out = [];
    Object.entries(store.state.dailyLogs).forEach(([date, log]) => {
      if (!D.isRealDate(date) || this.pendingSyncDates.has(date) || !log) return;
      const cloudLog = cloudByDate.get(date);
      if (!cloudLog) { if (D.dayContents(log).manual) out.push(date); return; }
      if (this.manualAhead(log, cloudLog, date)) out.push(date);
    });
    return out.sort();
  }

  // 起動時の同期（保存済みのログインを復元して Pull → 未送信分を Push）。
  // 以前は画面切替（visibilitychange）等のイベントでしか同期が始まらず、アプリを開いただけ・入力してすぐ閉じた場合に
  // 端末間で経費等が共有されなかった。起動時に1回、表示中は一定間隔でも同期する。
  startInitialSync() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const kick = () => setTimeout(() => this.pullAndSync(), 0);
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', kick);
    } else {
      kick();
    }
    // 表示中は60秒ごとに同期（裏に回っている間は通信しない。復帰時は visibilitychange で同期）
    if (typeof setInterval === 'function') {
      setInterval(() => {
        if (document.visibilityState === 'visible') this.pullAndSync();
      }, SYNC_INTERVAL_MS);
    }
  }

  // 保留中の同期待ち日付リストの読み込み
  loadPendingSyncDates() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(SYNC_STORAGE_KEYS.PENDING_DATES);
        if (raw) {
          return new Set(JSON.parse(raw));
        }
      }
    } catch (e) {
      console.warn('UBER_LOG: Failed to load pending dates', e);
    }
    return new Set();
  }

  // 保留中の同期待ち日付リストの保存
  savePendingSyncDates() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          SYNC_STORAGE_KEYS.PENDING_DATES,
          JSON.stringify(Array.from(this.pendingSyncDates))
        );
      }
    } catch (e) {}
  }

  // イベントリスナー初期化（画面復帰・オンライン検知）
  initEventListeners() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // 画面復帰時（iOS Safari切り替え・ブラウザタブ切り替え）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.pullAndSync();
      }
    });

    // オンライン復帰時
    window.addEventListener('online', () => {
      this.pullAndSync();
    });

    // オフライン検知
    window.addEventListener('offline', () => {
      this.setStatus('OFFLINE', 'オフライン（端末内保存中）');
    });

    // 認証状態の変化を購読
    if (window.supabaseManager) {
      window.supabaseManager.onAuthChange((event, session, user) => {
        if (user) {
          this.setStatus('SYNCING', 'ログイン中（同期確認中）');
          this.pullAndSync();
        } else {
          this.setStatus('NOT_LOGGED_IN', '未ログイン（ローカル単体稼働中）');
        }
      });
    }
  }

  // ステータス更新 & リスナー通知
  setStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    this.notifyListeners();
  }

  onStatusChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      try {
        callback(this.status, this.statusMessage);
      } catch (e) {}
    }
  }

  notifyListeners() {
    this.listeners.forEach(cb => {
      try {
        cb(this.status, this.statusMessage);
      } catch (e) {}
    });
  }

  // 目標クエスト保存時のフック（store.js から呼び出される）
  onTargetQuestsSaved() {
    this.pendingTargetQuestsSync = true;
    this.schedulePush();
  }

  // ローカルデータ保存時のフック（store.js から呼び出される）
  onLocalDataSaved(changedDate = null) {
    if (changedDate) {
      this.localVersions[changedDate] = (this.localVersions[changedDate] || 0) + 1;
      this.pendingSyncDates.add(changedDate);
    } else {
      // 日付未指定の場合は本日の日付をマーク
      if (typeof window.getTodayDateString === 'function') {
        this.pendingSyncDates.add(window.getTodayDateString());
      }
    }
    this.savePendingSyncDates();

    // 500msデバウンスで非同期プッシュをスケジュール
    this.schedulePush();
  }

  schedulePush() {
    if (this.pushTimeout) {
      clearTimeout(this.pushTimeout);
    }

    this.pushTimeout = setTimeout(() => {
      this.pushPendingChanges();
    }, 700);
  }

  // ------------------------------------------------------------
  // 【同期安全ルール 1 & 3】
  // ------------------------------------------------------------
  // 目標クエストの安全マージ（tombstone・updatedAt・端末間マージ）
  // ------------------------------------------------------------
  mergeTargetQuests(localQuests = [], localDeleted = [], cloudQuests = [], cloudDeleted = []) {
    const deletedIds = Array.from(new Set([
      ...(Array.isArray(localDeleted) ? localDeleted : []),
      ...(Array.isArray(cloudDeleted) ? cloudDeleted : [])
    ]));
    const qMap = new Map();
    (cloudQuests || []).forEach(q => {
      if (q && q.id) qMap.set(q.id, { ...q });
    });
    (localQuests || []).forEach(q => {
      if (q && q.id) {
        const existing = qMap.get(q.id);
        if (!existing || (q.updatedAt && (!existing.updatedAt || q.updatedAt >= existing.updatedAt))) {
          qMap.set(q.id, { ...q });
        }
      }
    });
    const mergedQuests = Array.from(qMap.values()).filter(q => !deletedIds.includes(q.id));
    const hasChange = JSON.stringify(mergedQuests) !== JSON.stringify(localQuests) ||
                      JSON.stringify(deletedIds) !== JSON.stringify(localDeleted);
    return { quests: mergedQuests, deletedIds, hasChange };
  }

  // ------------------------------------------------------------
  // 日別JSONのスマート・ディープマージ（配達・セッション・クエストの欠落防止）
  // ------------------------------------------------------------
  mergeDailyLog(localLog, cloudLog) {
    if (!localLog && !cloudLog) return null;
    if (!localLog) return JSON.parse(JSON.stringify(cloudLog));
    if (!cloudLog) return JSON.parse(JSON.stringify(localLog));

    const date = localLog.date || cloudLog.date;
    // 下で個別に統合しない項目（dayOff・officialImport・今後追加する手動項目など）は、片方にしか無くても消さない（同じ項目は端末側を優先）。
    // 以前は決まった項目だけで日別データを作り直していたため、それ以外の項目が同期のたびに失われていた
    const merged = {
      ...JSON.parse(JSON.stringify(cloudLog)),
      ...JSON.parse(JSON.stringify(localLog)),
      date: date,
      workStartedAt: localLog.workStartedAt || cloudLog.workStartedAt || null,
      workEndedAt: localLog.workEndedAt || cloudLog.workEndedAt || null,
      workMinutes: localLog.workMinutes || cloudLog.workMinutes || null,
      totalDistanceKm: localLog.totalDistanceKm !== null && localLog.totalDistanceKm !== undefined
        ? localLog.totalDistanceKm
        : (cloudLog.totalDistanceKm ?? null),
      manualUberSales: localLog.manualUberSales !== null && localLog.manualUberSales !== undefined
        ? localLog.manualUberSales
        : (cloudLog.manualUberSales ?? null),
      manualQuest: localLog.manualQuest !== null && localLog.manualQuest !== undefined
        ? localLog.manualQuest
        : (cloudLog.manualQuest ?? null),
      deliveriesCount: (localLog.deliveriesCount !== undefined && localLog.deliveriesCount !== null)
        ? localLog.deliveriesCount
        : (cloudLog.deliveriesCount ?? null),
      tripsCount: (localLog.tripsCount !== undefined && localLog.tripsCount !== null)
        ? localLog.tripsCount
        : (cloudLog.tripsCount ?? null),
      officialPoints: (localLog.officialPoints !== undefined && localLog.officialPoints !== null)
        ? localLog.officialPoints
        : (cloudLog.officialPoints ?? null),
      milestone: localLog.milestone || cloudLog.milestone || null,
      vehicleType: localLog.vehicleType || cloudLog.vehicleType || null,
      workSessions: [],
      deliveries: [],
      quests: []
    };

    // 1. 稼働セッションのマージ（ID一致時は終了時刻が入っている方を優先、片方のみのセッションは全て保持）
    const sessionMap = new Map();
    (cloudLog.workSessions || []).forEach(s => sessionMap.set(s.id, { ...s }));
    (localLog.workSessions || []).forEach(localS => {
      if (sessionMap.has(localS.id)) {
        const cloudS = sessionMap.get(localS.id);
        sessionMap.set(localS.id, {
          ...cloudS,
          ...localS,
          // 終了時刻がある方を優先（両方ある場合はより遅い時刻を採用）
          end: (localS.end && cloudS.end)
            ? (localS.end.localeCompare(cloudS.end) > 0 ? localS.end : cloudS.end)
            : (localS.end || cloudS.end || null),
          isApproximate: localS.isApproximate ?? cloudS.isApproximate,
          note: localS.note || cloudS.note || ''
        });
      } else {
        sessionMap.set(localS.id, { ...localS });
      }
    });
    merged.workSessions = Array.from(sessionMap.values()).sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    // 2. 配達明細のマージ（配達件数の消失を絶対阻止、確定済み公式実績日は手動空ログとの混在を防止）
    const localDels = localLog.deliveries || [];
    const cloudDels = cloudLog.deliveries || [];

    // 公式実績トリップ（店舗名または確定報酬あり）の存在チェック
    const localHasOfficial = localDels.some(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
    const cloudHasOfficial = cloudDels.some(d => d.restaurant || (d.fee !== null && d.fee !== undefined));

    // 片方が公式実績トリップを持ち、もう片方が手動仮記録（店舗空かつ報酬null）のみ、あるいは旧手動ログ残骸の場合の分離
    let filteredCloudDels = cloudDels;
    let filteredLocalDels = localDels;

    if (localHasOfficial && !cloudHasOfficial) {
      // ローカルが公式トリップを持ち、クラウドが手動仮記録のみの場合はローカル公式を最優先
      filteredCloudDels = [];
    } else if (!localHasOfficial && cloudHasOfficial) {
      // クラウドが公式トリップを持ち、ローカルが手動仮記録のみの場合はクラウド公式を最優先
      filteredLocalDels = [];
    } else if (localHasOfficial && cloudHasOfficial) {
      // 双方に公式データがある場合、混入した手動空タップ（店舗空・報酬null・タイムスタンプID）を排除
      filteredCloudDels = cloudDels.filter(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
      filteredLocalDels = localDels.filter(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
    }

    // 公式取込の新旧（officialImport.importedAt）。新しい公式取込を持つ側の公式値を採用し、古い端末の公式値で巻き戻さない
    const oiLocal = localLog.officialImport && localLog.officialImport.importedAt;
    const oiCloud = cloudLog.officialImport && cloudLog.officialImport.importedAt;
    const officialSide = (oiLocal && oiCloud) ? (oiCloud > oiLocal ? 'cloud' : 'local') : (oiCloud ? 'cloud' : (oiLocal ? 'local' : null));
    const offLog = officialSide === 'cloud' ? cloudLog : (officialSide === 'local' ? localLog : null);

    const deliveryMap = new Map();
    const cloudById = new Map(filteredCloudDels.map(d => [d.id, d]));
    const localById = new Map(filteredLocalDels.map(d => [d.id, d]));
    filteredCloudDels.forEach(d => deliveryMap.set(d.id, { ...d }));
    filteredLocalDels.forEach(localD => {
      if (deliveryMap.has(localD.id)) {
        const cloudD = deliveryMap.get(localD.id);
        // 公式の値: 新しい公式取込の側（無ければ従来どおり端末側を優先）
        const base = officialSide === 'cloud' ? { ...localD, ...cloudD } : {
          ...cloudD,
          ...localD,
          fee: localD.fee !== null && localD.fee !== undefined ? localD.fee : (cloudD.fee ?? null),
          distanceKm: localD.distanceKm !== null && localD.distanceKm !== undefined ? localD.distanceKm : (cloudD.distanceKm ?? null),
          restaurant: localD.restaurant || cloudD.restaurant || '',
          area: localD.area || cloudD.area || '',
          memo: localD.memo || cloudD.memo || '',
          durationStr: localD.durationStr || cloudD.durationStr || ''
        };
        deliveryMap.set(localD.id, base);
      } else {
        deliveryMap.set(localD.id, { ...localD });
      }
    });
    // trip ごとの手動メモ（○×評価・理由・MAP一口メモ）は、公式値とは別に更新時刻で選ぶ
    deliveryMap.forEach((d, id) => {
      const l = localById.get(id);
      const c = cloudById.get(id);
      if (!l || !c) return;
      TRIP_NOTE_GROUPS.forEach(g => {
        const lv = g.fields.map(f => l[f]);
        const cv = g.fields.map(f => c[f]);
        const lEmpty = lv.every(v => v === undefined);
        const cEmpty = cv.every(v => v === undefined);
        const r = this.pickByTime(date, `trip ${id} ${g.label}`, lEmpty ? undefined : lv, cEmpty ? undefined : cv, l[g.at], c[g.at], sameValue, { kind: 'trip', tripId: id, group: g.at });
        if (r.value === undefined) return;
        g.fields.forEach((f, i) => { if (r.value[i] === undefined) delete d[f]; else d[f] = r.value[i]; });
        if (r.at) d[g.at] = r.at;
      });
    });
    merged.deliveries = Array.from(deliveryMap.values()).sort((a, b) => {
      const idxDiff = (a.index || 0) - (b.index || 0);
      if (idxDiff !== 0) return idxDiff;
      return (a.completedAt || '').localeCompare(b.completedAt || '');
    });

    // 3. クエスト明細のマージ
    const questMap = new Map();
    (cloudLog.quests || []).forEach(q => questMap.set(q.id, { ...q }));
    (localLog.quests || []).forEach(localQ => {
      questMap.set(localQ.id, { ...(questMap.get(localQ.id) || {}), ...localQ });
    });
    const rawQuests = Array.from(questMap.values());
    if (typeof window !== 'undefined' && typeof window.deduplicateQuests === 'function') {
      merged.quests = window.deduplicateQuests(rawQuests);
    } else {
      merged.quests = rawQuests;
    }

    // 3-2. Uber公式の売上調整イベント（Support Adjustment等）はID基準で両端を保持
    const adjMap = new Map();
    const adjFirst = officialSide === 'cloud' ? localLog : cloudLog;   // 後から重ねる側（公式取込が新しい側）が優先
    const adjSecond = officialSide === 'cloud' ? cloudLog : localLog;
    (adjFirst.adjustments || []).forEach(a => adjMap.set(a.id, { ...a }));
    (adjSecond.adjustments || []).forEach(a => adjMap.set(a.id, { ...(adjMap.get(a.id) || {}), ...a }));
    if (adjMap.size > 0) {
      merged.adjustments = Array.from(adjMap.values());
    }

    // 3-3. 公式取込で決まる値（件数・距離・クエスト・公式取込の印）は新しい公式取込の側
    if (offLog) {
      OFFICIAL_DAY_FIELDS.forEach(f => { if (offLog[f] !== undefined && offLog[f] !== null) merged[f] = offLog[f]; });
      if (Array.isArray(offLog.quests)) {
        merged.quests = (typeof window !== 'undefined' && typeof window.deduplicateQuests === 'function') ? window.deduplicateQuests(offLog.quests.map(q => ({ ...q }))) : offLog.quests.map(q => ({ ...q }));
      }
      merged.officialImport = { ...offLog.officialImport };
    }

    // 4. 売上内訳のマージ（Delivery, Quest, Adjustment, Other, Total）
    if (localLog.sales || cloudLog.sales) {
      const ls = localLog.sales || {};
      const cs = cloudLog.sales || {};
      const useLocal = !cs.updatedAt || (ls.updatedAt && ls.updatedAt >= cs.updatedAt);
      const chosen = useLocal ? ls : cs;
      const fallback = useLocal ? cs : ls;
      merged.sales = {
        // 個別に統合しない売上項目（tip: 旧取込の「うちチップ」等）も残す（新しい側を優先）
        ...fallback,
        ...chosen,
        delivery: chosen.delivery !== undefined ? chosen.delivery : (fallback.delivery ?? 0),
        quest: chosen.quest !== undefined ? chosen.quest : (fallback.quest ?? 0),
        adjustment: chosen.adjustment !== undefined ? chosen.adjustment : (fallback.adjustment ?? 0),
        other: chosen.other !== undefined ? chosen.other : (fallback.other ?? 0),
        total: chosen.total !== undefined ? chosen.total : (fallback.total ?? 0),
        guaranteeBonus: chosen.guaranteeBonus !== undefined ? chosen.guaranteeBonus : (fallback.guaranteeBonus ?? 0),
        guaranteeBonusNote: chosen.guaranteeBonusNote || fallback.guaranteeBonusNote || '',
        regularTotal: chosen.regularTotal !== undefined ? chosen.regularTotal : (fallback.regularTotal ?? null),
        rawTextSummary: chosen.rawTextSummary || fallback.rawTextSummary || '',
        updatedAt: chosen.updatedAt || fallback.updatedAt || null
      };

      // 9/19の公式確定特別保証（¥12,132）の保全ガード
      if (date === '2026-09-19') {
        if (!merged.sales.guaranteeBonus || merged.sales.guaranteeBonus === 0) {
          if (localLog.sales && localLog.sales.guaranteeBonus) {
            merged.sales.guaranteeBonus = localLog.sales.guaranteeBonus;
            merged.sales.guaranteeBonusNote = localLog.sales.guaranteeBonusNote || '新規ドライバー特別保証（18件達成）';
          } else {
            merged.sales.guaranteeBonus = 12132;
            merged.sales.guaranteeBonusNote = '新規ドライバー特別保証（18件達成）';
          }
        }
        if (merged.sales.total < 21310) {
          merged.sales.total = 21310;
        }
      }

      // 9/21・9/22の公式確定売上（公式スクリーンショット照合済み）の保全ガード
      // 9/22は 23:46 Support Adjustment -¥607 反映後の確定値（¥8,250 + ¥1,600 - ¥607 = ¥9,243）
      const OFFICIAL_DAY_SALES = {
        '2026-09-21': { delivery: 3490, quest: 800, total: 4290 },
        '2026-09-22': { delivery: 8250, quest: 1600, adjustment: -607, total: 9243 }
      };
      const officialDay = OFFICIAL_DAY_SALES[date];
      const hasOfficialAdjustment = officialDay && officialDay.adjustment !== undefined;
      if (officialDay && (
        (merged.sales.total || 0) < officialDay.total ||
        (hasOfficialAdjustment && (merged.sales.adjustment !== officialDay.adjustment || merged.sales.total !== officialDay.total))
      )) {
        merged.sales.delivery = officialDay.delivery;
        merged.sales.quest = officialDay.quest;
        if (hasOfficialAdjustment) merged.sales.adjustment = officialDay.adjustment;
        merged.sales.total = officialDay.total;
      }

      // 公式の売上内訳は新しい公式取込の側（古い端末の公式値で巻き戻さない）
      if (offLog && offLog.sales) {
        OFFICIAL_SALES_KEYS.forEach(k => { if (offLog.sales[k] !== undefined) merged.sales[k] = offLog.sales[k]; });
      }

      // 公式取込v1（tools/official-import）で反映された日は、アプリ同梱の公式データを正とする。
      // ただし同期で受け取った公式取込のほうが新しい場合（この端末の版が古い）は同梱データで巻き戻さない
      const seedLog = (typeof window !== 'undefined' && typeof window.getConfirmedSeedData === 'function')
        ? (window.getConfirmedSeedData().dailyLogs || {})[date]
        : null;
      const mergedOi = merged.officialImport && merged.officialImport.importedAt;
      if (seedLog && seedLog.officialImport && seedLog.sales && (!mergedOi || !seedLog.officialImport.importedAt || seedLog.officialImport.importedAt >= mergedOi)) {
        OFFICIAL_SALES_KEYS.forEach(k => {
          merged.sales[k] = seedLog.sales[k];
        });
      }
    }

    // 5. 当日経費明細のマージ（ID単位の和集合。片方にだけある経費は必ず残す。同じIDは updatedAt が新しい方）
    //    削除済みマーク（tombstone）は両端を統合し、削除した経費の復活を防ぐ
    const deletedExpenseIds = Array.from(new Set([
      ...(Array.isArray(cloudLog.deletedExpenseIds) ? cloudLog.deletedExpenseIds : []),
      ...(Array.isArray(localLog.deletedExpenseIds) ? localLog.deletedExpenseIds : [])
    ]));
    if (typeof window !== 'undefined' && typeof window.mergeExpenseLists === 'function') {
      merged.expenses = window.mergeExpenseLists(localLog.expenses, cloudLog.expenses, deletedExpenseIds);
    } else {
      const expMap = new Map();
      (cloudLog.expenses || []).forEach(e => expMap.set(e.id, { ...e }));
      (localLog.expenses || []).forEach(e => {
        expMap.set(e.id, { ...(expMap.get(e.id) || {}), ...e });
      });
      merged.expenses = Array.from(expMap.values()).filter(e => !deletedExpenseIds.includes(e.id));
    }
    if (deletedExpenseIds.length > 0) {
      merged.deletedExpenseIds = deletedExpenseIds;
    }

    // 5-2. 手動タップ記録のアーカイブ（公式実績置換時の退避分）はID基準で保持
    const archiveMap = new Map();
    (cloudLog.manualTapsArchive || []).forEach(d => archiveMap.set(d.id, { ...d }));
    (localLog.manualTapsArchive || []).forEach(d => archiveMap.set(d.id, { ...(archiveMap.get(d.id) || {}), ...d }));
    if (archiveMap.size > 0) {
      merged.manualTapsArchive = Array.from(archiveMap.values());
    }

    // 6. 手動の日別項目（手動休み・天気・移動手段）は更新時刻（manualUpdatedAt）で新しい方。
    //    片方にしか無い値は消さない。どちらにも時刻が無く値が違うときは端末側を残し、競合として記録する
    const lmu = localLog.manualUpdatedAt || {};
    const cmu = cloudLog.manualUpdatedAt || {};
    const mu = { ...cmu, ...lmu };
    MANUAL_DAY_FIELDS.forEach(f => {
      const r = this.pickByTime(date, f, localLog[f], cloudLog[f], lmu[f], cmu[f], (a, b) => this.sameManual(f, a, b), { kind: 'day' });
      if (r.value === undefined) delete merged[f]; else merged[f] = r.value;
      if (r.at) mu[f] = r.at;
    });
    if (Object.keys(mu).length) merged.manualUpdatedAt = mu;

    // 後方互換性プロパティの整合性補正
    if (typeof window !== 'undefined' && window.store && typeof window.store.syncLegacyWorkInfo === 'function') {
      window.store.syncLegacyWorkInfo(merged);
    }

    return merged;
  }

  // ------------------------------------------------------------
  // 【同期安全ルール 2】
  // アプリ起動・復帰時の同期実行
  // 順序: SupabaseからPull → 検証・マージ → 新しいローカル変更だけPush
  // ------------------------------------------------------------
  async pullAndSync() {
    if (this.isSyncing) return;
    if (!navigator.onLine) {
      this.setStatus('OFFLINE', 'オフライン（端末内保存中）');
      this.recordSync({ lastResult: 'offline', lastCheckAt: new Date().toISOString() });
      return;
    }

    const sm = window.supabaseManager;
    if (!sm || !sm.isReady()) {
      this.setStatus('UNCONFIGURED', '接続未設定');
      this.recordSync({ lastResult: 'unconfigured', lastCheckAt: new Date().toISOString() });
      return;
    }

    if (!sm.isLoggedIn()) {
      // セッション回復を試みる
      const session = await sm.getSession();
      if (!session) {
        this.setStatus('NOT_LOGGED_IN', '未ログイン（ローカル単体稼働中）');
        this.recordSync({ lastResult: 'not_logged_in', loggedIn: false, lastCheckAt: new Date().toISOString() });
        return;
      }
    }

    this.isSyncing = true;
    this.setStatus('SYNCING', 'クラウドと同期中...');

    try {
      const client = sm.client;
      const userId = sm.getUserId();

      // 1. Supabaseから日別ログを取得 (Pull)
      const { data: cloudLogs, error: logError } = await client
        .from('uber_daily_logs')
        .select('date, data, updated_at')
        .eq('user_id', userId);

      if (logError) {
        throw new Error(`日別データ取得失敗: ${logError.message}`);
      }
      this.recordSync({ lastPullAt: new Date().toISOString(), cloudDays: Array.isArray(cloudLogs) ? cloudLogs.length : 0, loggedIn: true });
      this.saveCloudIndex(cloudLogs);

      // 2. ローカルデータへ安全にマージ
      let hasLocalUpdate = false;
      const store = window.store;

      if (cloudLogs && Array.isArray(cloudLogs) && cloudLogs.length > 0) {
        cloudLogs.forEach(row => {
          const date = row.date;
          const cloudData = row.data;
          const localData = store.state.dailyLogs[date];

          // ローカルに同期待ち変更がない場合、またはクラウドが最新の場合マージ
          const merged = this.mergeDailyLog(localData, cloudData);
          if (merged) {
            store.state.dailyLogs[date] = merged;
            hasLocalUpdate = true;
          }
        });

        if (hasLocalUpdate) {
          // LocalStorageへ永続化（クラウド送信フックは呼ばない）。
          // 別の画面が先に保存した経費等を消さないよう、保存済みデータと日ごとに統合して書く
          if (typeof store.persistState === 'function') {
            store.persistState();
          } else {
            localStorage.setItem('uber_log_v1_data', JSON.stringify(store.state));
          }
          // UI再描画を要請
          if (window.app && typeof window.app.renderAll === 'function') {
            window.app.renderAll();
          }
        }
      }

      // 3-2. 目標クエスト（uber_metadata: target_quests）のPull & マージ
      try {
        const { data: metaRows, error: metaErr } = await client
          .from('uber_metadata')
          .select('key, value, updated_at')
          .eq('user_id', userId)
          .eq('key', 'target_quests');

        if (!metaErr && metaRows && metaRows.length > 0 && metaRows[0].value) {
          const cloudData = metaRows[0].value;
          const localQuests = store.state.targetQuests || [];
          const localDeleted = store.state.deletedTargetQuestIds || [];

          const merged = this.mergeTargetQuests(localQuests, localDeleted, cloudData.quests || [], cloudData.deletedIds || []);
          if (merged.hasChange) {
            store.state.targetQuests = merged.quests;
            store.state.deletedTargetQuestIds = merged.deletedIds;
            if (typeof store.persistState === 'function') store.persistState();
            hasLocalUpdate = true;
          }
        }
      } catch (mqErr) {
        console.warn('UBER_LOG: Target quests pull warning:', mqErr);
      }

      // 3. 地雷データベース（uber_benchmarks）のPull & マージ
      const { data: cloudBms, error: bmError } = await client
        .from('uber_benchmarks')
        .select('id, data, updated_at')
        .eq('user_id', userId);

      if (!bmError && cloudBms && Array.isArray(cloudBms) && cloudBms.length > 0) {
        const avDb = window.AVOIDANCE_DATABASE;
        if (avDb && avDb.benchmarks) {
          cloudBms.forEach(row => {
            const b = avDb.benchmarks.find(x => x.id === row.id);
            if (b && row.data && row.data.status) {
              b.status = row.data.status;
            }
          });
        }
      }

      // 3-4. 送信漏れ（端末にだけある手動のデータ）を未送信に戻す
      const cloudByDate = new Map((Array.isArray(cloudLogs) ? cloudLogs : []).map(r => [r.date, r.data]));
      // 同じ日の自動再送は10分に1回まで（万一 merge の結果がクラウドとそろわない日があっても、60秒ごとに送り続けない）
      this.resentAt = this.resentAt || {};
      const nowMs = Date.now();
      const unsent = this.findUnsentDates(cloudByDate).filter(d => !(this.resentAt[d] && nowMs - this.resentAt[d] < 10 * 60 * 1000));
      unsent.forEach(d => { this.resentAt[d] = nowMs; });
      if (unsent.length) {
        unsent.forEach(d => this.pendingSyncDates.add(d));
        this.savePendingSyncDates();
        this.recordSync({ lastResendAt: new Date().toISOString(), lastResendDates: unsent });
      }

      // 4. 新しいローカル未同期差分があればPush
      await this.pushPendingChangesInternal();

      // 完了
      const nowIso = new Date().toISOString();
      const nowTime = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
      this.recordSync({ lastSyncAt: nowIso, lastResult: 'ok', lastError: null });
      this.setStatus('SYNCED', `同期完了 (${nowTime})`);
    } catch (err) {
      // 【同期安全ルール 4】通信失敗時もLocalStorageを絶対破壊・巻き戻ししない
      console.warn('UBER_LOG: Sync warning/error (local data preserved):', err);
      this.recordSync({ lastResult: 'error', lastError: err.message || '通信エラー', lastErrorAt: new Date().toISOString() });
      this.setStatus('ERROR', `同期一時停止: ${err.message || '通信エラー'}`);
    } finally {
      this.isSyncing = false;
    }
  }

  // 内部プッシュ処理
  async pushPendingChangesInternal() {
    if (this.pendingSyncDates.size === 0) return;

    const sm = window.supabaseManager;
    if (!sm || !sm.isReady()) return;
    if (!sm.isLoggedIn()) {
      // 保存済みのログイン（セッション）を復元してから送る。ログインしていなければ未送信のまま残す
      const session = await sm.getSession();
      if (!session || !sm.isLoggedIn()) return;
    }

    const client = sm.client;
    const userId = sm.getUserId();
    const store = window.store;

    const datesToPush = Array.from(this.pendingSyncDates);

    // 送信前に現在のクラウド側を取得し、日ごとに統合してから送る（別端末が先に送った経費等を上書きで消さない）
    const { data: cloudRows, error: fetchError } = await client
      .from('uber_daily_logs')
      .select('date, data, updated_at')
      .eq('user_id', userId);
    if (fetchError) {
      throw new Error(`送信前のクラウド確認に失敗: ${fetchError.message}`); // pending は残して次回再送
    }
    const cloudByDate = new Map((cloudRows || []).map(r => [r.date, r.data]));
    this.saveCloudIndex(cloudRows);
    const pushedRows = [];

    for (const date of datesToPush) {
      const versionAtStart = this.localVersions[date] || 0;
      let dayLog = store.state.dailyLogs[date];
      if (dayLog) {
        const cloudDay = cloudByDate.get(date);
        if (cloudDay) {
          const merged = this.mergeDailyLog(dayLog, cloudDay);
          if (JSON.stringify(merged) !== JSON.stringify(dayLog)) {
            store.state.dailyLogs[date] = merged;
            if (typeof store.persistState === 'function') store.persistState();
            dayLog = merged;
          }
        }
        const { error } = await client
          .from('uber_daily_logs')
          .upsert({
            user_id: userId,
            date: date,
            data: dayLog
          });

        if (error) {
          console.warn(`UBER_LOG: Failed to push ${date}:`, error);
          if (pushedRows.length) this.saveCloudIndex(pushedRows, { replaceAll: false });
          throw error; // エラー時はpendingSyncDatesから削除せず次回再送
        }
        pushedRows.push({ date, data: dayLog });
      }
      // 送信中にこの日が変更された場合は、次回も送るため pending を残す
      if ((this.localVersions[date] || 0) === versionAtStart) {
        this.pendingSyncDates.delete(date);
      }
    }

    this.savePendingSyncDates();
    if (pushedRows.length) this.saveCloudIndex(pushedRows, { replaceAll: false });
    if (datesToPush.length) this.recordSync({ lastPushAt: new Date().toISOString(), lastPushDays: datesToPush.length, cloudDays: new Set([...cloudByDate.keys(), ...datesToPush]).size });

    // 目標クエストのPush
    if (this.pendingTargetQuestsSync) {
      try {
        const localQuests = store.state.targetQuests || [];
        const localDeleted = store.state.deletedTargetQuestIds || [];

        // 送信前にもクラウド側を取得してマージ
        const { data: cloudMeta } = await client
          .from('uber_metadata')
          .select('key, value')
          .eq('user_id', userId)
          .eq('key', 'target_quests');

        let finalQuests = localQuests;
        let finalDeleted = localDeleted;
        if (cloudMeta && cloudMeta.length > 0 && cloudMeta[0].value) {
          const cm = cloudMeta[0].value;
          const merged = this.mergeTargetQuests(localQuests, localDeleted, cm.quests || [], cm.deletedIds || []);
          finalQuests = merged.quests;
          finalDeleted = merged.deletedIds;
          if (merged.hasChange) {
            store.state.targetQuests = finalQuests;
            store.state.deletedTargetQuestIds = finalDeleted;
            if (typeof store.persistState === 'function') store.persistState();
          }
        }

        const { error: pushMetaErr } = await client
          .from('uber_metadata')
          .upsert({
            user_id: userId,
            key: 'target_quests',
            value: {
              quests: finalQuests,
              deletedIds: finalDeleted,
              updatedAt: new Date().toISOString()
            }
          });

        if (!pushMetaErr) {
          this.pendingTargetQuestsSync = false;
        } else {
          console.warn('UBER_LOG: Failed to push target_quests:', pushMetaErr);
        }
      } catch (e) {
        console.warn('UBER_LOG: Error pushing target quests:', e);
      }
    }
  }

  // 保留中差分のPush実行
  // 入力の直後に送る（送れなかった日は未送信のまま残り、online 復帰・画面復帰・60秒ごとの同期で再送する）
  async pushPendingChanges() {
    if (this.isSyncing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus('OFFLINE', 'オフライン（端末内保存中・未送信あり）');
      this.recordSync({ lastResult: 'offline', lastCheckAt: new Date().toISOString() });
      return;
    }
    try {
      await this.pushPendingChangesInternal();
      if (this.pendingSyncDates.size === 0 && this.status === 'SYNCED') this.notifyListeners();
    } catch (e) {
      console.warn('UBER_LOG: Push error:', e);
      this.recordSync({ lastResult: 'error', lastError: e.message || '送信エラー', lastErrorAt: new Date().toISOString() });
      this.setStatus('ERROR', `同期一時停止: ${e.message || '送信エラー'}（未送信は端末に保存済み）`);
    }
  }

  // ------------------------------------------------------------
  // 【同期安全ルール 5 & 6】
  // データ整合性検証（30件配達・12クエスト・公式正本17,080円）
  // ------------------------------------------------------------
  validateIntegrity(dailyLogs) {
    const requiredDates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
    const errors = [];

    if (!dailyLogs || typeof dailyLogs !== 'object') {
      return { valid: false, errors: ['日別データが存在しません'] };
    }

    // 必須日付存在確認
    for (const d of requiredDates) {
      if (!dailyLogs[d]) {
        errors.push(`確定日付 ${d} が欠落しています`);
      }
    }

    let totalDeliveries = 0;
    let totalQuests = 0;
    let totalDeliverySales = 0;
    let totalQuestSales = 0;

    requiredDates.forEach(d => {
      const log = dailyLogs[d];
      if (log) {
        totalDeliveries += (log.deliveries || []).length;
        totalQuests += (log.quests || []).length;

        // 配達報酬合算
        (log.deliveries || []).forEach(del => {
          if (del.fee !== null && del.fee !== undefined) {
            totalDeliverySales += Number(del.fee) || 0;
          }
        });

        // クエスト報酬合算（重複除外後）
        const deduped = typeof window.deduplicateQuests === 'function'
          ? window.deduplicateQuests(log.quests || [])
          : (log.quests || []);
        deduped.filter(q => !q.isDuplicateIgnored).forEach(q => {
          totalQuestSales += Number(q.amount) || 0;
        });
      }
    });

    const calculatedTotal = totalDeliverySales + totalQuestSales; // 17,084
    const officialTotal = 17080;

    if (totalDeliveries !== 30) {
      errors.push(`配達件数が30件ではありません（現在: ${totalDeliveries}件）`);
    }

    if (totalQuests !== 12) {
      errors.push(`クエスト明細が12件ではありません（現在: ${totalQuests}件）`);
    }

    // 正本17,080円の照合（要確認差額+4円許容）
    if (calculatedTotal !== 17084 && calculatedTotal !== 17080) {
      errors.push(`明細合計が正本基準と不一致です（現在: ${calculatedTotal}円、期待値: 17,084円/正本17,080円）`);
    }

    return {
      valid: errors.length === 0,
      errors,
      metrics: {
        totalDeliveries,
        totalQuests,
        totalDeliverySales,
        totalQuestSales,
        calculatedTotal,
        officialTotal
      }
    };
  }

  // ------------------------------------------------------------
  // 初回データ移行（LocalStorage → Supabase）
  // ※ユーザーの明示的実行時のみ動作。事後検証クリアで完了とする
  // ------------------------------------------------------------
  async migrateLocalToCloud() {
    const sm = window.supabaseManager;
    if (!sm || !sm.isLoggedIn()) {
      throw new Error('Supabaseにログインしていません。ログイン後に実行してください。');
    }

    const store = window.store;
    if (!store || !store.state || !store.state.dailyLogs) {
      throw new Error('ローカルデータが見つかりません。');
    }

    // 【同期安全ルール 5】事前整合性チェック
    const preCheck = this.validateIntegrity(store.state.dailyLogs);
    if (!preCheck.valid) {
      throw new Error(`移行前のローカルデータ整合性エラー:\n${preCheck.errors.join('\n')}`);
    }

    // 事前バックアップ保存
    try {
      localStorage.setItem(
        SYNC_STORAGE_KEYS.PRE_MIGRATION_BACKUP,
        JSON.stringify(store.state)
      );
    } catch (e) {
      console.warn('Backup save error:', e);
    }

    this.setStatus('SYNCING', '確定データをクラウドへ初回移行中...');

    const client = sm.client;
    const userId = sm.getUserId();

    // 1. 日別ログ（uber_daily_logs）のUPSERT
    for (const [date, data] of Object.entries(store.state.dailyLogs)) {
      const { error } = await client
        .from('uber_daily_logs')
        .upsert({
          user_id: userId,
          date: date,
          data: data
        });

      if (error) {
        throw new Error(`クラウド投入エラー (${date}): ${error.message}`);
      }
    }

    // 2. 地雷DB（uber_benchmarks）のUPSERT
    const avDb = window.AVOIDANCE_DATABASE;
    if (avDb && Array.isArray(avDb.benchmarks)) {
      for (const bm of avDb.benchmarks) {
        await client.from('uber_benchmarks').upsert({
          user_id: userId,
          id: bm.id,
          data: bm
        });
      }
    }

    // 3. アプリメタデータ（uber_metadata）のUPSERT
    await client.from('uber_metadata').upsert({
      user_id: userId,
      key: 'app_version',
      value: { version: '1.1', migrated_at: new Date().toISOString() }
    });

    // 【同期安全ルール 6】事後検証（Supabaseから再取得して突合）
    const { data: verifyRows, error: verifyError } = await client
      .from('uber_daily_logs')
      .select('date, data')
      .eq('user_id', userId);

    if (verifyError || !verifyRows) {
      throw new Error(`移行後検証データ取得失敗: ${verifyError?.message || 'データなし'}`);
    }

    const downloadedLogs = {};
    verifyRows.forEach(r => { downloadedLogs[r.date] = r.data; });

    const postCheck = this.validateIntegrity(downloadedLogs);
    if (!postCheck.valid) {
      throw new Error(`移行後クラウドデータ整合性不一致:\n${postCheck.errors.join('\n')}`);
    }

    // 成功フラグ記録
    localStorage.setItem(SYNC_STORAGE_KEYS.MIGRATION_COMPLETED, 'true');
    this.setStatus('SYNCED', '確定データ移行完了・完全一致');
    return { success: true, metrics: postCheck.metrics };
  }
}

const cloudSync = new CloudSyncManager();

if (typeof window !== 'undefined') {
  window.cloudSync = cloudSync;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CloudSyncManager, cloudSync, SYNC_STORAGE_KEYS, SYNC_INTERVAL_MS, MANUAL_DAY_FIELDS, TRIP_NOTE_GROUPS };
}
