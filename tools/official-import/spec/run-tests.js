/**
 * UBER_LOG 公式取込 v1 — 自動テスト
 *   node tools/official-import/spec/run-tests.js
 *
 * 本物の js/store.js・js/trip-maps.js は一切書き換えない（一時フォルダへコピーして検証）。
 * fixture は 2026-09-21・09-22 の確定済み公式データ（Uber一覧形式テキスト＋スクショ読取値）と、
 * 既存の公式スクショ assets/maps/full_*.png を使用する。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIX = path.join(__dirname, 'fixtures');
const parser = require('../lib/activity-parser.js');
const pipeline = require('../lib/pipeline.js');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}
function section(title) { console.log(`\n【${title}】`); }

// ------------------------------------------------------------
// 一時ルート（アプリ一式のコピー）
// ------------------------------------------------------------
const tmpRoots = [];
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-import-'));
  tmpRoots.push(dir);
  ['js/store.js', 'js/trip-maps.js', 'js/cloud-sync.js', 'index.html', 'sw.js', 'pickup-map.html', 'route-judge.html', 'version.json', 'tools/release-check/version.js'].forEach(rel => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  });
  fs.mkdirSync(path.join(dir, 'assets', 'maps'), { recursive: true });
  const lib = path.join(dir, 'tools', 'official-import', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.readdirSync(path.join(__dirname, '..', 'lib')).filter(f => /\.(js|py)$/.test(f)).forEach(f => fs.copyFileSync(path.join(__dirname, '..', 'lib', f), path.join(lib, f)));
  return dir;
}

// inbox（activity.txt・スクショ）と staging（スクショ読取結果）を fixture から用意
function setupInbox(root, date, mutate = {}) {
  const inbox = path.join(root, 'tools', 'official-import', 'inbox', date);
  const shots = path.join(inbox, 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  let activity = fs.readFileSync(path.join(FIX, `${date}.activity.txt`), 'utf8');
  if (mutate.activity) activity = mutate.activity(activity);
  fs.writeFileSync(path.join(inbox, 'activity.txt'), activity, 'utf8');
  const screens = JSON.parse(fs.readFileSync(path.join(FIX, `${date}.screens.json`), 'utf8'));
  if (mutate.screens) mutate.screens(screens);
  screens.screenshots.forEach(s => {
    if (s._fixtureFull && !(mutate.skipImages || []).includes(s.file)) {
      fs.copyFileSync(path.join(ROOT, s._fixtureFull), path.join(shots, s.file));
    }
  });
  if (mutate.decisions) fs.writeFileSync(path.join(inbox, 'decisions.json'), JSON.stringify(mutate.decisions), 'utf8');
  const staging = path.join(root, 'tools', 'official-import', 'staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, `${date}.screens.json`), JSON.stringify(screens, null, 2), 'utf8');
  return { inbox, shots };
}

function removeSeedDay(root, date) {
  const file = path.join(root, 'js', 'store.js');
  const seed = pipeline.readSeed(file);
  const b = seed.blocks.find(x => x.date === date);
  const i = seed.blocks.indexOf(b);
  let src;
  if (i === seed.blocks.length - 1) {
    src = seed.src.slice(0, seed.blocks[i - 1].end) + seed.src.slice(b.end);
  } else {
    src = seed.src.slice(0, b.keyStart) + seed.src.slice(seed.blocks[i + 1].keyStart);
  }
  fs.writeFileSync(file, src.replace(/\n/g, seed.eol), 'utf8');
}

function keepSeedUntil(root, date) {
  pipeline.readSeed(path.join(root, 'js', 'store.js')).blocks
    .map(b => b.date).filter(d => d > date).reverse()
    .forEach(d => removeSeedDay(root, d));
}

function removeCatalogPrefix(root, prefix) {
  const file = path.join(root, 'js', 'trip-maps.js');
  const tm = pipeline.readTripMaps(file);
  const kept = Object.entries(tm.catalog).filter(([id]) => !id.startsWith(prefix));
  const body = kept.map(([id, e]) => `  ${JSON.stringify(id)}: {\n    "map": "${e.map}",\n    "full": "${e.full}",\n    "cropped": true,\n    "box": [${e.box.join(', ')}],\n    "origFile": ${JSON.stringify(e.origFile)}\n  }`).join(',\n');
  fs.writeFileSync(file, `// UBER_LOG 公式トリップ地図画像カタログ\nconst TRIP_MAP_CATALOG = {\n${body}\n};\n\nif (typeof module !== 'undefined') module.exports = { TRIP_MAP_CATALOG };\n`, 'utf8');
}

function runNode(code, args = []) {
  const r = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const origSeed = pipeline.readSeed(path.join(ROOT, 'js', 'store.js')).data.dailyLogs;
const origCatalog = pipeline.readTripMaps(path.join(ROOT, 'js', 'trip-maps.js')).catalog;

try {
  // ==========================================================
  section('1. activity.txt 解析');
  {
    const r = parser.parseActivityText('Delivery\nTuesday, September 22nd, 2026\n19:48\n￥483\nView Details\n', { defaultYear: 2026 });
    const e = r.events[0];
    check(r.events.length === 1 && e.type === 'delivery' && e.date === '2026-09-22' && e.time === '19:48' && e.amount === 483, 'Delivery（英語日付・序数付き）を解析');

    const d22 = parser.parseActivityText(fs.readFileSync(path.join(FIX, '2026-09-22.activity.txt'), 'utf8'), { defaultYear: 2026 });
    const s22 = parser.summarize(d22, '2026-09-22');
    check(s22.delivery === 18 && s22.deliverySales === 8250, `9/22 Delivery 18件 ¥8,250（=${s22.delivery} / ${s22.deliverySales}）`);
    check(s22.otherDates === 1, '他日付のDeliveryは対象外として分離');
    const dl = d22.events.find(x => x.type === 'delivery' && x.time === '19:48');
    check(dl && dl.tripUuid === '00000000-0000-4000-8000-000000000118' && /\/trips\//.test(dl.url), 'View Details URL・trip UUID を抽出');
    const adj = d22.events.find(x => x.type === 'adjustment');
    check(adj && adj.activityUuid === '00000000-0000-4000-8000-000000000999', 'activity UUID を抽出');

    check(parser.parseTime('午後12時53分') === '12:53' && parser.parseTime('午前0時5分') === '00:05', '日本語時刻（午前／午後）');
    check(parser.parseTime('7:48 PM') === '19:48' && parser.parseTime('12:10 AM') === '00:10', '英語時刻（AM／PM）');
    check(parser.parseDate('2026年9月22日', 2026) === '2026-09-22' && parser.parseDate('Sep 22', 2026) === '2026-09-22', '日本語／英語の日付');
    const tabbed = parser.parseActivityText('Delivery\tTue, Sep 22, 2026\t19:48\t￥483\tView Details', { defaultYear: 2026 });
    check(tabbed.events.length === 1 && tabbed.events[0].amount === 483 && tabbed.events[0].date === '2026-09-22', 'タブ区切り1行形式');

    const signs = parser.parseActivityText('2026年9月18日\n調整\n12:00\n+￥200\n調整\n12:30\n-￥607\n調整\n13:00\n￥-150\nSupport Adjustment\n13:30\n−¥80', { defaultYear: 2026 });
    const amounts = signs.events.map(x => x.amount);
    check(JSON.stringify(amounts) === JSON.stringify([200, -607, -150, -80]) && signs.events.every(x => x.type === 'adjustment'), `+調整／-調整の符号（${amounts.join(', ')}）`);
    check(signs.events[3].title === 'Support Adjustment', '公式名称 Support Adjustment を保持');

    const dec = parser.parseActivityText('クエスト\n\nWednesday, September 23rd, 2026\n\n14:05\n\n￥750\n\nView Details\n3 回乗車クエスト\n\nWednesday, September 23rd, 2026\n\n14:05\n\n￥750.00\n\nView Details\n3 回乗車クエスト\n\nWednesday, September 23rd, 2026\n\n15:00\n\n￥0.00\n\nView Details', { defaultYear: 2026 });
    const decQ = parser.dedupeQuests(dec.events);
    check(dec.events.length === 3 && dec.events.map(e => e.amount).join() === '750,750,0' && dec.events[1].title === '3 回乗車クエスト' && !dec.warnings.length,
      `小数表記 ￥750.00 / ￥0.00 と空行区切りの一覧（${dec.events.map(e => `${e.title} ${e.amount}`).join(' / ')}）`);
    check(decQ.quests.filter(q => q.counted).length === 1 && decQ.duplicateCandidates.length === 0, '「クエスト ¥750」＋「3 回乗車クエスト ¥750.00」→ 1回計上');
    check(parser.parseMoney('￥12.50') === 12.5, '円未満の端数は整数化せず残す（検証で停止させる）');

    const misc = parser.parseActivityText('2026-09-23\n保証報酬\n10:00\n￥5,000\nチップ\n11:00\n￥100\n謎の項目\n12:00\n￥10\n合計\n￥5,110', { defaultYear: 2026 });
    check(misc.events.map(x => x.type).join(',') === 'special,tip,unknown', `特別報酬・チップ単独・未分類を検知（${misc.events.map(x => x.type).join(',')}）`);
    check(misc.statementTotal && misc.statementTotal.amount === 5110, '一覧の合計表示を抽出（総売上の照合に使用）');
  }

  // ==========================================================
  section('2. クエスト重複排除');
  {
    const q = (title, category, time, amount, seq) => ({ type: 'quest', title, category, time, amount, seq, date: '2026-09-22' });
    const r1 = parser.dedupeQuests([q('クエスト', 'MISC', '20:09', 800, 1), q('6回乗車クエスト', 'QUEST', '20:09', 800, 2)]);
    check(r1.quests.filter(x => x.counted).length === 1 && r1.quests[0].counted, 'MISC クエスト ¥800 ＋ QUEST 6回乗車クエスト ¥800 → ¥800 を1回だけ計上');
    const r2 = parser.dedupeQuests([q('3回乗車クエスト', 'QUEST', '15:00', 0, 1)]);
    check(!r2.quests[0].counted && /¥0/.test(r2.quests[0].reason) && r2.duplicateCandidates.length === 0, '¥0クエストはイベントとして残し売上に加算しない');
    const r3 = parser.dedupeQuests([q('クエスト', null, '14:29', 800, 1), q('6回乗車クエスト', null, '20:09', 800, 2)]);
    check(r3.quests.every(x => x.counted), '時刻が違う同額クエストは別報酬として両方計上');
    const r4 = parser.dedupeQuests([q('クエスト', 'MISC', '10:00', 500, 1), q('クエスト', 'MISC', '10:00', 500, 2)]);
    check(r4.duplicateCandidates.length === 1 && r4.quests.every(x => !x.counted), '機械判定が危険な重なりは推測で消さず「重複候補」で停止');
    const r5 = parser.dedupeQuests([q('クエスト', 'MISC', '10:00', 500, 1), q('クエスト', 'MISC', '10:00', 500, 2)], { questDuplicates: { '10:00|500': 'count_once' } });
    check(r5.duplicateCandidates.length === 0 && r5.quests.filter(x => x.counted).length === 1, 'decisions.json（count_once）で確認後は1回計上');
    const r6 = parser.dedupeQuests([q('クエスト', 'MISC', '10:00', 500, 1), q('クエスト', 'MISC', '10:00', 500, 2)], { questDuplicates: { '10:00|500': 'count_all' } });
    check(r6.quests.every(x => x.counted), 'decisions.json（count_all）で両方計上');
  }

  // ==========================================================
  section('2-2. 一覧の表の見出し行（イベント 日時 売り上げ 表示する）・クエスト重複の表示');
  {
    // 2026-09-26: 見出し行ごとコピーすると、先頭の「クエスト ¥200」の件名に見出しが混ざり、21:28 の組が重複候補になっていた
    const text = 'イベント\t日時\t売り上げ\t表示する\nクエスト\n\nSaturday, September 26th, 2026\n\n21:28\n\n￥200\n\nView Details\nクエスト\n\nSaturday, September 26th, 2026\n\n21:28\n\n￥500\n\nView Details\n' +
      '1 回乗車クエスト\n\nSaturday, September 26th, 2026\n\n21:28\n\n￥200.00\n\nView Details\n3 回乗車クエスト\n\nSaturday, September 26th, 2026\n\n21:28\n\n￥500.00\n\nView Details';
    const hp = parser.parseActivityText(text, { defaultYear: 2026 });
    check(hp.events.length === 4 && hp.events[0].title === 'クエスト' && hp.warnings.some(w => /見出し（イベント・日時・売り上げ・表示する）はイベントではないため無視/.test(w)),
      `見出し行は件名に混ぜずに無視（先頭: 「${hp.events[0] && hp.events[0].title}」）`);
    const hq = parser.dedupeQuests(hp.events.filter(e => e.type === 'quest'));
    check(hq.duplicateCandidates.length === 0 && hq.quests.filter(x => x.counted).map(x => x.amount).sort().join() === '200,500',
      '21:28「クエスト ¥200」＋「1回乗車クエスト ¥200」→ ¥200 を1回だけ計上（¥500 の組も1回）・重複候補なし');
    const once = parser.dedupeQuests(hp.events.filter(e => e.type === 'quest'), { questDuplicates: { '21:28|200': 'count_once' } });
    check(once.quests.filter(x => x.counted).reduce((s, x) => s + x.amount, 0) === 700, 'decisions.json の count_once があっても結果は同じ（二重計上なし ¥700）');
    const plain = parser.parseActivityText('Delivery\nイベント・運転\n10:00\n￥320', { defaultYear: 2026 });
    check(plain.events.length === 1 && plain.events[0].type === 'delivery', '見出しと同じ語を含むだけの行は消さない');

    // 検証名は実際の状態を表す（候補ありで「候補なし」と出さない）
    const root = makeRoot();
    setupInbox(root, '2026-09-22');
    const actFile = path.join(root, 'tools', 'official-import', 'inbox', '2026-09-22', 'activity.txt');
    fs.appendFileSync(actFile, '\nクエスト\nTuesday, September 22nd, 2026\n23:50\n￥100\nクエスト\nTuesday, September 22nd, 2026\n23:50\n￥100\n', 'utf8');
    const st = pipeline.buildStaging(root, '2026-09-22');
    const dupCheck = st.validation.checks.find(c => /^クエスト重複/.test(c.name));
    check(st.validation.status === 'FAIL' && dupCheck && !dupCheck.ok && /^クエスト重複候補あり（1件/.test(dupCheck.name) && !/候補なし/.test(dupCheck.name),
      `重複候補があるときは「${dupCheck && dupCheck.name}」（「候補なし」と表示しない）`);
    check(st.questDuplicateCandidates.length === 1 && st.questDuplicateCandidates[0].key === '23:50|100', '重複候補を時刻・金額つきで画面へ渡す');
    const { ImportJob } = require('../lib/import-job.js');
    const job = new ImportJob({ root, date: '2026-09-22', testCommand: 'skip' });
    const probs = job.explain({ checks: st.validation.checks, questDuplicateCandidates: st.questDuplicateCandidates, deliveries: [] }, { screenshots: [] });
    const qp = probs.find(p => p.type === 'quest');
    check(qp && /^クエスト重複の確認が必要です/.test(qp.title) && qp.actions.join() === 'count_once,count_all' && qp.items[0].time === '23:50' && qp.items[0].amount === 100 &&
      /同じ確認で止まります/.test(qp.detail) && !probs.some(p => /候補なし/.test(p.title)),
      `画面: 「${qp && qp.title}」＋ 同じ報酬（count_once）／別々の報酬（count_all）ボタン・押し直しても止まる理由を表示`);
    const cleanRoot = makeRoot();
    setupInbox(cleanRoot, '2026-09-22');
    const clean = pipeline.buildStaging(cleanRoot, '2026-09-22');
    check(clean.validation.checks.some(c => c.name === 'クエスト重複候補なし' && c.ok), '重複候補が0件のときだけ「クエスト重複候補なし」');
  }

  // ==========================================================
  section('3. MAP crop（既存規格 420x233・既存切り抜き位置との一致）');
  {
    const py = process.env.UBER_IMPORT_PYTHON || 'python';
    const det = f => JSON.parse(spawnSync(py, [path.join(__dirname, '..', 'lib', 'crop_map.py'), 'detect', path.join(ROOT, f)], { encoding: 'utf8' }).stdout);
    ['del_0922_1', 'del_0922_8', 'del_0921_7', 'del_0919_19'].forEach(id => {
      const r = det(origCatalog[id].full);
      const box = origCatalog[id].box;
      check(r.ok && r.box.every((v, i) => Math.abs(v - box[i]) <= 2), `${id}: 検出 ${JSON.stringify(r.box)} / 既存 ${JSON.stringify(box)}`);
    });
    const cut = det(origCatalog.del_0922_10.full);
    check(!cut.ok, `地図が画像端で切れた del_0922_10 は推測で切り出さず停止（${cut.reason}）`);
  }

  // ==========================================================
  section('3-2. MAP crop: 表示倍率が違うスクショ（例: 9/26 の地図 378x210）・本当に切れた地図は通さない');
  {
    const py = process.env.UBER_IMPORT_PYTHON || 'python';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-scaled-'));
    tmpRoots.push(dir);
    // 既存の正常なスクショ（del_0922_1: 地図 420x233）を0.9倍に縮小した画面を作り、そこから切れた画像も作る
    const gen = spawnSync(py, ['-c', `
import sys
from PIL import Image
src, d = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
s = im.resize((round(im.width * 0.9), round(im.height * 0.9)), Image.LANCZOS)
s.save(d + '/scaled.png')
print(s.width, s.height)`, path.join(ROOT, origCatalog.del_0922_1.full), dir], { encoding: 'utf8' });
    const det = f => JSON.parse(spawnSync(py, [path.join(__dirname, '..', 'lib', 'crop_map.py'), 'detect', f], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).stdout);
    const ok = det(path.join(dir, 'scaled.png'));
    const bw = ok.box ? ok.box[2] - ok.box[0] : 0, bh = ok.box ? ok.box[3] - ok.box[1] : 0;
    check(gen.status === 0 && ok.ok && ok.scaled && Math.abs(bw - 378) <= 2 && Math.abs(bh - 210) <= 2,
      `0.9倍表示の画面（420x233 規格外）でも地図全体を検出: ${bw}x${bh}（縦横比 420:233）`);
    // 検出した地図の外側を切り落として「本当に切れた」画像を作る
    const mk = (name, expr) => spawnSync(py, ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]); l, t, r, b = ${JSON.stringify(ok.box || [0, 0, 1, 1])}
im.crop(${expr}).save(sys.argv[2])`, path.join(dir, 'scaled.png'), path.join(dir, name)], { encoding: 'utf8' });
    mk('cut_right.png', '(0, 0, r - 4, im.height)');
    mk('cut_right2.png', '(0, 0, r - 2, im.height)');
    mk('cut_left.png', '(l + 3, 0, im.width, im.height)');
    mk('edge_right.png', '(0, 0, r, im.height)');
    mk('cut_bottom.png', '(0, 0, im.width, b - 20)');
    const results = ['cut_right', 'cut_right2', 'cut_left', 'edge_right', 'cut_bottom'].map(n => [n, det(path.join(dir, `${n}.png`))]);
    results.forEach(([n, r]) => check(!r.ok, `${n}: 地図が切れた画像は通さない（${r.reason}）`));
    // 縦横比が合わない（横が欠けた地図を左右の白で囲んだ）画像も通さない
    spawnSync(py, ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); l, t, r, b = ${JSON.stringify(ok.box || [0, 0, 1, 1])}
out = im.copy(); out.paste((255, 255, 255), (r - 12, t, r, b)); out.save(sys.argv[2])`, path.join(dir, 'scaled.png'), path.join(dir, 'narrow.png')], { encoding: 'utf8' });
    const narrow = det(path.join(dir, 'narrow.png'));
    check(!narrow.ok, `地図の横幅が高さに対して足りない画像は通さない（${narrow.reason}）`);
  }

  // ==========================================================
  section('4. 既存 9/22・9/21 の再取込（照合のみ・二重登録なし）');
  for (const date of ['2026-09-22', '2026-09-21']) {
    const root = makeRoot();
    setupInbox(root, date);
    const before = fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
    const beforeTm = fs.readFileSync(path.join(root, 'js', 'trip-maps.js'), 'utf8');
    const r = pipeline.apply(root, date);
    const v = r.staging.validation;
    if (v.status !== 'PASS') console.log(v.errors);
    check(v.status === 'PASS', `${date} validation PASS`);
    check(r.unchanged === true && !r.applied, `${date} 既存データと完全一致 → 変更なし（二重登録なし）`);
    check(fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8') === before && fs.readFileSync(path.join(root, 'js', 'trip-maps.js'), 'utf8') === beforeTm, `${date} store.js・trip-maps.js は1バイトも変化なし`);
    const s = r.staging.summary;
    const o = origSeed[date];
    check(s.trips === o.tripsCount && s.deliveriesCount === o.deliveriesCount && s.deliverySales === o.sales.delivery && s.questSales === o.sales.quest && s.adjustmentSales === (o.sales.adjustment || 0) && s.totalSales === o.sales.total,
      `${date} 集計一致: ${s.trips}trip / ${s.deliveriesCount}件 / ${pipeline.yen(s.deliverySales)} / Q ${pipeline.yen(s.questSales)} / 調整 ${pipeline.yen(s.adjustmentSales)} / 総売上 ${pipeline.yen(s.totalSales)}`);
    check(s.distanceKm === o.totalDistanceKm, `${date} 距離 ${s.distanceKm}km`);
    check(s.maps === `${o.tripsCount}/${o.tripsCount}`, `${date} MAP ${s.maps}`);
    if (date === '2026-09-22') {
      check(s.durationText === '7:14:20', `9/22 配達時間 ${s.durationText}`);
      const d8 = r.staging.deliveries.find(d => d.id === 'del_0922_8');
      check(d8 && d8.status === 'existing' && d8.screen.amount === 607, '12:53 Delivery ¥607 は既存 del_0922_8 と照合（調整 -¥607 とは別イベント）');
    }
  }

  // ==========================================================
  section('4-2. 2026-09-24（修正C書の確定正解値をテストオラクルに使用）');
  {
    const root = makeRoot();
    keepSeedUntil(root, '2026-09-24');
    removeSeedDay(root, '2026-09-24');
    setupInbox(root, '2026-09-24');
    const r = pipeline.apply(root, '2026-09-24', { skipVersionBump: true });
    if (r.staging.validation.status !== 'PASS') console.log(r.staging.validation.errors);
    check(r.applied && r.staging.validation.status === 'PASS', '9/24 一覧＋スクショ（18:09 の重複スクショを含む17枚）→ PASS・反映');
    const d = pipeline.readSeed(path.join(root, 'js', 'store.js')).data.dailyLogs['2026-09-24'];
    const fees = d.deliveries.map(x => `${x.completedAt} ${x.fee}`);
    const expected = ['07:42 861', '08:33 320', '08:44 380', '09:18 387', '10:06 320', '10:19 386', '10:37 437', '11:21 320', '11:30 908', '13:06 320', '15:13 666', '15:42 320', '16:20 757', '17:39 320', '18:09 320', '18:39 677'];
    check(d.deliveries.length === 16 && d.tripsCount === 16 && JSON.stringify(fees) === JSON.stringify(expected), `1. Delivery 16件（確定正解の時刻・金額と完全一致）`);
    check(d.sales.delivery === 7699 && d.deliveries.reduce((s, x) => s + x.fee, 0) === 7699, '2. Delivery 合計 ¥7,699');
    const t1739 = d.deliveries.find(x => x.completedAt === '17:39');
    const t1809 = d.deliveries.find(x => x.completedAt === '18:09');
    check(t1739 && t1809 && t1739.id !== t1809.id && t1809.durationStr === '23分4秒' && t1809.distanceKm === 3.11, `3. 17:39 ¥320（${t1739 && t1739.id}）と 18:09 ¥320（${t1809 && t1809.id}・23分4秒・3.11km）は別Delivery`);
    check(d.deliveries.filter(x => x.fee === 320).length === 7, '4. 同額 ¥320 の7件（08:33・10:06・11:21・13:06・15:42・17:39・18:09）が統合されずに残る');
    check(r.staging.validation.warnings.some(w => /同じDelivery.*重複スクショ/.test(w)), '同じDeliveryを2回撮ったスクショ（全項目一致）は1枚として扱い、注意に記録');
    const q600 = d.quests.filter(q => q.amount === 600);
    const q8890 = d.quests.filter(q => q.amount === 8890);
    check(q600.length === 1 && q600[0].questName === '6回乗車クエスト' && q600[0].questType === 'normal', '5. 6回乗車クエスト ¥600 を1回だけ計上（通常クエスト）');
    check(q8890.length === 1 && q8890[0].questName === '80回乗車クエスト', '6. 80回乗車クエスト ¥8,890 を1回だけ計上');
    check(d.sales.quest === 9490 && d.quests.reduce((s, q) => s + q.amount, 0) === 9490, '7. クエスト合計 ¥9,490（19:15 達成表示と 19:23 売上計上を同一報酬として統合・15:00 の ¥0 は非加算）');
    check(q8890[0] && q8890[0].questType === 'special' && q8890[0].achievedAt === '19:15' && q8890[0].time === '19:23', '8. 80回乗車クエストを「特別クエスト」（questType: special）として識別・達成 19:15 / 計上 19:23 を保持');
    check(d.sales.total === 17189, '9. Delivery ＋ クエスト ＝ ¥17,189');
    const m = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(root, 'js', 'store.js'))});
      const x=store.getCalculatedMetrics(store.getDailyLog('2026-09-24'));
      console.log(JSON.stringify({total:x.totalSales,q:x.questSales,sq:x.specialQuestSales,sqs:x.specialQuests,count:x.count}));`);
    check(m.total === 17189 && m.q === 9490 && m.sq === 8890 && m.sqs.length === 1 && m.sqs[0].name === '80回乗車クエスト' && m.count === 22,
      `アプリ計算: 総売上 ¥17,189 / クエスト ¥9,490（うち特別 ¥8,890・80回乗車クエスト）/ 22件`);
    const again = pipeline.apply(root, '2026-09-24', { skipVersionBump: true });
    const d2 = pipeline.readSeed(path.join(root, 'js', 'store.js')).data.dailyLogs['2026-09-24'];
    check(again.unchanged === true && d2.deliveries.length === 16 && d2.quests.length === 2, '10. 再取り込み → 変更なし（Delivery・クエストの二重登録なし）');

    // 安全装置は維持: 中身が違うのに同時刻・同額のスクショが2枚 → 件数不一致で停止
    const root2 = makeRoot();
    keepSeedUntil(root2, '2026-09-24');
    removeSeedDay(root2, '2026-09-24');
    setupInbox(root2, '2026-09-24', { screens: s => { s.screenshots[s.screenshots.length - 1].distanceKm = 2.5; } });
    const bad = pipeline.apply(root2, '2026-09-24', { skipVersionBump: true });
    check(!bad.applied && bad.staging.validation.checks.some(c => !c.ok && /Delivery件数一致/.test(c.name)), '同時刻・同額でも中身（距離など）が違うスクショは同一扱いせず停止（本体は非反映）');
    // 07:42 のスクショが無い → 停止（9/24 取込で実際に起きた状態）
    const root3 = makeRoot();
    keepSeedUntil(root3, '2026-09-24');
    removeSeedDay(root3, '2026-09-24');
    setupInbox(root3, '2026-09-24', { screens: s => { s.screenshots = s.screenshots.filter(x => x.time !== '07:42'); } });
    const miss = pipeline.apply(root3, '2026-09-24', { skipVersionBump: true });
    const missCheck = miss.staging.validation.checks.find(c => /Delivery件数一致/.test(c.name));
    check(!miss.applied && missCheck && !missCheck.ok && /07:42 ¥861 に一致するスクショがありません/.test(missCheck.detail), '07:42 のスクショ不足 → 「一覧 07:42 ¥861 に一致するスクショがありません」で停止');
  }

  // ==========================================================
  section('4-3. クエストの達成表示と売上計上の統合ルール');
  {
    const q = (title, time, amount, seq) => ({ type: 'quest', title, category: null, time, amount, seq, date: '2026-09-24' });
    // 2026-10-24 の実例で、達成表示から売上計上まで 62〜132分遅れることが分かったため、60分超でも 1対1 に組めるときは統合する（下の 4-4）
    const far = parser.dedupeQuests([q('6 回乗車クエスト', '12:00', 600, 1), q('クエスト', '13:30', 600, 2)]);
    check(far.quests.filter(x => x.counted).length === 1 && far.quests[1].counted && far.quests[1].achievedAt === '12:00' && far.payoutAmbiguities.length === 0,
      '60分を超えて離れた同額の達成表示1件・売上計上1件は、同じ報酬として1回計上（10/24 以降のルール）');
    const diff = parser.dedupeQuests([q('6 回乗車クエスト', '19:15', 600, 1), q('クエスト', '19:23', 700, 2)]);
    check(diff.quests.filter(x => x.counted).length === 2, '金額が違えば統合しない');
    const before = parser.dedupeQuests([q('クエスト', '19:10', 600, 1), q('6 回乗車クエスト', '19:15', 600, 2)]);
    check(before.quests.filter(x => x.counted).length === 2, '売上計上が達成表示より前の時刻なら統合しない');
    const only = parser.dedupeQuests([q('6 回乗車クエスト', '19:15', 600, 1)]);
    check(only.quests[0].counted && only.quests[0].questType === 'normal' && only.quests[0].questName === '6 回乗車クエスト', '達成表示だけの回数クエストは1件として計上（通常クエスト）');
    check(parser.questTypeOf('80 回乗車クエスト') === 'special' && parser.questTypeOf('6回乗車クエスト') === 'normal' && parser.questTypeOf('クエスト') === 'normal',
      `特別クエストの判定: ${parser.SPECIAL_QUEST_MIN_TRIPS}回以上の回数クエスト（80回 → special / 6回・名称なし → normal）`);
    const two = parser.dedupeQuests([q('6 回乗車クエスト', '19:15', 600, 1), q('6 回乗車クエスト', '19:40', 600, 2), q('クエスト', '19:23', 600, 3)]);
    check(two.quests.filter(x => x.counted).length === 2, '達成表示2件・売上計上1件なら、近い組だけ統合して残り1件は別報酬として計上（1対1）');
  }

  // ==========================================================
  section('4-4. 60分を超えて遅れた売上計上（2026-10-24 の実例）と、組み合わせが曖昧なときの停止');
  {
    const q = (title, time, amount, seq, date = '2026-10-24') => ({ type: 'quest', title, category: /^クエスト$/.test(title) ? 'MISC' : 'QUEST', time, amount, seq, date });
    const counted = r => r.quests.filter(x => x.counted);
    const sum = r => counted(r).reduce((s, x) => s + x.amount, 0);

    // 実データ（クエスト行だけ・個人情報なし）: 一覧テキストに変換 → 解析 → 重複排除
    const normalizer = require('../lib/structured-normalizer.js');
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'quest-payout-delay-2026-10-24.json'), 'utf8'));
    const ev = parser.parseActivityText(normalizer.buildActivityTextFromStructured(fx, '2026-10-24'), { defaultYear: '2026' }).events.filter(e => e.type === 'quest');
    const r24 = parser.dedupeQuests(ev);
    const nQuest = fx.feedItems.filter(i => i.type === 'QUEST').length;
    const nMisc = fx.feedItems.filter(i => i.type === 'MISC').length;
    check(ev.length === 40 && nQuest === 20 && nMisc === 20, `10/24: クエスト行 40（QUEST ${nQuest} / MISC ${nMisc}）`);
    check(sum(r24) === 5710 && counted(r24).length === 20 && counted(r24).every(x => x.title === 'クエスト'),
      `10/24: 計上は売上計上行（MISC）20件だけ・¥5,710（=${sum(r24)}・計上 ${counted(r24).length} 件）`);
    const paidSeqs = r24.quests.filter(x => !x.counted).map(x => x.duplicateOfSeq);
    check(paidSeqs.length === 20 && new Set(paidSeqs).size === 20 && r24.duplicateCandidates.length === 0 && r24.payoutAmbiguities.length === 0,
      '10/24: 達成表示 20件がそれぞれ別の売上計上 1件と組む（二重計上 0・同じ計上行を2回使わない・停止なし）');
    const at = t => r24.quests.find(x => x.counted && x.time === t && x.amount === 200);
    check(at('13:40').achievedAt === '11:54' && at('13:50').achievedAt === '12:29' && at('14:14').achievedAt === '12:53' && at('15:21').achievedAt === '13:10' &&
      r24.quests.find(x => x.counted && x.time === '12:35').achievedAt === '11:33',
      '10/24: 遅れた ¥200×4・¥100 は時刻順に組む（11:54→13:40 / 12:29→13:50 / 12:53→14:14 / 13:10→15:21 / 11:33→12:35）');
    const app = spawnSync(process.execPath, ['-e', `global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
      const m=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      console.log(m.deduplicateQuests(JSON.parse(process.argv[1])).filter(x=>x.isDuplicateIgnored).length)`, JSON.stringify(counted(r24).map(x => ({ time: x.time, title: x.title, amount: x.amount })))], { encoding: 'utf8' });
    check(app.stdout.trim() === '0', `10/24: 取込結果はアプリのクエスト表示ロジックでも除外 0 件（store.js は変更なし・=${app.stdout.trim()}）`);

    // 同額が複数あっても 1対1・時刻順
    const multi = parser.dedupeQuests([q('1 回乗車クエスト', '10:00', 200, 1), q('1 回乗車クエスト', '10:30', 200, 2), q('クエスト', '12:10', 200, 3), q('クエスト', '12:20', 200, 4)]);
    check(sum(multi) === 400 && multi.quests[2].achievedAt === '10:00' && multi.quests[3].achievedAt === '10:30' && multi.payoutAmbiguities.length === 0,
      '同額の達成表示2件 → 2時間後の売上計上2件: 時刻順に組んで ¥400（¥800 にしない）');
    // 60分以内の組だけで済む日は従来どおり（遅れの大きい組合せに組み替えない）
    const nearOnly = parser.dedupeQuests([q('1 回乗車クエスト', '10:00', 150, 1), q('クエスト', '10:01', 150, 2), q('1 回乗車クエスト', '15:00', 150, 3), q('クエスト', '15:01', 150, 4)]);
    check(sum(nearOnly) === 300 && nearOnly.quests[1].achievedAt === '10:00' && nearOnly.quests[3].achievedAt === '15:00', '60分以内に組める日は従来どおりの組み合わせ');
    // 曖昧: 60分超で組める行があるのに数が合わない → 推測で組まずに止める
    const amb = parser.dedupeQuests([q('1 回乗車クエスト', '10:00', 200, 1), q('1 回乗車クエスト', '10:30', 200, 2), q('クエスト', '12:10', 200, 3)]);
    check(amb.payoutAmbiguities.length === 1 && amb.payoutAmbiguities[0].amount === 200 && amb.quests.every(x => /曖昧/.test(x.reason)),
      '達成表示2件・60分超の売上計上1件（数が合わない）→ 自動で統合せず「対応が曖昧」で停止');
    // 曖昧: 数は合うが時刻順に組むと計上が達成より前になる → 止める
    const order = parser.dedupeQuests([q('1 回乗車クエスト', '10:00', 200, 1), q('クエスト', '09:00', 200, 2), q('1 回乗車クエスト', '12:00', 200, 3), q('クエスト', '13:30', 200, 4)]);
    check(order.payoutAmbiguities.length === 1, '数は合うが時刻順に組むと「計上が達成より前」になる組がある → 停止');
    // 組める相手がいない行はそれぞれ別報酬（従来どおり）
    const lone = parser.dedupeQuests([q('1 回乗車クエスト', '20:00', 300, 1), q('クエスト', '09:00', 500, 2)]);
    check(sum(lone) === 800 && lone.payoutAmbiguities.length === 0, '達成表示だけ・売上計上だけの行（金額違い）はそれぞれ計上（従来どおり）');
    // 日付境界: 別の日の行とは組まない
    const cross = parser.dedupeQuests([q('1 回乗車クエスト', '23:50', 200, 1, '2026-10-24'), q('クエスト', '00:10', 200, 2, '2026-10-25')]);
    check(sum(cross) === 400 && cross.payoutAmbiguities.length === 0 && !cross.quests[1].achievedAt, '日付が違う行どうしは組まない（日付境界をまたいで統合しない）');
    // pipeline: 曖昧なときは検証で止まる（UBER_LOG に反映しない）
    check(parser.summarize({ events: amb.quests.map(x => ({ ...x, type: 'quest' })) }, '2026-10-24').payoutAmbiguities === 1, '一覧の簡易集計にも「対応が曖昧」の件数を出す');
  }

  // ==========================================================
  section('5. 新規日の取込（9/22 を一旦消した状態から一覧＋スクショで再構築）');
  {
    const root = makeRoot();
    keepSeedUntil(root, '2026-09-22'); // 週次・クエスト集計を 9/22 時点で比較するため、以降の日は除く
    removeSeedDay(root, '2026-09-22');
    setupInbox(root, '2026-09-22');
    const r = pipeline.apply(root, '2026-09-22');
    if (r.staging.validation.status !== 'PASS') console.log(r.staging.validation.errors);
    check(r.applied, '検証PASS → 新規日として反映');
    const rebuilt = pipeline.readSeed(path.join(root, 'js', 'store.js')).data.dailyLogs['2026-09-22'];
    const o = origSeed['2026-09-22'];
    const same = o.deliveries.every(od => {
      const nd = rebuilt.deliveries.find(x => x.id === od.id);
      return nd && nd.completedAt === od.completedAt && nd.fee === od.fee && nd.points === od.points &&
        nd.distanceKm === od.distanceKm && pipeline.durationToSeconds(nd.durationStr) === pipeline.durationToSeconds(od.durationStr) && nd.index === od.index;
    });
    check(same && rebuilt.deliveries.length === 18, '18trip を時刻順に del_0922_1〜18 として再構築（時刻・金額・距離・時間・ポイント・No.が確定データと一致）');
    check(rebuilt.deliveries.find(d => d.id === 'del_0922_6').tip === 50 && rebuilt.deliveries.find(d => d.id === 'del_0922_6').baseFee === 320, 'チップ内訳（基本料金¥320＋チップ¥50）を保持');
    check(rebuilt.deliveries.find(d => d.id === 'del_0922_8').memo === 'トリプル配達（3件完了/3pt）', 'トリプル配達メモを既存書式で付与');
    check(JSON.stringify(rebuilt.sales) === JSON.stringify(o.sales), `売上内訳一致 ${JSON.stringify(rebuilt.sales)}`);
    check(rebuilt.quests.length === 2 && rebuilt.quests.every(q => q.amount === 800) && /¥0は報酬0/.test(rebuilt.quests[1].note || ''), 'クエスト ¥800×2（重複表示と¥0クエストは note に記録）');
    check(rebuilt.adjustments.length === 1 && rebuilt.adjustments[0].amount === -607 && rebuilt.adjustments[0].time === '23:46', '調整 23:46 -¥607 を adjustments[] に保持');
    check(!rebuilt.expenses.length && !rebuilt.vehicleType, '経費（Bike・必要経費）は取込で入力しない');
    check(rebuilt.deliveries.every(d => !/^\d/.test(d.area) && !/[０-９]/.test(d.area)), '配達先の都道府県コード除去・全角数字の正規化');
    check(r.staging.summary.maps === '18/18', `既存MAPカタログを上書きせず使用（${r.staging.summary.maps}）`);
    check(r.version && /_v\d+$/.test(r.version.to) && r.version.to !== r.version.from, `バージョン更新 ${r.version && r.version.from} → ${r.version && r.version.to}`);
    {
      const { TARGETS } = require(path.join(ROOT, 'tools', 'release-check', 'version.js'));
      const stale = TARGETS.map(t => ({ file: t.file, found: t.find(fs.readFileSync(path.join(root, t.file), 'utf8')) }))
        .filter(x => !x.found.length || x.found.some(v => v !== r.version.to)).map(x => x.file);
      check(r.version && stale.length === 0, `取込の版更新は version.js と同じ反映先すべてに反映（index.html・sw.js・pickup-map.html・route-judge.html）${stale.length ? ' 古い版: ' + stale.join(', ') : ''}`);
    }
    const again = pipeline.apply(root, '2026-09-22');
    check(again.unchanged === true, '同日を再取込 → 変更なし（二重登録防止）');

    const m = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(root, 'js', 'store.js'))});
      const x=store.getCalculatedMetrics(store.getDailyLog('2026-09-22'));
      const w=store.getRevenueSummary('2026-09-22').thisWeek;
      console.log(JSON.stringify({total:x.totalSales,count:x.count,sec:x.workSeconds,week:w.officialSales,q:store.getQuestProgress('2026-09-22').currentCount}));`);
    check(m.total === 9243 && m.count === 25 && m.sec === 26060 && m.week === 13533 && m.q === 35, `アプリ計算: 9/22 ¥9,243 / 25件 / 7:14:20 / 今週 ¥13,533 / クエスト 35件（=${JSON.stringify(m)}）`);
  }

  // ==========================================================
  section('6. 既存日の照合・補完（10trip 登録済みの日へ全18tripを取込）');
  {
    const root = makeRoot();
    const file = path.join(root, 'js', 'store.js');
    const partial = JSON.parse(JSON.stringify(origSeed['2026-09-22']));
    partial.deliveries = partial.deliveries.slice(0, 10);
    partial.deliveries[0].evaluation = 'good';
    partial.deliveries[0].evaluationReason = 'テスト用評価';
    partial.tripsCount = 10;
    pipeline.writeSeedDay(file, '2026-09-22', partial);
    setupInbox(root, '2026-09-22');
    const r = pipeline.apply(root, '2026-09-22', { skipVersionBump: true });
    if (r.staging.validation.status !== 'PASS') console.log(r.staging.validation.errors);
    check(r.applied, '検証PASS → 補完として反映');
    const after = pipeline.readSeed(file).data.dailyLogs['2026-09-22'];
    check(after.deliveries.length === 18 && after.deliveries.slice(0, 10).every((d, i) => d.id === partial.deliveries[i].id), '既存trip ID（del_0922_1〜10）を維持し、不足8件を追加');
    check(after.deliveries[0].evaluation === 'good' && after.deliveries[0].evaluationReason === 'テスト用評価', '○×評価・評価理由を保持');
    check(JSON.stringify(after.expenses) === JSON.stringify(origSeed['2026-09-22'].expenses) && after.vehicleType === 'バイクシェア利用', '既存のBike経費を保持');
    check(after.tripsCount === 18 && after.deliveriesCount === 25 && after.totalDistanceKm === 67.13, '件数・距離を再計算（18trip / 25件 / 67.13km）');
    check(after.adjustments[0].officialTitle === 'Support Adjustment' && after.adjustments[0].userNote === '配達ミスに伴う調整', '既存の調整イベント（公式名称・ユーザーメモ）を保持');
  }

  // ==========================================================
  section('7. MAP 新規切り抜き（9/21 のMAPカタログを外した状態から）');
  {
    const root = makeRoot();
    removeCatalogPrefix(root, 'del_0921_');
    removeSeedDay(root, '2026-09-21');
    setupInbox(root, '2026-09-21');
    const r1 = pipeline.apply(root, '2026-09-21', { skipVersionBump: true });
    if (r1.staging.validation.status !== 'PASS') console.log(r1.staging.validation.errors);
    check(r1.applied && r1.staging.summary.maps === '7/7', `7件すべて公式スクショから切り抜き・MAP ${r1.staging.summary.maps}`);
    const cat = pipeline.readTripMaps(path.join(root, 'js', 'trip-maps.js')).catalog;
    const ids = ['del_0921_1', 'del_0921_2', 'del_0921_4', 'del_0921_5', 'del_0921_6', 'del_0921_7'];
    check(ids.every(id => cat[id] && cat[id].box.every((v, i) => Math.abs(v - origCatalog[id].box[i]) <= 2)), '新規MAPの切り抜き位置が既存確定MAPと一致（±2px）');
    // del_0921_3 は既存MAPが手作業で幅414に切られていたが、元画像では地図は420px全体が写っている（縦の白い道路で途切れても検出できること）
    check(cat.del_0921_3 && cat.del_0921_3.box[0] === 23 && cat.del_0921_3.box[1] === 169, `縦の白い道路で途切れる地図も検出（del_0921_3: ${cat.del_0921_3 && JSON.stringify(cat.del_0921_3.box)}）`);
    const all = ids.concat('del_0921_3');
    check(all.every(id => fs.existsSync(path.join(root, 'assets', 'maps', `map_${id}.png`)) && fs.existsSync(path.join(root, 'assets', 'maps', `full_${id}.png`))), 'map_*.png・full_*.png を assets/maps へ保存');
    const sizes = JSON.parse(spawnSync(process.env.UBER_IMPORT_PYTHON || 'python', ['-c', `import json,sys;from PIL import Image;print(json.dumps([Image.open(p).size for p in sys.argv[1:]]))`, ...all.map(id => path.join(root, 'assets', 'maps', `map_${id}.png`))], { encoding: 'utf8' }).stdout);
    check(sizes.every(s => s[0] === 420 && s[1] === 233), 'MAP画像は既存規格 420x233');
  }

  // ==========================================================
  section('7-2. 地図が画像端で切れたスクショ（del_0922_10 のMAPカタログを外した状態から）');
  {
    const root = makeRoot();
    removeCatalogPrefix(root, 'del_0922_10');
    setupInbox(root, '2026-09-22');
    const before = fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
    const beforeTm = fs.readFileSync(path.join(root, 'js', 'trip-maps.js'), 'utf8');
    const r1 = pipeline.apply(root, '2026-09-22', { skipVersionBump: true });
    const mapCheck = r1.staging.validation.checks.find(c => c.name.startsWith('MAP'));
    check(!r1.applied && r1.staging.validation.status === 'FAIL' && /MAPなし/.test(mapCheck.detail), `推測で切り出さず MAPなしとして停止: ${mapCheck.detail.split('\n')[0]}`);
    check(fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8') === before && fs.readFileSync(path.join(root, 'js', 'trip-maps.js'), 'utf8') === beforeTm, 'FAIL時は store.js・trip-maps.js を変更しない');

    setupInbox(root, '2026-09-22', { decisions: { mapMissingOk: [origCatalog.del_0922_10.origFile] } });
    const r2 = pipeline.apply(root, '2026-09-22', { skipVersionBump: true });
    if (r2.staging.validation.status !== 'PASS') console.log(r2.staging.validation.errors);
    check(r2.staging.validation.status === 'PASS' && r2.staging.summary.maps === '17/18', `ユーザー確認（mapMissingOk）後は PASS・MAP ${r2.staging.summary.maps}`);
    check(!pipeline.readTripMaps(path.join(root, 'js', 'trip-maps.js')).catalog.del_0922_10, 'MAPなしのtripはカタログ登録しない（捏造しない）');
  }

  // ==========================================================
  section('8. 検証FAIL時は反映しない');
  {
    const cases = [
      ['金額不一致', { screens: s => { s.screenshots[3].amount = 999; } }, /Delivery件数一致/],
      ['スクショ不足', { screens: s => { s.screenshots.pop(); }, skipImages: [] }, /Delivery件数一致/],
      ['UNKNOWN項目', { screens: s => { s.screenshots[0].distanceKm = 'UNKNOWN'; } }, /スクショ全件読取済み/],
      ['配達先に番地', { screens: s => { s.screenshots[0].area = '大阪市西区本田1丁目2-3'; } }, /スクショ全件読取済み/],
      ['既存tripが一覧に無い', { activity: a => a.replace('Delivery\nTuesday, September 22nd, 2026\n19:48\n￥483\nView Details\n', '') }, /既存データとの整合|Delivery件数一致/],
      ['特別報酬（対象外）', { activity: a => a + '\nプロモーション\nTuesday, September 22nd, 2026\n21:00\n￥1,000\n' }, /未分類イベントなし/],
      ['時刻不一致', { screens: s => { s.screenshots[0].time = '08:22'; } }, /Delivery件数一致/],
      ['チップ内訳不一致', { screens: s => { const t = s.screenshots.find(x => x.tip); t.tip = 60; } }, /スクショ全件読取済み/]
    ];
    cases.forEach(([name, mutate, expectCheck]) => {
      const root = makeRoot();
      if (name === 'スクショ不足') {
        const screens = JSON.parse(fs.readFileSync(path.join(FIX, '2026-09-22.screens.json'), 'utf8'));
        mutate.skipImages = [screens.screenshots[screens.screenshots.length - 1].file];
      }
      setupInbox(root, '2026-09-22', mutate);
      const before = fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
      const r = pipeline.apply(root, '2026-09-22');
      const failedChecks = r.staging.validation.checks.filter(c => !c.ok).map(c => c.name);
      check(!r.applied && r.staging.validation.status === 'FAIL' && failedChecks.some(n => expectCheck.test(n)) &&
        fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8') === before,
        `${name} → FAIL・未反映（${failedChecks.join(' / ')}）`);
    });
  }

  // ==========================================================
  section('9. 端末データとの同期（store.js 移行処理・cloud-sync）');
  {
    const root = makeRoot();
    removeSeedDay(root, '2026-09-22');
    setupInbox(root, '2026-09-22');
    pipeline.apply(root, '2026-09-22', { skipVersionBump: true });
    const seed = pipeline.readSeed(path.join(root, 'js', 'store.js')).data;
    const local = JSON.parse(JSON.stringify(seed));
    // 端末側: 取込前の9/22に手動タップ3件・Bike経費・○×評価がある状態
    local.dailyLogs['2026-09-22'] = {
      date: '2026-09-22',
      deliveries: [1, 2, 3].map(i => ({ id: `manual_${i}`, index: i, completedAt: `1${i}:00`, restaurant: '', fee: null })),
      expenses: [{ id: 'exp_local_1', category: 'バイクシェア', amount: 1527, memo: '端末で入力' }],
      workSessions: [{ id: 's1', start: '08:00', end: '20:00' }],
      sales: { delivery: 0, quest: 0, adjustment: 0, other: 0, total: 0 }
    };
    // 端末データはサイズが大きく Windows のコマンドライン長の上限を超えるため、一時ファイルで渡す
    const localFile = path.join(root, 'local-device-data.json');
    fs.writeFileSync(localFile, JSON.stringify(local), 'utf8');
    const out = runNode(`
      const map={uber_log_v1_data:require('fs').readFileSync(process.argv[1],'utf8'),uber_log_trip_evaluations:JSON.stringify({del_0922_3:{evaluation:'bad',reason:'階段'}})};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:k=>{delete map[k]}};
      global.window={localStorage:global.localStorage};
      const m=require(${JSON.stringify(path.join(root, 'js', 'store.js'))});
      global.window.getConfirmedSeedData=m.getConfirmedSeedData; global.window.store=m.store;
      const l=m.store.getDailyLog('2026-09-22'); const x=m.store.getCalculatedMetrics(l);
      const {cloudSync}=require(${JSON.stringify(path.join(root, 'js', 'cloud-sync.js'))});
      const stale=JSON.parse(JSON.stringify(l)); stale.sales={delivery:8250,quest:1600,adjustment:0,other:0,total:9850,updatedAt:'2099-01-01T00:00:00Z'};
      const merged=cloudSync.mergeDailyLog(l,stale);
      console.log(JSON.stringify({n:l.deliveries.length,archive:(l.manualTapsArchive||[]).length,exp:l.expenses.map(e=>e.id),ws:l.workSessions.length,
        ev:(l.deliveries.find(d=>d.id==='del_0922_3')||{}).evaluation,total:x.totalSales,profit:x.netProfit,mergedTotal:merged.sales.total,mergedAdj:merged.sales.adjustment}));`,
    [localFile]);
    check(out.n === 18 && out.archive === 3, `端末の手動タップ3件は manualTapsArchive へ退避し公式18tripへ置換（=${out.n} / 退避 ${out.archive}）`);
    check(out.exp.join() === 'exp_local_1' && out.ws === 1, '端末で入力した経費・稼働セッションを保持');
    check(out.ev === 'bad', '○×評価を保持');
    check(out.total === 9243 && out.profit === 7716, `端末の9/22: 総売上 ¥9,243 / 利益 ¥7,716（=${out.total} / ${out.profit}）`);
    check(out.mergedTotal === 9243 && out.mergedAdj === -607, `古いクラウド売上（¥9,850）で上書きされない（=${out.mergedTotal}）`);
  }

  // ==========================================================
  section('10. 9/22時点の確定データ回帰（本物の js/store.js のコピーから 9/23以降を除いて集計）');
  {
    const frozen = makeRoot();
    keepSeedUntil(frozen, '2026-09-22');
    const r = pipeline.report(frozen, '2026-09-22');
    check(r.day.trips === 18 && r.day.count === 25 && r.day.total === 9243 && r.day.profit === 7716 && r.day.seconds === 26060 && r.day.distance === 67.13, '9/22: 18trip / 25件 / ¥9,243 / 利益 ¥7,716 / 7:14:20 / 67.13km');
    check(r.day.delivery === 8250 && r.day.quest === 1600 && r.day.adjustment === -607, '9/22 内訳: 配達報酬 ¥8,250 / クエスト ¥1,600 / その他 -¥607');
    check(r.week.officialSales === 13533 && r.week.bikeExpenses === 3054 && r.week.salesProfit === 10479 && r.week.deliveriesCount === 35 && r.week.otherSales === -607, '今週: ¥13,533 / Bike ¥3,054 / 売上利益 ¥10,479 / 35件 / その他 -¥607');
    check(r.quest.current === 35 && r.quest.remaining === 45, '80件クエスト 35/80（残45）');
    check(r.month.sales === 60758 && r.month.bikeExpenses === 6561 && r.month.otherExpenses === 0 && r.month.salesProfit === 54197 && r.month.deliveriesCount === 107 && r.monthTrips === 89, '今月: ¥60,758 / Bike ¥6,561 / 必要経費 ¥0 / 売上利益 ¥54,197 / 107件 / 89trip');
    check(r.analytics.regular === 48626 && r.analytics.avgDaily === 4863 && r.analytics.avgPer === 454 && r.analytics.seconds === 143013, '通常分析売上 ¥48,626 / 平均日給 ¥4,863 / 平均単価 ¥454 / 39:43:33');
    check(r.maps.mapped === 89 && r.maps.total === 89, `MAP ${r.maps.mapped}/${r.maps.total}`);
    const prev = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(frozen, 'js', 'store.js'))});
      const w=store.getRevenueSummary('2026-09-20').thisWeek; const l=store.getDailyLog('2026-09-19');
      console.log(JSON.stringify({s:w.officialSales,p:w.salesProfit,o:w.otherSales,d19:store.getCalculatedMetrics(l).totalSales,has:l.deliveries.some(d=>d.id==='del_0919_19')}));`);
    check(prev.s === 43461 && prev.p === 39954 && prev.o === 200 && prev.d19 === 21310 && prev.has, '確定週 ¥43,461 / 利益 ¥39,954 / 9/18 調整 +¥200 / 9/19 ¥21,310・del_0919_19');
  }

  // ==========================================================
  section('10-2. 履歴の日別「B」バッジ（log.expenses[] のBike経費と連動）');
  {
    const r = runNode(`
      const map={};
      global.localStorage={getItem:k=>(k in map?map[k]:null),setItem:(k,v)=>{map[k]=String(v)},removeItem:k=>{delete map[k]}};
      global.window={localStorage:global.localStorage};
      const m=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))}); const s=m.store;
      // このセクションは B（と既存の調・賞）の確認。♥（チップ）は 10-4 で確認する
      const keys=d=>s.getDayAttributes(d).map(a=>a.key).filter(k=>k!=='tip').join(',');
      const out={};
      ['2026-09-18','2026-09-19','2026-09-21','2026-09-22','2026-09-23'].forEach(d=>out[d]=keys(d));
      const bike=s.addExpense('2026-09-23',{category:'バイクシェア',amount:1527,memo:'稼働画面から登録'});
      out.afterAdd=keys('2026-09-23');
      s.updateExpense('2026-09-23',bike.id,{category:'必要経費',amount:1527,memo:'種類を変更'});
      out.afterChangeToOther=keys('2026-09-23');
      s.updateExpense('2026-09-23',bike.id,{category:'バイクシェア',amount:1527,memo:'戻す'});
      out.afterChangeBack=keys('2026-09-23');
      s.deleteExpense('2026-09-23',bike.id);
      out.afterDelete=keys('2026-09-23');
      s.addExpense('2026-09-23',{category:'必要経費',amount:500,memo:'備品'});
      out.otherOnly=keys('2026-09-23');
      // 端末データを再読込しても（アプリ再起動相当）Bike経費からBが付くこと
      s.addExpense('2026-09-23',{category:'バイクシェア',amount:1527,memo:'再登録'});
      delete require.cache[require.resolve(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))})];
      const m2=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      out.reload=m2.store.getDayAttributes('2026-09-23').map(a=>a.key).filter(k=>k!=='tip').join(',');
      const w=m2.store.getRevenueSummary('2026-09-23').thisWeek;
      out.weekBike=w.bikeExpenses;
      out.pred=[m.isBikeExpenseCategory('バイクシェア'),m.isBikeExpenseCategory('バイクシェア利用'),m.isBikeExpenseCategory('レンタサイクル'),m.isBikeExpenseCategory('Bike share'),m.isBikeExpenseCategory('必要経費')].join(',');
      console.log(JSON.stringify(out));`);
    check(r['2026-09-18'] === 'bike_share,adjustment' && r['2026-09-19'] === 'bike_share,special_bonus' && r['2026-09-21'] === 'bike_share' && r['2026-09-22'] === 'bike_share,adjustment',
      `既存の B（9/18・9/19・9/21・9/22）と 調・🏆（旧「賞」） を維持（${['2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22'].map(d => `${d.slice(5)}:${r[d]}`).join(' / ')}）`);
    check(r['2026-09-23'] === '', 'Bike経費なしの日は B なし（9/23 同梱データ）');
    check(r.afterAdd === 'bike_share', '稼働画面の「バイクシェア」を登録 → 即 B');
    check(r.afterChangeToOther === '', '修正で「必要経費」に変更 → B が消える');
    check(r.afterChangeBack === 'bike_share', '修正で「バイクシェア」に戻す → B');
    check(r.afterDelete === '', 'Bike経費を全件削除 → B が消える');
    check(r.otherOnly === '', '必要経費のみの日は B なし');
    check(r.reload === 'bike_share', '保存データの再読込後も B');
    check(r.weekBike === 3054 + 1527, `B の判定と週次Bike集計が同じ判定を使用（今週Bike ¥${r.weekBike}）`);
    check(r.pred === 'true,true,true,true,false', `共通判定 isBikeExpenseCategory（${r.pred}）`);
  }

  // ==========================================================
  section('10-4. チップ（独立項目・二重計上なし）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const days={};
      store.getAllDailyLogs().forEach(l=>{const m=store.getCalculatedMetrics(l);days[l.date]={tip:m.tipSales,cnt:m.tipCount,base:m.baseDeliverySales,del:m.deliverySales,total:m.totalSales,profit:m.netProfit,attrs:store.getDayAttributes(l.date).map(a=>a.key).join(',')};});
      const w=store.getRevenueSummary('2026-09-22').thisWeek;
      const b=store.getSalesBreakdown('2026-09-01','2026-09-30');
      const b22=store.getSalesBreakdown('2026-09-22','2026-09-22');
      console.log(JSON.stringify({days,w:{off:w.officialSales,base:w.baseDeliverySales,tip:w.tipSales,q:w.questSales,g:w.guaranteeBonus,adj:w.adjustmentOnlySales,oth:w.otherOnlySales,legacyOther:w.otherSales,del:w.deliverySales},b,b22}));`);
    const d22 = r.days['2026-09-22'];
    const d23 = r.days['2026-09-23'];
    check(d22.tip === 50 && d22.cnt === 1 && d22.base === 8200 && d22.del === 8250 && d22.total === 9243 && d22.profit === 7716,
      '9/22: チップ ¥50（No.6 マクドナルド 九条店）・配達報酬 ¥8,200＋チップ ¥50＝¥8,250・総売上 ¥9,243 / 利益 ¥7,716 は不変（二重計上なし）');
    if (d23) {
      check(d23.tip === 218 && d23.cnt === 1 && d23.base + d23.tip === d23.del && d23.total === 10683,
        '9/23: チップ ¥218（No.17 ローソン 靱本町三丁目・公式スクショ確認済み）・総売上 ¥10,683 は不変');
    }
    const tipDays = Object.entries(r.days).filter(([, v]) => v.attrs.split(',').includes('tip')).map(([k]) => k);
    check(tipDays.join() === Object.entries(r.days).filter(([, v]) => v.tip > 0).map(([k]) => k).join() && tipDays.includes('2026-09-22'),
      `♥ はチップのある日だけ（${tipDays.join(', ')}）`);
    check(d22.attrs === 'bike_share,adjustment,tip' && r.days['2026-09-19'].attrs === 'bike_share,special_bonus' && r.days['2026-09-21'].attrs === 'bike_share',
      `並び順 B → 調 → 🏆 → ♥（9/22: ${d22.attrs}）・既存の B/調/🏆 は不変`);
    check(Object.values(r.days).every(v => v.base === null || v.base + v.tip === v.del), '全日: 配達報酬（チップ除く）＋チップ＝配達報酬（最終売上の合計）');
    const w = r.w;
    check(w.base + w.tip + w.q + w.g + w.adj + w.oth === w.off && w.del === w.base + w.tip && w.legacyOther === w.adj + w.oth,
      `今週の内訳（配達報酬 ¥${w.base} ＋ チップ ¥${w.tip} ＋ クエスト ＋ 特別 ＋ 調整 ＋ その他）＝売上 ¥${w.off}`);
    const b = r.b;
    check(b.baseDeliverySales + b.tipSales + b.questSales + b.guaranteeBonus + b.adjustmentSales + b.otherSales === b.totalSales,
      `期間指定（9/1〜9/30）: 内訳の合計＝総売上 ¥${b.totalSales}・チップ累計 ¥${b.tipSales}（${b.tipCount}件）`);
    check(r.b22.tipSales === 50 && r.b22.totalSales === 9243 && r.b22.days === 1, '期間指定（9/22のみ）: チップ ¥50・総売上 ¥9,243');
  }

  // ==========================================================
  section('10-5. 履歴カレンダーの稼働状況（稼働／休み（手動・自動）／空欄）');
  {
    const r = runNode(`
      const map={uber_log_v1_data:JSON.stringify({version:'1.2',dailyLogs:{'2026-09-20':{date:'2026-09-20',workStartedAt:'10:00',totalDistanceKm:null,workSessions:[],deliveries:[],quests:[]}}})};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store,CONFIRMED_DAY_OFF_DATES}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const TODAY='2026-10-13';
      // 基準日（TODAY）の時点では、TODAY より後の実データ（後日の公式取込）はまだ無い。中身のない日に置き換えて判定から外す
      // （メモリ上だけ。後日の取込でこのテストの期待値は変わらない）
      Object.keys(store.state.dailyLogs).filter(d=>d>TODAY).forEach(d=>{store.state.dailyLogs[d]={date:d,deliveries:[],quests:[]};});
      const S=(d,t=TODAY)=>store.getDayStatus(d,t);
      const st={};for(let d=1;d<=30;d++){const k='2026-09-'+String(d).padStart(2,'0');st[k]=S(k);}
      const oct={};for(let d=1;d<=31;d++){const k='2026-10-'+String(d).padStart(2,'0');oct[k]=S(k);}
      st['2099-01-01']=S('2099-01-01');
      const m20=store.getCalculatedMetrics(store.state.dailyLogs['2026-09-20']);
      const cov=store.getUberOfficialCoverage();
      const before=JSON.stringify(store.state);
      const allStatus=[...Object.keys(st),...Object.keys(oct)].map(d=>S(d));
      const noMutation=JSON.stringify(store.state)===before;
      const workedBefore=store.getAllDailyLogs().filter(l=>store.isWorkedDay(l)).length;
      // 今日（10/13）に実績0件のまま日付が進んでも、後続日（10/14以降）の公式データが無ければ休みにしない
      const t1013Next=S('2026-10-13','2026-10-15');
      // 5. 自動休みの日（9/25）へ後から公式データが取り込まれた → 自動解除（稼働日）
      store.state.dailyLogs['2026-09-25']={date:'2026-09-25',tripsCount:3,deliveriesCount:3,totalDistanceKm:5,workSessions:[],quests:[],expenses:[],
        deliveries:[{id:'del_0925_1',index:1,completedAt:'10:00',restaurant:'テスト店',fee:500}],officialImport:{source:'official-import-v1',importedAt:'2026-10-13T00:00:00Z'}};
      const s925=S('2026-09-25');
      // 10/14 の公式データが取り込まれると、0件の 10/13 は（今日が過ぎていれば）自動休み
      store.state.dailyLogs['2026-10-14']={date:'2026-10-14',tripsCount:1,deliveriesCount:1,workSessions:[],quests:[],expenses:[],
        deliveries:[{id:'del_1014_1',index:1,completedAt:'10:00',restaurant:'テスト店',fee:400}],officialImport:{source:'official-import-v1',importedAt:'2026-10-15T00:00:00Z'}};
      const t1013After=S('2026-10-13','2026-10-15');
      // 6. 手動休み（dayOff: true）は自動処理で変更されない（未来日・公式データの後でも手動のまま）
      store.state.dailyLogs['2026-10-07']={date:'2026-10-07',dayOff:true,deliveries:[],quests:[]};
      store.state.dailyLogs['2026-10-20']={date:'2026-10-20',dayOff:true,deliveries:[],quests:[]};
      const manual={d1007:S('2026-10-07'),d1020:S('2026-10-20'),d0912:S('2026-09-12'),flag1007:store.state.dailyLogs['2026-10-07'].dayOff,list:CONFIRMED_DAY_OFF_DATES.join()};
      console.log(JSON.stringify({st,oct,cov,p20:m20.netProfit,has20:!!store.state.dailyLogs['2026-09-20'],noMutation,workedBefore,t1013Next,s925,t1013After,manual}));`);
    const byStatus = (o, s, src) => Object.keys(o).filter(k => o[k].status === s && (!src || o[k].statusSource === src));
    check(r.cov.startDate === '2026-09-10' && r.cov.latestDate >= '2026-10-12', `Uber運用開始日 ${r.cov.startDate}・公式データの最新日 ${r.cov.latestDate}`);
    check(byStatus(r.st, 'off', 'manual').join() === '2026-09-12,2026-09-13,2026-09-20', `手動の休み（statusSource: manual）: ${byStatus(r.st, 'off', 'manual').map(d => d.slice(5)).join(', ')}`);
    check(byStatus(r.st, 'off', 'auto').join() === '2026-09-25,2026-09-30', `1. 過去日・Uber実績0件・後続日データあり → 自動で休み（9月: ${byStatus(r.st, 'off', 'auto').map(d => d.slice(5)).join(', ')}）`);
    check(byStatus(r.oct, 'off', 'auto').join() === '2026-10-07', `1. 10月の自動休み: ${byStatus(r.oct, 'off', 'auto').map(d => d.slice(5)).join(', ')}`);
    const worked = byStatus(r.st, 'worked');
    check(['10', '11', '14', '15', '16', '17', '18', '19', '21', '22'].every(d => worked.includes(`2026-09-${d}`)) && byStatus(r.oct, 'worked').length === 11, `2. 実績のある過去日は通常表示（9月 ${worked.length}日・10月 ${byStatus(r.oct, 'worked').length}日）`);
    check(r.st['2026-09-22'].count === 25 && r.st['2026-09-22'].totalSales === 9243 && r.st['2026-09-19'].count === 23 && !r.st['2026-09-22'].statusSource, '稼働日の件数・売上は一覧と同じ日別データ（9/22 25件 ¥9,243）');
    check(r.oct['2026-10-13'].status === 'unknown' && r.t1013Next.status === 'unknown', '3. 今日・実績0件 → 休みにしない（翌日以降も後続日の公式データが無いうちは休みにしない）');
    check(r.oct['2026-10-14'].status === 'unknown' && r.oct['2026-10-31'].status === 'unknown' && r.st['2099-01-01'].status === 'unknown', '4. 未来日 → 休みにしない');
    check(['2026-09-01', '2026-09-09'].every(d => r.st[d].status === 'unknown'), 'Uber運用開始日（9/10）より前の日は休みにしない');
    check(r.s925.status === 'worked' && r.s925.count === 3 && !r.s925.statusSource,'5. 自動休みの日（9/25）へ後から公式データ追加 → 自動休みを解除して稼働日表示');
    check(r.t1013After.status === 'off' && r.t1013After.statusSource === 'auto', '5. 今日（10/13）が終わり後続日（10/14）の公式データが入った段階で 0件なら自動休み');
    check(r.manual.d1007.status === 'off' && r.manual.d1007.statusSource === 'manual' && r.manual.flag1007 === true && r.manual.d1020.status === 'off' && r.manual.d1020.statusSource === 'manual' && r.manual.d0912.statusSource === 'manual' && r.manual.list === '2026-09-12,2026-09-13,2026-09-20',
      '6. 手動休み（dayOff・確認済みリスト）は自動判定で変更されない（未来日の手動休みもそのまま）');
    check(r.noMutation, '7. 判定は表示時の計算だけ（日別データ・売上・件数・距離へ書き込まない）');
    check(r.has20 && r.st['2026-09-20'].status === 'off' && r.p20 === null, '9/20 は端末の日別データを残したまま「休み」・利益なし（一覧の「利益 --」は非表示）');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    const calSrc = uiSrc.slice(uiSrc.indexOf('renderHistoryCalendar() {'), uiSrc.indexOf('renderHistoryView(expandedDate'));
    check(calSrc.includes('>休み</span>') && !calSrc.includes('>休</span>') && !calSrc.includes('非稼働'), 'カレンダーの表記は「休み」に統一（「休」「非稼働日」を混在させない）');
  }

  // ==========================================================
  section('10-5b. 分析画面（必要経費・稼働日数・売上内訳・配達時間 HH:MM）');
  {
    const r = runNode(`
      const map={};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store,formatMinutesHHMM}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const snap=()=>{const r=store.getRevenueSummary('2026-10-13');const b=store.getSalesBreakdown('2026-10-01','2026-10-13');
        return {ms:r.thisMonth.sales,mp:r.thisMonth.salesProfit,me:r.thisMonth.expenses,wd:r.thisMonth.workedDays,ed:r.thisMonth.elapsedDays,cnt:r.thisMonth.deliveriesCount,
          we:r.thisWeek.expenses,wp:r.thisWeek.salesProfit,ws:r.thisWeek.officialSales,
          b:{t:b.totalSales,sum:b.baseDeliverySales+b.questSales+b.guaranteeBonus+b.tipSales+b.adjustmentSales+b.otherSales,e:b.expenses,base:b.baseDeliverySales,q:b.questSales,g:b.guaranteeBonus,tip:b.tipSales,adj:b.adjustmentSales,oth:b.otherSales}};};
      const before=snap();
      // 生データ（日別の保存値）を直接合計した10月（10/1〜10/13）の値。固定値ではなく同梱データから導く（公式取込で日が増えても正しい期待値になる）
      const sec=s=>{if(!s)return 0;let t=0;const h=s.match(/(\\d+)時間/),m=s.match(/(\\d+)分/),x=s.match(/(\\d+)秒/);if(h)t+=3600*h[1];if(m)t+=60*m[1];if(x)t+=+x[1];return t;};
      const pad=n=>String(n).padStart(2,'0');
      const raw={s:0,c:0,base:0,q:0,g:0,tip:0,adj:0,oth:0,hh:{}};
      Object.values(store.state.dailyLogs).filter(l=>l.date>='2026-10-01'&&l.date<='2026-10-13').forEach(l=>{
        const s=l.sales||{};const tips=(l.deliveries||[]).reduce((a,d)=>a+(Number(d.tip)||0),0);
        const sp=(l.quests||[]).filter(q=>q.questType==='special'&&!q.isDuplicateIgnored&&Number(q.amount)>0).reduce((a,q)=>a+Number(q.amount),0);
        raw.s+=(s.delivery||0)+(s.quest||0)+(s.adjustment||0)+(s.other||0)+(s.guaranteeBonus||0);raw.c+=Number(l.deliveriesCount)||0;
        raw.base+=(s.delivery||0)-tips;raw.q+=(s.quest||0)-sp;raw.g+=sp+(s.guaranteeBonus||0);raw.tip+=tips;raw.adj+=s.adjustment||0;raw.oth+=s.other||0;
        const t=(l.deliveries||[]).reduce((a,d)=>a+sec(d.durationStr),0);const mm=Math.floor(t/60);raw.hh[l.date]=pad(Math.floor(mm/60))+':'+pad(mm%60);});
      const d5=store.getRevenueSummary('2026-10-05').thisMonth;const d7=store.getRevenueSummary('2026-10-07').thisMonth;
      const sep=store.getRevenueSummary('2026-09-30').thisMonth;
      // 経費を登録（バイクシェア・必要経費・旧カテゴリ「駐輪」）→ 1件ずつ1回だけ必要経費に入る
      const day=store.getDailyLog('2026-10-12');
      day.expenses=[{id:'e1',category:'バイクシェア',amount:1527,memo:'1日パス'},{id:'e2',category:'必要経費',amount:300,memo:'x'},{id:'e3',category:'駐輪',amount:100,memo:'y'}];
      const after=snap();
      const dayExp=store.getCalculatedMetrics(day).totalExpenses;
      const cmp=store.getAnalytics().dailyComparison;
      const hh={a:formatMinutesHHMM(276),b:formatMinutesHHMM(379),c:formatMinutesHHMM(303),d:formatMinutesHHMM(725),e:formatMinutesHHMM(0),f:formatMinutesHHMM(59)};
      const allHH=cmp.every(d=>d.durationHHMM===null||(/^\\d{2}:\\d{2}$/.test(d.durationHHMM)&&d.durationHHMM===formatMinutesHHMM(Math.floor(d.workSeconds/60))));
      const c={};['2026-10-12','2026-10-11','2026-10-10'].forEach(k=>{const x=cmp.find(d=>d.date===k);c[k]=x&&x.durationHHMM;});
      console.log(JSON.stringify({before,after,d5:{w:d5.workedDays,e:d5.elapsedDays},d7:{w:d7.workedDays,e:d7.elapsedDays},sep:{s:sep.sales,e:sep.expenses,bk:sep.bikeExpenses,p:sep.salesProfit,w:sep.workedDays,ed:sep.elapsedDays},dayExp,hh,allHH,c,raw}));`);
    const b0 = r.before;
    check(b0.wd === 11 && b0.ed === 13, `1-2. 稼働日数 10/13 時点: ${b0.wd} / ${b0.ed}日（10/1〜10/12 のうち実績のある日・10/7 は休み・今日 10/13 は0件でも分母に含む）`);
    check(r.d5.w === 5 && r.d5.e === 5 && r.d7.w === 6 && r.d7.e === 7 && r.sep.w === 16 && r.sep.ed === 30, `稼働日数は基準日までの経過日数が分母（10/5: ${r.d5.w}/${r.d5.e}・10/7: ${r.d7.w}/${r.d7.e}・9/30: ${r.sep.w}/${r.sep.ed}）`);
    check(r.sep.e === 6561 && r.sep.bk === 6561 && r.sep.p === r.sep.s - 6561, `9月の必要経費 ¥${r.sep.e}（バイクシェア利用 4件）・売上利益 = 売上 − 必要経費（従来と同額）`);
    const a = r.after;
    check(r.dayExp === 1927 && a.me === 1927 && a.we === 1927 && a.b.e === 1927, `3. 必要経費に二重計上なし（バイクシェア ¥1,527 ＋ 必要経費 ¥300 ＋ 駐輪 ¥100 ＝ ¥1,927。月・週・期間指定・日別で同額）`);
    check(a.mp === a.ms - 1927 && a.wp === a.ws - 1927 && a.ms === b0.ms, '必要経費は売上利益から1回だけ差し引く（月・週とも）・売上は経費で変わらない');
    check(b0.b.sum === b0.b.t, `4. 売上内訳の合計 ＝ 総売上（¥${b0.b.t.toLocaleString()}）`);
    const raw = r.raw;
    check(b0.ms === b0.b.t && b0.ms === raw.s && b0.cnt === raw.c, `5. 今月の売上 ¥${b0.ms.toLocaleString()}・${b0.cnt}件 ＝ 売上内訳の総売上 ＝ 日別の保存値の直接合計（¥${raw.s.toLocaleString()}・${raw.c}件）`);
    check(b0.b.base === raw.base && b0.b.q === raw.q && b0.b.g === raw.g && b0.b.tip === raw.tip && b0.b.adj === raw.adj && b0.b.oth === raw.oth,
      `11. 10月の内訳 ＝ 日別の保存値の直接合計（配達報酬 ¥${raw.base.toLocaleString()} / クエスト ¥${raw.q.toLocaleString()} / 特別ボーナス ¥${raw.g.toLocaleString()} / チップ ¥${raw.tip} / 調整 ¥${raw.adj} / その他 ¥${raw.oth}）`);
    check(JSON.stringify(a.b) === JSON.stringify({ ...b0.b, e: a.b.e }), '11. 経費を登録しても売上内訳の各項目は変わらない');
    check(r.hh.a === '04:36' && r.hh.b === '06:19' && r.hh.c === '05:03' && r.hh.d === '12:05' && r.hh.e === '00:00' && r.hh.f === '00:59', '8-9. 配達時間 HH:MM（04:36・06:19・05:03・12:05・2桁ゼロ埋め）');
    check(r.allHH && ['2026-10-12', '2026-10-11', '2026-10-10'].every(k => r.c[k] === raw.hh[k]) && r.c['2026-10-11'] === '06:19' && r.c['2026-10-10'] === '05:03',
      `日別比較の配達時間 ＝ その日のトリップ所要時間の合計（10/12 ${r.c['2026-10-12']}・10/11 06:19・10/10 05:03。秒は切り捨て）`);
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    const pb = uiSrc.slice(uiSrc.indexOf('renderPeriodBreakdown() {'), uiSrc.indexOf('openTripMapModal(deliveryId)'));
    const labels = [...pb.matchAll(/\['([^']+)', /g)].map(m => m[1]);
    check(labels.join(',') === '配達報酬,クエスト,特別ボーナス,チップ,調整,その他,総売上', `7. 売上内訳の順番（${labels.join(' → ')}）`);
    check(!/tipCount/.test(pb) && !/Bike/.test(pb), '6. 売上内訳にチップ件数を表示しない・「Bike」表記なし（必要経費）');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const an = html.slice(html.indexOf('<main id="tab-analytics"'), html.indexOf('<main id="tab-avoidance"'));
    check(!/>Bike</.test(an) && !/>バイクシェア</.test(an) && (an.match(/>必要経費</g) || []).length === 2 && /id="month-worked-days-val"/.test(an), '1-2. 分析画面の「Bike」「バイクシェア」を「必要経費」に統一・今月の実績に「稼働日数」');
    check(/<th class="col-weather"[^>]*>天気<\/th>/.test(an) && /d\.weather/.test(uiSrc) && /weather-none">—</.test(uiSrc) && !/☀|🌧|☁/.test(an),
      '10. 日別比較に天気列（気象庁の観測だけを表示・未登録は「—」。HTML に固定の天気を書かない）');
    check(/d\.durationHHMM \|\| '--'/.test(uiSrc), '日別比較は durationHHMM を表示（記録なしは --）');
  }

  // ==========================================================
  section('10-5c. 分析画面の集計期間（今週・先週・今月・期間指定・全期間の分離 / aggregateForRange）');
  {
    // 合成データ（2099年。実データと重ならない）。基準日 2099-04-15（水）: 今週 04-13〜04-19 / 先週 04-06〜04-12 / 今月 04-01〜04-15
    const r = runNode(`
      const T=(id,fee,dur,tip)=>({id,index:1,completedAt:'10:00',restaurant:'テスト店',area:'',fee,distanceKm:1,durationStr:dur,memo:'',...(tip?{tip}:{})});
      const D=(date,cnt,sales,km,dur,extra={})=>({date,deliveriesCount:cnt,tripsCount:cnt,totalDistanceKm:km,workSessions:[],quests:[],expenses:[],
        sales:{delivery:sales.d||0,quest:sales.q||0,adjustment:sales.a||0,other:sales.o||0,total:(sales.d||0)+(sales.q||0)+(sales.a||0)+(sales.o||0)},
        deliveries:[T('t_'+date,sales.d||0,dur,extra.tip)],...extra});
      const logs={
        '2099-03-31':D('2099-03-31',5,{d:1000},10,'1時間0分0秒'),
        '2099-04-01':D('2099-04-01',2,{d:2000,q:300},20,'2時間0分0秒',{tip:100,expenses:[{id:'x1',category:'バイクシェア',amount:1527,memo:''}]}),
        '2099-04-07':D('2099-04-07',3,{d:3000},30,'3時間0分0秒',{expenses:[{id:'x2',category:'必要経費',amount:200,memo:''}]}),
        '2099-04-12':D('2099-04-12',4,{d:4000,q:1000},40,'4時間0分0秒',{quests:[{id:'q1',questName:'特別',title:'特別',amount:1000,time:'20:00',questType:'special'}]}),
        '2099-04-13':D('2099-04-13',6,{d:5000,a:-100,o:50},50,'5時間3分0秒',{expenses:[{id:'x3',category:'駐輪',amount:100,memo:''}]}),
        '2099-04-15':D('2099-04-15',1,{d:600},6,'0時間30分0秒'),
        '2099-04-25':D('2099-04-25',7,{d:7000},70,'7時間0分0秒',{expenses:[{id:'x4',category:'必要経費',amount:999,memo:''}]}),
        '2099-05-01':D('2099-05-01',8,{d:8000},80,'8時間0分0秒')
      };
      Object.values(logs).forEach(l=>{l.deliveries[0].tip=l.tip;delete l.tip;if(!l.deliveries[0].tip)delete l.deliveries[0].tip;});
      const map={uber_log_v1_data:JSON.stringify({version:'1.2',dailyLogs:logs})};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store,parseUberSalesText}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const rev=store.getRevenueSummary('2099-04-15');
      const pick=a=>({sales:a.totalSales,exp:a.expenses,profit:a.profit,cnt:a.deliveriesCount,days:a.workedDays,sec:a.workSeconds,km:a.distanceKm,reg:a.regularSales,avgD:a.avgDailyEarnings,avgP:a.avgPerDelivery,hh:a.durationHHMM,
        parts:[a.baseDeliverySales,a.questSales,a.guaranteeBonus,a.tipSales,a.adjustmentSales,a.otherSales]});
      const period=pick(store.getSalesBreakdown('2099-04-07','2099-04-12'));
      const all=pick(store.aggregateForRange(null,null));
      // 全期間の直接合計（稼働日の件数）
      let allCnt=0,allSales=0;store.getAllDailyLogs().forEach(l=>{const m=store.getCalculatedMetrics(l);if(store.isWorkedDay(l))allCnt+=m.count;allSales+=(m.totalSales||0);});
      const empty=store.getRevenueSummary('2099-08-10').thisMonth;
      // 旧売上テキスト取込: チップは「その他」に入らない
      const p1=parseUberSalesText('配達\\n¥3,000\\nチップ\\n¥200\\nクエスト\\n¥500\\n総売上\\n¥3,500');
      const p2=parseUberSalesText('配達\\n¥2,800\\nチップ\\n¥200\\nクエスト\\n¥500\\n総売上\\n¥3,500');
      const p3=parseUberSalesText('配達\\n¥3,000\\nチップ\\n¥200');
      const p4=parseUberSalesText('Multiple\\n¥300\\n総売上\\n¥300');
      const P=p=>({d:p.deliverySales,t:p.tipSales,o:p.otherSales,tot:p.totalSales,st:p.tipStatus});
      store.saveDailySales('2099-06-02',{delivery:p1.deliverySales,quest:p1.questSales,adjustment:p1.adjustmentSales,other:p1.otherSales,tip:p1.tipSales});
      const m62=store.getCalculatedMetrics(store.getDailyLog('2099-06-02'));
      const b62=store.getSalesBreakdown('2099-06-02','2099-06-02');
      // 公式取込の日は sales.tip を使わない（配達ごとの tip が正）
      const off=store.getDailyLog('2026-10-12');off.sales={...off.sales,tip:500};
      const mOff=store.getCalculatedMetrics(off);
      console.log(JSON.stringify({month:pick(store.aggregateForRange('2099-04-01','2099-04-15')),m:rev.thisMonth,week:pick(store.aggregateForRange('2099-04-13','2099-04-19')),
        w:{sales:rev.thisWeek.officialSales,exp:rev.thisWeek.expenses,profit:rev.thisWeek.salesProfit,cnt:rev.thisWeek.deliveriesCount,range:[rev.thisWeek.startDate,rev.thisWeek.endDate],
          parts:[rev.thisWeek.baseDeliverySales,rev.thisWeek.questSales,rev.thisWeek.guaranteeBonus,rev.thisWeek.tipSales,rev.thisWeek.adjustmentOnlySales,rev.thisWeek.otherOnlySales],
          prev:rev.thisWeek.prevWeek,diff:rev.thisWeek.prevWeekComparison.diffAmount},
        period,all,allCnt,allSales,empty:{s:empty.sales,c:empty.deliveriesCount,ad:empty.avgDailyEarnings,ap:empty.avgPerDelivery,hh:empty.durationHHMM,km:empty.distanceKm,wd:empty.workedDays,ed:empty.elapsedDays,p:empty.salesProfit},
        p1:P(p1),p2:P(p2),p3:P(p3),p4:P(p4),m62:{t:m62.tipSales,base:m62.baseDeliverySales,o:m62.otherSales,tot:m62.totalSales},b62:{tip:b62.tipSales,oth:b62.otherSales,tot:b62.totalSales},
        off:{t:mOff.tipSales,cnt:mOff.tipCount}}));`);
    const M = r.month, m = r.m;
    check(m.startDate === '2099-04-01' && m.endDate === '2099-04-15', `今月の範囲は当月1日〜基準日（${m.startDate}〜${m.endDate}）`);
    check(m.sales === 15850 && M.sales === 15850, `1. 今月に前月（3/31）・翌月（5/1）が混ざらない: 総売上 ¥${m.sales}（期待 ¥15,850）`);
    check(m.deliveriesCount === 16, `2. 今月件数は当月のみ ${m.deliveriesCount}件（期待 16件）`);
    check(m.workSeconds === 52380 && m.durationHHMM === '14:33', `3. 今月の配達時間は当月のみ ${m.durationHHMM}（期待 14:33）`);
    check(m.distanceKm === 146, `4. 今月の配達距離は当月のみ ${m.distanceKm}km（期待 146km）`);
    check(m.regularSales === 14800 && m.workedDays === 5 && m.avgDailyEarnings === 2960, `5. 今月平均日給は当月のみ ¥${m.avgDailyEarnings}（通常売上 ¥14,800 ÷ 5日。特別クエスト・その他は除外）`);
    check(m.avgPerDelivery === 925, `6. 今月平均単価は当月のみ ¥${m.avgPerDelivery}（¥14,800 ÷ 16件）`);
    check(r.w.range.join() === '2099-04-13,2099-04-19' && r.w.sales === 5550 && r.w.cnt === 7 && r.w.exp === 100 && r.w.profit === 5450, `7. 今週（月〜日）に先週が混ざらない: 売上 ¥${r.w.sales} / ${r.w.cnt}件 / 必要経費 ¥${r.w.exp} / 利益 ¥${r.w.profit}`);
    check(r.w.prev.startDate === '2099-04-06' && r.w.prev.sales === 8000 && r.w.prev.expenses === 200 && r.w.prev.salesProfit === 7800, `8. 先週に今週が混ざらない: 先週 売上 ¥${r.w.prev.sales} / 利益 ¥${r.w.prev.salesProfit}`);
    check(r.w.diff === 5450 - 7800, `先週比は「今週の売上利益 − 先週の売上利益」（同じ種類の比較） ${r.w.diff}`);
    check(r.period.sales === 8000 && r.period.cnt === 7 && r.period.days === 2 && r.period.exp === 200, `9. 期間指定（4/7〜4/12）に外側が混ざらない: ¥${r.period.sales} / ${r.period.cnt}件 / ${r.period.days}日`);
    check(r.all.cnt === r.allCnt && r.all.sales === r.allSales && r.all.cnt > M.cnt + 5, `10. 全期間は全期間（${r.all.cnt}件 / ¥${r.all.sales.toLocaleString()} = 全日別データの直接合計）`);
    check(m.expenses === 1827 && m.bikeExpenses === 1527 && m.otherExpenses === 200 && m.salesProfit === 15850 - 1827, `11. 必要経費は1件1回（バイクシェア ¥1,527 ＋ 駐輪 ¥100 ＋ 必要経費 ¥200 ＝ ¥1,827。4/25 の未来分は含めない）・利益 ¥${m.salesProfit}`);
    const sum = a => a.reduce((s, x) => s + x, 0);
    check(sum(M.parts) === M.sales && sum(r.week.parts) === r.week.sales && sum(r.w.parts) === r.w.sales && sum(r.period.parts) === r.period.sales,
      `12. 売上内訳の合計 ＝ 総売上（今月 [${M.parts.join(', ')}]・今週・期間指定）`);
    check(M.parts.join() === '14500,300,1000,100,-100,50', '内訳: 配達報酬 ¥14,500 / クエスト ¥300 / 特別ボーナス ¥1,000 / チップ ¥100 / 調整 -¥100 / その他 ¥50（重複なし）');
    check(m.sales === M.sales && r.w.sales === r.week.sales, '13. 上部の売上（今月・今週）＝ 同じ期間の売上内訳の総売上');
    check(r.p1.st === 'included' && r.p1.d === 3000 && r.p1.t === 200 && r.p1.o === 0 && r.p1.tot === 3500, `14. 旧取込: チップ込みの配達（総売上で確認）→ 配達報酬 ¥3,000・うちチップ ¥200・その他 ¥0`);
    check(r.p2.st === 'separate' && r.p2.d === 3000 && r.p2.t === 200 && r.p2.o === 0 && r.p2.tot === 3500, `14. 旧取込: チップ別の配達 → 配達報酬 ¥3,000（¥2,800＋チップ）・うちチップ ¥200・その他 ¥0・総売上 ¥3,500`);
    check(r.p3.st === 'unknown' && r.p3.t === 0 && r.p3.o === 0 && r.p3.d === 3000, '14. 旧取込: 総売上の行が無くチップの扱いを判定できない → 配達報酬・その他に推測で入れない');
    check(r.p4.st === 'none' && r.p4.o === 0, '「Multiple」等の単語の一部をチップと誤検知しない');
    check(r.m62.t === 200 && r.m62.base === 2800 && r.m62.o === 0 && r.m62.tot === 3500 && r.b62.tip === 200 && r.b62.oth === 0 && r.b62.tot === 3500,
      '14. 旧取込で登録した日: チップ ¥200 はチップ（配達報酬 ¥2,800 ＋ チップ ¥200）、その他 ¥0、総売上 ¥3,500（二重計上なし）');
    check(r.off.t === 0, '公式取込の日は sales.tip を使わない（配達ごとの tip が正・二重計上しない）');
    const e = r.empty;
    check(e.s === 0 && e.c === 0 && e.ad === null && e.ap === null && e.hh === '00:00' && e.km === 0 && e.wd === 0 && e.ed === 10 && e.p === 0, '15. 0件の月でもクラッシュしない（売上 ¥0・件数 0・平均 --・配達時間 00:00・稼働 0 / 10日）');
    check(m.sales === 15850 && m.expenses === 1827, '16. 未来日（4/25 の売上 ¥7,000・経費 ¥999）は今月の集計に入らない');
  }

  // ==========================================================
  section('10-5d. 分析画面の実データ照合（2026年10月・日別データの直接合計 / 日別比較）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const TODAY='2026-10-13';
      // 日別の生データを直接合計（集計関数を使わない）
      const sec=s=>{if(!s)return 0;let t=0;const h=s.match(/(\\d+)時間/),m=s.match(/(\\d+)分/),x=s.match(/(\\d+)秒/);if(h)t+=3600*h[1];if(m)t+=60*m[1];if(x)t+=+x[1];return t;};
      const raw={days:0,cnt:0,sales:0,special:0,sec:0,km:0,exp:0};
      Object.values(store.state.dailyLogs).filter(l=>l.date>='2026-10-01'&&l.date<=TODAY).forEach(l=>{
        const c=Number(l.deliveriesCount)||0;if(c>0)raw.days++;raw.cnt+=c;
        raw.sales+=(l.sales?Number(l.sales.total)||0:0)+(l.sales?Number(l.sales.guaranteeBonus)||0:0);
        raw.special+=(l.quests||[]).filter(q=>q.questType==='special'&&!q.isDuplicateIgnored&&Number(q.amount)>0).reduce((s,q)=>s+Number(q.amount),0);
        raw.sec+=(l.deliveries||[]).reduce((s,d)=>s+sec(d.durationStr),0);raw.km+=Number(l.totalDistanceKm)||0;
        raw.exp+=(l.expenses||[]).reduce((s,e)=>s+(Number(e.amount)>0?Number(e.amount):0),0);});
      raw.km=Number(raw.km.toFixed(2));
      const m=store.getRevenueSummary(TODAY).thisMonth;
      const b=store.getSalesBreakdown('2026-10-01',TODAY);
      // 日別比較の各行 ＝ その日1日だけの集計
      const rows=store.getAnalytics().dailyComparison;
      const rowOk=rows.every(d=>{const a=store.aggregateForRange(d.date,d.date);const mm=store.getCalculatedMetrics(store.state.dailyLogs[d.date]);
        return d.count===a.deliveriesCount&&d.regularSales===a.regularSales&&d.workSeconds===a.workSeconds&&d.totalSales===a.totalSales&&d.distance===mm.totalDistanceKm;});
      const s1012=(store.state.dailyLogs['2026-10-12'].deliveries||[]).reduce((a,d)=>a+sec(d.durationStr),0);const m1012=Math.floor(s1012/60);
      const hh1012=String(Math.floor(m1012/60)).padStart(2,'0')+':'+String(m1012%60).padStart(2,'0');
      console.log(JSON.stringify({raw,m,b:{t:b.totalSales,days:b.days,cnt:b.deliveriesCount},rowOk,rows:rows.length,r1012:rows.find(d=>d.date==='2026-10-12'),hh1012}));`);
    const raw = r.raw, m = r.m;
    check(m.sales === raw.sales && m.sales === r.b.t, `今月売上 ¥${m.sales.toLocaleString()} ＝ 日別データの直接合計 ¥${raw.sales.toLocaleString()} ＝ 売上内訳の総売上`);
    check(m.salesProfit === raw.sales - raw.exp && m.expenses === raw.exp, `今月利益 ¥${m.salesProfit.toLocaleString()}・必要経費 ¥${m.expenses.toLocaleString()}（直接合計と一致）`);
    check(m.deliveriesCount === raw.cnt && m.workedDays === raw.days && m.elapsedDays === 13, `今月件数 ${m.deliveriesCount}件・稼働日数 ${m.workedDays} / ${m.elapsedDays}日（直接合計 ${raw.cnt}件・${raw.days}日）`);
    check(m.workSeconds === raw.sec && m.distanceKm === raw.km, `今月配達時間 ${m.durationHHMM}・配達距離 ${m.distanceKm}km（直接合計と一致）`);
    check(m.avgDailyEarnings === Math.round((raw.sales - raw.special) / raw.days) && m.avgPerDelivery === Math.round((raw.sales - raw.special) / raw.cnt),
      `今月平均日給 ¥${m.avgDailyEarnings}・平均単価 ¥${m.avgPerDelivery}（通常売上 ＝ 総売上 − 特別クエスト ¥${raw.special.toLocaleString()} で直接計算と一致）`);
    check(r.rowOk && r.rows > 0 && r.r1012.durationHHMM === r.hh1012, `日別比較 ${r.rows}行: 件数・通常売上・配達時間・総売上・距離が日別データと一致（10/12 ${r.hh1012} ＝ トリップ所要時間の合計）`);
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    const av = uiSrc.slice(uiSrc.indexOf('renderAnalyticsView() {'), uiSrc.indexOf('renderAvoidanceView() {'));
    check(!/analytics\.(totalDeliveries|avgDailyEarnings|avgPerDelivery|totalDurationText|totalDistanceSum|totalSalesSum)/.test(av), '今月の実績は全期間（getAnalytics）の値を使わない（rev.thisMonth のみ）');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const an = html.slice(html.indexOf('<main id="tab-analytics"'), html.indexOf('<main id="tab-avoidance"')).replace(/<!--[\s\S]*?-->/g, '');
    const labels = [...an.matchAll(/class="(?:stat-card-label|breakdown-label)">([^<]+)</g)].map(x => x[1]);
    check(labels.join(',') === '配達報酬,チップ,クエスト,特別ボーナス,調整,その他,必要経費,配達件数,総売上,配達件数,平均日給,平均単価,配達時間,配達距離,必要経費,稼働 / 休み'
      && !/Bike|バイク|>経費</.test(an), `分析画面の名称を統一（${labels.join('・')}。「Bike」「バイク」「経費」の旧表記なし）`);
  }

  // ==========================================================
  section('10-6. 日本の祝日（年ごとの計算）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
      const m=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const days=['2026-09-21','2026-09-22','2026-09-23','2026-09-19','2026-09-26','2026-10-12','2026-11-03','2026-11-23','2026-05-06','2025-02-24','2025-11-24','2027-03-22','2027-01-11','2028-09-22'];
      const out={};days.forEach(d=>out[d]=m.getJapanHolidayName(d));
      console.log(JSON.stringify(out));`);
    check(r['2026-09-21'] === '敬老の日' && r['2026-09-22'] === '国民の休日' && r['2026-09-23'] === '秋分の日', '2026/9/21 敬老の日・9/22 国民の休日・9/23 秋分の日');
    check(r['2026-09-19'] === null && r['2026-09-26'] === null, '祝日でない土曜は祝日にしない');
    check(r['2026-10-12'] === 'スポーツの日' && r['2026-11-03'] === '文化の日' && r['2026-11-23'] === '勤労感謝の日', '2026年10〜11月の祝日（スポーツの日・文化の日・勤労感謝の日）');
    check(r['2026-05-06'] === '振替休日' && r['2025-02-24'] === '振替休日' && r['2025-11-24'] === '振替休日' && r['2027-03-22'] === '振替休日', '振替休日（2025/2/24・2025/11/24・2026/5/6・2027/3/22）');
    check(r['2027-01-11'] === '成人の日' && r['2028-09-22'] === '秋分の日', '他の年（2027年成人の日・2028年秋分の日）もハードコードなしで判定');
  }

  // ==========================================================
  section('10-7. 日別一覧の 🏆（特別ボーナス系: 新規保証・特別収入／特別クエスト。旧「賞」は廃止して統一）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const m=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});const s=m.store;
      const attrs={};s.getAllDailyLogs().forEach(l=>{attrs[l.date]=s.getDayAttributes(l.date).map(a=>a.key+':'+a.label+':'+a.className);});
      const trophies=d=>s.getDayAttributes(d).filter(a=>a.label==='🏆').length;
      // 同じ日に特別クエストが2件ある場合も 🏆 は1個
      const log=JSON.parse(JSON.stringify(s.getDailyLog('2026-09-24')));
      log.quests.push({id:'q_extra',time:'20:00',title:'クエスト',amount:1000,isDuplicateIgnored:false,questName:'100回乗車クエスト',questType:'special'});
      s.state.dailyLogs['2099-01-01']=Object.assign(log,{date:'2099-01-01'});
      const two=trophies('2099-01-01');
      // 通常クエストだけの日（questType: normal）
      const normal=JSON.parse(JSON.stringify(s.getDailyLog('2026-09-24')));
      normal.quests=normal.quests.filter(q=>q.questType!=='special');
      s.state.dailyLogs['2099-01-02']=Object.assign(normal,{date:'2099-01-02'});
      const none=trophies('2099-01-02');
      // 新規保証・特別収入と特別クエストが同じ日にある場合も 🏆 は1個（内部データは別々のまま）
      const both=JSON.parse(JSON.stringify(s.getDailyLog('2026-09-24')));
      both.sales=Object.assign({},both.sales||{},{guaranteeBonus:5000,guaranteeBonusNote:'テスト保証'});
      s.state.dailyLogs['2099-01-03']=Object.assign(both,{date:'2099-01-03'});
      const mb=s.getCalculatedMetrics(s.state.dailyLogs['2099-01-03']);
      const bothN=trophies('2099-01-03');
      const labels=Object.values(m.DAY_ATTRIBUTE_DEFINITIONS).map(d=>d.label);
      // 期待値は保存データから直接判定（集計コードを通さない）: 新規保証・特別収入 > 0、または特別クエスト（重複除外でない・金額 > 0）がある日
      const expected=s.getAllDailyLogs().filter(l=>!l.date.startsWith('2099-')).filter(l=>Number((l.sales||{}).guaranteeBonus)>0
        ||(l.quests||[]).some(q=>q.questType==='special'&&!q.isDuplicateIgnored&&Number(q.amount)>0)).map(l=>l.date);
      console.log(JSON.stringify({attrs,two,none,bothN,bothG:mb.guaranteeBonus,bothSq:mb.specialQuestSales,labels,hasSQdef:!!m.DAY_ATTRIBUTE_DEFINITIONS.special_quest,expected}));`);
    const a24 = r.attrs['2026-09-24'] || [];
    const a19 = r.attrs['2026-09-19'] || [];
    check(a19.map(x => x.split(':')[1]).join(' ') === 'B 🏆', `9/19（新規保証 ¥12,132）は「賞」ではなく 🏆（${a19.map(x => x.split(':')[1]).join(' ')}）`);
    check(a24.filter(x => x.split(':')[1] === '🏆').length === 1, `9/24（特別クエスト ¥8,890）は 🏆 を1個のまま（${a24.map(x => x.split(':')[1]).join(' ')}）`);
    check([...a19, ...a24].filter(x => x.split(':')[1] === '🏆').every(x => x.endsWith(':attr-bonus attr-quest-trophy')), '🏆 は従来の金色系（attr-bonus）を使用');
    check(!r.labels.includes('賞') && !Object.values(r.attrs).some(v => v.some(x => x.split(':')[1] === '賞')), '日別属性から「賞」を廃止（どの日にも出ない）');
    const withTrophy = Object.entries(r.attrs).filter(([k, v]) => !k.startsWith('2099-') && v.some(x => x.split(':')[1] === '🏆')).map(([k]) => k).sort();
    const expectedTrophy = [...r.expected].sort();
    // 取込で実データが増えても壊れないよう、期待する日は保存データ（新規保証・特別クエスト）から判定する。
    // 既知の確定日（9/19 新規保証・9/24 80回・9/27 50回・10/11 70回乗車クエスト）は必ず含まれること
    const knownTrophy = ['2026-09-19', '2026-09-24', '2026-09-27', '2026-10-11'];
    check(withTrophy.join() === expectedTrophy.join() && knownTrophy.every(d => withTrophy.includes(d)),
      `🏆 は特別ボーナス系のある日だけ（表示 ${withTrophy.join(', ')} / データ上 ${expectedTrophy.join(', ')}）`);
    check(r.two === 1 && r.none === 0, '特別クエストが複数でも 🏆 は1個・通常クエストだけの日は表示しない');
    check(r.bothN === 1 && r.bothG === 5000 && r.bothSq === 8890, '新規保証と特別クエストが同じ日でも 🏆 は1個（内部は guaranteeBonus / specialQuestSales で別管理）');
    const order = ['bike_share', 'adjustment', 'special_bonus', 'tip'];
    check(Object.values(r.attrs).every(v => v.map(x => order.indexOf(x.split(':')[0])).every((n, i, arr) => n >= 0 && (i === 0 || arr[i - 1] <= n))), '並び順 B → 調 → 🏆 → ♥');
    check(r.attrs['2026-09-22'].map(x => x.split(':')[1]).join(' ') === 'B 調 ♥', '9/22「B 調 ♥」は変更なし');
  }

  // ==========================================================
  section('10-8. 分析の売上内訳: 特別クエスト → 特別ボーナス（通常クエストはクエスト）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      // 検証用: 9/24 までの日だけで集計（9/26 以降の取込で今週の値が変わらないよう対象日を固定。10-9 と同じ）
      store.state.dailyLogs=Object.fromEntries(store.getAllDailyLogs().filter(l=>l.date<='2026-09-24').map(l=>[l.date,l]));
      const w=store.getRevenueSummary('2026-09-24').thisWeek;
      const pick=b=>({q:b.questSales,g:b.guaranteeBonus,go:b.guaranteeOnlySales,sq:b.specialQuestSales,t:b.totalSales,base:b.baseDeliverySales,tip:b.tipSales,adj:b.adjustmentSales,oth:b.otherSales});
      const d24=store.getCalculatedMetrics(store.getDailyLog('2026-09-24'));
      console.log(JSON.stringify({
        w:{q:w.questSales,g:w.guaranteeBonus,go:w.guaranteeOnlySales,sq:w.specialQuestSales,off:w.officialSales,p:w.salesProfit,sum:w.baseDeliverySales+w.tipSales+w.questSales+w.guaranteeBonus+w.adjustmentOnlySales+w.otherOnlySales},
        p0921:pick(store.getSalesBreakdown('2026-09-21','2026-09-25')),
        p0924:pick(store.getSalesBreakdown('2026-09-24','2026-09-24')),
        p0923:pick(store.getSalesBreakdown('2026-09-23','2026-09-23')),
        p0919:pick(store.getSalesBreakdown('2026-09-19','2026-09-19')),
        month:pick(store.getSalesBreakdown('2026-09-01','2026-09-30')),
        prev:store.getRevenueSummary('2026-09-20').thisWeek,
        d24:{q:d24.questSales,t:d24.totalSales,sq:d24.specialQuestSales}
      }));`);
    check(r.w.q === 4650 && r.w.g === 8890 && r.w.sq === 8890 && r.w.go === 0, `今週（9/21〜）: クエスト ¥${r.w.q} / 特別ボーナス ¥${r.w.g}（うち特別クエスト ¥${r.w.sq}）`);
    check(r.w.off === 41405 && r.w.sum === 41405 && r.w.p === 38351, `総売上 ¥41,405・売上利益 ¥38,351 は不変（内訳の合計 ¥${r.w.sum}）`);
    check(r.p0921.q === 4650 && r.p0921.g === 8890 && r.p0921.t === 41405, '期間指定 9/21〜9/25: クエスト ¥4,650 / 特別ボーナス ¥8,890 / 総売上 ¥41,405');
    check(r.p0924.q === 600 && r.p0924.g === 8890 && r.p0924.t === 17189, '期間指定 9/24: 通常クエスト ¥600 はクエスト・特別クエスト ¥8,890 は特別ボーナス・総売上 ¥17,189');
    check(r.p0923.q === 1650 && r.p0923.g === 0, '特別クエストの無い日（9/23）はクエスト ¥1,650・特別ボーナス ¥0 のまま');
    const sumOk = b => b.base + b.tip + b.q + b.g + b.adj + b.oth === b.t;
    check([r.p0921, r.p0924, r.p0923, r.p0919, r.month].every(sumOk), '二重計上なし: どの期間も 配達報酬＋チップ＋クエスト＋特別ボーナス＋調整＋その他 ＝ 総売上');
    check(r.p0919.g === 12132 && r.p0919.go === 12132 && r.p0919.sq === 0 && r.prev.guaranteeBonus === 12132 && r.prev.officialSales === 43461,
      '既存の特別収入（9/19 新規保証 ¥12,132）は特別ボーナスのまま・確定週 ¥43,461 不変');
    check(r.month.g === 12132 + 8890 && r.month.go === 12132 && r.month.sq === 8890, `今月: 特別ボーナス ¥${r.month.g}（特別収入 ¥12,132 ＋ 特別クエスト ¥8,890）`);
    check(r.d24.q === 9490 && r.d24.sq === 8890 && r.d24.t === 17189, '日別（9/24）はクエスト合計 ¥9,490 のまま（日別詳細の表示は変更なし）');
  }

  // ==========================================================
  section('10-9. 効率指標（平均日給・平均単価・通常時給）から特別クエストを除外');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const logs=store.getAllDailyLogs().filter(l=>l.date<='2026-09-24');
      // 検証用: 9/24 までの日だけで集計（今後の取込で値が変わらないよう対象日を固定）
      store.state.dailyLogs=Object.fromEntries(logs.map(l=>[l.date,l]));
      const a=store.getAnalytics();
      const d24=store.getCalculatedMetrics(store.getDailyLog('2026-09-24'));
      const d23=store.getCalculatedMetrics(store.getDailyLog('2026-09-23'));
      const d19=store.getCalculatedMetrics(store.getDailyLog('2026-09-19'));
      const r=store.getRevenueSummary('2026-09-24');
      const c24=a.dailyComparison.find(x=>x.date==='2026-09-24');
      console.log(JSON.stringify({reg:a.totalRegularSalesSum,days:a.activeDaysCount,cnt:a.totalDeliveries,avgDaily:a.avgDailyEarnings,avgPer:a.avgPerDelivery,total:a.totalSalesSum,
        d24:{hb:d24.hourlyBaseSales,hw:d24.hourlyWage,t:d24.totalSales,p:d24.netProfit,q:d24.questSales,sq:d24.specialQuestSales,sec:d24.workSeconds},
        d23:{hb:d23.hourlyBaseSales,t:d23.totalSales},d19:{hb:d19.hourlyBaseSales,t:d19.totalSales,g:d19.guaranteeBonus},
        c24:{reg:c24.regularSales,hw:c24.hourlyWage},
        month:{s:r.thisMonth.sales,p:r.thisMonth.salesProfit},week:{s:r.thisWeek.officialSales,p:r.thisWeek.salesProfit,g:r.thisWeek.guaranteeBonus,q:r.thisWeek.questSales}}));`);
    check(r.d24.hb === 8299 && r.d24.t === 17189 && r.d24.p === 17189, `9/24 通常分析売上 ¥${r.d24.hb}（¥7,699 ＋ 通常クエスト ¥600。特別クエスト ¥8,890 を除外）・総売上 ¥17,189 / 利益は不変`);
    check(r.d24.hw === Math.round(8299 / (r.d24.sec / 3600)) && r.c24.reg === 8299 && r.c24.hw === Math.round(r.d24.hw / 10) * 10, `9/24 通常時給 ¥${r.d24.hw}（日別比較の表示 ¥${r.c24.hw}）は特別クエストを除いた通常分析売上で計算`);
    check(r.d23.hb === r.d23.t && r.d23.hb === 10683, '特別クエストの無い日（9/23）は通常クエスト込みのまま（¥10,683）');
    check(r.d19.hb === 21310 - 12132 && r.d19.g === 12132, '既存の大型特別ボーナス（9/19 新規保証 ¥12,132）の除外は従来どおり');
    const expectedReg = 76498 - 8890;
    check(r.reg === expectedReg && r.days === 12 && r.cnt === 152, `今月（9/24まで）の通常分析売上 ¥${r.reg}（¥76,498 − 特別クエスト ¥8,890）`);
    check(r.avgDaily === Math.round(expectedReg / 12) && r.avgDaily === 5634, `平均日給 ¥${r.avgDaily}（¥67,608 ÷ 12日）`);
    check(r.avgPer === Math.round(expectedReg / 152) && r.avgPer === 445, `平均単価 ¥${r.avgPer}（¥67,608 ÷ 152件）`);
    check(r.total === 88630 && r.month.s === 88630 && r.month.p === 82069, '総売上 ¥88,630・今月の売上利益 ¥82,069 は不変（特別クエストを含む）');
    check(r.week.s === 41405 && r.week.p === 38351 && r.week.g === 8890 && r.week.q === 4650, '今週の総売上 ¥41,405・売上利益 ¥38,351・特別ボーナス ¥8,890（特別クエスト）は不変');
  }

  // ==========================================================
  section('10-10. バイクシェア1日パスの初期値 ¥1,527（既存経費は書き換えない）');
  {
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    const block = uiSrc.slice(uiSrc.indexOf('const EXPENSE_TYPE_PRESETS'), uiSrc.indexOf('// 画面を開いた時は'));
    // 実際のプリセット処理（ui.js の該当部分）を偽の入力欄で動かす
    const fake = () => ({ value: '' });
    const els = { 'expense-input-type': fake(), 'expense-input-content': fake(), 'expense-input-amount': fake() };
    const document = { getElementById: id => els[id] };
    const applyPreset = new Function('document', `${block}; return applyPreset;`)(document);
    els['expense-input-type'].value = 'バイクシェア';
    applyPreset('バイクシェア');
    check(els['expense-input-content'].value === 'バイクシェア1日パス' && els['expense-input-amount'].value === '1527', `バイクシェア選択時: 「${els['expense-input-content'].value} / ¥${els['expense-input-amount'].value}」`);
    els['expense-input-amount'].value = '2000';
    check(parseInt(els['expense-input-amount'].value, 10) === 2000, '自動入力後に金額を手動で変更できる（登録は入力欄の値を使用）');
    applyPreset('必要経費');
    check(els['expense-input-content'].value === '' && els['expense-input-amount'].value === '', '必要経費に戻すと内容・金額は空欄');
    check(!/amount:\s*'527'/.test(uiSrc), '旧初期値 ¥527 は残っていない');
    const r = runNode(`
      const map={uber_log_v1_data:JSON.stringify({version:'1.2',dailyLogs:{'2026-09-24':{date:'2026-09-24',expenses:[{id:'exp_old527',category:'バイクシェア',amount:527,memo:'バイクシェア1日パス'}]}}})};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const e=(store.getDailyLog('2026-09-24').expenses||[]).find(x=>x.id==='exp_old527');
      console.log(JSON.stringify({amt:e&&e.amount}));`);
    check(r.amt === 527, `登録済みの経費（¥527 で登録済みの分）は書き換えない（¥${r.amt}）`);
  }

  // ==========================================================
  section('10-11. 稼働日の共通判定（日別履歴一覧・日別比較・カレンダー）');
  {
    const r = runNode(`
      const map={};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const m0=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const today='2099-02-10';
      delete require.cache[require.resolve(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))})];
      const logs={
        '2026-09-20':{date:'2026-09-20',workStartedAt:'10:00',workEndedAt:null,totalDistanceKm:null,workSessions:[{id:'ws1',start:'10:00',end:null}],deliveries:[],quests:[]},
        '2099-02-01':{date:'2099-02-01',expenses:[{id:'e1',category:'必要経費',amount:300,memo:'x'}],deliveries:[],quests:[]},
        '2099-02-02':{date:'2099-02-02',deliveries:[],quests:[],workSessions:[]},
        '2099-02-03':{date:'2099-02-03',workSessions:[{id:'ws2',start:'09:00',end:'12:00'}],deliveries:[],quests:[]},
        '2099-02-04':{date:'2099-02-04',deliveriesCount:0,sales:{delivery:0},deliveries:[],quests:[]}
      };
      logs[today]={date:today,workStartedAt:'09:00',workSessions:[{id:'ws3',start:'09:00',end:null}],deliveries:[],quests:[]};
      map.uber_log_v1_data=JSON.stringify({version:'1.2',dailyLogs:logs});
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      store.getTodayDateString=()=>today;
      const w=d=>store.isWorkedDay(d);
      const cmp=()=>store.getAnalytics().dailyComparison.map(x=>x.date);
      store.addDelivery(today,'10:00'); // 手動タップ（店舗名・報酬なし）
      const todayTap={worked:w(today),inCmp:cmp().includes(today),status:store.getDayStatus(today).status};
      store.getDailyLog(today).deliveries.push({id:'d_real',index:2,completedAt:'10:30',restaurant:'テスト店',area:'',fee:500,distanceKm:null,durationStr:'',memo:''});
      const todayReal={worked:w(today),inCmp:cmp().includes(today),status:store.getDayStatus(today).status};
      store.getDailyLog(today).deliveries=[];
      const st={};['2026-09-12','2026-09-13','2026-09-20'].forEach(d=>st[d]=store.getDayStatus(d).status);
      const l20=store.state.dailyLogs['2026-09-20'];
      // 既存の稼働日（9/24まで）の値
      const a=store.getAnalytics();
      const c22=a.dailyComparison.find(x=>x.date==='2026-09-22');
      const m22=store.getCalculatedMetrics(store.getDailyLog('2026-09-22'));
      const m24=store.getCalculatedMetrics(store.getDailyLog('2026-09-24'));
      const b=store.getSalesBreakdown('2026-09-01','2026-09-24');
      const logs24=store.getAllDailyLogs().filter(l=>l.date<='2026-09-24');
      store.state.dailyLogs=Object.fromEntries(logs24.map(l=>[l.date,l]));
      const a24=store.getAnalytics();
      console.log(JSON.stringify({today,todayTap,todayReal,
        others:{exp:w('2099-02-01'),empty:w('2099-02-02'),ws:w('2099-02-03'),zero:w('2099-02-04'),none:w('2099-02-05')},
        cmp:a.dailyComparison.map(x=>x.date),st,
        keep20:{ws:l20&&l20.workStartedAt,sess:l20&&l20.workSessions&&l20.workSessions.length},
        c22:{c:c22.count,t:c22.totalSales},m22:{c:m22.count,t:m22.totalSales,p:m22.netProfit,hw:m22.hourlyWage},m24:{c:m24.count,t:m24.totalSales,p:m24.netProfit,hw:m24.hourlyWage},
        bdays:b.days,btotal:b.totalSales,
        a24:{days:a24.activeDaysCount,cnt:a24.totalDeliveries,avgDaily:a24.avgDailyEarnings,avgPer:a24.avgPerDelivery,total:a24.totalSalesSum,cmp:a24.dailyComparison.length}}));`);
    check(r.cmp.every(d => !['2026-09-12', '2026-09-13', '2026-09-20'].includes(d)) && !r.cmp.some(d => d.startsWith('2099-02-')), `日別比較に 9/20（稼働開始時刻・workSessionだけ）・9/12・9/13・非稼働の日は出ない（${r.cmp.length}日）`);
    check(r.st['2026-09-20'] === 'off' && r.st['2026-09-12'] === 'off' && r.st['2026-09-13'] === 'off', 'カレンダーでは 9/12・9/13・9/20 は「休み」のまま');
    check(r.keep20.ws === '10:00' && r.keep20.sess === 1, '9/20 の稼働開始時刻・workSession は削除しない（表示だけ除外）');
    check(!r.todayTap.worked && !r.todayTap.inCmp && r.todayTap.status === 'unknown', `今日（${r.today}）: 稼働開始・手動タップだけなら非稼働（一覧・日別比較に出さない・「休」にもしない）`);
    check(r.todayReal.worked && r.todayReal.inCmp && r.todayReal.status === 'worked', '今日に配達実績が1件入ると自動で稼働日（一覧・日別比較に表示）');
    check(!r.others.exp && !r.others.empty && !r.others.ws && !r.others.zero && !r.others.none, '経費だけ・空レコード・workSessionだけ・0件/売上0・データなしの日は稼働日ではない');
    const expected = ['10', '11', '14', '15', '16', '17', '18', '19', '21', '22', '23', '24'].map(d => `2026-09-${d}`);
    check(expected.every(d => r.cmp.includes(d)), '既存の稼働日（9/10〜9/24 の12日）は日別比較に表示');
    check(r.c22.c === 25 && r.c22.t === 9243 && r.m22.c === 25 && r.m22.t === 9243 && r.m24.c === 22 && r.m24.t === 17189 && r.m24.p === 17189, '既存稼働日の件数・売上・利益は不変（9/22 25件 ¥9,243 / 9/24 22件 ¥17,189）');
    check(r.a24.days === 12 && r.a24.cnt === 152 && r.a24.avgDaily === 5634 && r.a24.avgPer === 445 && r.a24.total === 88630 && r.a24.cmp === 12,
      `端末に 9/20 の稼働開始データがあっても稼働日数 ${r.a24.days}日・平均日給 ¥${r.a24.avgDaily}・平均単価 ¥${r.a24.avgPer}・総売上 ¥88,630 は不変`);
    check(r.bdays === 12 && r.btotal === 88630, `売上内訳の「稼働 N日」も共通判定（${r.bdays}日、経費だけの日は数えない）・総売上は不変`);
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    check(/const activeLogs = allLogs\.filter\(log => store\.isWorkedDay\(log\)\)/.test(uiSrc), '日別履歴一覧は共通判定 store.isWorkedDay を使用（今日・レコードの有無では判定しない）');
  }

  // ==========================================================
  section('10-12. 2026-09-26 公式取込の確定値（表示倍率の違うスクショ・チップ・見出し行つき一覧）');
  {
    const r = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const {TRIP_MAP_CATALOG}=require(${JSON.stringify(path.join(ROOT, 'js', 'trip-maps.js'))});
      const log=store.getDailyLog('2026-09-26');const m=store.getCalculatedMetrics(log);
      const d=log.deliveries.find(x=>x.completedAt==='08:13');
      const ids=Object.keys(TRIP_MAP_CATALOG).filter(k=>k.startsWith('del_0926_'));
      console.log(JSON.stringify({trips:m.tripsCount,count:m.count,ds:m.deliverySales,base:m.baseDeliverySales,tip:m.tipSales,tipCount:m.tipCount,q:m.questSales,t:m.totalSales,km:m.totalDistanceKm,sec:m.workSeconds,
        d0813:d&&{fee:d.fee,tip:d.tip,base:d.baseFee},q2128:log.quests.filter(q=>q.time==='21:28'&&!q.isDuplicateIgnored).map(q=>q.amount).sort((a,b)=>a-b),
        maps:ids.length,files:ids.map(i=>TRIP_MAP_CATALOG[i].map),attrs:store.getDayAttributes('2026-09-26').map(a=>a.label).join('')}));`);
    check(r.trips === 25 && r.count === 34 && r.ds === 11845 && r.q === 7700 && r.t === 19545 && r.km === 90.44 && r.sec === 37907,
      `9/26: 25トリップ / 34件 / 配達 ¥11,845 / クエスト ¥7,700 / 総売上 ¥19,545 / 90.44km / 10:31:47`);
    check(r.d0813 && r.d0813.fee === 702 && r.d0813.tip === 97 && r.d0813.base === 605 && r.tip === 97 && r.tipCount === 1 && r.base === 11845 - 97,
      '08:13 ¥702 = 料金 ¥605 ＋ チップ ¥97（チップは売上 ¥702 に含まれ再加算しない・日別チップ ¥97）');
    check(JSON.stringify(r.q2128) === '[200,500]', '21:28 ¥200（クエスト＋1回乗車クエストの2種類の表示）は1回だけ計上');
    const sizes = JSON.parse(spawnSync(process.env.UBER_IMPORT_PYTHON || 'python', ['-c', 'import json,sys;from PIL import Image;print(json.dumps(sorted({Image.open(p).size for p in sys.argv[1:]})))',
      ...r.files.map(f => path.join(ROOT, f))], { encoding: 'utf8' }).stdout);
    check(r.maps === 25 && JSON.stringify(sizes) === '[[378,210]]', `MAP 25/25（表示倍率の違う画面の実サイズ ${sizes.map(s => s.join('x')).join(', ')} で保存・拡大縮小なし）`);
    check(r.attrs === '♥', '9/26 の日別属性は ♥（チップ）');
  }

  // ==========================================================
  section('10-3. UBER取込.cmd（run-latest-import.ps1: 最新日付の自動判定・実行前チェック・Claude Code 起動）');
  {
    const script = path.join(__dirname, '..', 'run-latest-import.ps1');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-latest-'));
    tmpRoots.push(base);
    const inbox = path.join(base, 'inbox');
    const mkDay = (name, { activity = true, shots = 1 } = {}) => {
      const d = path.join(inbox, name);
      fs.mkdirSync(path.join(d, 'screenshots'), { recursive: true });
      if (activity) fs.writeFileSync(path.join(d, 'activity.txt'), 'Delivery\n2026-09-23\n08:01\n￥451\n', 'utf8');
      for (let i = 0; i < shots; i++) fs.writeFileSync(path.join(d, 'screenshots', `s${i}.png`), 'x');
    };
    // 偽の claude（受け取った引数と作業フォルダを記録するだけ）
    const fakeClaude = path.join(base, 'fake-claude.cmd');
    const argsFile = path.join(base, 'args.txt');
    fs.writeFileSync(fakeClaude, `@echo off\r\n>"${argsFile}" echo ARGS=%*\r\n>>"${argsFile}" echo CWD=%CD%\r\nexit /b 0\r\n`, 'ascii');
    const run = (extra = []) => {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InboxDir', inbox, '-Today', '2026-09-24', '-NoPause', ...extra], { encoding: 'utf8' });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };

    mkDay('2026-09-21'); mkDay('2026-09-22'); mkDay('2026-09-23', { shots: 3 });
    fs.mkdirSync(path.join(inbox, 'notes'));          // 日付形式でない
    fs.mkdirSync(path.join(inbox, '2026-13-01'));     // 存在しない日付
    fs.mkdirSync(path.join(inbox, '2026-9-30'));      // 形式違い
    mkDay('2099-01-01');                              // 未来日
    let r = run(['-DryRun']);
    check(r.code === 0 && /対象日:\s*\r?\n2026-09-23/.test(r.out) && /\/uber-import 2026-09-23/.test(r.out), '最新の有効な日付フォルダ 2026-09-23 を自動選択（文字列でなく日付として比較）');
    check(!/2026-13-01|2026-9-30|notes/.test(r.out.replace(/警告.*\r?\n/g, '')), '無効フォルダ（notes・2026-13-01・2026-9-30）は無視');
    check(/未来日のフォルダ 2099-01-01 は自動選択しません/.test(r.out), '未来日フォルダは選ばず警告');
    check(/screenshots:\s*\r?\n3枚/.test(r.out) && /activity\.txt:\s*\r?\nOK/.test(r.out), '実行画面に対象日・activity.txt・スクショ枚数を表示');

    r = run(['-ClaudeCommand', fakeClaude]);
    const recorded = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '';
    check(r.code === 0 && /ARGS="\/uber-import 2026-09-23"/.test(recorded), `Claude Code を初期プロンプト「/uber-import 2026-09-23」付きで起動（${recorded.split(/\r?\n/)[0]}）`);
    check(recorded.includes(`CWD=${ROOT}`), 'UBER_LOG 直下で起動');
    check(/Claude Code を終了しました/.test(r.out), '終了後に結果確認の案内を表示');

    fs.rmSync(path.join(inbox, '2026-09-23', 'activity.txt'));
    r = run(['-DryRun']);
    check(r.code === 1 && /対象: 2026-09-23/.test(r.out) && /activity\.txt がありません/.test(r.out), 'activity.txt なし → 開始せずエラー表示');

    fs.rmSync(path.join(inbox, '2026-09-23', 'screenshots'), { recursive: true });
    mkDay('2026-09-23', { shots: 0 });
    r = run(['-DryRun']);
    check(r.code === 1 && /画像（PNG \/ JPG）がありません/.test(r.out), 'スクショ0枚 → 開始せずエラー表示');
    fs.rmSync(path.join(inbox, '2026-09-23', 'screenshots'), { recursive: true });
    r = run(['-DryRun']);
    check(r.code === 1 && /screenshots フォルダがありません/.test(r.out), 'screenshots フォルダなし → 開始せずエラー表示');

    mkDay('2026-09-23');
    r = run(['-ClaudeCommand', 'claude-not-installed-xyz']);
    check(r.code === 1 && /Claude Codeが見つかりません/.test(r.out), 'Claude Code が PATH に無い → 日本語で表示して停止（インストールしない）');

    fs.rmSync(inbox, { recursive: true });
    fs.mkdirSync(inbox);
    r = run(['-DryRun']);
    check(r.code === 1 && /取込できる日付フォルダ/.test(r.out), '日付フォルダが無い → エラー表示');
  }

  // ==========================================================
  section('13. ローカルbackend・「取り込み実行」（spec/server-tests.js）');
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'server-tests.js')], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
    process.stdout.write((r.stdout || '').split('\n').filter(l => !/^結果:/.test(l)).join('\n'));
    const m = (r.stdout || '').match(/結果: (\d+) passed, (\d+) failed/);
    if (m) { passed += Number(m[1]); failed += Number(m[2]); } else { failed++; console.log(`  ❌ server-tests が完了しません: ${(r.stderr || '').slice(0, 300)}`); }
  }

  // ==========================================================
  section('14. 経費（ユーザー入力）の端末保存・クラウド同期（spec/sync-tests.js）');
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'sync-tests.js')], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
    process.stdout.write((r.stdout || '').split('\n').filter(l => !/^結果:/.test(l)).join('\n'));
    const m = (r.stdout || '').match(/結果: (\d+) passed, (\d+) failed/);
    if (m) { passed += Number(m[1]); failed += Number(m[2]); } else { failed++; console.log(`  ❌ sync-tests が完了しません: ${(r.stderr || '').slice(0, 300)}`); }
  }

  // ==========================================================
  section('13-7. デスクトップ用ランチャー（launcher.vbs）');
  {
    const vbs = path.join(__dirname, '..', 'launcher.vbs');
    const port = 8096;
    const health = () => {
      const r = spawnSync(process.execPath, ['-e', `require('http').get({host:'127.0.0.1',port:${port},path:'/api/health',headers:{Host:'localhost:${port}'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))}).on('error',()=>console.log('{}'))`], { encoding: 'utf8' });
      try { return JSON.parse(r.stdout); } catch (e) { return {}; }
    };
    const launch = p => spawnSync('cscript', ['//nologo', vbs, `/port:${p}`, '/nobrowser'], { encoding: 'utf8', timeout: 60000 });
    const r1 = launch(port);
    const h1 = health();
    const r2 = launch(port);
    const h2 = health();
    check(r1.status === 0 && /started/.test(r1.stdout) && h1.app === 'uber-log-local', 'サーバー未起動 → 画面を出さずに自動起動');
    check(r2.status === 0 && /running/.test(r2.stdout) && h2.pid === h1.pid, `起動済み → 二重起動しない（同じプロセス pid ${h1.pid}）`);
    const listen = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { $_.LocalAddress }) -join ','`], { encoding: 'utf8' }).stdout.trim();
    check(listen.split(',').every(a => a === '127.0.0.1' || a === '::1') && listen.length > 0, `待受けはループバックのみ（${listen}）`);
    if (h1.pid) { try { process.kill(h1.pid); } catch (e) { /* 終了済み */ } }
    // 別のプログラムがポートを使用中なら起動せず知らせる
    const other = require('child_process').spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('other')).listen(8095,'127.0.0.1')`]);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},700)']);
    const r3 = launch(8095);
    other.kill();
    check(r3.status === 2, '別のプログラムがポート使用中 → 起動せずメッセージ（終了コード 2）');
  }

  // ==========================================================
  section('11. 本体データの整合性（現在の js/store.js・js/trip-maps.js 全日）');
  {
    const seed = pipeline.readSeed(path.join(ROOT, 'js', 'store.js')).data.dailyLogs;
    const catalog = pipeline.readTripMaps(path.join(ROOT, 'js', 'trip-maps.js')).catalog;
    const problems = [];
    const allIds = new Set();
    Object.entries(seed).forEach(([date, log]) => {
      const trips = log.deliveries || [];
      trips.forEach(d => {
        if (allIds.has(d.id)) problems.push(`${date}: trip ID 重複 ${d.id}`);
        allIds.add(d.id);
      });
      if (log.tripsCount !== undefined && log.tripsCount !== trips.length) problems.push(`${date}: tripsCount ${log.tripsCount} ≠ trip数 ${trips.length}`);
      const pts = trips.reduce((s, d) => s + (Number(d.points) || 0), 0);
      // 「配達件数 = ポイント合計」は v21（9/21）以降と公式取込日のルール（9/14 は旧データで 4件/5pt のまま確定済み）
      const pointsRule = log.officialImport || date >= '2026-09-21';
      if (pointsRule && log.deliveriesCount !== undefined && log.deliveriesCount !== pts) problems.push(`${date}: 配達件数 ${log.deliveriesCount} ≠ ポイント合計 ${pts}`);
      const s = log.sales;
      if (s) {
        const sum = (s.delivery || 0) + (s.quest || 0) + (s.adjustment || 0) + (s.other || 0) + (s.guaranteeBonus || 0);
        if (sum !== s.total) problems.push(`${date}: 総売上 ${s.total} ≠ 内訳合計 ${sum}`);
        if (log.officialImport && s.delivery !== trips.reduce((a, d) => a + d.fee, 0)) problems.push(`${date}: 配達報酬 ≠ trip金額合計`);
        const adjSum = (log.adjustments || []).reduce((a, x) => a + x.amount, 0);
        if (log.adjustments && adjSum !== (s.adjustment || 0)) problems.push(`${date}: 調整合計 ${adjSum} ≠ sales.adjustment ${s.adjustment}`);
      }
      if ((log.expenses || []).some(e => Number(e.amount) < 0)) problems.push(`${date}: 経費にマイナス値（売上調整の混入）`);
    });
    Object.entries(catalog).forEach(([id, e]) => {
      if (!allIds.has(id)) problems.push(`MAPカタログ ${id} に対応するtripがありません`);
      [e.map, e.full].forEach(f => { if (!fs.existsSync(path.join(ROOT, f))) problems.push(`MAPファイルがありません: ${f}`); });
    });
    const unmapped = [...allIds].filter(id => !catalog[id]);
    check(problems.length === 0, `全${Object.keys(seed).length}日・${allIds.size}trip の整合性${problems.length ? `: ${problems.join(' / ')}` : ''}`);
    const confirmedIds = Object.entries(seed).filter(([d]) => d <= '2026-09-22').flatMap(([, l]) => (l.deliveries || []).map(t => t.id));
    check(confirmedIds.length === 89 && confirmedIds.every(id => catalog[id]), `9/22までの既存MAP 89/89 を維持（=${confirmedIds.filter(id => catalog[id]).length}/${confirmedIds.length}）`);
    console.log(`     MAP登録: ${allIds.size - unmapped.length}/${allIds.size}${unmapped.length ? `（MAPなし確認済み: ${unmapped.join(', ')}）` : ''}`);
  }

  // ==========================================================
  section('15. 目標クエスト（Target Quest）機能の単体・統合テスト');
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'spec', 'target-quest-tests.js')], { encoding: 'utf8' });
    if (r.status !== 0) console.log(r.stdout, r.stderr);
    check(r.status === 0, '目標クエスト全テスト（作成・編集・削除・進捗計算・予定報酬分離・クラウド同期）PASS');
  }

  // ==========================================================
  section('16. 構造化自動取得（Phase 1: 単配達・ダブル・内訳一致・順序捏造防止）');
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'structured-tests.js')], { encoding: 'utf8' });
    if (r.status !== 0) console.log(r.stdout, r.stderr);
    check(r.status === 0, '構造化自動取得 全テスト（単配達・ダブル・チップ・内訳一致・重複防止・安全停止）PASS');
  }
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'amount-follow-tests.js')], { encoding: 'utf8' });
    if (r.status !== 0) console.log(r.stdout, r.stderr);
    check(r.status === 0, 'Uber 公式の値の後からの変更に自動追従（金額変更・一覧と詳細の差・調整の増減・重複なし・手入力保護・安全停止）PASS');
  }
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'browser-auth-tests.js')], { encoding: 'utf8', timeout: 2 * 60 * 1000 });
    if (r.status !== 0) console.log(r.stdout, r.stderr);
    check(r.status === 0, `Uber Web 取得（ログイン判定・画面の再読込・応答なしの再試行・取得日時と最終トリップ）PASS（${((r.stdout || '').match(/ℹ pass \d+/) || ['?'])[0]}）`);
  }
} catch (e) {
  failed++;
  console.log(`  ❌ 例外: ${e.stack}`);
} finally {
  tmpRoots.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 一時フォルダの削除失敗は無視 */ } });
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
