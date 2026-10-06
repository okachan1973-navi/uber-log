#!/usr/bin/env node
/**
 * 過去日の編集が端末間で同期されることのテスト
 *   node spec/past-date-sync-tests.js
 *
 * 日付を受け取る13の操作（稼働セッション・配達・クエスト・稼働時刻・距離）が、保存時に「対象日」を同期対象にすること。
 * 以前は対象日を渡さず「今日」だけが同期対象になり、昨日以前の編集が Supabase・他の端末へ届かなかった。
 * 本物の js/store.js・js/cloud-sync.js を端末ごとの実行環境で動かす（tools/official-import/spec/sync-harness.js）。
 * UBER_LOG_ROOT を指定すると、そのフォルダの js/ を対象にする（修正前のコードでこのテストが失敗することの確認用）。
 *
 * 既知の未対応（このテストでは現状の動作を確認し、直ったら知らせる）:
 *   削除の同期 — クラウドとの統合（cloud-sync.js mergeDailyLog）は稼働セッション・配達・クエストを ID の和集合で統合し、
 *   削除の記録（tombstone）は経費にしか無い。そのため削除はクラウド・他の端末へ届かず、統合で復活する。別対応。
 */
'use strict';

const { createStorage, createCloud, createDevice } = require('../tools/official-import/spec/sync-harness.js');

let passed = 0;
let failed = 0;
const known = [];
const check = (c, m, detail) => {
  if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ FAIL: ${m}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
};
const section = t => console.log(`\n【${t}】`);

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(new Date());
const YESTERDAY = ymd(new Date(Date.now() - 24 * 3600 * 1000));
const PAST = '2026-08-20'; // 公式データの無い過去日
const OFFICIAL = '2026-09-29'; // 公式取込済みの過去日

// 1) 13の操作それぞれで、同期対象が「その日だけ」になる（送信しないで確認するので、統合の影響を受けない）
function markingScenario(label, date) {
  section(`${label}（${date}）: 13の操作で同期対象がその日になる`);
  const dev = createDevice({ storage: createStorage(), cloud: createCloud() });
  const ops = [];
  const op = (name, fn) => {
    dev.sync.pendingSyncDates.clear();
    fn();
    const p = [...dev.sync.pendingSyncDates];
    check(p.length === 1 && p[0] === date, `${name} → 同期対象 ${date}`, p);
    ops.push(name);
  };
  let sess, started, del, q;
  op('稼働セッション追加', () => { sess = dev.store.addWorkSession(date, { start: '10:00', end: '12:00' }); });
  op('稼働セッション修正', () => { dev.store.updateWorkSession(date, sess.id, { end: '13:00' }); });
  op('稼働セッション削除', () => { dev.store.deleteWorkSession(date, sess.id); });
  op('稼働開始', () => { started = dev.store.startWorkSession(date, '14:00').session; });
  op('稼働終了', () => { dev.store.endWorkSession(date, '15:00', started.id); });
  op('稼働時刻（updateWorkInfo）', () => { dev.store.updateWorkInfo(date, { workStartedAt: '09:00', workEndedAt: '16:00' }); });
  op('配達追加（1タップ記録）', () => { del = dev.store.addDelivery(date, '11:11').delivery; });
  op('配達修正', () => { dev.store.updateDelivery(date, del.id, { memo: '修正' }); });
  op('配達削除', () => { dev.store.deleteDelivery(date, del.id); });
  op('配達の取り消し', () => { dev.store.addDelivery(date, '12:12'); dev.sync.pendingSyncDates.clear(); dev.store.undoLastDelivery(date); });
  op('クエスト追加', () => { q = dev.store.addQuest(date, { time: '13:13', title: 'テスト', amount: 123 }); });
  op('クエスト削除', () => { dev.store.deleteQuest(date, q.id); });
  op('距離（updateDailyNumbers）', () => { dev.store.updateDailyNumbers(date, { totalDistanceKm: '12.3' }); });
  check(ops.length === 13, `13操作すべてを確認（${ops.length}）`);
}

// 2) 追加・修正がクラウドと別の端末へ届く
async function cloudScenario(label, date, { official }) {
  // 公式取込済みの日は、手動の空タップ記録を統合で除き（cloud-sync.js）、距離は公式の値を優先する（起動時に同梱データへ合わせる）仕様
  const manualDeliveries = !official;
  section(`${label}（${date}）: 追加・修正がクラウドと別端末へ届く`);
  const cloud = createCloud();
  const dev = createDevice({ storage: createStorage(), cloud });
  const row = () => cloud.row(date) || {};
  const s = dev.store.addWorkSession(date, { start: '10:00', end: '12:00' });
  await dev.flushPush();
  check((row().workSessions || []).some(x => x.id === s.id && x.end === '12:00'), '稼働セッション追加がクラウドに届く');
  dev.store.updateWorkSession(date, s.id, { end: '13:00' });
  await dev.flushPush();
  check((row().workSessions || []).some(x => x.id === s.id && x.end === '13:00'), '稼働セッション修正がクラウドに届く');
  const q = dev.store.addQuest(date, { time: '13:13', title: 'テスト', amount: 123 });
  await dev.flushPush();
  check((row().quests || []).some(x => x.id === q.id), 'クエスト追加がクラウドに届く');
  dev.store.updateDailyNumbers(date, { totalDistanceKm: '12.3' });
  await dev.flushPush();
  check(row().totalDistanceKm === 12.3, '距離がクラウドに届く');
  let del = null;
  if (manualDeliveries) {
    del = dev.store.addDelivery(date, '11:11').delivery;
    dev.store.updateDelivery(date, del.id, { memo: '修正' });
    await dev.flushPush();
    check((row().deliveries || []).some(x => x.id === del.id && x.memo === '修正'), '配達の追加・修正がクラウドに届く');
  }
  const other = createDevice({ storage: createStorage(), cloud });
  await other.pull();
  const o = other.day(date) || {};
  const officialDistance = official ? createDevice({ storage: createStorage() }).day(date).totalDistanceKm : null;
  check((o.workSessions || []).some(x => x.id === s.id && x.end === '13:00') && o.totalDistanceKm === (official ? officialDistance : 12.3) && (o.quests || []).some(x => x.id === q.id)
    && (!del || (o.deliveries || []).some(x => x.id === del.id)), official ? '別端末で pull → 稼働セッション・クエストが届く（距離は公式の値のまま）' : '別端末で pull → 同じ内容（稼働セッション・クエスト・距離・配達）', { sessions: (o.workSessions || []).map(x => x.id === s.id ? x.end : '-'), distance: o.totalDistanceKm, quest: (o.quests || []).some(x => x.id === q.id), official: !!o.officialImport });

  // 既知の未対応: 削除はクラウドへ届かない（統合で復活する）
  dev.store.deleteWorkSession(date, s.id);
  await dev.flushPush();
  const stillInCloud = (row().workSessions || []).some(x => x.id === s.id);
  known.push(`${date}: 稼働セッション削除 → クラウドに${stillInCloud ? '残る（既知の未対応）' : '反映された（直っている → 既知リストから外すこと）'}`);
}

(async () => {
  try {
    console.log(`対象日: 今日 ${TODAY} / 昨日 ${YESTERDAY} / 過去日 ${PAST} / 公式取込済みの過去日 ${OFFICIAL}`);
    markingScenario('今日の編集', TODAY);
    markingScenario('昨日の編集', YESTERDAY);
    markingScenario('過去日の編集', PAST);
    markingScenario('公式取込済みの過去日の編集', OFFICIAL);

    const hasOfficial = date => { const d = createDevice({ storage: createStorage() }).day(date); return !!(d && d.officialImport); };
    await cloudScenario('今日の編集', TODAY, { official: hasOfficial(TODAY) });
    await cloudScenario('昨日の編集', YESTERDAY, { official: hasOfficial(YESTERDAY) });
    await cloudScenario('過去日の編集', PAST, { official: false });

    section(`公式取込済みの過去日（${OFFICIAL}）: 本人入力の同期で公式データは変わらない`);
    const cloud = createCloud();
    const dev = createDevice({ storage: createStorage(), cloud });
    const before = JSON.stringify({ d: dev.day(OFFICIAL).deliveries.map(x => x.id), s: dev.day(OFFICIAL).sales });
    const s = dev.store.addWorkSession(OFFICIAL, { start: '11:00', end: '18:00' });
    await dev.flushPush();
    check((cloud.row(OFFICIAL).workSessions || []).some(x => x.id === s.id), 'クラウドの公式取込済みの日に稼働セッションが届く');
    check(JSON.stringify({ d: cloud.row(OFFICIAL).deliveries.map(x => x.id), s: cloud.row(OFFICIAL).sales }) === before, '公式データ（配達・売上）は変わらない');
  } catch (e) {
    failed++;
    console.log('  ❌ 例外: ' + (e && e.stack || e));
  }
  if (known.length) { console.log('\n⚠ 既知の未対応（別対応・合否には含めない）:'); known.forEach(k => console.log('  - ' + k)); }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
