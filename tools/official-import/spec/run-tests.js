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
  ['js/store.js', 'js/trip-maps.js', 'js/cloud-sync.js', 'index.html', 'sw.js', 'version.json'].forEach(rel => {
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
  section('5. 新規日の取込（9/22 を一旦消した状態から一覧＋スクショで再構築）');
  {
    const root = makeRoot();
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
    const again = pipeline.apply(root, '2026-09-22');
    check(again.unchanged === true, '同日を再取込 → 変更なし（二重登録防止）');

    const m = runNode(`
      global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(root, 'js', 'store.js'))});
      const x=store.getCalculatedMetrics(store.getDailyLog('2026-09-22'));
      const w=store.getRevenueSummary('2026-09-22').thisWeek;
      console.log(JSON.stringify({total:x.totalSales,count:x.count,sec:x.workSeconds,week:w.officialSales,q:store.getQuestProgress().currentCount}));`);
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
    const before = fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
    const r1 = pipeline.apply(root, '2026-09-21', { skipVersionBump: true });
    const mapCheck = r1.staging.validation.checks.find(c => c.name.startsWith('MAP'));
    check(!r1.applied && r1.staging.validation.status === 'FAIL' && /MAPなし/.test(mapCheck.detail), `地図が切れたスクショ（del_0921_3相当）は MAPなしとして停止: ${mapCheck.detail.split('\n')[0]}`);
    check(fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8') === before, 'FAIL時は store.js を変更しない');

    const cutFile = origCatalog.del_0921_3.origFile;
    setupInbox(root, '2026-09-21', { decisions: { mapMissingOk: [cutFile] } });
    const r2 = pipeline.apply(root, '2026-09-21', { skipVersionBump: true });
    if (r2.staging.validation.status !== 'PASS') console.log(r2.staging.validation.errors);
    check(r2.applied && r2.staging.summary.maps === '6/7', `ユーザー確認（mapMissingOk）後に反映・MAP ${r2.staging.summary.maps}`);
    const cat = pipeline.readTripMaps(path.join(root, 'js', 'trip-maps.js')).catalog;
    const ids = ['del_0921_1', 'del_0921_2', 'del_0921_4', 'del_0921_5', 'del_0921_6', 'del_0921_7'];
    check(ids.every(id => cat[id] && cat[id].box.every((v, i) => Math.abs(v - origCatalog[id].box[i]) <= 2)), '新規MAPの切り抜き位置が既存確定MAPと一致（±2px）');
    check(!cat.del_0921_3, 'MAPなしのtripはカタログ登録しない（捏造しない）');
    check(ids.every(id => fs.existsSync(path.join(root, 'assets', 'maps', `map_${id}.png`)) && fs.existsSync(path.join(root, 'assets', 'maps', `full_${id}.png`))), 'map_*.png（420x233）・full_*.png を assets/maps へ保存');
    const sizes = JSON.parse(spawnSync(process.env.UBER_IMPORT_PYTHON || 'python', ['-c', `import json,sys;from PIL import Image;print(json.dumps([Image.open(p).size for p in sys.argv[1:]]))`, ...ids.map(id => path.join(root, 'assets', 'maps', `map_${id}.png`))], { encoding: 'utf8' }).stdout);
    check(sizes.every(s => s[0] === 420 && s[1] === 233), 'MAP画像は既存規格 420x233');
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
    const out = runNode(`
      const map={uber_log_v1_data:process.argv[1],uber_log_trip_evaluations:JSON.stringify({del_0922_3:{evaluation:'bad',reason:'階段'}})};
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
    [JSON.stringify(local)]);
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
    pipeline.readSeed(path.join(frozen, 'js', 'store.js')).blocks
      .map(b => b.date).filter(d => d > '2026-09-22').reverse()
      .forEach(d => removeSeedDay(frozen, d));
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
} catch (e) {
  failed++;
  console.log(`  ❌ 例外: ${e.stack}`);
} finally {
  tmpRoots.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 一時フォルダの削除失敗は無視 */ } });
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
