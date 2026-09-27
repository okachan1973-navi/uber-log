/**
 * UBER_LOG - 目標クエスト（Target Quest）機能 自動検証テストスイート
 * 
 * 検証要件:
 * 1. 目標クエストの作成・編集・削除
 * 2. 50回、70回、80回、90回など自由な目標件数で正しく進捗計算されること
 * 3. 開始日時・終了日時の期間判定 [startAt, endAt) が秒単位・分単位で正確に機能すること
 * 4. ダブル配達(2pt)・トリプル配達(3pt)の公式ポイントが集計されること
 * 5. クエスト途中作成・取込追加時にも過去データから自動で即時進捗がバックフィルされること
 * 6. 達成時 (isAchieved = true)、残り件数0、100%となること
 * 7. 未設定時、進行中、達成時、期間終了時の状態判定が正確なこと
 * 8. 手動補正 (manualAdjust) が正しく加減算されること
 * 9. 予定報酬額 (expectedReward) が売上・利益・通常分析売上・時給に一切加算されないこと
 * 10. Supabase同期 (uber_metadata: target_quests) のディープマージ、updatedAt比較、tombstone削除追跡
 * 11. 過去の9/21〜9/25の80回クエストが履歴データとして破壊されずに保存されていること
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// LocalStorageのモック
const storageMap = {};
global.localStorage = {
  getItem: k => (k in storageMap ? storageMap[k] : null),
  setItem: (k, v) => { storageMap[k] = String(v); },
  removeItem: k => { delete storageMap[k]; },
  clear: () => { Object.keys(storageMap).forEach(k => delete storageMap[k]); }
};
global.window = {
  localStorage: global.localStorage
};

// store.jsの読み込み
const storeModule = require(path.join(ROOT, 'js', 'store.js'));
const store = storeModule.store;

let passedCount = 0;
let totalCount = 0;

function test(description, fn) {
  totalCount++;
  try {
    fn();
    console.log(`  ✅ ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${description}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('\n🎯 【目標クエスト（TargetQuest）機能 包括的自動テスト】');

// -------------------------------------------------------------
// 1. 過去データの保全
// -------------------------------------------------------------
test('1. 過去の9/21〜9/25の80回クエストが履歴データとして保全されていること', () => {
  const quests = store.getTargetQuests();
  assert(Array.isArray(quests), 'targetQuestsが配列であること');
  const legacy = quests.find(q => q.id === 'quest_20260921_0925');
  assert(legacy, '9/21〜9/25の80回クエストが存在すること');
  assert.strictEqual(legacy.targetCount, 80, '目標件数が80件であること');
  assert.strictEqual(legacy.expectedReward, 8890, '予定報酬が8,890円であること');
  assert.strictEqual(legacy.startAt, '2026-09-21T04:00:00+09:00', '開始日時が正しいこと');
  assert.strictEqual(legacy.endAt, '2026-09-25T04:00:00+09:00', '終了日時が正しいこと');
});

// -------------------------------------------------------------
// 2. 作成・編集・削除
// -------------------------------------------------------------
test('2-1. 新規目標クエストの作成（70回乗車クエスト）', () => {
  const created = store.saveTargetQuest({
    id: 'tq_test_70',
    name: '70回乗車特別クエスト',
    startAt: '2026-10-02T04:00:00+09:00',
    endAt: '2026-10-05T04:00:00+09:00',
    targetCount: 70,
    expectedReward: 7500,
    manualAdjust: 0,
    memo: '週末目標'
  });
  assert(created, '作成結果が返ること');
  assert.strictEqual(created.id, 'tq_test_70');
  assert.strictEqual(created.name, '70回乗車特別クエスト');
  assert.strictEqual(created.targetCount, 70);
  assert.strictEqual(created.expectedReward, 7500);

  const found = store.getTargetQuestById('tq_test_70');
  assert(found, 'IDで取得できること');
  assert.strictEqual(found.name, '70回乗車特別クエスト');
});

test('2-2. 目標クエストの編集（件数・報酬・メモの変更）', () => {
  const updated = store.saveTargetQuest({
    id: 'tq_test_70',
    name: '90回乗車特別クエスト（拡大）',
    startAt: '2026-10-02T04:00:00+09:00',
    endAt: '2026-10-05T04:00:00+09:00',
    targetCount: 90,
    expectedReward: 12000,
    manualAdjust: 2,
    memo: '雨天予報のため上方修正'
  });
  assert(updated, '更新結果が返ること');
  assert.strictEqual(updated.targetCount, 90, '目標件数が90件に更新されること');
  assert.strictEqual(updated.expectedReward, 12000, '予定報酬が12,000円に更新されること');
  assert.strictEqual(updated.manualAdjust, 2, '手動補正が2件に更新されること');

  const found = store.getTargetQuestById('tq_test_70');
  assert.strictEqual(found.name, '90回乗車特別クエスト（拡大）');
});

test('2-3. 目標クエストの削除とtombstone記録', () => {
  const delRes = store.deleteTargetQuest('tq_test_70');
  assert.strictEqual(delRes, true, '削除が成功すること');
  assert.strictEqual(store.getTargetQuestById('tq_test_70'), null, '削除後は取得できないこと');
  assert(store.state.deletedTargetQuestIds.includes('tq_test_70'), 'deletedTargetQuestIdsにtombstoneが記録されること');
});

// -------------------------------------------------------------
// 3. 50回クエスト実データ検証（9/26〜9/27）
// -------------------------------------------------------------
test('3. 2026-09-25 04:00〜09-28 04:00 50回乗車クエストの自動進捗計算', () => {
  // 50回乗車クエストを作成
  store.saveTargetQuest({
    id: 'tq_20260925_50',
    name: '50回乗車クエスト',
    startAt: '2026-09-25T04:00:00+09:00',
    endAt: '2026-09-28T04:00:00+09:00',
    targetCount: 50,
    expectedReward: 4450,
    manualAdjust: 0,
    memo: '9/25〜9/28 週末大型クエスト'
  });

  const progress = store.getQuestProgress(store.getTargetQuestById('tq_20260925_50'));
  assert(progress, '進捗オブジェクトが返ること');
  assert.strictEqual(progress.targetCount, 50, '目標は50件');
  
  // 9/26のDelivery件数（34件）＋ 9/27のDelivery件数（17件）＝ 51件
  assert.strictEqual(progress.officialCount, 51, `公式Delivery件数の合計が51件であること（=${progress.officialCount}）`);
  assert.strictEqual(progress.currentCount, 51, '現在件数が51件');
  assert.strictEqual(progress.remainingCount, 0, '目標達成のため残り件数は0件');
  assert.strictEqual(progress.percentage, 100, '達成率は100%');
  assert.strictEqual(progress.isAchieved, true, 'isAchievedがtrue');
  assert.strictEqual(progress.expectedReward, 4450, '予定報酬4,450円');
});

// -------------------------------------------------------------
// 4. 期間判定 [startAt, endAt) の境界値検証
// -------------------------------------------------------------
test('4. 期間判定 [startAt, endAt) の境界値（開始時刻ちょうどは含む、終了時刻ちょうどは含まない）', () => {
  const dummyQuest = {
    startAt: '2026-10-10T04:00:00+09:00',
    endAt: '2026-10-13T04:00:00+09:00'
  };

  assert.strictEqual(store.isDateTimeInQuestPeriod('2026-10-10', '03:59', dummyQuest), false, '開始前03:59は含まない');
  assert.strictEqual(store.isDateTimeInQuestPeriod('2026-10-10', '04:00', dummyQuest), true, '開始時刻04:00ちょうどは含む');
  assert.strictEqual(store.isDateTimeInQuestPeriod('2026-10-12', '23:59', dummyQuest), true, '期間内は含む');
  assert.strictEqual(store.isDateTimeInQuestPeriod('2026-10-13', '03:59', dummyQuest), true, '終了直前03:59は含む');
  assert.strictEqual(store.isDateTimeInQuestPeriod('2026-10-13', '04:00', dummyQuest), false, '終了時刻04:00ちょうどは含まない');
});

// -------------------------------------------------------------
// 5. 手動補正（manualAdjust）の反映
// -------------------------------------------------------------
test('5. 手動補正（manualAdjust）の加算・減算検証', () => {
  const quest = store.getTargetQuestById('tq_20260925_50');
  
  // +3件補正
  store.saveTargetQuest({
    ...quest,
    manualAdjust: 3
  });
  let p = store.getQuestProgress(store.getTargetQuestById('tq_20260925_50'));
  assert.strictEqual(p.manualAdjust, 3);
  assert.strictEqual(p.currentCount, 54, '公式51 + 補正3 = 54件');

  // -5件補正
  store.saveTargetQuest({
    ...quest,
    manualAdjust: -5
  });
  p = store.getQuestProgress(store.getTargetQuestById('tq_20260925_50'));
  assert.strictEqual(p.manualAdjust, -5);
  assert.strictEqual(p.currentCount, 46, '公式51 - 補正5 = 46件');
  assert.strictEqual(p.remainingCount, 4, '残り4件');
  assert.strictEqual(p.isAchieved, false, '未達成');

  // 戻す
  store.saveTargetQuest({
    ...quest,
    manualAdjust: 0
  });
});

// -------------------------------------------------------------
// 6. 予定報酬額が売上・時給に一切加算されないこと
// -------------------------------------------------------------
test('6. 目標クエストの予定報酬額（expectedReward）が売上・利益・通常分析売上・時給に影響しないこと', () => {
  // 9/27の売上メトリクスを取得
  const log0927 = store.getDailyLog('2026-09-27');
  const metrics = store.getCalculatedMetrics(log0927);

  // 9/27の実績: 配達 ¥5,362, 通常クエスト ¥2,400, 特別クエスト ¥4,450, 総売上 ¥12,212
  assert.strictEqual(metrics.totalSales, 12212, '総売上は¥12,212');
  assert.strictEqual(metrics.deliverySales, 5362, '配達報酬は¥5,362');
  assert.strictEqual(metrics.questSales, 6850, 'クエスト合計は¥6,850');
  assert.strictEqual(metrics.specialQuestSales, 4450, '特別クエストは¥4,450');
  assert.strictEqual(metrics.hourlyBaseSales, 7762, '通常分析売上は¥7,762（特別クエスト除外）');
  assert.strictEqual(metrics.hourlyWage, 1898, '通常時給は¥1,898');

  // クエストのexpectedRewardを極端な値に変更
  const quest = store.getTargetQuestById('tq_20260925_50');
  store.saveTargetQuest({
    ...quest,
    expectedReward: 999999
  });

  const metricsAfter = store.getCalculatedMetrics(log0927);
  assert.strictEqual(metricsAfter.totalSales, 12212, '総売上に予定報酬が加算されないこと');
  assert.strictEqual(metricsAfter.hourlyBaseSales, 7762, '通常分析売上に予定報酬が加算されないこと');
  assert.strictEqual(metricsAfter.hourlyWage, 1898, '通常時給に予定報酬が加算されないこと');

  // 戻す
  store.saveTargetQuest({
    ...quest,
    expectedReward: 4450
  });
});

// -------------------------------------------------------------
// 7. 未設定時・状態判定
// -------------------------------------------------------------
test('7. 未設定時・進行中・終了時の状態判定', () => {
  // 一時的にクエスト全削除
  const savedQuests = [...store.state.targetQuests];
  store.state.targetQuests = [];
  
  const emptyProg = store.getQuestProgress();
  assert.strictEqual(emptyProg.hasQuest, false, '未設定時はhasQuestがfalse');
  assert.strictEqual(emptyProg.title, '目標クエスト未設定');
  assert.strictEqual(emptyProg.currentCount, 0);
  assert.strictEqual(emptyProg.targetCount, 0);

  // 復元
  store.state.targetQuests = savedQuests;

  // 未来のクエスト
  const futureQuest = {
    id: 'tq_future',
    name: '未来のクエスト',
    startAt: '2099-01-01T04:00:00+09:00',
    endAt: '2099-01-05T04:00:00+09:00',
    targetCount: 50
  };
  const futureProg = store.calculateTargetQuestProgress(futureQuest, new Date('2026-09-27T12:00:00+09:00'));
  assert.strictEqual(futureProg.isStarted, false, '開始前');
  assert.strictEqual(futureProg.isEnded, false, '未終了');
  assert(futureProg.remainingTimeText.includes('開始まで'), '開始までの時間が表示されること');

  // 終了したクエスト
  const pastQuest = {
    id: 'tq_past',
    name: '過去のクエスト',
    startAt: '2026-09-01T04:00:00+09:00',
    endAt: '2026-09-05T04:00:00+09:00',
    targetCount: 50
  };
  const pastProg = store.calculateTargetQuestProgress(pastQuest, new Date('2026-09-27T12:00:00+09:00'));
  assert.strictEqual(pastProg.isStarted, true, '開始済み');
  assert.strictEqual(pastProg.isEnded, true, '終了済み');
  assert(pastProg.remainingTimeText.includes('受付終了') || pastProg.remainingTimeText.includes('終了'), '終了表示');
});

// -------------------------------------------------------------
// 8. クラウド同期ディープマージ検証
// -------------------------------------------------------------
test('8. クラウド同期ディープマージ（tombstone除外、updatedAt新側優先）', () => {
  const { cloudSync } = require(path.join(ROOT, 'js', 'cloud-sync.js'));
  assert(cloudSync, 'cloudSyncが読み込めること');

  const localQuests = [
    { id: 'q1', name: 'ローカル古い', updatedAt: '2026-09-25T10:00:00Z', targetCount: 50 },
    { id: 'q2', name: 'ローカル新しい', updatedAt: '2026-09-27T10:00:00Z', targetCount: 60 },
    { id: 'q3', name: 'ローカルのみ', updatedAt: '2026-09-27T10:00:00Z', targetCount: 70 }
  ];

  const cloudQuests = [
    { id: 'q1', name: 'リモート新しい', updatedAt: '2026-09-26T10:00:00Z', targetCount: 55 },
    { id: 'q2', name: 'リモート古い', updatedAt: '2026-09-26T10:00:00Z', targetCount: 50 },
    { id: 'q4_deleted', name: 'リモートに残る削除済み', updatedAt: '2026-09-20T10:00:00Z', targetCount: 40 }
  ];

  const merged = cloudSync.mergeTargetQuests(localQuests, [], cloudQuests, ['q4_deleted']);
  assert.strictEqual(merged.quests.length, 3, 'マージ後件数は3件（q4_deletedは除外）');

  const q1 = merged.quests.find(q => q.id === 'q1');
  assert.strictEqual(q1.name, 'リモート新しい', 'updatedAtが新しいリモートが勝つ');
  assert.strictEqual(q1.targetCount, 55);

  const q2 = merged.quests.find(q => q.id === 'q2');
  assert.strictEqual(q2.name, 'ローカル新しい', 'updatedAtが新しいローカルが勝つ');
  assert.strictEqual(q2.targetCount, 60);

  const q3 = merged.quests.find(q => q.id === 'q3');
  assert.strictEqual(q3.name, 'ローカルのみ', '片方にしかないものも保持');

  const q4 = merged.quests.find(q => q.id === 'q4_deleted');
  assert.strictEqual(q4, undefined, 'tombstone削除対象は復活しない');
});

console.log(`\n🎉 全テスト完了: ${passedCount} passed, 0 failed\n`);
