/**
 * UBER_LOG 公式取込 — Uber 公式の値の後からの変更への自動追従テスト
 *   node tools/official-import/spec/amount-follow-tests.js
 *
 * 基本仕様: Uber 公式データを正とし、既存 trip・クエスト・調整の値が後から変わっても止めずに最新の値へ更新する。
 *   1. 既存 trip の金額変更（trip UUID で照合・ID 維持・変更履歴）
 *   2. 同じデータの再取込（重複登録なし・履歴も重ならない）
 *   3. ダブル配達の件数維持・ポイントの変更で件数を計算し直す
 *   4. 調整の増減・クエストの金額変更・クエストの重複登録なし
 *   5. 同じ日の複数回取込（途中 → 追加）
 *   6. 同じ取得で一覧と詳細の金額が違う（内訳つきのトリップ詳細を採用）
 *   7. 既存データ・手入力（経費・評価・メモ・稼働・店舗名）を守る
 *   8. 安全に同じ trip と言えないものは更新しない（止める・止めたときは本体を変更しない）
 * 日付は実データと重ならない 2099 年を使う（本番の js/store.js は変更しない。一時フォルダのコピーで検証）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pipeline = require('../lib/pipeline.js');
const browserFetcher = require('../lib/browser-fetcher.js');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}
function section(title) { console.log(`\n【${title}】`); }

const tmpRoots = [];
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-amount-test-'));
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
  tmpRoots.forEach(dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 無視 */ } });
}

const U = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${'0'.repeat(12)}`;
function trip(n, o = {}) {
  const amount = o.amount ?? 400;
  return {
    tripUuid: U(n), statusType: 'COMPLETED', time: o.time || `${String(8 + n).padStart(2, '0')}:00`, amount, baseFee: o.baseFee ?? amount, tip: o.tip ?? null,
    distanceKm: o.distanceKm ?? 2.5, durationStr: o.durationStr || '20分0秒', points: o.points ?? 1,
    restaurant: o.restaurant || `テスト店${n}`, area: o.area || '大阪市西区九条1丁目', tripLegCount: o.points ?? 1, legs: []
  };
}
// 1回分の取得（Uber Web 構造化データ）を本番と同じ saveStructuredInbox で保存して prepare → validate → apply
function importFetch(root, date, { trips, feed }) {
  const feedItems = feed || trips.map(t => ({ type: 'delivery', tripUuid: t.tripUuid, time: t.time, amount: t.amount }));
  browserFetcher.saveStructuredInbox(root, date, {
    source: 'uber-driver-web', fetchedAt: new Date().toISOString(), targetDate: date,
    activity: { feedItems }, trips: trips.map(t => ({ ...t, date }))
  });
  pipeline.prepare(root, date);
  return pipeline.apply(root, date, { skipVersionBump: true });
}
const dayOf = (root, date) => pipeline.readSeed(path.join(root, 'js', 'store.js')).data.dailyLogs[date];
const storeText = root => fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
const failNames = r => r.staging.validation.checks.filter(c => !c.ok).map(c => c.name).join(' / ');

function runTests() {
  const realLogs = pipeline.readSeed(path.join(ROOT, 'js', 'store.js')).data.dailyLogs;

  // ============================================================
  section('1. 既存 trip の金額変更（trip UUID で照合・ID 維持・変更履歴）');
  // ============================================================
  const root = makeRoot();
  const d1 = '2099-11-01';
  check(!realLogs[d1], `テスト用の日付 ${d1} が実データに無い`);
  const a1 = importFetch(root, d1, { trips: [trip(1, { amount: 400 }), trip(2, { amount: 500, points: 2, durationStr: '35分0秒' })] });
  check(a1.applied, `初回取込: 反映（${a1.applied ? '' : failNames(a1)}）`);
  const r1 = importFetch(root, d1, { trips: [trip(1, { amount: 350 }), trip(2, { amount: 500, points: 2, durationStr: '35分0秒' })] });
  check(r1.applied, `金額だけ変わった再取込: 止めずに反映（${r1.applied ? '' : failNames(r1)}）`);
  let day = dayOf(root, d1);
  const t1 = day.deliveries.find(d => d.tripUuid === U(1));
  check(day.deliveries.length === 2 && t1.id === 'del_1101_1', `trip は2件のまま・ID 維持（${day.deliveries.map(d => d.id).join(', ')}）`);
  check(t1.fee === 350, `金額 ¥400 → ¥350 に更新（fee ${t1.fee}）`);
  const h1 = (t1.officialHistory || []).filter(h => h.type === 'update');
  check(h1.length === 1 && h1[0].changes.some(c => c.field === 'fee' && c.from === 400 && c.to === 350) && h1[0].match === 'uuid' && h1[0].at,
    `変更履歴に 変更前 ¥400 → 変更後 ¥350・照合方法 uuid・日時を記録（${JSON.stringify(h1)}）`);
  check(day.sales.delivery === 850 && day.sales.total === 850, `配達報酬・総売上を計算し直す（¥${day.sales.delivery}）`);
  check(r1.staging.officialUpdates.length === 1 && r1.staging.deliveries[0].status === 'updated', 'staging に更新内容（officialUpdates・status updated）');

  // ============================================================
  section('2. 同じデータの再取込（重複登録なし・履歴も重ならない）');
  // ============================================================
  const r2 = importFetch(root, d1, { trips: [trip(1, { amount: 350 }), trip(2, { amount: 500, points: 2, durationStr: '35分0秒' })] });
  check(!r2.applied && r2.unchanged, '同じ内容の再取込は変更なし（unchanged）');
  day = dayOf(root, d1);
  check(day.deliveries.length === 2 && (day.deliveries.find(d => d.tripUuid === U(1)).officialHistory || []).length === 1, 'trip・履歴とも増えない');

  // ============================================================
  section('3. ダブル配達の件数維持・ポイントの変更で件数を計算し直す');
  // ============================================================
  check(day.tripsCount === 2 && day.deliveriesCount === 3 && day.officialPoints === 3, `ダブル配達を含む 2trip / 3件 を維持（${day.tripsCount}trip / ${day.deliveriesCount}件）`);
  const r3 = importFetch(root, d1, { trips: [trip(1, { amount: 350, points: 2, durationStr: '25分0秒', distanceKm: 3.1 }), trip(2, { amount: 500, points: 2, durationStr: '35分0秒' })] });
  check(r3.applied, `ポイント・時間・距離が変わった再取込: 反映（${r3.applied ? '' : failNames(r3)}）`);
  day = dayOf(root, d1);
  const t1b = day.deliveries.find(d => d.tripUuid === U(1));
  check(t1b.points === 2 && t1b.durationStr === '25分0秒' && t1b.distanceKm === 3.1, 'trip のポイント・時間・距離を公式の値に更新');
  check(day.tripsCount === 2 && day.deliveriesCount === 4 && day.totalDistanceKm === 5.6, `件数・距離を計算し直す（${day.tripsCount}trip / ${day.deliveriesCount}件 / ${day.totalDistanceKm}km）`);

  // ============================================================
  section('4. 調整の増減・クエストの金額変更・クエストの重複登録なし');
  // ============================================================
  const d4 = '2099-11-02';
  const base4 = [trip(3, { amount: 600 })];
  const feed4 = (quest, adj) => [
    { type: 'delivery', tripUuid: U(3), time: base4[0].time, amount: 600 },
    { type: 'quest', title: 'クエスト', time: '15:00', amount: quest },
    { type: 'misc', title: '調整', time: '16:00', amount: adj }
  ];
  const a4 = importFetch(root, d4, { trips: base4, feed: feed4(300, 100) });
  check(a4.applied, `初回: クエスト ¥300・調整 +¥100（${a4.applied ? '' : failNames(a4)}）`);
  const r4 = importFetch(root, d4, { trips: base4, feed: feed4(450, -50) });
  check(r4.applied, `クエスト ¥300→¥450・調整 +¥100→-¥50 に変わった再取込: 反映（${r4.applied ? '' : failNames(r4)}）`);
  day = dayOf(root, d4);
  check(day.quests.length === 1 && day.quests[0].amount === 450 && day.quests[0].id === 'quest_1102_1', `クエストは1件のまま・ID 維持・¥450（${JSON.stringify(day.quests.map(q => [q.id, q.amount]))}）`);
  check(day.adjustments.length === 1 && day.adjustments[0].amount === -50 && day.adjustments[0].id === 'adj_1102_1', `調整は1件のまま・減額 -¥50 に更新（${JSON.stringify(day.adjustments.map(a => [a.id, a.amount]))}）`);
  check(day.sales.quest === 450 && day.sales.adjustment === -50 && day.sales.total === 1000, `売上を計算し直す（クエスト ¥${day.sales.quest} / 調整 ¥${day.sales.adjustment} / 総売上 ¥${day.sales.total}）`);
  check((day.quests[0].officialHistory || [])[0]?.changes[0]?.from === 300 && (day.adjustments[0].officialHistory || [])[0]?.changes[0]?.from === 100, 'クエスト・調整の変更前の金額を履歴に記録');
  const r4b = importFetch(root, d4, { trips: base4, feed: [...feed4(450, -50), { type: 'misc', title: '調整', time: '17:00', amount: 200 }] });
  day = dayOf(root, d4);
  check(r4b.applied && day.adjustments.length === 2 && day.sales.adjustment === 150, `新しい調整（増額 +¥200）は追加（調整 ${day.adjustments.length} 件・合計 ¥${day.sales.adjustment}）`);
  const r4c = importFetch(root, d4, { trips: base4, feed: [...feed4(450, -50), { type: 'misc', title: '調整', time: '17:00', amount: 200 }] });
  day = dayOf(root, d4);
  check(r4c.unchanged && day.quests.length === 1 && day.adjustments.length === 2, '同じ内容の再取込でクエスト・調整を重複登録しない');

  // ============================================================
  section('5. 同じ日の複数回取込（途中 → 追加 → 金額変更）');
  // ============================================================
  const d5 = '2099-11-03';
  importFetch(root, d5, { trips: [trip(4, { amount: 320 })] });
  importFetch(root, d5, { trips: [trip(4, { amount: 320 }), trip(5, { amount: 420, points: 2 })] });
  const r5 = importFetch(root, d5, { trips: [trip(4, { amount: 320 }), trip(5, { amount: 410, points: 2 }), trip(6, { amount: 380 })] });
  day = dayOf(root, d5);
  check(r5.applied && day.deliveries.map(d => `${d.id}:${d.fee}`).join(',') === 'del_1103_1:320,del_1103_2:410,del_1103_3:380',
    `3回目: 既存2件は ID 維持（うち1件は金額更新）・新規1件を追加（${day.deliveries.map(d => `${d.id}:${d.fee}`).join(',')}）`);
  check(day.tripsCount === 3 && day.deliveriesCount === 4, `件数 3trip / 4件（${day.tripsCount} / ${day.deliveriesCount}）`);

  // ============================================================
  section('6. 同じ取得で一覧と詳細の金額が違う（2026-10-30 09:05 の型: 一覧 ¥338 / 詳細 ¥676）');
  // ============================================================
  const d6 = '2099-11-04';
  const t7 = trip(7, { amount: 676, points: 2, time: '09:05', durationStr: '38分53秒', distanceKm: 4.3 });
  const t8 = trip(8, { amount: 320, time: '09:07' });
  importFetch(root, d6, { trips: [t7, t8] });
  const feed6 = [
    { type: 'delivery', tripUuid: U(7), time: '09:05', amount: 338 },
    { type: 'delivery', tripUuid: U(8), time: '09:07', amount: 320 }
  ];
  const r6 = importFetch(root, d6, { trips: [t7, t8, trip(9, { amount: 422, time: '21:19', points: 2 })], feed: [...feed6, { type: 'delivery', tripUuid: U(9), time: '21:19', amount: 422 }] });
  check(r6.applied, `一覧と詳細の金額差では止めない（${r6.applied ? '' : failNames(r6)}）`);
  day = dayOf(root, d6);
  const t7s = day.deliveries.find(d => d.tripUuid === U(7));
  check(t7s.fee === 676 && t7s.id === 'del_1104_1', '内訳つきのトリップ詳細の金額 ¥676 を採用・ID 維持');
  check((t7s.officialHistory || []).some(h => h.type === 'list-detail' && h.listAmount === 338 && h.detailAmount === 676), '一覧の金額 ¥338 を履歴（list-detail）に記録');
  check(day.tripsCount === 3 && day.deliveriesCount === 5 && day.sales.delivery === 1418, `件数・売上: 3trip / 5件 / ¥1,418（${day.tripsCount} / ${day.deliveriesCount} / ¥${day.sales.delivery}）`);
  check(r6.staging.validation.warnings.some(w => /一覧 09:05 ¥338 とトリップ詳細 09:05 ¥676/.test(w)), '差を警告として表示（止めない）');
  const r6b = importFetch(root, d6, { trips: [t7, t8, trip(9, { amount: 422, time: '21:19', points: 2 })], feed: [...feed6, { type: 'delivery', tripUuid: U(9), time: '21:19', amount: 422 }] });
  check(r6b.unchanged && dayOf(root, d6).deliveries.find(d => d.tripUuid === U(7)).officialHistory.length === 1, '同じ差が続いても履歴を重ねない（unchanged）');
  // 新規 trip の初回取込で一覧と詳細が違う場合も詳細を採用
  const d6b = '2099-11-05';
  const r6c = importFetch(root, d6b, { trips: [trip(10, { amount: 676, points: 2, time: '10:00' })], feed: [{ type: 'delivery', tripUuid: U(10), time: '10:00', amount: 338 }] });
  check(r6c.applied && dayOf(root, d6b).deliveries[0].fee === 676, '新規 trip でも一覧と詳細の差は詳細 ¥676 を採用');

  // ============================================================
  section('7. 既存データ・手入力を守る（経費・評価・メモ・稼働・店舗名）');
  // ============================================================
  const d7 = '2099-11-06';
  importFetch(root, d7, { trips: [trip(11, { amount: 500 })] });
  const manual = dayOf(root, d7);
  manual.expenses = [{ id: 'exp_test_1', category: 'Bike', amount: 1527, memo: '1日パス' }];
  manual.workSessions = [{ start: '10:00', end: '18:00' }];
  manual.weather = 'rain';
  manual.deliveries[0].evaluation = '○';
  manual.deliveries[0].evaluationUpdatedAt = '2099-11-06T20:00:00.000Z';
  manual.deliveries[0].memo = '本人メモ';
  manual.deliveries[0].restaurant = 'テスト店11（本人が直した名前）';
  pipeline.writeSeedDay(path.join(root, 'js', 'store.js'), d7, manual);
  const r7 = importFetch(root, d7, { trips: [trip(11, { amount: 450 })] });
  day = dayOf(root, d7);
  const t11 = day.deliveries[0];
  check(r7.applied && t11.fee === 450, '金額は公式の値 ¥450 に更新');
  check(JSON.stringify(day.expenses) === JSON.stringify(manual.expenses) && day.workSessions.length === 1 && day.weather === 'rain', '経費・稼働・天気はそのまま');
  check(t11.evaluation === '○' && t11.evaluationUpdatedAt === manual.deliveries[0].evaluationUpdatedAt && t11.memo === '本人メモ' && t11.restaurant === 'テスト店11（本人が直した名前）',
    'trip の評価・メモ・店舗名（手入力）はそのまま');

  // ============================================================
  section('8. 安全に同じ trip と言えないものは更新しない（止める）');
  // ============================================================
  // 8-1. UUID の無い既存 trip（旧スクショ取込）: 時刻が同じ trip が1件だけ・店舗も同じなら金額更新
  const d8 = '2099-11-07';
  importFetch(root, d8, { trips: [trip(12, { amount: 500, time: '12:00' }), trip(13, { amount: 300, time: '13:00' })] });
  const old8 = dayOf(root, d8);
  old8.deliveries.forEach(d => { delete d.tripUuid; });
  pipeline.writeSeedDay(path.join(root, 'js', 'store.js'), d8, old8);
  const r8 = importFetch(root, d8, { trips: [trip(12, { amount: 480, time: '12:00' }), trip(13, { amount: 300, time: '13:00' })] });
  day = dayOf(root, d8);
  check(r8.applied && day.deliveries.length === 2 && day.deliveries[0].fee === 480 && day.deliveries[0].id === 'del_1107_1',
    `UUID の無い既存 trip: 時刻が一意・店舗が同じなら金額を更新（${day.deliveries.map(d => `${d.id}:${d.fee}`).join(',')}）`);
  check(day.deliveries[0].officialHistory[0].match === 'time-store' && day.deliveries[0].tripUuid === U(12), '照合方法 time-store を記録・UUID を補完');
  // 8-2. 同じ時刻に UUID の無い既存 trip が2件 → どれが変わったか決められないので止める
  const d8b = '2099-11-08';
  importFetch(root, d8b, { trips: [trip(14, { amount: 500, time: '12:00', restaurant: '同じ店' }), trip(15, { amount: 300, time: '12:00', restaurant: '同じ店' })] });
  const old8b = dayOf(root, d8b);
  old8b.deliveries.forEach(d => { delete d.tripUuid; });
  pipeline.writeSeedDay(path.join(root, 'js', 'store.js'), d8b, old8b);
  const before8b = storeText(root);
  const r8b = importFetch(root, d8b, { trips: [trip(14, { amount: 510, time: '12:00', restaurant: '同じ店' }), trip(15, { amount: 290, time: '12:00', restaurant: '同じ店' })] });
  check(!r8b.applied && /既存データとの整合/.test(failNames(r8b)), `同じ時刻の候補が2件: 推測で組まずに止める（${failNames(r8b)}）`);
  check(storeText(root) === before8b, '止めたときは store.js を変更しない');
  // 8-3. UUID の無い既存 trip で店舗が違う → 別 trip の可能性があるので更新しない
  const d8c = '2099-11-09';
  importFetch(root, d8c, { trips: [trip(16, { amount: 500, time: '12:00', restaurant: 'A店' })] });
  const old8c = dayOf(root, d8c);
  delete old8c.deliveries[0].tripUuid;
  pipeline.writeSeedDay(path.join(root, 'js', 'store.js'), d8c, old8c);
  const r8c = importFetch(root, d8c, { trips: [trip(16, { amount: 450, time: '12:00', restaurant: 'B店' })] });
  check(!r8c.applied && dayOf(root, d8c).deliveries[0].fee === 500, '時刻が同じでも店舗が違えば更新しない（止める・既存 ¥500 のまま）');
  // 8-4. 既存 trip が Uber の一覧から消えた → 消さずに止める（金額の変更ではない）
  const r8d = importFetch(root, d1, { trips: [trip(2, { amount: 500, points: 2, durationStr: '35分0秒' })] });
  check(!r8d.applied && dayOf(root, d1).deliveries.length === 2, '既存 trip が取得結果に無い: 削除せずに止める');
  // 8-5. クエスト: 同じ時刻の既存2件がどちらも変わった → 推測で組まずに止める
  const d8e = '2099-11-10';
  const feed8e = (x, y) => [{ type: 'delivery', tripUuid: U(17), time: '11:00', amount: 400 }, { type: 'quest', title: 'クエスト', time: '15:00', amount: x }, { type: 'quest', title: 'クエスト', time: '15:00', amount: y }];
  importFetch(root, d8e, { trips: [trip(17, { amount: 400, time: '11:00' })], feed: feed8e(300, 50) });
  const r8e = importFetch(root, d8e, { trips: [trip(17, { amount: 400, time: '11:00' })], feed: feed8e(310, 60) });
  check(!r8e.applied && dayOf(root, d8e).quests.map(q => q.amount).join(',') === '300,50', '同じ時刻のクエスト2件がどちらも変わった: 止める（既存のまま）');
  // 8-6. スクショ取込（Claude Code の画像読取）は自動更新しない: 既存と距離・ポイントが違えば従来どおり止める（読み違いを公式の変更として通さない）
  const exShot = { date: '2099-11-11', tripsCount: 1, deliveriesCount: 1, deliveries: [{ id: 'del_1111_1', index: 1, completedAt: '12:00', restaurant: 'A店', area: '大阪市西区', fee: 500, distanceKm: 2.5, durationStr: '20分0秒', points: 1, memo: '' }], quests: [], sales: { delivery: 500, quest: 0, adjustment: 0, other: 0, total: 500 } };
  const shot = { activity: { time: '12:00', amount: 500 }, screen: { file: 'a.png', time: '12:00', amount: 500, restaurant: 'A店', area: '大阪市西区', distanceKm: 3.5, durationStr: '20分0秒', durationSeconds: 1200, points: 2, baseFee: null, tip: null } };
  const recShot = pipeline.reconcile('2099-11-11', exShot, [shot], [], [], {}, { at: 'x', structured: false });
  check(recShot.errors.some(e => /公式スクショが不一致/.test(e)) && recShot.log.deliveries[0].distanceKm === 2.5 && recShot.updates.length === 0, `スクショ取込: 距離・ポイントの違いは止める・既存の値のまま（${recShot.errors.join(' / ')}）`);
  const recShotS = pipeline.reconcile('2099-11-11', exShot, [shot], [], [], {}, { at: 'x', structured: true });
  check(recShotS.errors.length === 0 && recShotS.log.deliveries[0].points === 2 && recShotS.log.deliveriesCount === 2, '同じ違いでも Uber Web の構造化データなら公式の値に更新');

  cleanup();
  console.log(`\nテスト結果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  runTests();
} catch (e) {
  cleanup();
  console.error('テスト実行中例外:', e);
  process.exit(1);
}
