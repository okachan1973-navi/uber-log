#!/usr/bin/env node
/**
 * 2端末同期テスト（SYNC_MODEL.md）
 *   node tools/data-audit/spec/sync-model-tests.js
 * 本物の js/store.js と js/cloud-sync.js を端末ごとの JS 環境で動かし（tools/official-import/spec/sync-harness.js）、
 * メモリ上のクラウド（Supabase の表を模したもの）で 端末A = OPPO（主に入力）・端末B = PC を同期させる。
 * 実際のクラウド・実機には触れない（ここで確かめるのは「コード／人工データで確認済み」の範囲）。
 */
'use strict';

const path = require('path');
const H = require(path.join(__dirname, '..', '..', 'official-import', 'spec', 'sync-harness.js'));

let passed = 0, failed = 0;
const check = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); } else { failed++; console.log(`  ❌ FAIL: ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
};
const section = t => console.log(`\n【${t}】`);
const settle = () => H.sleep(900); // 入力後の自動送信（700ms 後）が終わるのを待つ

const D = '2099-11-10';      // 普段の日（人工）
const PAST = '2099-01-20';   // 過去日
const TRIP_DAY = '2026-10-12'; // 同梱データにある公式の日（trip の評価・メモ用）
const TRIP = 'del_1012_1';

const exps = (dev, date) => ((dev.day(date) || {}).expenses || []);
const expIds = (dev, date) => exps(dev, date).map(e => e.id).sort();
const cloudDay = (cloud, date) => cloud.row(date);

function pair() {
  const cloud = H.createCloud();
  const A = H.createDevice({ storage: H.createStorage(), cloud });
  const B = H.createDevice({ storage: H.createStorage(), cloud });
  return { cloud, A, B };
}

(async () => {
  try {
    // ==========================================================
    section('1-4. 経費: OPPO で入力 → クラウド → PC。PC が古くても消さない・PC の未送信も失わない・重複しない');
    {
      const { cloud, A, B } = pair();
      await B.pull(); // PC は先に起動していた（この日のデータは古いまま）
      const e1 = A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: 'OPPO' });
      await settle();
      check(cloudDay(cloud, D) && (cloudDay(cloud, D).expenses || []).some(e => e.id === e1.id), '1. OPPO で入力した経費が自動でクラウドへ（送信ボタン不要）');
      await B.pull();
      check(expIds(B, D).includes(e1.id), '1. PC を開く（pull）と OPPO の経費が表示される');
      // PC で別の経費（PC だけにある未送信）→ その後に同期
      const e2 = B.store.addExpense(D, { category: '駐輪', amount: 100, memo: 'PC' });
      await settle();
      await A.pull();
      check(expIds(A, D).join() === [e1.id, e2.id].sort().join() && expIds(B, D).join() === [e1.id, e2.id].sort().join(), '2-3. 両端末の経費が両方に残る（PC の古いデータで OPPO の経費を消さない・PC の新しい入力も失わない）');
      for (let i = 0; i < 3; i++) { await A.pull(); await B.pull(); }
      check(exps(A, D).length === 2 && exps(B, D).length === 2 && (cloudDay(cloud, D).expenses || []).length === 2, '4. 同期を何度繰り返しても同じ経費は1件だけ');
      check(A.profit(D) === -1627 || A.store.getCalculatedMetrics(A.day(D)).totalExpenses === 1627, '必要経費 ¥1,627（両端末で同じ）');
      check(B.store.getCalculatedMetrics(B.day(D)).totalExpenses === A.store.getCalculatedMetrics(A.day(D)).totalExpenses, 'OPPO と PC で必要経費が一致');
    }

    // ==========================================================
    section('5. 削除した経費は別端末から復活しない（tombstone）');
    {
      const { cloud, A, B } = pair();
      const e = A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: '' });
      await settle(); await B.pull();
      check(expIds(B, D).includes(e.id), '前提: PC にも同じ経費がある');
      A.store.deleteExpense(D, e.id);
      await settle();
      B.store.addExpense(D, { category: '必要経費', amount: 50, memo: 'PC の別の入力（この日を PC から送る）' });
      await settle(); await A.pull(); await B.pull();
      check(!expIds(A, D).includes(e.id) && !expIds(B, D).includes(e.id) && !(cloudDay(cloud, D).expenses || []).some(x => x.id === e.id),
        'OPPO で削除した経費は、PC が古いコピーを持っていても復活しない（端末・クラウドとも）');
    }

    // ==========================================================
    section('6, 12, 13. 過去日・別の日・同じ日を両端末で更新');
    {
      const { cloud, A, B } = pair();
      const ep = A.store.addExpense(PAST, { category: '交通費', amount: 200, memo: '過去日' });
      const eb = B.store.addExpense('2099-11-11', { category: '必要経費', amount: 300, memo: 'PC 別の日' });
      const ea = A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: 'OPPO 同じ日' });
      const ec = B.store.addExpense(D, { category: '駐輪', amount: 100, memo: 'PC 同じ日' });
      await settle(); await A.pull(); await B.pull(); await A.pull();
      check(expIds(B, PAST).includes(ep.id) && cloudDay(cloud, PAST), '6. 過去日の経費はその日付で同期（今日ではない）');
      check(expIds(A, '2099-11-11').includes(eb.id), '12. 別の日の更新はそれぞれ届く');
      check(expIds(A, D).join() === [ea.id, ec.id].sort().join() && expIds(B, D).join() === [ea.id, ec.id].sort().join(), '13. 同じ日を両端末で更新しても両方残る（ID 単位の和集合）');
    }

    // ==========================================================
    section('7. 手動休み（更新時刻で新しい方。古い端末が戻さない）');
    {
      const { A, B } = pair();
      A.store.setDayOff(D, true);
      await settle(); await B.pull();
      check(B.day(D).dayOff === true, 'OPPO の手動休みが PC へ');
      await H.sleep(5);
      B.store.setDayOff(D, false); // PC で後から解除
      await settle(); await A.pull();
      check(A.day(D).dayOff === false && A.store.getDayStatus(D, '2099-12-31').status !== 'off', 'PC で後から解除 → OPPO も解除（新しい方）');
      // v78 以前の古い値（更新時刻なし）を持つ端末: 時刻つきの新しい値に従う（古い値で戻さない）
      const { cloud: cloud2, A: A2, B: B2 } = pair();
      B2.store.state.dailyLogs[D] = { date: D, deliveries: [], quests: [], expenses: [], dayOff: true }; // 時刻なしの古い手動休み
      A2.store.setDayOff(D, false);
      await settle(); await B2.pull();
      check(B2.day(D).dayOff === false && cloud2.row(D).dayOff === false && !B2.sync.getConflicts().some(x => x.field === 'dayOff'),
        '時刻のない古い手動休み（PC）より、時刻つきの新しい解除（OPPO）を採用（競合にしない）');
    }

    // ==========================================================
    section('8. 天気（手動の weather）');
    {
      const { A, B } = pair();
      A.store.setDayWeather(D, { type: 'rain', raw: '雨' });
      await settle(); await B.pull();
      check(B.day(D).weather && B.day(D).weather.type === 'rain' && B.store.getWeather(D).label === '雨', 'OPPO で登録した天気が PC へ');
      await H.sleep(5);
      B.store.setDayWeather(D, { type: 'cloudy', raw: '曇' });
      await settle(); await A.pull();
      check(A.day(D).weather.type === 'cloudy', 'PC で後から直した天気が OPPO へ（新しい方）');
    }

    // ==========================================================
    section('9-10. MAP一口メモ・○×評価（再起動しても古い評価に戻らない）');
    {
      const { cloud, A, B } = pair();
      B.store.setTripEvaluation(TRIP, 'AVOID'); // PC で先に付けた古い評価
      await settle();
      await H.sleep(5);
      A.store.setTripEvaluation(TRIP, 'OK');    // OPPO で後から付けた新しい評価
      A.store.setTripEvaluationReason(TRIP, '近い・楽');
      A.store.setTripMapMemo(TRIP, '裏口から');
      await settle(); await B.pull();
      check(B.store.getTripEvaluationData(TRIP).evaluation === 'OK' && B.store.getTripEvaluationData(TRIP).reason === '近い・楽', '10. 新しい評価・理由が PC へ（PC の古い評価で上書きしない）');
      check(B.store.getTripMapMemo(TRIP) === '裏口から', '9. MAP一口メモがクラウド経由で PC へ（以前は端末内だけ）');
      const B2 = H.createDevice({ storage: B.storage, cloud }); // PC を開き直す
      check(B2.store.getTripEvaluationData(TRIP).evaluation === 'OK' && B2.store.getTripMapMemo(TRIP) === '裏口から', '10. PC を開き直しても端末内の古い控え（AVOID）に戻らない');
      await A.pull();
      check(A.store.getTripEvaluationData(TRIP).evaluation === 'OK', 'OPPO も OK のまま（往復で巻き戻らない）');
    }

    // ==========================================================
    section('11. オフラインで入力 → 再接続 → クラウド → 別端末');
    {
      const { cloud, A, B } = pair();
      cloud.setOnline(false);
      A.window.navigator = { onLine: false };
      const e = A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: 'オフライン' });
      await settle();
      check(A.sync.pendingSyncDates.has(D) && expIds(A, D).includes(e.id), 'オフライン中: 端末に保存・未送信として残る（入力を失わない）');
      check(!cloudDay(cloud, D), 'オフライン中はクラウドに送らない');
      cloud.setOnline(true);
      await A.pull(); // online 復帰で自動同期（pull → 未送信を送る）
      check(!A.sync.pendingSyncDates.has(D) && (cloudDay(cloud, D).expenses || []).some(x => x.id === e.id), '再接続後: 未送信が自動で送られる');
      await B.pull();
      check(expIds(B, D).includes(e.id), '別端末（PC）に届く');
    }

    // ==========================================================
    section('14-15. 公式の値: 新しい公式取込を古い端末の公式値で巻き戻さない');
    {
      const { cloud, A, B } = pair();
      const OD = '2099-11-20';
      const official = (importedAt, trips, total) => ({
        date: OD, officialImport: { source: 'official-import-v1', importedAt },
        tripsCount: trips, deliveriesCount: trips, officialPoints: trips, totalDistanceKm: trips * 2,
        deliveries: Array.from({ length: trips }, (_, i) => ({ id: `del_x_${i + 1}`, index: i + 1, completedAt: `1${i}:00`, restaurant: `店${i + 1}`, fee: 500, points: 1, distanceKm: 2, durationStr: '10分0秒' })),
        quests: [], expenses: [], workSessions: [], sales: { delivery: trips * 500, quest: 0, adjustment: 0, other: 0, total: total }
      });
      // OPPO: 新しい公式取込（夕方まで 21trip）。PC: 昼の途中データ（17trip）で古い
      A.store.state.dailyLogs[OD] = official('2099-11-21T00:00:00Z', 21, 10500);
      A.store.saveToStorage(OD);
      B.store.state.dailyLogs[OD] = official('2099-11-20T06:00:00Z', 17, 8500);
      await settle();
      B.store.addExpense(OD, { category: 'バイクシェア', amount: 1527, memo: 'PC で入力（この日を PC から送る）' });
      await settle();
      const c = cloudDay(cloud, OD);
      check(c.tripsCount === 21 && c.deliveries.length === 21 && c.sales.total === 10500 && c.officialImport.importedAt === '2099-11-21T00:00:00Z',
        `15. 古い公式値（17trip）を持つ PC が送っても、クラウドは新しい公式値（${c.tripsCount}trip・¥${c.sales.total}）のまま`);
      check((c.expenses || []).length === 1, '15. PC で入れた経費はクラウドに加わる');
      await B.pull();
      check(B.day(OD).tripsCount === 21 && B.day(OD).sales.total === 10500 && B.store.getCalculatedMetrics(B.day(OD)).count === 21, '14. PC も新しい公式値に更新される（公式再取込の結果が端末間で揃う）');
      await A.pull();
      check(A.day(OD).tripsCount === 21 && (A.day(OD).expenses || []).length === 1, 'OPPO は新しい公式値のまま・PC の経費も届く');
      const B2 = H.createDevice({ storage: B.storage, cloud });
      check(B2.day(OD).tripsCount === 21, 'PC を開き直しても新しい公式値のまま');
    }

    // ==========================================================
    section('競合: 自動で決められない値は端末側を残して記録し、勝手に捨てない');
    {
      const { A, B } = pair();
      const CD = '2099-11-25';
      // 更新時刻のない旧データ（v78 以前に入った移動手段）が両端末で違う
      A.store.state.dailyLogs[CD] = { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: 'バイクシェア利用' };
      A.store.saveToStorage(CD);
      await settle();
      B.store.state.dailyLogs[CD] = { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: '自前自転車' };
      await B.pull();
      const conf = B.sync.getConflicts();
      check(B.day(CD).vehicleType === '自前自転車' && conf.some(x => x.date === CD && x.field === 'vehicleType' && x.cloud === 'バイクシェア利用'),
        '時刻のない値が違う → PC の値を残し、競合として記録（クラウドの値も記録に残る）');
      B.store.updateVehicleType(CD, 'バイクシェア利用'); // 利用者が直す（時刻つき）
      await settle(); await B.pull();
      check(!B.sync.getConflicts().some(x => x.date === CD && x.field === 'vehicleType'), '値をそろえると競合の記録は消える');
    }

    // ==========================================================
    section('同期の記録（diag.html・ヘッダーの「同期済み HH:MM」）');
    {
      const { A } = pair();
      A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: '' });
      await settle(); await A.pull();
      const info = A.sync.getSyncInfo();
      check(info.clientId && info.lastPullAt && info.lastPushAt && info.lastSyncAt && info.lastResult === 'ok' && info.cloudDays >= 1 && info.pendingDates.length === 0,
        `最終 pull・push・結果・クラウドの日数・端末ID を記録（${JSON.stringify({ result: info.lastResult, cloudDays: info.cloudDays })}）`);
      const cloud2 = H.createCloud();
      const E = H.createDevice({ storage: H.createStorage(), cloud: cloud2 });
      cloud2.setOnline(false);
      E.store.addExpense(D, { category: '必要経費', amount: 10, memo: '' });
      await E.pull();
      const ei = E.sync.getSyncInfo();
      check(ei.lastResult === 'error' && ei.lastError && ei.pendingDates.includes(D), `同期できないときはエラーと未送信を記録（${ei.lastError}）`);
    }

    // ==========================================================
    // v80: 移動手段の旧名称・競合の解決・日数の差（端末だけの日・送信漏れ）
    // ==========================================================
    const putCloud = (cloud, date, data) => cloud.tables.uber_daily_logs.set(date, { user_id: 'user-1', date, data: JSON.parse(JSON.stringify(data)), updated_at: new Date().toISOString() });
    const upserts = (cloud, date) => { let n = 0; cloud.onUpsert = async row => { if (!date || row.date === date) n++; }; return () => n; };
    const diffOf = dev => {
      const D = dev.window.UberLogDiagnostics;
      const idx = JSON.parse(dev.storage.getItem('uber_sync_cloud_index') || 'null');
      return D.diffLocalCloud(dev.store.state.dailyLogs, idx, { pendingDates: Array.from(dev.sync.pendingSyncDates), conflicts: dev.sync.getConflicts() });
    };

    section('v80-1. 移動手段の旧名称（レンタサイクル = バイクシェア利用）は競合にしない・保存値は書き換えない');
    {
      const { cloud, A, B } = pair();
      const VD = '2099-09-19';
      putCloud(cloud, VD, { date: VD, deliveries: [], quests: [], expenses: [], vehicleType: 'レンタサイクル' }); // 古い同梱データが送られたままのクラウド
      A.store.state.dailyLogs[VD] = { date: VD, deliveries: [], quests: [], expenses: [], vehicleType: 'バイクシェア利用' };
      A.store.persistState();
      // v79 で記録された同じ競合が端末に残っている状態
      A.storage.setItem('uber_sync_conflicts', JSON.stringify([{ key: `${VD}|vehicleType`, date: VD, field: 'vehicleType', local: 'バイクシェア利用', cloud: 'レンタサイクル', kept: 'local', at: '2026-10-14T00:00:00Z' }]));
      const count = upserts(cloud, VD);
      await A.pull();
      check(!A.sync.getConflicts().some(c => c.date === VD), '1. 同義の旧名称は比べる前にそろえる → v79 で残った競合も次の同期で消える');
      check(A.day(VD).vehicleType === 'バイクシェア利用' && cloud.row(VD).vehicleType === 'レンタサイクル' && count() === 0, '保存値はどちらも書き換えない（端末「バイクシェア利用」・クラウド「レンタサイクル」のまま。送信もしない）');
      await B.pull();
      check(!B.sync.getConflicts().length && A.window.UberLogDiagnostics.canonicalVehicleType(B.day(VD).vehicleType) === 'バイクシェア利用', 'PC でも競合にならない（表示上は同じ「バイクシェア利用」）');
      const d = diffOf(A);
      check(!d.different.some(x => x.date === VD), '端末とクラウドの差分でも「同じ」扱い');
      check(A.window.UberLogDiagnostics.canonicalVehicleType('自前自転車') === '自前自転車' && A.window.UberLogDiagnostics.canonicalVehicleType('電動レンタル') === '電動レンタル', '意味の違う値（自前自転車・電動レンタル）はそろえない');
    }

    section('v80-2〜6. 本当の競合は利用者が選ぶ（この端末の値 / クラウドの値）→ 両端末で一致・競合 0');
    {
      const { cloud, A, B } = pair();
      const CD = '2099-09-20';
      putCloud(cloud, CD, { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: '自前自転車' });
      for (const dev of [A, B]) { dev.store.state.dailyLogs[CD] = { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: 'バイクシェア利用' }; dev.store.persistState(); }
      const count = upserts(cloud, CD);
      await A.pull(); await B.pull();
      const key = `${CD}|vehicleType`;
      check(A.sync.getConflicts().some(c => c.key === key) && B.sync.getConflicts().some(c => c.key === key), '2. 意味の違う値（時刻なし）は両端末で競合として残る');
      check(cloud.row(CD).vehicleType === '自前自転車' && count() === 0, '2. 競合中は勝手に送らない（送信漏れの自動再送の対象外）');
      // 二重押し: 2回目は「処理中」で何もしない
      const p1 = B.sync.resolveConflictChoice(key, 'cloud');
      const p2 = await B.sync.resolveConflictChoice(key, 'local');
      const r1 = await p1;
      check(r1.ok && r1.message === '競合を解決しました' && p2.ok === false && /処理中/.test(p2.message), `二重押しを防ぐ（1回目: ${r1.message} / 2回目: ${p2.message}）`);
      check(B.day(CD).vehicleType === '自前自転車' && B.day(CD).manualUpdatedAt.vehicleType && cloud.row(CD).vehicleType === '自前自転車' && cloud.row(CD).manualUpdatedAt.vehicleType === B.day(CD).manualUpdatedAt.vehicleType,
        '4. 「クラウドの値を採用」→ PC の値がクラウドの値になり、新しい更新時刻つきでクラウドへ');
      check(!B.sync.getConflicts().some(c => c.key === key), '6. PC の競合は消える');
      await A.pull();
      check(A.day(CD).vehicleType === '自前自転車' && !A.sync.getConflicts().some(c => c.key === key), '5-6. OPPO は次の同期で同じ値になり、競合も消える（A/B 一致・競合 0）');

      // 「この端末の値を採用」
      const { cloud: c2, A: A2, B: B2 } = pair();
      putCloud(c2, CD, { date: CD, deliveries: [], quests: [], expenses: [], dayOff: false });
      A2.store.state.dailyLogs[CD] = { date: CD, deliveries: [], quests: [], expenses: [], dayOff: true }; A2.store.persistState();
      await A2.pull();
      const k2 = `${CD}|dayOff`;
      check(A2.sync.getConflicts().some(c => c.key === k2), '前提: 手動休みの競合（OPPO 休み / クラウド 休みではない）');
      const r = await A2.sync.resolveConflictChoice(k2, 'local');
      check(r.ok && A2.day(CD).dayOff === true && c2.row(CD).dayOff === true && !A2.sync.getConflicts().length, '3. 「この端末の値を採用」→ 端末の値（休み）がクラウドへ・競合が消える');
      await B2.pull();
      check(B2.day(CD).dayOff === true && B2.store.getDayStatus(CD, '2099-12-31').status === 'off' && !B2.sync.getConflicts().length, '5. PC にも同じ値（休み）が届く・競合なし');

      // 失敗しても値を失わない（オフライン）
      const { cloud: c3, A: A3 } = pair();
      putCloud(c3, CD, { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: '自前自転車' });
      A3.store.state.dailyLogs[CD] = { date: CD, deliveries: [], quests: [], expenses: [], vehicleType: 'バイクシェア利用' }; A3.store.persistState();
      await A3.pull();
      c3.setOnline(false);
      const rf = await A3.sync.resolveConflictChoice(`${CD}|vehicleType`, 'cloud');
      check(!rf.ok && /解決できませんでした/.test(rf.message) && A3.day(CD).vehicleType === 'バイクシェア利用' && !(A3.day(CD).manualUpdatedAt || {}).vehicleType && A3.sync.getConflicts().length === 1 && !A3.sync.pendingSyncDates.has(CD),
        `失敗したら値は元のまま・競合も残る（${rf.message}）`);
      c3.setOnline(true);

      // trip の評価の競合も選べる
      const { cloud: c4, A: A4 } = pair();
      const base = A4.store.state.dailyLogs[TRIP_DAY];
      const cloudCopy = JSON.parse(JSON.stringify(base));
      cloudCopy.deliveries.find(d => d.id === TRIP).evaluation = 'AVOID';
      putCloud(c4, TRIP_DAY, cloudCopy);
      base.deliveries.find(d => d.id === TRIP).evaluation = 'OK';
      A4.store.persistState();
      await A4.pull();
      const tk = A4.sync.getConflicts().find(c => c.date === TRIP_DAY);
      check(tk && tk.kind === 'trip' && tk.tripId === TRIP, '前提: 時刻のない評価の競合（記録に trip の ID）');
      const rt = await A4.sync.resolveConflictChoice(tk.key, 'cloud');
      check(rt.ok && A4.store.getTripEvaluationData(TRIP).evaluation === 'AVOID' && c4.row(TRIP_DAY).deliveries.find(d => d.id === TRIP).evaluation === 'AVOID' && !A4.sync.getConflicts().length,
        '評価の競合も「クラウドの値を採用」で解決（端末の控えも同じ値）');
      const A4b = H.createDevice({ storage: A4.storage, cloud: c4 });
      check(A4b.store.getTripEvaluationData(TRIP).evaluation === 'AVOID', '開き直しても解決した値のまま');
    }

    section('v80-7〜13. 日数の差: 空の日・Uber 実績だけの日は送らない／手動のデータの送信漏れは自動で送る');
    {
      const { cloud, A, B } = pair();
      const EMPTY = '2099-08-01', MEAN = '2099-08-02', HOLD = '2099-08-03';
      A.store.peekDailyLog('2099-08-05');
      check(!A.day('2099-08-05'), '8. 画面で日付を開くだけ（peekDailyLog）では空の日を作らない');
      A.store.getDailyLog(EMPTY); // v79 までの画面表示で作られた空の日（既存データ）
      A.store.persistState();
      A.store.addExpense(D, { category: '駐輪', amount: 100, memo: '' });
      await settle(); await A.pull();
      let d = diffOf(A);
      const lo = date => d.localOnly.find(x => x.date === date);
      check(lo(EMPTY) && lo(EMPTY).status === 'empty' && !cloud.row(EMPTY), '7. 端末だけの空の日 → 「空」と分類し、クラウドへ送らない（消しもしない）');
      check(lo(TRIP_DAY) && lo(TRIP_DAY).status === 'official' && !cloud.row(TRIP_DAY), '10. 同梱の Uber 実績だけの日 → クラウドに無くて正常（送らない）');
      check(d.problems === 0 && d.local.total > d.cloudCount, `11. 端末の日数（${d.local.total}）とクラウドの日数（${d.cloudCount}）が違っても、問題 0 件（正常）`);
      // 本当の送信漏れ: 手動のデータが入ったのに未送信の印が無い（v79 までのバックアップ読込・ログイン前の入力など）
      A.store.state.dailyLogs[MEAN] = { date: MEAN, deliveries: [], quests: [], expenses: [{ id: 'exp_leak_1', category: '交通費', amount: 300, memo: '', createdAt: '2099-08-02T01:00:00Z' }] };
      A.store.persistState();
      d = diffOf(A);
      check(d.localOnly.some(x => x.date === MEAN && x.status === 'unsent') && d.problems === 1, '12. 本当の送信漏れ（端末だけの手動のデータ）を「送信漏れ」として検出');
      await A.pull();
      check(cloud.row(MEAN) && (cloud.row(MEAN).expenses || []).some(e => e.id === 'exp_leak_1'), '13. 次の同期で自動で送る（送信ボタン不要）');
      await B.pull();
      check(expIds(B, MEAN).includes('exp_leak_1') && diffOf(A).problems === 0 && diffOf(B).problems === 0, '13. PC にも届き、両端末とも差分の問題 0 件');
      // 9. クラウドだけの手動の日（別端末が送った休み）→ 受信で端末に入る
      putCloud(cloud, HOLD, { date: HOLD, deliveries: [], quests: [], expenses: [], dayOff: true, manualUpdatedAt: { dayOff: '2099-08-03T00:00:00Z' } });
      const D2 = A.window.UberLogDiagnostics;
      const pre = D2.diffLocalCloud(A.store.state.dailyLogs, { days: { [HOLD]: D2.daySignature(cloud.row(HOLD)) } }, {});
      check(pre.cloudOnly.some(x => x.date === HOLD), '9. クラウドだけの日を「クラウドだけ」と表示できる');
      await A.pull();
      check(A.day(HOLD) && A.day(HOLD).dayOff === true && !diffOf(A).cloudOnly.length, '9. 受信するとこの端末にも入り、クラウドだけの日は 0');
      // 既存の手動データが同じなら送り直さない（同期のたびに送らない）
      const count = upserts(cloud);
      await A.pull(); await B.pull();
      check(count() === 0, '一致しているときは何も送らない（送り直しの繰り返しなし）');
    }

    section('v80-14〜15. 送信漏れの自動再送・競合の解決で、公式値の巻き戻り・削除した経費の復活が起きない');
    {
      const { cloud, A, B } = pair();
      const OD = '2099-07-20';
      const official = (importedAt, trips) => ({
        date: OD, officialImport: { source: 'official-import-v1', importedAt }, tripsCount: trips, deliveriesCount: trips, officialPoints: trips, totalDistanceKm: trips,
        deliveries: Array.from({ length: trips }, (_, i) => ({ id: `del_y_${i + 1}`, index: i + 1, completedAt: `1${i}:00`, restaurant: `店${i + 1}`, fee: 500, points: 1, distanceKm: 1 })),
        quests: [], expenses: [], workSessions: [], sales: { delivery: trips * 500, quest: 0, adjustment: 0, other: 0, total: trips * 500 }
      });
      putCloud(cloud, OD, { ...official('2099-07-21T00:00:00Z', 21), vehicleType: '自前自転車' });
      // 古い PC: 昼の途中データ（17trip）＋送信漏れの経費＋時刻のない別の移動手段
      B.store.state.dailyLogs[OD] = { ...official('2099-07-20T06:00:00Z', 17), vehicleType: 'バイクシェア利用', expenses: [{ id: 'exp_pc_1', category: '駐輪', amount: 100, memo: '', createdAt: '2099-07-20T05:00:00Z' }] };
      B.store.persistState();
      await B.pull();
      check(cloud.row(OD).tripsCount === 21 && cloud.row(OD).sales.total === 10500 && (cloud.row(OD).expenses || []).some(e => e.id === 'exp_pc_1'),
        '14. 送信漏れの再送でも、古い PC の公式値（17trip）でクラウド（21trip）を巻き戻さない（経費だけ加わる）');
      const r = await B.sync.resolveConflictChoice(`${OD}|vehicleType`, 'local');
      check(r.ok && cloud.row(OD).tripsCount === 21 && cloud.row(OD).vehicleType === 'バイクシェア利用' && B.day(OD).tripsCount === 21, '14. 競合の解決で送っても公式値は 21trip のまま');
      // 15. tombstone: OPPO で削除 → 古いコピーを持つ PC の送信漏れ再送で復活しない
      A.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: '' });
      await settle(); await B.pull();
      const eid = expIds(B, D)[0];
      A.store.deleteExpense(D, eid);
      await settle();
      const stale = JSON.parse(JSON.stringify(B.day(D))); // PC の古いコピー（削除前）
      B.store.state.dailyLogs[D] = stale; B.store.persistState();
      await B.pull(); await A.pull();
      check(!expIds(A, D).includes(eid) && !expIds(B, D).includes(eid) && !(cloud.row(D).expenses || []).some(e => e.id === eid), '15. 削除した経費は、送信漏れの再送でも復活しない（tombstone）');
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ 例外: ${e.stack}`);
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
