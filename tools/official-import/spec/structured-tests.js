/**
 * UBER_LOG 公式取込 — 構造化自動取得（Phase 1）テスト
 *   node tools/official-import/spec/structured-tests.js
 *
 * 要件14に基づく検証項目:
 *   1. 単配達（正常系、内訳一致）
 *   2. ダブル配達（tripLegCount: 2、各leg保持、sequence: null）
 *   3. チップあり（配送料 ¥605 ＋ チップ ¥97 ＝ 総売上 ¥702）
 *   4. チップなし（配送料 ¥495 ＝ 総売上 ¥495）
 *   5. 内訳不一致の検出（安全停止）
 *   6. クエストあり（売上加算と二重計上防止）
 *   7. 既存日再取込（二重登録なし、unchanged）
 *   8. 同一trip再取得（重複登録なし、同一UUID統合）
 *   9. 途中取得失敗（不完全データの混入防止・安全停止）
 *  10. 証拠がある場合の順序確定（個別タイムスタンプによるsequence生成）
 *  11. 証拠がない場合の順序捏造防止（sequence: null）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pipeline = require('../lib/pipeline.js');
const structuredNormalizer = require('../lib/structured-normalizer.js');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}
function section(title) { console.log(`\n【${title}】`); }

// 一時ルートの作成（本番ファイルを一切変更しない）
const tmpRoots = [];
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-structured-test-'));
  tmpRoots.push(dir);
  ['js/store.js', 'js/trip-maps.js', 'js/cloud-sync.js', 'index.html', 'sw.js', 'pickup-map.html', 'route-judge.html', 'version.json', 'tools/release-check/version.js'].forEach(rel => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  });
  fs.mkdirSync(path.join(dir, 'assets', 'maps'), { recursive: true });
  const lib = path.join(dir, 'tools', 'official-import', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.readdirSync(path.join(__dirname, '..', 'lib')).filter(f => /\.(js|py)$/.test(f)).forEach(f => {
    fs.copyFileSync(path.join(__dirname, '..', 'lib', f), path.join(lib, f));
  });
  return dir;
}

function cleanup() {
  tmpRoots.forEach(dir => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  });
}

function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('UBER_LOG 構造化自動取得 Phase 1 検証テスト');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ============================================================
  section('1. 単配達（実地確認例: ¥372, 3.83km, 19分21秒, 1pt）');
  // ============================================================
  const singleRaw = {
    tripUuid: '11111111-1111-1111-1111-111111111111',
    statusType: 'COMPLETED',
    date: '2026-10-02',
    time: '12:34',
    amount: 372,
    baseFee: 372,
    tip: null,
    distanceKm: 3.83,
    durationStr: '19分21秒',
    points: 1,
    restaurant: 'スターバックス コーヒー 弁天町店',
    area: '大阪市港区弁天1丁目',
    tripLegCount: 1,
    legs: [
      {
        legUuid: 'leg-111',
        restaurant: 'スターバックス コーヒー 弁天町店',
        pickupAddress: '大阪市港区弁天1-2-3',
        dropoffAddress: '大阪市港区弁天1丁目5-6',
        customRouteMap: 'https://example.com/map1.png'
      }
    ]
  };

  const normSingle = structuredNormalizer.normalizeTripDetail(singleRaw, '2026-10-02');
  check(normSingle.errors.length === 0, '単配達の正規化エラーなし');
  check(normSingle.trip.amount === 372, '総売上 ¥372');
  check(normSingle.trip.baseFee === 372 && normSingle.trip.tip === null, 'チップなし（基本料金 ¥372、tip null）');
  check(normSingle.trip.distanceKm === 3.83, '距離 3.83km');
  check(normSingle.trip.durationSeconds === 1161, '時間 19分21秒 (1161秒)');
  check(normSingle.trip.points === 1, 'ポイント 1');
  check(normSingle.trip.tripLegCount === 1, 'tripLegCount 1');
  check(normSingle.trip.legs.length === 1, 'legs配列 1件保持');
  check(normSingle.trip.sequence === null, '単配達は sequence null');

  // ============================================================
  section('2. ダブル配達 & チップあり（実地確認例: 配送料¥605 + チップ¥97 = 総売上¥702）');
  // ============================================================
  const doubleRaw = {
    tripUuid: '22222222-2222-2222-2222-222222222222',
    statusType: 'COMPLETED',
    date: '2026-10-02',
    time: '14:20',
    amount: 702,
    baseFee: 605,
    tip: 97,
    distanceKm: 6.81,
    durationStr: '52分31秒',
    points: 2,
    tripLegCount: 2,
    legs: [
      {
        legUuid: 'leg-222-1',
        restaurant: '吉野家 弁天町店',
        pickupAddress: '大阪市港区市岡元町1丁目',
        dropoffAddress: '大阪市此花区西九条1丁目',
        customRouteMap: 'https://example.com/map2-1.png'
      },
      {
        legUuid: 'leg-222-2',
        restaurant: 'マクドナルド 高見プラザ店',
        pickupAddress: '大阪市此花区高見1丁目',
        dropoffAddress: '大阪市此花区伝法5丁目',
        customRouteMap: 'https://example.com/map2-2.png'
      }
    ]
  };

  const normDouble = structuredNormalizer.normalizeTripDetail(doubleRaw, '2026-10-02');
  check(normDouble.errors.length === 0, 'ダブル配達の正規化エラーなし');
  check(normDouble.trip.baseFee === 605 && normDouble.trip.tip === 97, '内訳: 配送料 ¥605 / チップ ¥97');
  check(normDouble.trip.baseFee + normDouble.trip.tip === normDouble.trip.amount, '内訳一致: 605 + 97 = 702');
  check(normDouble.trip.points === 2, 'ポイント 2（2配達完了）');
  check(normDouble.trip.tripLegCount === 2, 'tripLegCount 2');
  check(normDouble.trip.legs.length === 2, '各legの別UUID・住所・マップを2件保持');
  check(normDouble.trip.legs[0].legUuid === 'leg-222-1' && normDouble.trip.legs[1].legUuid === 'leg-222-2', '各legのUUIDが正しく保存');
  check(normDouble.trip.sequence === null, '証拠がない場合 sequence は null（順序を捏造しない）');

  // ============================================================
  section('3. 内訳不一致の検出（安全装置）');
  // ============================================================
  const badMathRaw = {
    ...doubleRaw,
    tripUuid: '33333333-3333-3333-3333-333333333333',
    amount: 702,
    baseFee: 605,
    tip: 90 // 605 + 90 = 695 !== 702
  };
  const normBadMath = structuredNormalizer.normalizeTripDetail(badMathRaw, '2026-10-02');
  check(normBadMath.errors.length > 0, '内訳不一致エラーを検出');
  check(/一致しません/.test(normBadMath.errors[0]), '不一致理由を明示: ' + normBadMath.errors[0]);

  // ============================================================
  section('4. PICK/DROP 順序確定（証拠がある場合 vs ない場合）');
  // ============================================================
  // 証拠がある場合: 各legのpickup/dropoffに実測タイムスタンプが存在
  const sequencedRaw = {
    ...doubleRaw,
    tripUuid: '44444444-4444-4444-4444-444444444444',
    legs: [
      {
        legUuid: 'leg-seq-1',
        restaurant: '店舗1',
        pickupAddress: '大阪市港区市岡元町1丁目',
        dropoffAddress: '大阪市此花区西九条1丁目',
        pickedUpAt: '2026-10-02T13:40:00Z',
        deliveredAt: '2026-10-02T14:05:00Z'
      },
      {
        legUuid: 'leg-seq-2',
        restaurant: '店舗2',
        pickupAddress: '大阪市此花区高見1丁目',
        dropoffAddress: '大阪市此花区伝法5丁目',
        pickedUpAt: '2026-10-02T13:50:00Z',
        deliveredAt: '2026-10-02T14:20:00Z'
      }
    ]
  };
  const normSeq = structuredNormalizer.normalizeTripDetail(sequencedRaw, '2026-10-02');
  check(normSeq.trip.sequence !== null, '個別タイムスタンプがある場合は sequence を生成');
  check(Array.isArray(normSeq.trip.sequence) && normSeq.trip.sequence.length === 4, '全4イベント (PICK1, PICK2, DROP1, DROP2)');
  const orderStr = normSeq.trip.sequence.map(s => `${s.type}${s.legIndex + 1}`).join(' → ');
  check(orderStr === 'PICK1 → PICK2 → DROP1 → DROP2', `時系列順序が正しく復元: ${orderStr}`);

  // ============================================================
  section('5. パイプライン統合テスト（単配達・ダブル・クエスト・調整の一括取込）');
  // ============================================================
  const root = makeRoot();
  // テスト用の日付は実データと重ならない 2099 年にする（以前は 2026-10-15〜17 を使っていて、
  // 実際の 10/16 を取り込んだ後に「既存データとの整合」で 7. が失敗した。ID は月日だけを使うため del_1015_* のまま）
  const testDate = '2099-10-15'; // テスト用新規日
  const dupDate = '2099-10-16';
  const partialDate = '2099-10-17';
  const realLogs = pipeline.readSeed(path.join(ROOT, 'js', 'store.js')).data.dailyLogs;
  check([testDate, dupDate, partialDate].every(d => !realLogs[d]), `テスト用の日付（${testDate}・${dupDate}・${partialDate}）が実データに無い`);

  const structuredPayload = {
    source: 'uber-driver-web',
    fetchedAt: new Date().toISOString(),
    targetDate: testDate,
    activity: {
      feedItems: [
        { type: 'delivery', tripUuid: singleRaw.tripUuid, time: '12:34', amount: 372 },
        { type: 'delivery', tripUuid: doubleRaw.tripUuid, time: '14:20', amount: 702 },
        { type: 'quest', title: '雨の日クエスト', time: '15:00', amount: 400 },
        { type: 'misc', title: '調整', time: '15:30', amount: 100 }
      ]
    },
    trips: [
      { ...singleRaw, date: testDate },
      { ...doubleRaw, date: testDate }
    ]
  };

  const inboxDir = path.join(root, 'tools', 'official-import', 'inbox', testDate);
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'structured.json'), JSON.stringify(structuredPayload, null, 2), 'utf8');

  // prepare 実行
  const prep = pipeline.prepare(root, testDate);
  check(prep.summary.delivery === 2, `prepare: Delivery 2件検出 (${prep.summary.delivery})`);
  check(prep.summary.quest === 1, `prepare: クエスト 1件検出 (${prep.summary.quest})`);
  check(prep.summary.adjustment === 1, `prepare: 調整 1件検出 (${prep.summary.adjustment})`);
  check(prep.pending.length === 0, 'prepare: 構造化入力のため未読(UNKNOWN)は0件');

  // buildStaging (validate) 実行
  const staging = pipeline.buildStaging(root, testDate);
  check(staging.validation.status === 'PASS', `validate: PASS (${staging.validation.status})`);
  check(staging.summary.trips === 2, `trip件数: 2 (${staging.summary.trips})`);
  check(staging.summary.deliveriesCount === 3, `配達件数(ポイント合計): 3 (${staging.summary.deliveriesCount})`);
  check(staging.summary.deliverySales === 1074, `配達報酬合計: ¥1,074 (372 + 702 = ${staging.summary.deliverySales})`);
  check(staging.summary.questSales === 400, `クエスト合計: ¥400 (${staging.summary.questSales})`);
  check(staging.summary.adjustmentSales === 100, `調整合計: ¥100 (${staging.summary.adjustmentSales})`);
  check(staging.summary.totalSales === 1574, `総売上: ¥1,574 (1074 + 400 + 100 = ${staging.summary.totalSales})`);
  check(staging.deliveries[1].screen.tripLegCount === 2, 'ダブル配達の tripLegCount 2 を維持');
  check(staging.deliveries[1].screen.legs.length === 2, 'ダブル配達の legs 2件を維持');

  // apply 実行
  const applied = pipeline.apply(root, testDate, { skipVersionBump: true });
  check(applied.applied === true, 'store.js への反映完了 (applied: true)');

  // store.js の内容を検証
  const seed = pipeline.readSeed(path.join(root, 'js', 'store.js'));
  const savedDay = seed.data.dailyLogs[testDate];
  check(savedDay !== undefined, `${testDate} のデータが store.js に存在`);
  check(savedDay.deliveries.length === 2, `deliveries: 2件保存`);
  check(savedDay.deliveries[0].id === 'del_1015_1', `単配達 ID: del_1015_1 (既存規約維持)`);
  check(savedDay.deliveries[1].id === 'del_1015_2', `ダブル配達 ID: del_1015_2 (既存規約維持)`);
  check(savedDay.deliveries[1].tripLegCount === 2, `ダブル配達 tripLegCount: 2 保持`);
  check(savedDay.deliveries[1].legs.length === 2, `ダブル配達 legs: 2件保持`);
  check(savedDay.deliveries[1].fee === 702, `ダブル配達 fee: ¥702`);
  check(savedDay.deliveries[1].baseFee === 605 && savedDay.deliveries[1].tip === 97, `ダブル配達 baseFee ¥605 / tip ¥97 保持`);
  check(savedDay.sales.total === 1574, `sales.total: ¥1,574`);

  // ============================================================
  section('6. 既存日再取込（二重登録防止）');
  // ============================================================
  const reApplied = pipeline.apply(root, testDate, { skipVersionBump: true });
  check(reApplied.applied === false && reApplied.unchanged === true, '既存日を再取込しても二重登録されず unchanged: true');

  // ============================================================
  section('7. 同一trip UUID 再取得（重複排除テスト）');
  // ============================================================
  // 一覧および詳細にまったく同一の tripUuid が2重に紛れ込んだ場合
  const dupPayload = {
    source: 'uber-driver-web',
    fetchedAt: new Date().toISOString(),
    targetDate: dupDate,
    activity: {
      feedItems: [
        { type: 'delivery', tripUuid: singleRaw.tripUuid, time: '12:34', amount: 372 },
        { type: 'delivery', tripUuid: singleRaw.tripUuid, time: '12:34', amount: 372 } // 一覧側の同一UUID重複行
      ]
    },
    trips: [{ ...singleRaw, date: dupDate }, { ...singleRaw, date: dupDate }] // 詳細側の同一UUID重複取得
  };
  const dupInbox = path.join(root, 'tools', 'official-import', 'inbox', dupDate);
  fs.mkdirSync(dupInbox, { recursive: true });
  fs.writeFileSync(path.join(dupInbox, 'structured.json'), JSON.stringify(dupPayload, null, 2), 'utf8');
  pipeline.prepare(root, dupDate);
  const dupStaging = pipeline.buildStaging(root, dupDate);
  check(dupStaging.validation.status === 'PASS', '同一UUIDの重複行を1件に統合してPASS');
  check(dupStaging.summary.trips === 1, `trip件数は1件に統合 (${dupStaging.summary.trips} trip)`);

  // ============================================================
  section('8. 途中取得失敗時の安全装置');
  // ============================================================
  // 詳細取得が1件欠落している場合（一覧2件に対し詳細1件）
  const partialPayload = {
    source: 'uber-driver-web',
    fetchedAt: new Date().toISOString(),
    targetDate: partialDate,
    activity: {
      feedItems: [
        { type: 'delivery', tripUuid: singleRaw.tripUuid, time: '12:34', amount: 372 },
        { type: 'delivery', tripUuid: doubleRaw.tripUuid, time: '14:20', amount: 702 }
      ]
    },
    trips: [{ ...singleRaw, date: partialDate }] // doubleRaw が欠落
  };
  const partialInbox = path.join(root, 'tools', 'official-import', 'inbox', partialDate);
  fs.mkdirSync(partialInbox, { recursive: true });
  fs.writeFileSync(path.join(partialInbox, 'structured.json'), JSON.stringify(partialPayload, null, 2), 'utf8');
  pipeline.prepare(root, partialDate);
  const partialStaging = pipeline.buildStaging(root, partialDate);
  check(partialStaging.validation.status === 'FAIL', '詳細欠落時は検証FAILで安全停止');
  check(partialStaging.validation.errors.some(e => /件数不一致|一致する/.test(e)), '件数不一致エラーを検出');

  const partialApplied = pipeline.apply(root, partialDate, { skipVersionBump: true });
  check(partialApplied.applied === false, '検証FAIL時は store.js へ反映しない');

  // ============================================================
  section('12. 認証状態判定（URL・タイトル・DOMに基づく安全判定・Cookie必須排除）');
  // ============================================================
  const browserFetcher = require('../lib/browser-fetcher.js');

  // A. auth.uber.com や サインイン画面 → needsLogin: true
  const authLoginCase = browserFetcher.determineAuthState({
    url: 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fdrivers.uber.com%2Fearnings%2Factivities',
    title: 'Uber に登録またはサインイン',
    isLoginPage: true,
    isDrivers: false,
    isActivities: false,
    isDriverAuthenticated: false
  });
  check(authLoginCase.needsLogin === true, 'auth.uber.com では needsLogin: true');
  check(authLoginCase.authenticated === false, 'auth.uber.com では authenticated: false');

  // B. /login パス → needsLogin: true
  const pathLoginCase = browserFetcher.determineAuthState({
    url: 'https://drivers.uber.com/login',
    title: 'Uber Driver Login',
    isLoginPage: true,
    isDrivers: true,
    isActivities: false,
    isDriverAuthenticated: false
  });
  check(pathLoginCase.needsLogin === true, '/login パスでは needsLogin: true');
  check(pathLoginCase.authenticated === false, '/login パスでは authenticated: false');

  // C. drivers.uber.com/earnings/activities 正常表示（本人用DOMあり・Cookie不要） → authenticated: true
  const authedCase = browserFetcher.determineAuthState({
    url: 'https://drivers.uber.com/earnings/activities',
    title: 'Uber - アクティビティの詳細',
    isLoginPage: false,
    isDrivers: true,
    isActivities: true,
    hasProfileDom: true,
    hasActivityFeed: true,
    isDriverAuthenticated: true
  });
  check(authedCase.authenticated === true, 'earnings/activities 正常表示時は authenticated: true');
  check(authedCase.needsLogin === false, 'earnings/activities 正常表示時は needsLogin: false');
  check(/ログイン済み/.test(authedCase.message), 'ログイン済みメッセージを返却');

  // D. 判定不能（about:blank、読み込み中、他のドメイン） → unknown: true
  const unknownCase = browserFetcher.determineAuthState({
    url: 'about:blank',
    title: '',
    isLoginPage: false,
    isDrivers: false,
    isActivities: false,
    isDriverAuthenticated: false
  });
  check(unknownCase.unknown === true, '判定不能時は unknown: true');
  check(unknownCase.authenticated === false, '判定不能時は authenticated: false');
  check(unknownCase.needsLogin === false, '判定不能時は needsLogin: false (安易にneedsLoginと決めつけない)');

  const nullCase = browserFetcher.determineAuthState(null);
  check(nullCase.unknown === true, 'info null 時は unknown: true');

  cleanup();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`テスト結果: ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

try {
  runTests();
} catch (e) {
  cleanup();
  console.error('テスト実行中例外:', e);
  process.exit(1);
}
