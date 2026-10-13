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

  const api = { checkDailyLogs, summarizeByMonth, hasUberActivity, rawDayTotal, isRealDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UberLogDiagnostics = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
