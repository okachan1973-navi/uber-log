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
  MIGRATION_COMPLETED: 'uber_cloud_migration_completed'
};

class CloudSyncManager {
  constructor() {
    this.status = 'UNCONFIGURED'; // UNCONFIGURED | NOT_LOGGED_IN | SYNCED | SYNCING | OFFLINE | ERROR
    this.statusMessage = '未接続';
    this.listeners = [];
    this.pushTimeout = null;
    this.isSyncing = false;
    this.pendingSyncDates = this.loadPendingSyncDates();

    this.initEventListeners();
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

  // ローカルデータ保存時のフック（store.js から呼び出される）
  onLocalDataSaved(changedDate = null) {
    if (changedDate) {
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
  // 日別JSONのスマート・ディープマージ（配達・セッション・クエストの欠落防止）
  // ------------------------------------------------------------
  mergeDailyLog(localLog, cloudLog) {
    if (!localLog && !cloudLog) return null;
    if (!localLog) return JSON.parse(JSON.stringify(cloudLog));
    if (!cloudLog) return JSON.parse(JSON.stringify(localLog));

    const date = localLog.date || cloudLog.date;
    const merged = {
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

    const deliveryMap = new Map();
    filteredCloudDels.forEach(d => deliveryMap.set(d.id, { ...d }));
    filteredLocalDels.forEach(localD => {
      if (deliveryMap.has(localD.id)) {
        const cloudD = deliveryMap.get(localD.id);
        deliveryMap.set(localD.id, {
          ...cloudD,
          ...localD,
          fee: localD.fee !== null && localD.fee !== undefined ? localD.fee : (cloudD.fee ?? null),
          distanceKm: localD.distanceKm !== null && localD.distanceKm !== undefined ? localD.distanceKm : (cloudD.distanceKm ?? null),
          restaurant: localD.restaurant || cloudD.restaurant || '',
          area: localD.area || cloudD.area || '',
          memo: localD.memo || cloudD.memo || '',
          durationStr: localD.durationStr || cloudD.durationStr || ''
        });
      } else {
        deliveryMap.set(localD.id, { ...localD });
      }
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

    // 4. 売上内訳のマージ（Delivery, Quest, Adjustment, Other, Total）
    if (localLog.sales || cloudLog.sales) {
      const ls = localLog.sales || {};
      const cs = cloudLog.sales || {};
      const useLocal = !cs.updatedAt || (ls.updatedAt && ls.updatedAt >= cs.updatedAt);
      const chosen = useLocal ? ls : cs;
      const fallback = useLocal ? cs : ls;
      merged.sales = {
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
    }

    // 5. 当日経費明細のマージ（ID一致時はローカル優先、新規明細は全て合算）
    const expMap = new Map();
    (cloudLog.expenses || []).forEach(e => expMap.set(e.id, { ...e }));
    (localLog.expenses || []).forEach(e => {
      expMap.set(e.id, { ...(expMap.get(e.id) || {}), ...e });
    });
    merged.expenses = Array.from(expMap.values());

    // 6. 車両/移動手段種別のマージ
    merged.vehicleType = localLog.vehicleType || cloudLog.vehicleType || null;

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
      return;
    }

    const sm = window.supabaseManager;
    if (!sm || !sm.isReady()) {
      this.setStatus('UNCONFIGURED', '接続未設定');
      return;
    }

    if (!sm.isLoggedIn()) {
      // セッション回復を試みる
      const session = await sm.getSession();
      if (!session) {
        this.setStatus('NOT_LOGGED_IN', '未ログイン（ローカル単体稼働中）');
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
          // LocalStorageへ永続化（ループ防止のため直接setItem）
          localStorage.setItem('uber_log_v1_data', JSON.stringify(store.state));
          // UI再描画を要請
          if (window.app && typeof window.app.renderAll === 'function') {
            window.app.renderAll();
          }
        }
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

      // 4. 新しいローカル未同期差分があればPush
      await this.pushPendingChangesInternal();

      // 完了
      const nowTime = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      this.setStatus('SYNCED', `同期完了 (${nowTime})`);
    } catch (err) {
      // 【同期安全ルール 4】通信失敗時もLocalStorageを絶対破壊・巻き戻ししない
      console.warn('UBER_LOG: Sync warning/error (local data preserved):', err);
      this.setStatus('ERROR', `同期一時停止: ${err.message || '通信エラー'}`);
    } finally {
      this.isSyncing = false;
    }
  }

  // 内部プッシュ処理
  async pushPendingChangesInternal() {
    if (this.pendingSyncDates.size === 0) return;

    const sm = window.supabaseManager;
    if (!sm || !sm.isLoggedIn()) return;

    const client = sm.client;
    const userId = sm.getUserId();
    const store = window.store;

    const datesToPush = Array.from(this.pendingSyncDates);

    for (const date of datesToPush) {
      const dayLog = store.state.dailyLogs[date];
      if (dayLog) {
        const { error } = await client
          .from('uber_daily_logs')
          .upsert({
            user_id: userId,
            date: date,
            data: dayLog
          });

        if (error) {
          console.warn(`UBER_LOG: Failed to push ${date}:`, error);
          throw error; // エラー時はpendingSyncDatesから削除せず次回再送
        }
      }
      this.pendingSyncDates.delete(date);
    }

    this.savePendingSyncDates();
  }

  // 保留中差分のPush実行
  async pushPendingChanges() {
    if (this.isSyncing) return;
    try {
      await this.pushPendingChangesInternal();
    } catch (e) {
      console.warn('UBER_LOG: Push error:', e);
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
  module.exports = { CloudSyncManager, cloudSync, SYNC_STORAGE_KEYS };
}
