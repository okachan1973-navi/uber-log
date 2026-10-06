#!/usr/bin/env node
/**
 * 公開前の全テスト（公式取込・履歴・配達マップ・ルート判断・DROP照合・同期・データ整合性）
 *
 *   node tools/release-check/run-all.js                   … 全テスト（画面テストを含む。Edge が必要・数分かかる）
 *   node tools/release-check/run-all.js --quick           … 画面テスト（E2E）を除く
 *   node tools/release-check/run-all.js --rebuild-stores  … 先に配達マップの店舗マスタを再生成（data/uber_pickup_stores.* を書き換える）
 *
 * 1件でも「予期しない失敗」があれば exit 1。公開（commit・push）はこの結果が 0 のときだけ行う。
 * 既知の例外は KNOWN_EXCEPTIONS に理由・条件つきで明示する（条件が成り立つときだけ既知扱い。テスト自体は弱めない）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const NODE = process.execPath;
const PY = process.env.PYTHON || 'python';
const EXCEL = path.join(os.homedir(), 'Desktop', '大阪市_タワマン一覧_Uber配達用.xlsx');

const SUITES = [
  { name: '公式取込（集計・整合性）', cmd: [NODE, 'tools/official-import/spec/run-tests.js'] },
  { name: '端末・クラウド同期（経費）', cmd: [NODE, 'tools/official-import/spec/sync-tests.js'] },
  { name: '取込サーバー', cmd: [NODE, 'tools/official-import/spec/server-tests.js'] },
  { name: '過去日の編集の同期', cmd: [NODE, 'spec/past-date-sync-tests.js'] },
  { name: '目標クエスト', cmd: [NODE, 'spec/target-quest-tests.js'] },
  { name: 'DROP照合 単体', cmd: [NODE, 'tools/drop-check/spec/drop-check-tests.js'] },
  { name: 'DROP照合 バックアップ', cmd: [NODE, 'tools/drop-check/spec/drop-backup-tests.js'] },
  { name: 'DROP照合 データと Excel の一致', cmd: [PY, 'tools/drop-check/import_excel.py', '--check'] },
  { name: '配達マップ 単体', cmd: [NODE, 'tools/pickup-map/spec/pickup-map-tests.js'] },
  { name: '配達マップ 店舗マスタが最新', cmd: [NODE, 'tools/pickup-map/build-stores.js', '--check'] },
  { name: 'ルート判断 単体', cmd: [NODE, 'tools/route-judge/spec/route-judge-tests.js'] },
  { name: 'ルート判断 地理データが最新', cmd: [NODE, 'tools/route-judge/build-geo.js', '--check'] },
  { name: '履歴 画面', cmd: [NODE, 'tools/history/spec/history-e2e.js'], e2e: true },
  { name: 'DROP照合 画面', cmd: [NODE, 'tools/drop-check/spec/drop-check-e2e.js'], e2e: true },
  { name: '配達マップ 画面', cmd: [NODE, 'tools/pickup-map/spec/pickup-map-e2e.js'], e2e: true },
  { name: 'ルート判断 画面', cmd: [NODE, 'tools/route-judge/spec/route-judge-e2e.js'], e2e: true }
];

// 既知の例外（理由と、既知とみなす条件）。条件が成り立たない（例: Excel が戻った）ときは通常の失敗として扱う
const KNOWN_EXCEPTIONS = [
  {
    suite: 'DROP照合 単体',
    match: /Excel再取込で本人データが消えない/,
    when: () => !fs.existsSync(EXCEL),
    reason: `Excel 原本（${EXCEL}）が無い（2026-10-06 本人判断で保留）`
  },
  {
    suite: 'DROP照合 データと Excel の一致',
    match: /Excel が見つかりません/,
    when: () => !fs.existsSync(EXCEL),
    reason: `Excel 原本（${EXCEL}）が無い（2026-10-06 本人判断で保留）`
  }
];

// 失敗を表す行（各テストの出力形式: 「NG」「❌」「ERROR」、Python の終了メッセージ）
const FAILURE_LINE = /^\s*(NG\b|❌|ERROR\b|Excel が見つかりません|Traceback)/;

function runSuite(s) {
  const t0 = Date.now();
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lines = out.split(/\r?\n/);
  const failures = [...new Set(lines.filter(l => FAILURE_LINE.test(l)).map(l => l.trim()))];
  const summary = (lines.map(l => l.trim()).filter(l => /passed|結果|全テスト完了|一致|最新/.test(l)).pop() || '').slice(0, 120);
  const known = KNOWN_EXCEPTIONS.filter(k => k.suite === s.name && k.when());
  let status;
  if (r.error) status = 'error';
  else if (r.status === 0) status = 'pass';
  else if (failures.length && failures.every(f => known.some(k => k.match.test(f)))) status = 'known';
  else status = 'fail';
  return { name: s.name, status, code: r.status, failures, summary, known, sec: Math.round((Date.now() - t0) / 1000), error: r.error && r.error.message };
}

function main() {
  if (args.has('--rebuild-stores')) {
    console.log('配達マップの店舗マスタを再生成: node tools/pickup-map/build-stores.js');
    const r = spawnSync(NODE, ['tools/pickup-map/build-stores.js'], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write((r.stdout || '').split(/\r?\n/).filter(l => /店舗数|総トリップ|新店舗|ERROR|書き出し/.test(l)).map(l => '  ' + l).join('\n') + '\n');
    if (r.status !== 0) { console.log('✕ 店舗マスタの再生成に失敗しました'); process.exit(1); }
  }
  const suites = SUITES.filter(s => !(QUICK && s.e2e));
  console.log(`公開前の全テスト（${suites.length}件${QUICK ? '・画面テストを除く' : ''}）`);
  const results = [];
  for (const s of suites) {
    process.stdout.write(`  … ${s.name}`);
    const r = runSuite(s);
    results.push(r);
    const mark = { pass: '✓', known: '△', fail: '✕', error: '✕' }[r.status];
    process.stdout.write(`\r  ${mark} ${s.name}（${r.sec}秒）${r.summary ? ' ' + r.summary : ''}\n`);
    if (r.status === 'fail' || r.status === 'error') (r.failures.length ? r.failures : [r.error || `終了コード ${r.code}`]).slice(0, 8).forEach(f => console.log('      ' + f));
    if (r.status === 'known') r.known.forEach(k => console.log(`      既知の例外: ${k.reason}`));
  }
  // 既知の例外の条件が成り立っているのにテストが通った → 解消済み（リストから外す）
  KNOWN_EXCEPTIONS.filter(k => k.when()).forEach(k => {
    const r = results.find(x => x.name === k.suite);
    if (r && r.status === 'pass') console.log(`  ※ 既知の例外が解消しています（KNOWN_EXCEPTIONS から外す）: ${k.suite} / ${k.reason}`);
  });
  const bad = results.filter(r => r.status === 'fail' || r.status === 'error');
  const known = results.filter(r => r.status === 'known');
  console.log(`\n結果: ${results.length - bad.length - known.length} passed, ${known.length} known, ${bad.length} failed`);
  if (bad.length) console.log('予期しない失敗があります。公開（commit・push）しないでください: ' + bad.map(r => r.name).join(' / '));
  process.exit(bad.length ? 1 : 0);
}

main();
