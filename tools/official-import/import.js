#!/usr/bin/env node
/**
 * UBER_LOG 公式取込 v1 — コマンドライン
 *
 *   node tools/official-import/import.js prepare  2026-09-23   一覧解析＋スクショ読取テンプレート作成
 *   node tools/official-import/import.js validate 2026-09-23   照合・MAP切り抜き・検証（反映しない）
 *   node tools/official-import/import.js apply    2026-09-23   検証PASS時のみ UBER_LOG へ反映
 *   node tools/official-import/import.js report   2026-09-23   反映後の日次・週次・月次・クエスト進捗
 *   node tools/official-import/import.js test                  自動テスト
 *
 * 通常は Claude Code で「/uber-import 2026-09-23」を実行すれば、この順に自動で進む。
 */
'use strict';

const path = require('path');
const pipeline = require('./lib/pipeline.js');

const ROOT = path.resolve(__dirname, '..', '..');
const { yen, formatHms } = pipeline;

function printChecks(staging) {
  staging.validation.checks.forEach(c => {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `\n       ${c.detail.split('\n').join('\n       ')}` : ''}`);
  });
  if (staging.validation.warnings.length) {
    console.log('\n  注意:');
    staging.validation.warnings.forEach(w => console.log(`   - ${w}`));
  }
}

function printSummary(date, s, status) {
  const [y, m, d] = date.split('-');
  console.log(`\n${y}/${m}/${d} 公式取込`);
  console.log(`Delivery:    ${s.trips} trip`);
  console.log(`配達:        ${s.deliveriesCount}件`);
  console.log(`配達報酬:    ${yen(s.deliverySales)}`);
  console.log(`Quest:       ${yen(s.questSales)}`);
  console.log(`Adjustment:  ${yen(s.adjustmentSales)}`);
  if (s.otherSales) console.log(`その他:      ${yen(s.otherSales)}`);
  console.log(`総売上:      ${yen(s.totalSales)}`);
  console.log(`距離:        ${s.distanceKm.toFixed(2)}km`);
  console.log(`配達時間:    ${s.durationText}`);
  console.log(`MAP:         ${s.maps}`);
  console.log(`VALIDATION:  ${status}`);
}

function main() {
  const [cmd, date] = process.argv.slice(2);
  switch (cmd) {
    case 'prepare': {
      const r = pipeline.prepare(ROOT, date);
      const s = r.summary;
      console.log(`■ ${date} 取込準備`);
      console.log(`  一覧: Delivery ${s.delivery} / クエスト ${s.quest} / 調整 ${s.adjustment} / 未分類 ${s.unknown} / 他日付 ${s.otherDates}`);
      console.log(`  一覧合計: 配達報酬 ${yen(s.deliverySales)} / クエスト（重複排除後） ${yen(s.questSales)} / 調整 ${yen(s.adjustmentSales)}`);
      if (s.duplicateCandidates) console.log(`  ⚠ クエスト重複候補 ${s.duplicateCandidates} 件（validate で詳細）`);
      if (r.parsed.warnings.length) r.parsed.warnings.forEach(w => console.log(`  ⚠ ${w}`));
      console.log(`  スクショ: ${r.files.length} 枚  → ${path.relative(ROOT, r.paths.screenshotDir)}`);
      console.log(`  読取結果ファイル: ${path.relative(ROOT, r.paths.screensFile)}`);
      if (r.removed.length) console.log(`  ⚠ フォルダから消えた画像の読取結果: ${r.removed.join(', ')}`);
      if (r.pending.length) {
        console.log(`\n  未記入（UNKNOWN）のスクショ ${r.pending.length} 枚:`);
        r.pending.forEach(f => console.log(`   - ${path.join(path.relative(ROOT, r.paths.screenshotDir), f)}`));
      } else {
        console.log('\n  全スクショ記入済み → validate へ');
      }
      break;
    }
    case 'validate':
    case 'apply': {
      const r = cmd === 'apply' ? pipeline.apply(ROOT, date) : { staging: pipeline.buildStaging(ROOT, date) };
      const st = r.staging;
      console.log(`■ ${date} 検証（staging: ${path.relative(ROOT, pipeline.getPaths(ROOT, date).stagingFile)}）`);
      printChecks(st);
      if (st.summary && st.summary.trips !== undefined) printSummary(date, st.summary, st.validation.status);
      if (st.validation.status !== 'PASS') {
        console.log('\n⛔ 検証FAIL: UBER_LOG には反映していません。上の ❌ の項目を確認してください。');
        process.exitCode = 1;
        break;
      }
      if (cmd === 'validate') {
        console.log(`\n反映内容: ${st.plan.isNewDay ? '新規日を追加' : st.plan.changed ? '既存日を照合・補完' : '変更なし（取込済み）'}`);
        break;
      }
      if (r.unchanged) {
        console.log('\n✔ 既に取込済みで変更はありません（二重登録なし）。');
      } else {
        console.log(`\n✔ UBER_LOG へ反映しました（js/store.js・js/trip-maps.js${r.addedMaps.length ? `・assets/maps ${r.addedMaps.length}件` : ''}）`);
        if (r.version) console.log(`  バージョン: ${r.version.from} → ${r.version.to}`);
      }
      break;
    }
    case 'report': {
      const r = pipeline.report(ROOT, date);
      const d = r.day;
      console.log(`■ ${date} 日次: ${d.trips}trip / ${d.count}件 / 配達報酬 ${yen(d.delivery)} / クエスト ${yen(d.quest)} / 調整 ${yen(d.adjustment)} / 総売上 ${yen(d.total)} / 距離 ${d.distance}km / 配達時間 ${formatHms(d.seconds || 0)} / MAP ${d.maps}/${d.trips}`);
      console.log(`  （経費はアプリの稼働画面で入力。アプリ同梱データ上の経費: ${yen(d.expenses)} → 利益 ${yen(d.profit)}）`);
      const w = r.week;
      console.log(`■ 今週 ${w.periodLabel}: 売上 ${yen(w.officialSales)}（配達報酬 ${yen(w.deliverySales)} / クエスト ${yen(w.questSales)} / 特別 ${yen(w.guaranteeBonus)} / その他 ${yen(w.otherSales)}） / Bike ${yen(w.bikeExpenses)} / 売上利益 ${yen(w.salesProfit)} / ${w.deliveriesCount}件`);
      const m = r.month;
      const a = r.analytics;
      console.log(`■ 今月 ${m.periodLabel}: 売上 ${yen(m.sales)} / Bike ${yen(m.bikeExpenses)} / 必要経費 ${yen(m.otherExpenses)} / 売上利益 ${yen(m.salesProfit)} / ${m.deliveriesCount}件 / ${r.monthTrips}trip`);
      console.log(`  通常分析売上 ${yen(a.regular)} / 稼働 ${a.days}日 / 平均日給 ${yen(a.avgDaily)} / 平均単価 ${yen(a.avgPer)} / 平均時給 ${yen(a.avgHourly)} / 配達時間 ${formatHms(a.seconds)} / 距離 ${a.distance}km`);
      console.log(`■ ${r.quest.title}: ${r.quest.current}/${r.quest.target}（残 ${r.quest.remaining}）`);
      console.log(`■ MAP: ${r.maps.mapped}/${r.maps.total}`);
      console.log('  ※ 週次・月次のBike/必要経費はアプリ同梱データ分のみ（端末で入力した経費はこの集計に含まれません）');
      break;
    }
    case 'test': {
      require('./spec/run-tests.js');
      break;
    }
    default:
      console.log('使い方: node tools/official-import/import.js <prepare|validate|apply|report> YYYY-MM-DD\n       node tools/official-import/import.js test');
      process.exitCode = 2;
  }
}

try {
  main();
} catch (e) {
  console.error(`⛔ ${e.message}`);
  process.exitCode = 1;
}
