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
      `既存の B（9/18・9/19・9/21・9/22）と 調・賞 を維持（${['2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22'].map(d => `${d.slice(5)}:${r[d]}`).join(' / ')}）`);
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
      `並び順 B → 調 → 賞 → ♥（9/22: ${d22.attrs}）・既存の B/調/賞 は不変`);
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
  section('10-5. 履歴カレンダーの稼働状況（稼働／休／空欄）');
  {
    const r = runNode(`
      const map={uber_log_v1_data:JSON.stringify({version:'1.2',dailyLogs:{'2026-09-20':{date:'2026-09-20',workStartedAt:'10:00',totalDistanceKm:null,workSessions:[],deliveries:[],quests:[]}}})};
      global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
      const {store}=require(${JSON.stringify(path.join(ROOT, 'js', 'store.js'))});
      const st={};for(let d=1;d<=30;d++){const k='2026-09-'+String(d).padStart(2,'0');st[k]=store.getDayStatus(k);}
      st['2099-01-01']=store.getDayStatus('2099-01-01');
      const m20=store.getCalculatedMetrics(store.state.dailyLogs['2026-09-20']);
      console.log(JSON.stringify({st,p20:m20.netProfit,has20:!!store.state.dailyLogs['2026-09-20']}));`);
    const byStatus = s => Object.keys(r.st).filter(k => r.st[k].status === s);
    check(byStatus('off').join() === '2026-09-12,2026-09-13,2026-09-20', `「休」は確認済みの非稼働日だけ（${byStatus('off').map(d => d.slice(5)).join(', ')}）`);
    const worked = byStatus('worked');
    check(['10', '11', '14', '15', '16', '17', '18', '19', '21', '22'].every(d => worked.includes(`2026-09-${d}`)), `稼働日は配達実績のある日（${worked.map(d => d.slice(8)).join(', ')}）`);
    check(r.st['2026-09-22'].count === 25 && r.st['2026-09-22'].totalSales === 9243 && r.st['2026-09-19'].count === 23, '稼働日の件数・売上は一覧と同じ日別データ（9/22 25件 ¥9,243）');
    check(['2026-09-01', '2026-09-09', '2026-09-30', '2099-01-01'].every(d => r.st[d].status === 'unknown'), 'データの無い日・未来の日は「休」にしない（空欄）');
    check(r.has20 && r.st['2026-09-20'].status === 'off' && r.p20 === null, '9/20 は端末の日別データを残したまま「休」・利益なし（一覧の「利益 --」は非表示）');
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
} catch (e) {
  failed++;
  console.log(`  ❌ 例外: ${e.stack}`);
} finally {
  tmpRoots.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 一時フォルダの削除失敗は無視 */ } });
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
