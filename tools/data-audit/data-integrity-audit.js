#!/usr/bin/env node
/**
 * UBER_LOG データ整合性監査（開発用・読み取り専用・外部送信なし）
 *
 *   node tools/data-audit/data-integrity-audit.js                       … 同梱データ（js/store.js のシード）を監査
 *   node tools/data-audit/data-integrity-audit.js --file backup.json    … アプリの「バックアップ書き出し」JSON（端末データ）を監査
 *   node tools/data-audit/data-integrity-audit.js --today 2026-10-13    … 基準日（省略時は日本時間の今日）
 *   node tools/data-audit/data-integrity-audit.js --json                … 結果を JSON で出力
 *
 * 調べること（DATA_MODEL.md の不変条件）
 *  1. 保存データ: 日付・数値（NaN/Infinity/文字列）・保存された総売上と内訳・調整の符号・トリップID/経費IDの重複・
 *     マイナス経費・チップ・未来日・公式日の件数/売上/距離（js/data-diagnostics.js の checkDailyLogs）
 *  2. 集計: 月・週（月〜日）・全期間について、日別（getCalculatedMetrics）を直接合計した値 ＝ aggregateForRange、
 *     生データの月合計（summarizeByMonth）＝ aggregateForRange、売上内訳の合計 ＝ 総売上、利益 ＝ 総売上 − 必要経費
 *  3. 画面の集計: 今月（月初〜今日）・今週（月曜〜今日）・先週 ＝ 直接合計（未来日・期間外が混ざらない）
 * 1件でも error / 不一致があれば exit 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FILE = opt('--file');
const AS_JSON = args.includes('--json');

// 既知の旧データ差異（変更しない。理由は HANDOFF.md / DATA_MODEL.md）
const KNOWN_LEGACY = {
  '2026-09-14': '配達件数 4 / ポイント合計 5（確定済みの旧データ。「配達件数＝ポイント合計」は v21 以降と公式取込日に適用）',
  '2026-09-16': '配達件数 8 / ポイント合計 10（同上）',
  '2026-09-19': '配達距離 70.18km / トリップ距離合計 70.22km（旧記載の端数。月間距離の旧記載 358.23km / 内部合算 358.24km）'
};

function loadStore(dataJson) {
  const map = {};
  if (dataJson) map.uber_log_v1_data = JSON.stringify(dataJson);
  global.localStorage = { getItem: k => (k in map ? map[k] : null), setItem: (k, v) => { map[k] = String(v); }, removeItem: k => { delete map[k]; } };
  global.window = { localStorage: global.localStorage };
  const mod = require(path.join(ROOT, 'js', 'store.js'));
  return mod;
}

function readBackup(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // store.exportJSON() の形（{version, dailyLogs, ...}）、または { data: {...} } / dailyLogs だけの形
  const state = raw && raw.dailyLogs ? raw : (raw && raw.data && raw.data.dailyLogs ? raw.data : (raw && typeof raw === 'object' ? { dailyLogs: raw } : null));
  if (!state || !state.dailyLogs) throw new Error('バックアップ JSON に dailyLogs が見つかりません: ' + file);
  return state;
}

function main() {
  const backup = FILE ? readBackup(FILE) : null;
  const { store, getTodayDateString, getWeekRange, getPreviousWeekRange } = loadStore(backup);
  const D = require(path.join(ROOT, 'js', 'data-diagnostics.js'));
  const today = opt('--today') || getTodayDateString();
  const logs = store.state.dailyLogs;
  const problems = D.checkDailyLogs(logs, { today, knownLegacyCountDates: Object.keys(KNOWN_LEGACY) });
  const mismatches = [];
  const eq = (label, a, b) => { if (!(a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005))) mismatches.push(`${label}: 集計 ${JSON.stringify(a)} ≠ 直接合計 ${JSON.stringify(b)}`); };

  // 日別を直接合計（集計関数を使わない）
  const direct = (start, end) => {
    const r = { totalSales: 0, expenses: 0, deliveriesCount: 0, tripsCount: 0, workedDays: 0, workSeconds: 0, distanceKm: 0, regularSales: 0, parts: 0 };
    store.getAllDailyLogs().filter(l => (!start || l.date >= start) && (!end || l.date <= end)).forEach(l => {
      const m = store.getCalculatedMetrics(l);
      r.totalSales += m.totalSales || 0;
      r.expenses += m.totalExpenses || 0;
      r.parts += (m.baseDeliverySales || 0) + ((m.questSales || 0) - (m.specialQuestSales || 0)) + ((m.guaranteeBonus || 0) + (m.specialQuestSales || 0)) + (m.tipSales || 0) + (m.adjustmentSales || 0) + (m.otherSales || 0);
      if (store.isWorkedDay(l)) {
        r.workedDays++; r.deliveriesCount += m.count; r.tripsCount += m.tripsCount || 0;
        r.workSeconds += m.workSeconds || 0; r.distanceKm += m.totalDistanceKm || 0; r.regularSales += m.regularSales || 0;
      }
    });
    r.distanceKm = Number(r.distanceKm.toFixed(2));
    return r;
  };
  const compare = (label, a, d) => {
    ['totalSales', 'expenses', 'deliveriesCount', 'tripsCount', 'workedDays', 'workSeconds', 'distanceKm', 'regularSales'].forEach(k => eq(`${label} ${k}`, a[k], d[k]));
    eq(`${label} 利益`, a.profit, d.totalSales - d.expenses);
    eq(`${label} 内訳の合計`, a.baseDeliverySales + a.questSales + a.guaranteeBonus + a.tipSales + a.adjustmentSales + a.otherSales, a.totalSales);
    eq(`${label} 内訳（日別の直接合計）`, d.parts, d.totalSales);
  };

  // 月・週・全期間
  const dates = Object.keys(logs).filter(D.isRealDate).sort();
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const rawMonths = Object.fromEntries(D.summarizeByMonth(logs).map(r => [r.month, r]));
  const monthRows = months.map(m => {
    const end = `${m}-31`;
    const a = store.aggregateForRange(`${m}-01`, end);
    compare(`月 ${m}`, a, direct(`${m}-01`, end));
    const raw = rawMonths[m];
    if (raw) {
      eq(`月 ${m} 総売上（生データ）`, a.totalSales, raw.sales);
      eq(`月 ${m} 必要経費（生データ）`, a.expenses, raw.expenses);
      eq(`月 ${m} 配達件数（生データ）`, a.deliveriesCount, raw.deliveries);
      eq(`月 ${m} トリップ数（生データ）`, a.tripsCount, raw.trips);
      eq(`月 ${m} 稼働日数（生データ）`, a.workedDays, raw.workedDays);
    }
    return { month: m, sales: a.totalSales, expenses: a.expenses, expenseCount: a.expenseCount, profit: a.profit, deliveries: a.deliveriesCount, trips: a.tripsCount, workedDays: a.workedDays,
      duration: a.durationHHMM, distanceKm: a.distanceKm, avgDaily: a.avgDailyEarnings, avgPer: a.avgPerDelivery, expenseByCategory: a.expenseByCategory };
  });
  const weekStarts = [...new Set(dates.map(d => getWeekRange(d).startStr))];
  weekStarts.forEach(ws => {
    const wr = getWeekRange(ws);
    compare(`週 ${wr.startStr}〜${wr.endStr}`, store.aggregateForRange(wr.startStr, wr.endStr), direct(wr.startStr, wr.endStr));
  });
  const all = store.aggregateForRange(null, null);
  compare('全期間', all, direct(null, null));

  // 画面の集計（今月・今週・先週）
  const rev = store.getRevenueSummary(today);
  const mStart = `${today.slice(0, 7)}-01`;
  const dm = direct(mStart, today);
  eq('今月 総売上', rev.thisMonth.sales, dm.totalSales);
  eq('今月 必要経費', rev.thisMonth.expenses, dm.expenses);
  eq('今月 利益', rev.thisMonth.salesProfit, dm.totalSales - dm.expenses);
  eq('今月 配達件数', rev.thisMonth.deliveriesCount, dm.deliveriesCount);
  eq('今月 稼働日数', rev.thisMonth.workedDays, dm.workedDays);
  eq('今月 配達時間', rev.thisMonth.workSeconds, dm.workSeconds);
  eq('今月 配達距離', rev.thisMonth.distanceKm, dm.distanceKm);
  eq('今月 平均日給', rev.thisMonth.avgDailyEarnings, dm.workedDays ? Math.round(dm.regularSales / dm.workedDays) : null);
  eq('今月 平均単価', rev.thisMonth.avgPerDelivery, dm.deliveriesCount ? Math.round(dm.regularSales / dm.deliveriesCount) : null);
  eq('今月 経過日数', rev.thisMonth.elapsedDays, Number(today.slice(8, 10)));
  const wr = getWeekRange(today);
  const dw = direct(wr.startStr, today);
  eq('今週 総売上', rev.thisWeek.officialSales, dw.totalSales);
  eq('今週 必要経費', rev.thisWeek.expenses, dw.expenses);
  eq('今週 利益', rev.thisWeek.salesProfit, dw.totalSales - dw.expenses);
  eq('今週 配達件数', rev.thisWeek.deliveriesCount, dw.deliveriesCount);
  const pr = getPreviousWeekRange(today);
  const dp = direct(pr.startStr, pr.endStr);
  eq('先週 売上利益', rev.thisWeek.prevWeek.salesProfit, dp.totalSales - dp.expenses);
  if (rev.thisWeek.prevWeekComparison.hasComparison) eq('先週比', rev.thisWeek.prevWeekComparison.diffAmount, (dw.totalSales - dw.expenses) - (dp.totalSales - dp.expenses));

  const errors = problems.filter(p => p.level === 'error');
  const result = {
    source: FILE ? `バックアップ ${path.basename(FILE)}（端末データ＋アプリが起動時に補う同梱データ）` : '同梱データ（js/store.js のシード）',
    today, days: dates.length, range: dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : '--',
    months: monthRows,
    thisMonth: { range: `${mStart}〜${today}`, sales: rev.thisMonth.sales, expenses: rev.thisMonth.expenses, profit: rev.thisMonth.salesProfit, deliveries: rev.thisMonth.deliveriesCount, workedDays: `${rev.thisMonth.workedDays} / ${rev.thisMonth.elapsedDays}日`, duration: rev.thisMonth.durationHHMM, distanceKm: rev.thisMonth.distanceKm, avgDaily: rev.thisMonth.avgDailyEarnings, avgPer: rev.thisMonth.avgPerDelivery },
    thisWeek: { range: `${wr.startStr}〜${today}`, sales: rev.thisWeek.officialSales, expenses: rev.thisWeek.expenses, profit: rev.thisWeek.salesProfit, deliveries: rev.thisWeek.deliveriesCount, prevWeekProfit: rev.thisWeek.prevWeek.salesProfit },
    problems, knownLegacy: KNOWN_LEGACY, mismatches,
    ok: errors.length === 0 && mismatches.length === 0
  };

  if (AS_JSON) { console.log(JSON.stringify(result, null, 1)); process.exit(result.ok ? 0 : 1); }
  const yen = n => (n === null || n === undefined) ? '--' : `¥${Number(n).toLocaleString()}`;
  console.log('=== UBER_LOG データ整合性監査 ===');
  console.log(`対象: ${result.source} / 基準日 ${today} / ${result.days}日（${result.range}）`);
  console.log('\n[月別]（必要経費 = 登録済み経費を1件1回ずつ・利益 = 総売上 − 必要経費・平均は通常売上）');
  monthRows.forEach(r => console.log(`  ${r.month}: 総売上 ${yen(r.sales)} / 必要経費 ${yen(r.expenses)}（${r.expenseCount}件 ${Object.entries(r.expenseByCategory).map(([k, v]) => `${k} ${yen(v)}`).join('・') || 'なし'}）/ 利益 ${yen(r.profit)} / ${r.deliveries}件・${r.trips}trip / 稼働 ${r.workedDays}日 / ${r.duration} / ${r.distanceKm}km / 平均日給 ${yen(r.avgDaily)} / 平均単価 ${yen(r.avgPer)}`));
  const tm = result.thisMonth;
  console.log(`\n[今月 ${tm.range}] 総売上 ${yen(tm.sales)} / 必要経費 ${yen(tm.expenses)} / 利益 ${yen(tm.profit)} / ${tm.deliveries}件 / 稼働日数 ${tm.workedDays} / ${tm.duration} / ${tm.distanceKm}km / 平均日給 ${yen(tm.avgDaily)} / 平均単価 ${yen(tm.avgPer)}`);
  const tw = result.thisWeek;
  console.log(`[今週 ${tw.range}] 総売上 ${yen(tw.sales)} / 必要経費 ${yen(tw.expenses)} / 利益 ${yen(tw.profit)} / ${tw.deliveries}件 / 先週の売上利益 ${yen(tw.prevWeekProfit)}`);
  console.log('\n[保存データのチェック]');
  if (!problems.length) console.log('  問題なし');
  problems.forEach(p => console.log(`  ${p.level === 'error' ? 'ERROR' : p.level === 'warn' ? 'WARN ' : 'INFO '} ${p.date} ${p.field}: ${p.message}`));
  console.log('\n[集計の照合]（月・週・全期間・今月・今週・先週: 集計 ＝ 日別の直接合計 ＝ 生データ）');
  if (!mismatches.length) console.log(`  すべて一致（月 ${months.length}・週 ${weekStarts.length}・全期間・今月・今週・先週）`);
  mismatches.forEach(m => console.log('  NG ' + m));
  console.log(`\n${result.ok ? 'OK 不整合なし' : `NG error ${errors.length}件 / 集計の不一致 ${mismatches.length}件`}`);
  process.exit(result.ok ? 0 : 1);
}

main();
