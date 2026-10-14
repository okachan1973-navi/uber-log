/**
 * UBER_LOG データ診断（読み取り専用・外部送信なし）
 *
 * 日別データ（dailyLogs: { 'YYYY-MM-DD': 日別ログ }）を生のまま調べる純粋関数だけを置く。
 * - checkDailyLogs: 保存データの整合性チェック（不整合を日付・項目つきで返す）
 * - summarizeByMonth: 月ごとの生データ合計（件数・売上・必要経費・経費の種類）
 * 使う場所: diag.html（端末で開く診断ページ）、tools/data-audit/data-integrity-audit.js（PC の監査スクリプト）。
 * 定義は DATA_MODEL.md に従う。store.js を読み込まない（読み込むと端末保存の補完・書き込みが走るため）。
 */
(function (root) {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isRealDate = s => {
    if (!DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  };
  const num = v => (v === null || v === undefined || v === '') ? 0 : Number(v);
  const isBad = v => v !== null && v !== undefined && v !== '' && !Number.isFinite(Number(v));
  const round2 = n => Math.round(n * 100) / 100;

  // 実績のある日（DATA_MODEL.md「稼働日」）: 公式の件数・トリップ数が1以上、または店舗名か報酬のある配達が1件以上
  function hasUberActivity(log) {
    if (!log) return false;
    if (num(log.deliveriesCount) > 0 || num(log.tripsCount) > 0) return true;
    return (log.deliveries || []).some(d => d && ((d.restaurant && String(d.restaurant).trim()) || num(d.fee) > 0));
  }

  // 生データからの1日の総売上（store.getCalculatedMetrics と同じ規則を最小限で再計算）
  // sales があれば delivery + quest + adjustment + other + guaranteeBonus、無ければ配達報酬（fee）＋重複を除いたクエスト
  function rawDayTotal(log) {
    const s = log.sales;
    if (s && (s.delivery !== undefined || s.quest !== undefined)) {
      return num(s.delivery) + num(s.quest) + num(s.adjustment) + num(s.other) + num(s.guaranteeBonus);
    }
    const fees = (log.deliveries || []).reduce((a, d) => a + (Number.isFinite(Number(d && d.fee)) ? num(d.fee) : 0), 0);
    const quests = (log.quests || []).filter(q => q && !q.isDuplicateIgnored).reduce((a, q) => a + num(q.amount), 0);
    return fees + quests + num(s && s.adjustment) + num(s && s.other) + num(s && s.guaranteeBonus) + num(log.guaranteeBonus);
  }

  /**
   * 保存データの整合性チェック
   * @param {object} dailyLogs
   * @param {{today?: string, knownLegacyCountDates?: string[]}} opts
   * @returns {{level:'error'|'warn'|'info', date:string, field:string, message:string}[]}
   */
  function checkDailyLogs(dailyLogs, opts = {}) {
    const today = opts.today || null;
    const known = new Set(opts.knownLegacyCountDates || []);
    const out = [];
    const add = (level, date, field, message) => out.push({ level, date, field, message });
    const tripSeen = new Map();
    const expenseSeen = new Map();

    Object.keys(dailyLogs || {}).sort().forEach(key => {
      const log = dailyLogs[key];
      if (!isRealDate(key)) { add('error', key, 'date', `日付の形式が不正（YYYY-MM-DD の実在日ではない）`); return; }
      if (!log || typeof log !== 'object') { add('error', key, 'log', '日別データがオブジェクトではない'); return; }
      if (log.date !== undefined && log.date !== key) add('error', key, 'date', `中の date（${log.date}）がキーと違う`);

      // 数値項目: NaN / Infinity / 数値でない文字列
      ['deliveriesCount', 'tripsCount', 'officialPoints', 'totalDistanceKm'].forEach(f => {
        if (isBad(log[f])) add('error', key, f, `数値ではない値: ${JSON.stringify(log[f])}`);
      });
      const s = log.sales || null;
      if (s) {
        ['delivery', 'quest', 'adjustment', 'other', 'total', 'guaranteeBonus', 'tip'].forEach(f => {
          if (isBad(s[f])) add('error', key, `sales.${f}`, `数値ではない値: ${JSON.stringify(s[f])}`);
        });
        // 保存された合計（派生値）と内訳の一致: total = delivery + quest + adjustment + other + guaranteeBonus
        if (s.total !== undefined && s.total !== null && !isBad(s.total)) {
          const comp = num(s.delivery) + num(s.quest) + num(s.adjustment) + num(s.other) + num(s.guaranteeBonus);
          if (num(s.total) !== comp) add('error', key, 'sales.total', `保存された総売上 ¥${num(s.total)} ≠ 内訳の合計 ¥${comp}`);
        }
        if (num(s.tip) < 0) add('error', key, 'sales.tip', `うちチップがマイナス（¥${num(s.tip)}）`);
        if (num(s.tip) > 0 && num(s.tip) > num(s.delivery)) add('error', key, 'sales.tip', `うちチップ ¥${num(s.tip)} が配達報酬 ¥${num(s.delivery)} より大きい`);
        if (num(s.other) !== 0) add('info', key, 'sales.other', `その他 ¥${num(s.other)}（旧売上取込・手入力。内容の確認対象）`);
      }

      // 調整イベントと sales.adjustment（符号付き）の一致
      if (Array.isArray(log.adjustments) && log.adjustments.length && s) {
        const sum = log.adjustments.reduce((a, x) => a + num(x && x.amount), 0);
        if (sum !== num(s.adjustment)) add('error', key, 'sales.adjustment', `調整イベントの合計 ¥${sum} ≠ sales.adjustment ¥${num(s.adjustment)}（符号を含めて一致が必要）`);
      }

      // トリップ（deliveries[] は1トリップ1要素）
      const trips = Array.isArray(log.deliveries) ? log.deliveries : [];
      const dayTripIds = new Set();
      trips.forEach((d, i) => {
        if (!d || typeof d !== 'object') { add('error', key, `deliveries[${i}]`, 'トリップがオブジェクトではない'); return; }
        ['fee', 'distanceKm', 'tip', 'points', 'baseFee'].forEach(f => {
          if (isBad(d[f])) add('error', key, `deliveries[${i}].${f}`, `数値ではない値: ${JSON.stringify(d[f])}`);
        });
        if (d.id) {
          if (dayTripIds.has(d.id)) add('error', key, 'deliveries.id', `同じ日にトリップID ${d.id} が重複`);
          dayTripIds.add(d.id);
          if (tripSeen.has(d.id) && tripSeen.get(d.id) !== key) add('error', key, 'deliveries.id', `トリップID ${d.id} が ${tripSeen.get(d.id)} にもある（重複）`);
          tripSeen.set(d.id, key);
        }
        if (num(d.tip) < 0) add('error', key, `deliveries[${i}].tip`, `チップがマイナス`);
        if (num(d.tip) > 0 && d.fee !== null && d.fee !== undefined && num(d.tip) > num(d.fee)) add('error', key, `deliveries[${i}].tip`, `チップ ¥${num(d.tip)} が配達の最終売上 ¥${num(d.fee)} より大きい`);
      });

      // 公式データの日: 件数・売上・距離が trip と一致すること
      const official = !!log.officialImport || trips.some(d => d && d.points !== undefined);
      if (official && trips.length && trips.every(d => d && d.fee !== null && d.fee !== undefined)) {
        const fees = trips.reduce((a, d) => a + num(d.fee), 0);
        const pts = trips.reduce((a, d) => a + num(d.points), 0);
        const km = round2(trips.reduce((a, d) => a + num(d.distanceKm), 0));
        if (s && s.delivery !== undefined && num(s.delivery) !== fees) add('error', key, 'sales.delivery', `配達報酬 ¥${num(s.delivery)} ≠ トリップの最終売上合計 ¥${fees}`);
        if (log.tripsCount !== undefined && log.tripsCount !== null && num(log.tripsCount) !== trips.length) add('error', key, 'tripsCount', `トリップ数 ${log.tripsCount} ≠ トリップ明細 ${trips.length}件`);
        if (pts > 0 && log.deliveriesCount !== undefined && log.deliveriesCount !== null && num(log.deliveriesCount) !== pts) {
          add(known.has(key) ? 'info' : 'error', key, 'deliveriesCount', `配達件数 ${log.deliveriesCount} ≠ トリップのポイント合計 ${pts}${known.has(key) ? '（既知の旧データ差異・変更しない）' : ''}`);
        }
        if (log.totalDistanceKm !== undefined && log.totalDistanceKm !== null && Math.abs(num(log.totalDistanceKm) - km) > 0.011 && !known.has(key)) {
          add('warn', key, 'totalDistanceKm', `配達距離 ${log.totalDistanceKm}km ≠ トリップ距離の合計 ${km}km`);
        }
      }

      // 経費（必要経費）: 1件1回・金額は正の数
      (Array.isArray(log.expenses) ? log.expenses : []).forEach((e, i) => {
        if (!e || typeof e !== 'object') { add('error', key, `expenses[${i}]`, '経費がオブジェクトではない'); return; }
        if (isBad(e.amount)) add('error', key, `expenses[${i}].amount`, `数値ではない金額: ${JSON.stringify(e.amount)}`);
        else if (num(e.amount) < 0) add('error', key, `expenses[${i}].amount`, `マイナスの経費 ¥${num(e.amount)}（集計に入らない）`);
        else if (num(e.amount) === 0) add('warn', key, `expenses[${i}].amount`, `0円の経費（集計に入らない）`);
        if (!e.id) add('warn', key, `expenses[${i}].id`, '経費にIDが無い（同期で重複・消失の判定ができない）');
        else {
          if (expenseSeen.has(e.id)) add('error', key, 'expenses.id', `経費ID ${e.id} が ${expenseSeen.get(e.id)} にもある（二重計上のおそれ）`);
          expenseSeen.set(e.id, key);
        }
        if (Array.isArray(log.deletedExpenseIds) && e.id && log.deletedExpenseIds.includes(e.id)) add('error', key, 'expenses', `削除済み（tombstone）の経費 ${e.id} が残っている`);
      });

      // 同期に使う更新時刻（読めない・遠い未来の時刻は新旧の判定を狂わせる）
      const badTime = v => v !== undefined && v !== null && (typeof v !== 'string' || isNaN(Date.parse(v)));
      const futureTime = v => typeof v === 'string' && !isNaN(Date.parse(v)) && opts.now && Date.parse(v) > Date.parse(opts.now) + 86400000;
      const timeChecks = [];
      (log.expenses || []).forEach((e, i) => { if (e) { timeChecks.push([`expenses[${i}].updatedAt`, e.updatedAt]); timeChecks.push([`expenses[${i}].createdAt`, e.createdAt]); } });
      Object.entries(log.manualUpdatedAt || {}).forEach(([f, v]) => timeChecks.push([`manualUpdatedAt.${f}`, v]));
      trips.forEach((d, i) => { if (d) { timeChecks.push([`deliveries[${i}].evaluationUpdatedAt`, d.evaluationUpdatedAt]); timeChecks.push([`deliveries[${i}].mapMemoUpdatedAt`, d.mapMemoUpdatedAt]); } });
      if (log.officialImport) timeChecks.push(['officialImport.importedAt', log.officialImport.importedAt]);
      timeChecks.forEach(([f, v]) => {
        if (badTime(v)) add('error', key, f, `同期の更新時刻が読めない（${JSON.stringify(v)}）`);
        else if (futureTime(v)) add('warn', key, f, `同期の更新時刻が未来（${v}。端末の時計がずれている可能性。新旧の判定で常に勝ってしまう）`);
      });

      // 天気（手動）
      if (log.weather !== undefined && log.weather !== null) {
        if (typeof log.weather !== 'object' || !['sunny', 'cloudy', 'rain', 'unknown'].includes(log.weather.type)) add('error', key, 'weather', `天気の値が不正: ${JSON.stringify(log.weather)}`);
        else if (log.weather.observedDate && log.weather.observedDate !== key) add('warn', key, 'weather.observedDate', `天気の日付（${log.weather.observedDate}）が日別データの日と違う`);
      }

      // 未来日
      if (today && key > today) {
        if (hasUberActivity(log) || (s && rawDayTotal(log) !== 0)) add('error', key, 'date', `未来日（今日 ${today} より後）に実績・売上がある`);
        else if ((log.expenses || []).some(e => num(e && e.amount) > 0)) add('warn', key, 'expenses', `未来日（今日 ${today} より後）に経費がある（今月・今週の集計には入らない）`);
      }
    });
    return out;
  }

  /**
   * 月ごとの生データ合計（store を使わない。端末の診断・監査の照合用）
   */
  function summarizeByMonth(dailyLogs) {
    const months = {};
    Object.keys(dailyLogs || {}).filter(isRealDate).sort().forEach(key => {
      const log = dailyLogs[key] || {};
      const m = key.slice(0, 7);
      const r = months[m] || (months[m] = { month: m, recordDays: 0, workedDays: 0, deliveries: 0, trips: 0, sales: 0, expenseCount: 0, expenses: 0, expenseByCategory: {}, otherSalesDays: 0, tipDays: 0, officialDays: 0, firstDate: key, lastDate: key });
      r.recordDays++;
      r.lastDate = key;
      const worked = hasUberActivity(log);
      if (worked) {
        r.workedDays++;
        const trips = Array.isArray(log.deliveries) ? log.deliveries : [];
        r.deliveries += (log.deliveriesCount !== undefined && log.deliveriesCount !== null) ? num(log.deliveriesCount) : trips.length;
        r.trips += (log.tripsCount !== undefined && log.tripsCount !== null) ? num(log.tripsCount) : trips.length;
      }
      r.sales += rawDayTotal(log);
      if (log.officialImport) r.officialDays++;
      if (log.sales && num(log.sales.other) !== 0) r.otherSalesDays++;
      if ((log.deliveries || []).some(d => num(d && d.tip) > 0) || (log.sales && num(log.sales.tip) > 0)) r.tipDays++;
      (Array.isArray(log.expenses) ? log.expenses : []).forEach(e => {
        const amt = num(e && e.amount);
        if (!(amt > 0)) return;
        const cat = String((e && e.category) || '').trim() || '（種類なし）';
        r.expenseCount++;
        r.expenses += amt;
        r.expenseByCategory[cat] = (r.expenseByCategory[cat] || 0) + amt;
      });
    });
    return Object.values(months);
  }

  // ------------------------------------------------------------
  // 移動手段（vehicleType）の正式な値と旧名称（DATA_MODEL.md §1）
  // 「レンタサイクル」「レンタバイク」は、同梱データの同じ記録（ドコモ・バイクシェア1日パス）を
  // 開発途中で「バイクシェア利用」へ改名する前の名前（b6733f9 → 11c0968 → 3cd9361）。
  // 保存されている値は書き換えず、比べるとき・表示するときだけ正式な値にそろえる。
  // 「自前自転車」「電動レンタル」「その他」は別の意味（同じ候補一覧に並んでいた別の選択肢）なので、そろえない。
  // ------------------------------------------------------------
  const VEHICLE_TYPE_CANONICAL = { BIKE_SHARE: 'バイクシェア利用' };
  const VEHICLE_TYPE_ALIASES = { 'レンタサイクル': 'バイクシェア利用', 'レンタバイク': 'バイクシェア利用', 'バイクシェア': 'バイクシェア利用' };
  function canonicalVehicleType(v) {
    if (v === undefined || v === null) return v;
    const s = String(v).trim();
    if (!s) return '';
    return VEHICLE_TYPE_ALIASES[s] || s;
  }
  const isLegacyVehicleType = v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(VEHICLE_TYPE_ALIASES, v.trim());
  // 手動の日別項目の値が同じか（vehicleType は旧名称をそろえて比べる）
  function sameManualValue(field, a, b) {
    const norm = v => (field === 'vehicleType' ? canonicalVehicleType(v) : v);
    const x = norm(a), y = norm(b);
    return JSON.stringify(x === undefined ? null : x) === JSON.stringify(y === undefined ? null : y);
  }

  // ------------------------------------------------------------
  // 1日の中身の分類（SYNC_MODEL.md「日数の意味」）
  //  - 存在する日: 日別データ（dailyLogs のキー）がある日。画面で日付を開いただけの空の日も含む
  //  - 中身のある日: 下のどれか1つでもある日。空の日: どれも無い日
  //  - 手動のデータ: 経費・削除記録・手動休み・天気・移動手段・評価/メモ・稼働時間・手入力の配達/売上（クラウドで共有する対象）
  //  - Uber 実績だけの日: 公式（同梱）データだけ。アプリに同梱されて各端末へ届くので、クラウドへ送る必要はない
  // ------------------------------------------------------------
  const CONTENT_LABELS = {
    uber: 'Uber実績', official: '公式取込', expense: '経費', tombstone: '経費の削除記録', dayOff: '手動休み', dayOn: '休みの解除',
    weather: '手動の天気', vehicle: '移動手段', notes: '評価・メモ', sessions: '稼働時間', taps: '手入力の配達', archive: '手入力の退避記録', sales: '売上の手入力'
  };
  const MANUAL_CONTENT = ['expense', 'tombstone', 'dayOff', 'dayOn', 'weather', 'vehicle', 'notes', 'sessions', 'taps', 'archive', 'sales'];
  const isOfficialTrip = d => d && ((d.restaurant && String(d.restaurant).trim()) || (d.fee !== null && d.fee !== undefined));
  const hasTripNote = d => d && ((d.evaluation !== undefined && d.evaluation !== null) || (d.evaluationReason && String(d.evaluationReason).trim()) || (d.mapMemo && String(d.mapMemo).trim()));
  function dayContents(log) {
    const keys = [];
    const counts = {};
    if (!log || typeof log !== 'object') return { keys, counts, meaningful: false, manual: false, empty: true, uberOnly: false };
    const trips = Array.isArray(log.deliveries) ? log.deliveries : [];
    const uber = hasUberActivity(log);
    if (uber) keys.push('uber');
    if (log.officialImport) keys.push('official');
    const exps = (Array.isArray(log.expenses) ? log.expenses : []).filter(e => e && typeof e === 'object');
    if (exps.length) { keys.push('expense'); counts.expense = exps.length; }
    if (Array.isArray(log.deletedExpenseIds) && log.deletedExpenseIds.length) { keys.push('tombstone'); counts.tombstone = log.deletedExpenseIds.length; }
    const mu = log.manualUpdatedAt || {};
    if (log.dayOff === true) keys.push('dayOff');
    else if (log.dayOff === false && mu.dayOff) keys.push('dayOn');
    if (log.weather && typeof log.weather === 'object' && log.weather.type) keys.push('weather');
    if (log.vehicleType) keys.push('vehicle');
    const notes = trips.filter(hasTripNote).length;
    if (notes) { keys.push('notes'); counts.notes = notes; }
    if ((Array.isArray(log.workSessions) && log.workSessions.length) || log.workStartedAt) keys.push('sessions');
    const taps = trips.filter(d => d && !isOfficialTrip(d)).length;
    if (taps) { keys.push('taps'); counts.taps = taps; }
    if (Array.isArray(log.manualTapsArchive) && log.manualTapsArchive.length) keys.push('archive');
    if (!uber && !log.officialImport && rawDayTotal(log) !== 0) keys.push('sales');
    const manual = keys.some(k => MANUAL_CONTENT.includes(k));
    return { keys, counts, meaningful: keys.length > 0, manual, empty: keys.length === 0, uberOnly: (uber || !!log.officialImport) && !manual };
  }
  function describeContents(c) {
    if (!c || c.empty) return '空（中身なし）';
    return c.keys.filter(k => !(k === 'official' && c.keys.includes('uber'))).map(k => {
      const label = k === 'uber' && c.keys.includes('official') ? 'Uber実績（公式取込）' : CONTENT_LABELS[k];
      return c.counts[k] ? `${label} ${c.counts[k]}件` : label;
    }).join('・');
  }

  // 端末とクラウドの比較に使う、1日の要約（大きな JSON をそのまま比べない・表示しない）
  const shortHash = s => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  function daySignature(log) {
    if (!log || typeof log !== 'object') return null;
    const trips = Array.isArray(log.deliveries) ? log.deliveries : [];
    const mu = log.manualUpdatedAt || {};
    return {
      oi: (log.officialImport && log.officialImport.importedAt) || null,
      trips: trips.filter(isOfficialTrip).length,
      cnt: (log.deliveriesCount === undefined || log.deliveriesCount === null) ? null : num(log.deliveriesCount),
      total: rawDayTotal(log),
      exp: (Array.isArray(log.expenses) ? log.expenses : []).filter(e => e && typeof e === 'object').map(e => `${e.id || 'noid'}:${num(e.amount)}:${shortHash(`${e.category || ''}|${e.memo || ''}`)}`).sort(),
      tomb: (Array.isArray(log.deletedExpenseIds) ? log.deletedExpenseIds : []).slice().sort(),
      off: (log.dayOff === undefined || log.dayOff === null) ? null : (log.dayOff === false && !mu.dayOff ? null : !!log.dayOff),
      w: (log.weather && log.weather.type) || null,
      veh: canonicalVehicleType(log.vehicleType) || null,
      notes: trips.filter(hasTripNote).map(d => `${d.id}:${shortHash(`${d.evaluation || ''}|${d.evaluationReason || ''}|${d.mapMemo || ''}`)}`).sort(),
      ses: (Array.isArray(log.workSessions) ? log.workSessions : []).map(s => `${s && s.id}:${(s && s.start) || ''}-${(s && s.end) || ''}`).sort(),
      taps: trips.filter(d => d && !isOfficialTrip(d)).length
    };
  }
  const SIGNATURE_FIELDS = [
    { key: 'oi', label: '公式取込の時刻', kind: 'official' },
    { key: 'trips', label: 'トリップ数', kind: 'official' },
    { key: 'cnt', label: '配達件数', kind: 'official' },
    { key: 'total', label: '総売上', kind: 'official' },
    { key: 'exp', label: '経費', kind: 'manual' },
    { key: 'tomb', label: '経費の削除記録', kind: 'manual' },
    { key: 'off', label: '手動休み', kind: 'manual', field: 'dayOff' },
    { key: 'w', label: '手動の天気', kind: 'manual', field: 'weather' },
    { key: 'veh', label: '移動手段', kind: 'manual', field: 'vehicleType' },
    { key: 'notes', label: '評価・メモ', kind: 'manual' },
    { key: 'ses', label: '稼働時間', kind: 'manual' },
    { key: 'taps', label: '手入力の配達', kind: 'manual' }
  ];
  function compareSignatures(l, c) {
    if (!l || !c) return [];
    return SIGNATURE_FIELDS.filter(f => JSON.stringify(l[f.key] === undefined ? null : l[f.key]) !== JSON.stringify(c[f.key] === undefined ? null : c[f.key]))
      .map(f => ({ key: f.key, label: f.label, kind: f.kind, field: f.field || null }));
  }

  /**
   * 端末とクラウドの日付の差分（diag.html・監査スクリプト）
   * @param {object} localLogs 端末の dailyLogs
   * @param {object|null} cloudIndex クラウドの要約（cloud-sync.js が最終受信時に保存: { at, days: { 日付: daySignature } }）
   * @param {{pendingDates?: string[], conflicts?: object[]}} opts
   * 判定（status）:
   *  - 端末だけの日: empty（空の日・送らない）/ official（Uber 実績だけ・同梱データ・送らない）/ pending（未送信・自動で送る）/ unsent（手動のデータがクラウドに無い＝送信漏れ。次の同期で送る）
   *  - 違う日の項目: official-local-newer（端末の公式データが新しい・問題なし）/ official-cloud-newer / official（公式の値の差）/ conflict / pending / unsent
   */
  function diffLocalCloud(localLogs, cloudIndex, opts = {}) {
    const logs = localLogs || {};
    const cloudDays = (cloudIndex && cloudIndex.days) || null;
    const pending = new Set(opts.pendingDates || []);
    const conflictKeys = new Set((opts.conflicts || []).map(x => `${x.date}|${x.field}`));
    const localDates = Object.keys(logs).filter(isRealDate).sort();
    const counts = { total: localDates.length, meaningful: 0, empty: 0, manual: 0, uberOnly: 0 };
    localDates.forEach(d => { const c = dayContents(logs[d]); if (c.empty) counts.empty++; else counts.meaningful++; if (c.manual) counts.manual++; if (c.uberOnly) counts.uberOnly++; });
    const result = { available: !!cloudDays, local: counts, cloudCount: cloudDays ? Object.keys(cloudDays).length : null, localOnly: [], cloudOnly: [], different: [], same: 0, problems: 0 };
    if (!cloudDays) return result;
    localDates.forEach(d => {
      const log = logs[d];
      const c = dayContents(log);
      if (!cloudDays[d]) {
        const status = c.empty ? 'empty' : (!c.manual ? 'official' : (pending.has(d) ? 'pending' : 'unsent'));
        if (status === 'unsent') result.problems++;
        result.localOnly.push({ date: d, contents: describeContents(c), keys: c.keys, status });
        return;
      }
      const diffs = compareSignatures(daySignature(log), cloudDays[d]).map(f => {
        let status;
        if (f.kind === 'official') {
          const lo = (log.officialImport && log.officialImport.importedAt) || null;
          const co = cloudDays[d].oi || null;
          status = lo && (!co || lo > co) ? 'official-local-newer' : (co && (!lo || co > lo) ? 'official-cloud-newer' : 'official');
        } else if (f.field && conflictKeys.has(`${d}|${f.field}`)) status = 'conflict';
        else if (f.key === 'notes' && [...conflictKeys].some(k => k.startsWith(`${d}|trip `))) status = 'conflict';
        else status = pending.has(d) ? 'pending' : 'unsent';
        if (status === 'unsent') result.problems++;
        return { ...f, status };
      });
      if (diffs.length) result.different.push({ date: d, fields: diffs });
      else result.same++;
    });
    Object.keys(cloudDays).filter(isRealDate).sort().forEach(d => { if (!logs[d]) result.cloudOnly.push({ date: d }); });
    return result;
  }

  // ------------------------------------------------------------
  // 競合の説明（diag.html の競合カード・アプリのヘッダー）。値は人が読める言葉にする
  // important: 集計（稼働 / 休みの日数）に影響する項目。売上・件数・経費は競合にならない（公式は新しい取込・経費は ID 単位で統合）
  // ------------------------------------------------------------
  const WEATHER_LABELS = { sunny: '晴', cloudy: '曇', rain: '雨', unknown: '不明' };
  function describeConflict(c) {
    const field = String((c && c.field) || '');
    const none = '（未設定）';
    const trip = /^trip (\S+) (.+)$/.exec(field);
    let title, impact, important = false, fmt;
    if (field === 'vehicleType') {
      title = '移動手段'; impact = '表示だけの項目です。売上・件数・経費には影響しません';
      fmt = v => (v === null || v === undefined || v === '') ? none : (isLegacyVehicleType(v) ? `${v}（旧名称。= ${canonicalVehicleType(v)}）` : String(v));
    } else if (field === 'dayOff') {
      title = '手動休み'; impact = '「稼働 / 休み」の日数に影響します。売上・件数・経費には影響しません'; important = true;
      fmt = v => v === true ? '休み' : (v === false ? '休みではない' : none);
    } else if (field === 'weather') {
      title = '天気（手動）'; impact = '表示だけの項目です。売上・件数・経費には影響しません';
      fmt = v => (v && typeof v === 'object' && v.type) ? (WEATHER_LABELS[v.type] || v.type) + (v.raw && v.raw !== WEATHER_LABELS[v.type] ? `（${v.raw}）` : '') : none;
    } else if (trip && /評価/.test(trip[2])) {
      title = `○×評価・理由（${trip[1]}）`; impact = '評価のメモです。売上・件数・経費には影響しません';
      fmt = v => {
        if (!Array.isArray(v)) return none;
        const e = v[0] === 'OK' ? '○' : (v[0] === 'AVOID' ? '×' : '評価なし');
        return v[1] ? `${e}・理由「${v[1]}」` : e;
      };
    } else if (trip) {
      title = `MAP一口メモ（${trip[1]}）`; impact = 'メモです。売上・件数・経費には影響しません';
      fmt = v => (Array.isArray(v) && v[0]) ? `「${v[0]}」` : none;
    } else {
      title = field || '（不明な項目）'; impact = '内容を確認してください';
      fmt = v => (v === null || v === undefined) ? none : JSON.stringify(v);
    }
    return { title, impact, important, local: fmt(c && c.local), cloud: fmt(c && c.cloud) };
  }

  const api = {
    describeConflict,
    checkDailyLogs, summarizeByMonth, hasUberActivity, rawDayTotal, isRealDate,
    VEHICLE_TYPE_CANONICAL, VEHICLE_TYPE_ALIASES, canonicalVehicleType, isLegacyVehicleType, sameManualValue,
    CONTENT_LABELS, dayContents, describeContents, daySignature, compareSignatures, diffLocalCloud
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UberLogDiagnostics = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
