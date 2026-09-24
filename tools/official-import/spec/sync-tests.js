/**
 * 経費（ユーザー入力）の端末保存・クラウド同期テスト
 *   node tools/official-import/spec/sync-tests.js   （run-tests.js からも呼ばれる）
 *
 * 本物の js/store.js・js/cloud-sync.js を端末ごとの独立した実行環境で動かし（spec/sync-harness.js）、
 * 「スマホで 9/23（公式取込済みの日）に Bike 経費を登録 → 後から消える」不具合の再現シナリオを確認する。
 */
'use strict';

const { createStorage, createCloud, createDevice, sleep } = require('./sync-harness.js');

const D = '2026-09-23';
let passed = 0;
let failed = 0;
const check = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ FAIL: ${m}`); } };
const section = t => console.log(`\n【${t}】`);
const bikeCount = (dev, id) => ((dev.day(D) || {}).expenses || []).filter(e => e.id === id).length;

(async () => {
  try {
    // ==========================================================
    section('14-1. 実機シナリオ: 公式取込済みの 9/23 にスマホで Bike 経費を追加 → 同期・再読込');
    const cloud = createCloud();
    // PC（別端末）が 9/23 の公式データ（経費なし）をクラウドへ送っている状態
    const pc = createDevice({ storage: createStorage(), cloud });
    pc.store.setTripEvaluation(pc.day(D).deliveries[0].id, 'OK');
    await pc.flushPush();
    check(cloud.row(D) && !(cloud.row(D).expenses || []).length, '1. 9/23 は公式取込済み（20trip）・クラウドの 9/23 には経費なし');

    const phoneSt = createStorage();
    let phone = createDevice({ storage: phoneSt, cloud });
    await phone.pull();
    check(phone.day(D).tripsCount === 20 && phone.profit(D) === 10683 && !phone.hasB(D), '9/23 公式データ（利益 ¥10,683・B なし）');
    cloud.setOnline(false); // 送信前にオフライン → クラウドは古いまま
    const exp = phone.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: 'ドコモ・バイクシェア1日パス' });
    await sleep(800);
    check(phone.profit(D) === 9156 && phone.hasB(D), '2-3. 経費 ¥1,527 を登録 → 利益 ¥9,156・B 表示');
    check(!(cloud.row(D).expenses || []).length, '4. クラウド側はまだ経費の無い古い状態');

    cloud.setOnline(true);
    await phone.pull();
    check(bikeCount(phone, exp.id) === 1 && phone.profit(D) === 9156 && phone.hasB(D), '5. クラウド pull・統合後も経費が残る（利益は戻らない・B は消えない）');

    phone = createDevice({ storage: phoneSt, cloud });
    check(bikeCount(phone, exp.id) === 1 && phone.profit(D) === 9156 && phone.hasB(D), '6. 再読込後も 経費・B・利益を維持');

    await phone.pull(); // pull の最後に未送信分を送る
    check((cloud.row(D).expenses || []).filter(e => e.id === exp.id).length === 1, '7. クラウドへ送信（経費1件）');
    const other = createDevice({ storage: createStorage(), cloud });
    await other.pull();
    check(bikeCount(other, exp.id) === 1 && other.profit(D) === 9156, '7. 別端末で pull → 同じ経費が1件だけ（二重登録なし）');
    await other.pull();
    await phone.pull();
    check(bikeCount(other, exp.id) === 1 && bikeCount(phone, exp.id) === 1, '7. 同期を繰り返しても1件のまま');

    // 8. 公式シードの再同期（端末データの公式部分が古い → 起動時に公式データへ合わせる）
    const raw = JSON.parse(phoneSt.getItem('uber_log_v1_data'));
    raw.dailyLogs[D].sales.total = 1;
    raw.dailyLogs[D].tripsCount = 3;
    phoneSt.setItem('uber_log_v1_data', JSON.stringify(raw));
    phone = createDevice({ storage: phoneSt, cloud });
    check(phone.day(D).tripsCount === 20 && phone.day(D).sales.total === 10683, '8. 公式シード再同期で公式データ（20trip・¥10,683）へ戻る');
    check(bikeCount(phone, exp.id) === 1 && phone.profit(D) === 9156 && phone.hasB(D), '8. 公式シード再同期後も経費を維持');

    // ==========================================================
    section('14-2. 原因1: 古い端末（PC）がクラウドの 9/23 を丸ごと上書き');
    // PC は 9/23 の経費を知らないまま ○× を保存 → 送信
    pc.store.setTripEvaluation(pc.day(D).deliveries[1].id, 'AVOID');
    await pc.flushPush();
    check((cloud.row(D).expenses || []).some(e => e.id === exp.id), '送信前にクラウドと統合するため、古い端末の送信でもクラウドの経費が消えない');
    check(bikeCount(pc, exp.id) === 1, 'PC 側にも経費が取り込まれる');
    const fresh = createDevice({ storage: createStorage(), cloud });
    await fresh.pull();
    check(bikeCount(fresh, exp.id) === 1, '新しい端末（別ブラウザ・別のホーム画面アプリ）でも経費が見える');

    // ==========================================================
    section('14-3. 原因2: 同じ端末の古い画面（別タブ・古いインスタンス）が端末保存を丸ごと上書き');
    const st = createStorage();
    const oldScreen = createDevice({ storage: st });
    const newScreen = createDevice({ storage: st });
    const e2 = newScreen.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: '新しい画面で登録' });
    oldScreen.store.setTripEvaluation(oldScreen.day(D).deliveries[0].id, 'OK'); // 古いメモリのまま保存
    const reloaded = createDevice({ storage: st });
    check(bikeCount(reloaded, e2.id) === 1 && reloaded.hasB(D), '古い画面が保存しても、新しい画面で登録した経費は消えない');
    check(bikeCount(oldScreen, e2.id) === 1, '古い画面も保存時に最新の経費を取り込む');
    oldScreen.fire('storage');
    check(bikeCount(oldScreen, e2.id) === 1, '別の画面の保存（storage イベント）でメモリを最新に読み直す');

    // ==========================================================
    section('14-4. 削除（tombstone）・修正（updatedAt）・送信中の変更');
    // 削除: スマホで削除 → 経費を持ったままの古い端末が送信しても復活しない
    const pc2 = createDevice({ storage: createStorage(), cloud });
    await pc2.pull();
    check(bikeCount(pc2, exp.id) === 1, '（準備）別端末も経費を保持');
    phone.store.deleteExpense(D, exp.id);
    await phone.flushPush();
    pc2.store.setTripEvaluation(pc2.day(D).deliveries[2].id, 'OK');
    await pc2.flushPush();
    await phone.pull();
    await pc2.pull();
    const fresh2 = createDevice({ storage: createStorage(), cloud });
    await fresh2.pull();
    check(bikeCount(phone, exp.id) === 0 && bikeCount(pc2, exp.id) === 0 && bikeCount(fresh2, exp.id) === 0 && !(cloud.row(D).expenses || []).some(e => e.id === exp.id),
      '削除した経費は、古い端末が持っていても復活しない（tombstone を統合）');
    check(!phone.hasB(D) && phone.profit(D) === 10683, '全件削除で B が消え、利益が戻る');

    // 修正: スマホで金額を修正 → 古いコピーより updatedAt が新しい方を採用
    const e3 = phone.store.addExpense(D, { category: 'バイクシェア', amount: 1000, memo: '金額修正前' });
    await phone.flushPush();
    await pc2.pull();
    await sleep(5);
    phone.store.updateExpense(D, e3.id, { amount: 1527, memo: '修正後' });
    await phone.flushPush();
    pc2.store.setTripEvaluation(pc2.day(D).deliveries[3].id, 'OK'); // 古い金額のまま送信
    await pc2.flushPush();
    await phone.pull();
    const amt = (phone.day(D).expenses.find(e => e.id === e3.id) || {}).amount;
    const cloudAmt = ((cloud.row(D).expenses || []).find(e => e.id === e3.id) || {}).amount;
    check(amt === 1527 && cloudAmt === 1527, `同じ経費は updatedAt が新しい修正を採用（端末 ¥${amt} / クラウド ¥${cloudAmt}）`);

    // 送信中に同じ日を変更 → pending を残して次回送信
    let injected = null;
    cloud.onUpsert = async () => {
      if (!injected) injected = phone.store.addExpense(D, { category: '必要経費', amount: 300, memo: '送信中に追加' });
    };
    phone.store.setTripEvaluation(phone.day(D).deliveries[4].id, 'OK');
    await phone.flushPush();
    cloud.onUpsert = null;
    check(phone.sync.pendingSyncDates.has(D), '送信中に追加された変更は「未送信」として残す');
    await phone.flushPush();
    check((cloud.row(D).expenses || []).some(e => e.id === injected.id), '次回の送信でクラウドへ反映');

    // ==========================================================
    section('14-5. 公式シード補完で経費を置き換えない（9/18・9/19）');
    const st18 = createStorage();
    let dev18 = createDevice({ storage: st18 });
    const add18 = dev18.store.addExpense('2026-09-18', { category: '必要経費', amount: 800, memo: '修理' });
    dev18 = createDevice({ storage: st18 });
    const ids18 = dev18.day('2026-09-18').expenses.map(e => e.id);
    check(ids18.includes('exp_0918_1') && ids18.includes(add18.id), '9/18 に追加した経費を、再読込時のシード補完が置き換えない');
    dev18.store.deleteExpense('2026-09-18', 'exp_0918_1');
    dev18 = createDevice({ storage: st18 });
    check(!dev18.day('2026-09-18').expenses.some(e => e.id === 'exp_0918_1') && dev18.day('2026-09-18').expenses.some(e => e.id === add18.id),
      '削除した確定Bike経費（exp_0918_1）はシード補完で復活しない');
    const dev19 = createDevice({ storage: createStorage() });
    check(dev19.day('2026-09-19').expenses.some(e => e.id === 'exp_0919_1') && dev19.hasB('2026-09-19') && dev19.hasB('2026-09-18'), '新しい端末では確定Bike経費（9/18・9/19）が入り B 表示');

    // ==========================================================
    section('14-7. 起動時の同期（ログインを保存済みの端末でアプリを開いただけ・入力してすぐ閉じた場合）');
    {
      const D24 = '2026-09-24';
      const cloud7 = createCloud();
      // 本物の supabase-client.js と同じく、isReady()/getSession() が呼ばれるまでログインを復元しない端末
      const phoneSt7 = createStorage();
      const phone7 = createDevice({ storage: phoneSt7, cloud: cloud7, lazySession: true });
      await sleep(200);
      check(phone7.sync.status === 'SYNCED', `スマホを開いただけで起動時の同期が走る（状態: ${phone7.sync.status}）`);
      const eBike = phone7.store.addExpense(D24, { category: 'バイクシェア', amount: 527, memo: 'バイクシェア1日パス' });
      await sleep(1000);
      check(((cloud7.row(D24) || {}).expenses || []).some(x => x.id === eBike.id), '1. スマホで登録した経費が、画面切替なしで自動的にクラウドへ送られる');
      const web7St = createStorage();
      const web7 = createDevice({ storage: web7St, cloud: cloud7, lazySession: true });
      await sleep(300);
      check(web7.bikeIds(D24).includes(eBike.id) && web7.hasB(D24), '1. Web を開いただけでスマホの経費が表示され、9/24 に B');
      const eWeb = web7.store.addExpense(D24, { category: '必要経費', amount: 300, memo: 'Webで登録' });
      await sleep(1000);
      const phone7b = createDevice({ storage: phoneSt7, cloud: cloud7, lazySession: true });
      await sleep(300);
      check(((phone7b.day(D24) || {}).expenses || []).some(x => x.id === eWeb.id), '2. Web で登録した経費が、スマホを開き直すと表示される');
      const ids = ((phone7b.day(D24) || {}).expenses || []).map(x => x.id);
      check(ids.filter(x => x === eBike.id).length === 1 && ids.filter(x => x === eWeb.id).length === 1 && ids.length === 2, '3. 同じ経費が二重登録されない（各1件）');
      const m7 = phone7b.store.getCalculatedMetrics(phone7b.day(D24));
      check(m7.specialQuestSales === 8890 && m7.questSales === 9490 && m7.deliverySales === 7699, '9/24 の特別クエスト ¥8,890・クエスト ¥9,490・Delivery ¥7,699 は同期後も維持');
      // 未ログインの端末は同期しない（状態を「未ログイン」として表示できる）
      const offline7 = createDevice({ storage: createStorage(), cloud: cloud7, loggedIn: false, lazySession: true });
      await sleep(200);
      offline7.store.addExpense(D24, { category: '必要経費', amount: 1, memo: '未ログイン端末' });
      await sleep(900);
      check(offline7.sync.status === 'NOT_LOGGED_IN' && !((cloud7.row(D24) || {}).expenses || []).some(x => x.amount === 1),
        `未ログインの端末は送信せず「未ログイン」状態になる（画面に注意を表示）: ${offline7.sync.status}`);
      check(offline7.sync.pendingSyncDates.has(D24), '未ログイン中の入力は「未送信」として残り、ログイン後の同期で送られる');
    }

    // ==========================================================
    section('14-6. 全データの復元・初期化は統合せずにそのまま反映');
    const stR = createStorage();
    const devR = createDevice({ storage: stR });
    devR.store.addExpense(D, { category: 'バイクシェア', amount: 1527, memo: 'x' });
    devR.store.clearAllData();
    check(JSON.parse(stR.getItem('uber_log_v1_data')).dailyLogs && Object.keys(JSON.parse(stR.getItem('uber_log_v1_data')).dailyLogs).length === 0, '「データ全削除」は保存済みデータと統合せずに初期化');
  } catch (e) {
    failed++;
    console.log(`  ❌ 例外: ${e.stack}`);
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
