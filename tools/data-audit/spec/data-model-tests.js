#!/usr/bin/env node
/**
 * データモデル・集計・同期・取込の不変条件テスト（DATA_MODEL.md）
 *   node tools/data-audit/spec/data-model-tests.js
 * 人工データ（2099年。実データと重ならない）で、月境界・週境界・売上の全項目・経費の全種類・trip/delivery・休み・未来日・
 * 経費だけの日・同期マージ・公式再取込・旧取込・日本時間・監査スクリプトを確かめる。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE = JSON.stringify(path.join(ROOT, 'js', 'store.js'));
let passed = 0, failed = 0;
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); } else { failed++; console.log(`  ❌ FAIL: ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
}
function section(t) { console.log(`\n【${t}】`); }
// 別プロセスで実行（store.js は読み込み時に1回だけ端末データを読むため、データごとに新しいプロセスにする）
function run(code, env = {}) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ------------------------------------------------------------
// 人工データ（基準日 2099-10-07 水曜。今週 10/05〜10/07・先週 09/28〜10/04＝月をまたぐ）
// ------------------------------------------------------------
const OI = { source: 'test-fixture', importedAt: '2099-10-08T00:00:00Z' };
const trip = (id, fee, km, dur, extra = {}) => ({ id, index: 1, completedAt: '10:00', restaurant: 'テスト店', area: '', fee, distanceKm: km, durationStr: dur, points: 1, memo: '', ...extra });
const day = (date, trips, sales, extra = {}) => ({
  date, workStartedAt: null, workEndedAt: null, workMinutes: null, workSessions: [],
  tripsCount: trips.length, deliveriesCount: trips.reduce((s, t) => s + t.points, 0), officialPoints: trips.reduce((s, t) => s + t.points, 0),
  totalDistanceKm: Math.round(trips.reduce((s, t) => s + t.distanceKm, 0) * 100) / 100,
  deliveries: trips, quests: [], expenses: [], officialImport: OI,
  sales: { delivery: sales.d || 0, quest: sales.q || 0, adjustment: sales.a || 0, other: sales.o || 0, total: (sales.d || 0) + (sales.q || 0) + (sales.a || 0) + (sales.o || 0) },
  ...extra
});
const exp = (id, category, amount) => ({ id, category, amount, memo: '', createdAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' });
const trips27 = Array.from({ length: 27 }, (_, i) => trip(`fx_1002_${i + 1}`, 300, 1, '0時間10分0秒', { index: i + 1, points: i < 3 ? 2 : 1 }));
const FIXTURE = {
  // 9月（前月）: 9/27 は先週より前・9/29〜9/30 は先週（月をまたぐ）
  '2099-09-27': day('2099-09-27', [trip('fx_0927_1', 900, 2, '0時間30分0秒')], { d: 900 }),
  '2099-09-29': day('2099-09-29', [trip('fx_0929_1', 1000, 3, '0時間40分0秒')], { d: 1000 }, { expenses: [exp('ex_bike', 'バイクシェア', 1527)] }),
  // 1 trip 2 deliveries（ダブル）・通常クエスト・同じ日に複数の経費（必要経費・駐輪・交通費）
  '2099-09-30': day('2099-09-30', [trip('fx_0930_1', 1500, 4, '0時間50分0秒', { points: 2 })], { d: 1500, q: 500 }, {
    quests: [{ id: 'q_0930', title: '通常クエスト', questName: '通常クエスト', amount: 500, time: '20:00' }],
    expenses: [exp('ex_need', '必要経費', 300), exp('ex_park', '駐輪', 100), exp('ex_train', '交通費', 200)]
  }),
  // 特別ボーナス（特別クエスト）・チップ・プラス調整とマイナス調整・その他
  '2099-10-01': day('2099-10-01', [trip('fx_1001_1', 2000, 5, '1時間0分0秒', { tip: 120, baseFee: 1880 }), trip('fx_1001_2', 800, 2, '0時間20分0秒', { index: 2 })], { d: 2800, q: 1000, a: 200, o: 50 }, {
    quests: [{ id: 'q_1001', title: '特別クエスト', questName: '特別クエスト', amount: 1000, time: '21:00', questType: 'special' }],
    adjustments: [{ id: 'adj_p', time: '12:00', amount: 500 }, { id: 'adj_m', time: '13:00', amount: -300 }]
  }),
  // 27 trips / 30 deliveries
  '2099-10-02': day('2099-10-02', trips27, { d: 8100 }),
  // 経費だけの日（売上0・経費あり）
  '2099-10-03': { date: '2099-10-03', deliveries: [], quests: [], workSessions: [], expenses: [exp('ex_train2', '交通費', 400)] },
  // 手動休み
  '2099-10-04': { date: '2099-10-04', dayOff: true, deliveries: [], quests: [], workSessions: [], expenses: [] },
  // 10/05 はデータなし（後続日に公式データあり → 自動休み）
  '2099-10-06': day('2099-10-06', [trip('fx_1006_1', 700, 3, '0時間45分0秒')], { d: 700 }),
  // 10/07（今日）はデータなし。10/09 は未来日（売上・経費あり。今月・今週に入れない）
  '2099-10-09': day('2099-10-09', [trip('fx_1009_1', 9999, 9, '2時間0分0秒')], { d: 9999 }, { expenses: [exp('ex_future', '必要経費', 777)] })
};
const TODAY = '2099-10-07';

const loadWith = data => `const map={uber_log_v1_data:${JSON.stringify(JSON.stringify({ version: '1.2', dailyLogs: data }))}};
  global.localStorage={getItem:k=>map[k]||null,setItem:(k,v)=>{map[k]=v},removeItem:()=>{}};global.window={localStorage:global.localStorage};
  const M=require(${STORE});const {store}=M;`;

// ============================================================
section('1. 売上（全項目・符号付き調整）と trip / delivery');
const A = run(`${loadWith(FIXTURE)}
  const m=store.getCalculatedMetrics(store.state.dailyLogs['2099-10-01']);
  const m2=store.getCalculatedMetrics(store.state.dailyLogs['2099-10-02']);
  const a2=store.aggregateForRange('2099-10-02','2099-10-02');
  console.log(JSON.stringify({m:{base:m.baseDeliverySales,del:m.deliverySales,q:m.questSales,sp:m.specialQuestSales,tip:m.tipSales,adj:m.adjustmentSales,oth:m.otherSales,tot:m.totalSales,reg:m.regularSales},
    m2:{count:m2.count,trips:m2.tripsCount},a2:{d:a2.deliveriesCount,t:a2.tripsCount}}));`);
check(A.m.tot === 2680 + 0 + 1000 + 120 + 200 + 50 && A.m.tot === 4050, `総売上 ¥4,050 ＝ 配達報酬 ¥2,680 ＋ クエスト ¥0 ＋ 特別ボーナス ¥1,000 ＋ チップ ¥120 ＋ 調整 ¥200 ＋ その他 ¥50`, A.m);
check(A.m.base === 2680 && A.m.del === 2800 && A.m.tip === 120, '配達報酬（チップ除く）¥2,680 ＋ チップ ¥120 ＝ 配達の最終売上 ¥2,800（チップは二重に足さない）', A.m);
check(A.m.adj === 200, '調整は符号付き（+¥500 と −¥300 → +¥200。絶対値にしない）', A.m.adj);
check(A.m.reg === 2800 + 1000 - 1000 + 200, '通常売上（効率指標の分子）＝ 配達報酬 ＋ 通常クエスト ＋ 調整（特別ボーナス・その他は除く）¥3,000', A.m.reg);
check(A.m2.count === 30 && A.m2.trips === 27 && A.a2.d === 30 && A.a2.t === 27, '27 trips / 30 deliveries: 配達件数 30・トリップ数 27（混同しない）', { m2: A.m2, a2: A.a2 });

// ============================================================
section('2. 期間（今週・先週・今月・過去月・期間指定・全期間・未来日）');
const P = run(`${loadWith(FIXTURE)}
  const pick=a=>({s:a.totalSales,e:a.expenses,p:a.profit,c:a.deliveriesCount,t:a.tripsCount,w:a.workedDays,reg:a.regularSales,ad:a.avgDailyEarnings,ap:a.avgPerDelivery,
    parts:a.baseDeliverySales+a.questSales+a.guaranteeBonus+a.tipSales+a.adjustmentSales+a.otherSales,cat:a.expenseByCategory,n:a.expenseCount});
  const r=store.getRevenueSummary('${TODAY}');
  console.log(JSON.stringify({month:pick(store.aggregateForRange('2099-10-01','${TODAY}')),m:r.thisMonth,
    sep:pick(store.aggregateForRange('2099-09-01','2099-09-30')),sepB:pick(store.getSalesBreakdown('2099-09-01','2099-09-30')),
    week:{s:r.thisWeek.officialSales,e:r.thisWeek.expenses,p:r.thisWeek.salesProfit,c:r.thisWeek.deliveriesCount,label:[r.thisWeek.startDate,r.thisWeek.endDate],agg:r.thisWeek.aggregatedEndDate},
    prev:r.thisWeek.prevWeek,diff:r.thisWeek.prevWeekComparison.diffAmount,
    period:pick(store.getSalesBreakdown('2099-10-01','2099-10-02')),fx:pick(store.aggregateForRange('2099-01-01','2099-12-31')),
    all:pick(store.aggregateForRange(null,null))}));`);
const M = P.m;
check(M.startDate === '2099-10-01' && M.endDate === TODAY, `今月 ＝ 月初〜今日（${M.startDate}〜${M.endDate}）`);
check(M.sales === 12850 && P.month.parts === 12850, `今月に前月（9月）・未来日（10/9 ¥9,999）が混ざらない: 総売上 ¥${M.sales}（内訳の合計も ¥${P.month.parts}）`);
check(M.expenses === 400 && M.salesProfit === 12450, `今月の必要経費 ¥${M.expenses}（10/9 の未来の経費 ¥777 は入らない）・利益 ¥${M.salesProfit}`);
check(M.deliveriesCount === 33 && P.month.t === 30 && M.workedDays === 3 && M.elapsedDays === 7, `今月 ${M.deliveriesCount}件・${P.month.t}trip・稼働日数 ${M.workedDays} / ${M.elapsedDays}日（経費だけの日・休み・今日0件は稼働日に数えない／今日は分母に入る）`);
check(M.regularSales === 11800 && M.avgDailyEarnings === 3933 && M.avgPerDelivery === 358, `平均日給 ¥${M.avgDailyEarnings}（通常売上 ¥11,800 ÷ 3日）・平均単価 ¥${M.avgPerDelivery}（÷ 33件）`);
check(P.sep.s === 3900 && P.sep.e === 2127 && P.sep.p === 1773 && P.sep.c === 4 && P.sep.t === 3 && P.sepB.s === 3900, `過去月（9月）は月全体: 総売上 ¥3,900・必要経費 ¥2,127・利益 ¥1,773・4件・3trip`);
check(P.week.label.join() === '2099-10-05,2099-10-11' && P.week.agg === TODAY && P.week.s === 700 && P.week.e === 0 && P.week.p === 700 && P.week.c === 1,
  `今週 ＝ 月曜〜今日（10/05〜10/07。表示の期間は月〜日のまま）: ¥${P.week.s}・${P.week.c}件。先週・未来日が混ざらない`);
check(P.prev.startDate === '2099-09-28' && P.prev.endDate === '2099-10-04' && P.prev.sales === 15150 && P.prev.expenses === 2527 && P.prev.salesProfit === 12623,
  `先週（9/28〜10/4・月をまたぐ）: 総売上 ¥${P.prev.sales}・必要経費 ¥${P.prev.expenses}・利益 ¥${P.prev.salesProfit}（今週が混ざらない）`);
check(P.diff === 700 - 12623, `先週比 ＝ 今週の利益 − 先週の利益（${P.diff}）`);
check(P.period.s === 12150 && P.period.c === 32 && P.period.e === 0, `期間指定（10/1〜10/2）は指定期間だけ: ¥${P.period.s}・${P.period.c}件`);
check(P.fx.s === 3900 + 12850 + 9999 && P.fx.e === 2127 + 400 + 777, `期間指定（2099年全体）には未来日も含む（指定どおり）: ¥${P.fx.s}・必要経費 ¥${P.fx.e}`);
check(P.all.s > P.fx.s && P.all.c > P.fx.c, `全期間（期間制限なし）は同梱データも含めた全部: ¥${P.all.s.toLocaleString()}・${P.all.c}件`);

// ============================================================
section('3. 必要経費（種類ごと・同日複数・売上0・経費0・週・月・期間）');
const E = run(`${loadWith(FIXTURE)}
  const d=k=>store.getCalculatedMetrics(store.state.dailyLogs[k]);
  console.log(JSON.stringify({bike:d('2099-09-29').totalExpenses,multi:d('2099-09-30').totalExpenses,train:d('2099-10-03').totalExpenses,trainSales:d('2099-10-03').totalSales,trainProfit:d('2099-10-03').netProfit,
    zero:d('2099-10-06').totalExpenses,sepCat:store.aggregateForRange('2099-09-01','2099-09-30').expenseByCategory,sepN:store.aggregateForRange('2099-09-01','2099-09-30').expenseCount,
    week:store.getRevenueSummary('${TODAY}').thisWeek.expenses,prevWeek:store.getRevenueSummary('${TODAY}').thisWeek.prevWeek.expenses,period:store.getSalesBreakdown('2099-09-30','2099-10-03').expenses}));`);
check(E.bike === 1527, '1. バイクシェアだけの日 ¥1,527');
check(E.multi === 600, '2-4, 6. 必要経費 ¥300・駐輪 ¥100・交通費 ¥200（同じ日に複数）→ ¥600');
check(E.train === 400 && E.trainSales === null && E.trainProfit === null, '4, 7. 交通費だけ・売上0の日: 必要経費 ¥400（日別の利益は売上が無いため --）', E);
check(E.zero === 0, '8. 経費0の日 ¥0');
const sortObj = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
check(E.sepN === 4 && sortObj(E.sepCat) === sortObj({ 'バイクシェア': 1527, '必要経費': 300, '駐輪': 100, '交通費': 200 }), '5. 複数カテゴリ混在（9月）: バイクシェア ¥1,527 ＋ 必要経費 ¥300 ＋ 駐輪 ¥100 ＋ 交通費 ¥200 ＝ ¥2,127（1件1回）', E.sepCat);
check(E.week === 0 && E.prevWeek === 2527 && E.period === 1000, `9-11. 週 ¥${E.week}・先週 ¥${E.prevWeek}・期間指定（9/30〜10/3）¥${E.period}（月はセクション2）`);

// ============================================================
section('4. 休み・稼働日（手動休み・自動休み・今日0件・未来日・経費だけの日）');
const S = run(`${loadWith(FIXTURE)}
  const st=d=>store.getDayStatus(d,'${TODAY}');
  console.log(JSON.stringify({d1004:st('2099-10-04'),d1005:st('2099-10-05'),d1003:st('2099-10-03'),d1007:st('${TODAY}'),d1008:st('2099-10-08'),d1006:st('2099-10-06'),
    worked1003:store.isWorkedDay('2099-10-03'),dayOff:store.state.dailyLogs['2099-10-04'].dayOff}));`);
check(S.d1004.status === 'off' && S.d1004.statusSource === 'manual' && S.dayOff === true, '手動休み（dayOff）は休み（manual）のまま');
check(S.d1005.status === 'off' && S.d1005.statusSource === 'auto', 'データの無い過去日（後続日に公式データあり）は自動休み');
check(S.d1003.status === 'off' && S.d1003.statusSource === 'auto' && !S.worked1003, '経費だけの日は稼働日ではない（Uber実績0 → 自動休み。経費は必要経費に入る）');
check(S.d1007.status === 'unknown' && S.d1008.status === 'unknown', '今日（0件）・未来日は休みにしない');
check(S.d1006.status === 'worked', '実績のある日は稼働日');

// ============================================================
section('4b. 稼働 / 休み（今月。今日は終わるまでどちらにも入れない）');
const WO = run(`${loadWith({ ...FIXTURE, '2099-10-20': { date: '2099-10-20', dayOff: true, deliveries: [], quests: [] } })}
  const m=t=>{const x=store.getRevenueSummary(t).thisMonth;return [x.workedDays,x.offDays,x.offDaysManual];};
  const base=m('${TODAY}'), at1005=m('2099-10-05'), at1006=m('2099-10-06');
  // 今日（10/07）に1件でも公式実績が入る
  store.state.dailyLogs['${TODAY}']=JSON.parse(JSON.stringify(store.state.dailyLogs['2099-10-06']));store.state.dailyLogs['${TODAY}'].date='${TODAY}';
  store.state.dailyLogs['${TODAY}'].deliveries=[{...store.state.dailyLogs['2099-10-06'].deliveries[0],id:'fx_1007_1'}];
  const todayWorked=m('${TODAY}');
  // 自動休みだった 10/05 に後から公式データが入る
  store.state.dailyLogs['2099-10-05']={...JSON.parse(JSON.stringify(store.state.dailyLogs['2099-10-06'])),date:'2099-10-05',deliveries:[{...store.state.dailyLogs['2099-10-06'].deliveries[0],id:'fx_1005_1'}]};
  const later=m('${TODAY}');
  console.log(JSON.stringify({base,at1005,at1006,todayWorked,later}));`);
check(WO.base.join() === '3,3,1', `今日（10/07）未稼働: 稼働 ${WO.base[0]} / 休み ${WO.base[1]}（10/03 自動・10/04 手動・10/05 自動。今日は数えない。10/20 の未来の手動休みも数えない）`, WO.base);
check(WO.todayWorked.join() === '4,3,1', `今日に1件でも実績が入ると 稼働 +1（${WO.todayWorked[0]} / ${WO.todayWorked[1]}）`, WO.todayWorked);
check(WO.at1005[1] === 2 && WO.at1006[1] === 3, `昨日0件・後続の公式データあり → 休み +1（10/05 時点 ${WO.at1005[1]} → 10/06 時点 ${WO.at1006[1]}）`, [WO.at1005, WO.at1006]);
check(WO.base[2] === 1, '手動休み（dayOff）は休みに含む');
check(WO.later.join() === '5,2,1', `自動休みの日（10/05）に後から公式データ → 休みから外れて稼働へ（${WO.later[0]} / ${WO.later[1]}）`, WO.later);

// ============================================================
section('4c. 天気（気象庁の観測・分類・未登録は推測しない）');
const W = require(path.join(ROOT, 'tools', 'weather', 'jma-weather.js'));
const fx = fs.readFileSync(path.join(ROOT, 'tools', 'weather', 'spec', 'fixtures', 'jma_osaka_2026_09.html'), 'utf8');
const rows = W.parseDailyPage(fx, 2026, 9);
const r29 = rows.find(x => x.date === '2026-09-29');
const r12 = rows.find(x => x.date === '2026-09-12');
check(rows.length === 30 && r29.day === '雨' && r29.night === '曇時々雨' && r29.precipitationMm === 30.5 && r12.precipitationNone === true && r12.precipitationMm === null,
  '気象庁の実ページ（大阪 2026年9月）から 天気概況 昼・夜・降水量・日照 を読む（「--」は降水なし）');
const C = s => W.classify(s);
check(C('晴') === 'sunny' && C('快晴') === 'sunny' && C('晴後曇') === 'sunny' && C('晴一時曇') === 'sunny', '晴: 降水なしで最初の天気が 晴・快晴（例: 晴後曇）');
check(C('曇') === 'cloudy' && C('曇後晴') === 'cloudy' && C('薄曇') === 'cloudy' && C('曇時々晴') === 'cloudy', '曇: 降水なしで最初の天気が 曇・薄曇（例: 曇後晴）');
check(C('雨') === 'rain' && C('大雨一時曇') === 'rain' && C('曇後一時雨') === 'rain' && C('曇一時晴後時々雨、雷を伴う') === 'rain' && C('晴後雨') === 'rain' && C('曇時々雪') === 'rain',
  '雨: 昼の天気概況に 雨・雪 等を含めば雨（一時雨・時々雨・後雨・大雨・雷を伴う も雨）');
check(C('') === null && C('霧') === 'unknown', '天気概況が空欄（未発表）は登録しない・晴/曇/雨のどれでもない表現は unknown');
check(W.toEntry({ date: '2026-10-13', day: '', night: '', precipitationMm: null, precipitationNone: true, sunshineH: 10.7 }) === null, '天気概況が未発表の日（例: 2026-10-13）は保存しない（画面は「—」）');
const WT = run(`${loadWith({ ...FIXTURE,
    '2099-10-01': { ...FIXTURE['2099-10-01'], weather: { type: 'rain', source: 'manual', raw: '雨', observedDate: '2099-10-01' } },
    '2099-10-02': { ...FIXTURE['2099-10-02'], weather: { type: 'sunny', source: 'manual', raw: '晴', observedDate: '2099-10-02' } },
    '2099-09-30': { ...FIXTURE['2099-09-30'], weather: { type: 'cloudy', source: 'manual', raw: '曇', observedDate: '2099-09-30' } },
    '2099-09-29': { ...FIXTURE['2099-09-29'], weather: { type: 'unknown', source: 'manual', raw: '霧', observedDate: '2099-09-29' } } })}
  const g=d=>{const w=store.getWeather(d);return w&&{t:w.type,l:w.label,i:w.icon,s:w.source};};
  const cmp=store.getAnalytics().dailyComparison;
  console.log(JSON.stringify({rain:g('2099-10-01'),sunny:g('2099-10-02'),cloudy:g('2099-09-30'),unk:g('2099-09-29'),none:g('2099-10-06'),
    jma29:g('2026-09-29'),jma12:g('2026-10-12'),jma13:g('2026-10-13'),row:(cmp.find(d=>d.date==='2026-09-29')||{}).weather,rowNone:'weather' in (cmp.find(d=>d.date==='2099-10-06')||{}) && (cmp.find(d=>d.date==='2099-10-06')||{}).weather}));`);
check(WT.sunny.t === 'sunny' && WT.sunny.l === '晴' && WT.sunny.i === '☀' && WT.cloudy.l === '曇' && WT.cloudy.i === '☁' && WT.rain.l === '雨' && WT.rain.i === '🌧' && WT.unk.t === 'unknown',
  '表示: ☀ 晴 / ☁ 曇 / 🌧 雨（日別データの weather があれば優先）', WT);
check(WT.none === null && WT.rowNone === null && WT.jma13 === null, '天気が無い日は null（画面は「—」。推測で晴にしない）。10/13（未発表）も「—」');
check(WT.jma29.t === 'rain' && WT.jma29.s === 'jma' && WT.jma12.t === 'sunny' && WT.row && WT.row.type === 'rain', '気象庁のデータ: 2026-09-29 は雨・2026-10-12 は晴。日別比較の行に天気が入る');

// ============================================================
section('4d. 天気の自動更新（未登録の過去日だけ・今日は取らない・失敗しても取込を止めない）');
const WF = run(`
  const fs=require('fs'),path=require('path'),os=require('os');
  const {updateWeather}=require(${JSON.stringify(path.join(ROOT, 'tools', 'weather', 'fetch-jma-weather.js'))});
  const {ImportJob}=require(${JSON.stringify(path.join(ROOT, 'tools', 'official-import', 'lib', 'import-job.js'))});
  const html=fs.readFileSync(${JSON.stringify(path.join(ROOT, 'tools', 'weather', 'spec', 'fixtures', 'jma_osaka_2026_09.html'))},'utf8');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uberlog-weather-'));
  fs.mkdirSync(path.join(root,'data'));
  const keep={type:'cloudy',day:'手で確認した値（書き換えない）',night:'',nightRain:false,precipitationMm:null,precipitationNone:true,sunshineH:null};
  fs.writeFileSync(path.join(root,'data','uber_weather.json'),JSON.stringify({days:{'2026-09-11':keep}}));
  const ok=u=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve(html)});
  (async()=>{
    const r1=await updateWeather({root,missingOnly:true,today:'2026-09-15',fetchImpl:ok});
    const d1=JSON.parse(fs.readFileSync(path.join(root,'data','uber_weather.json'),'utf8')).days;
    const js1=fs.readFileSync(path.join(root,'data','uber_weather.js'),'utf8');
    const before=fs.readFileSync(path.join(root,'data','uber_weather.json'),'utf8');
    const r2=await updateWeather({root,missingOnly:true,today:'2026-09-20',fetchImpl:()=>Promise.reject(new Error('ネットワークなし'))});
    const r3=await updateWeather({root,missingOnly:true,today:'2026-09-20',timeoutMs:50,fetchImpl:(u,o)=>new Promise((res,rej)=>o.signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';rej(e);}))});
    const after=fs.readFileSync(path.join(root,'data','uber_weather.json'),'utf8');
    // 取込の中では失敗を警告にするだけ（例外にしない）
    fs.mkdirSync(path.join(root,'tools','weather'),{recursive:true});
    fs.writeFileSync(path.join(root,'tools','weather','fetch-jma-weather.js'),"module.exports={updateWeather:async()=>({ok:false,error:'気象庁に接続できません'})};");
    const job=new ImportJob({root,handoffFile:'',date:'2026-09-20',today:'2026-09-21',testCommand:'skip'});
    const warns=await job.updateWeatherSafe();
    delete require.cache[require.resolve(path.join(root,'tools','weather','fetch-jma-weather.js'))];
    fs.writeFileSync(path.join(root,'tools','weather','fetch-jma-weather.js'),"module.exports={updateWeather:async()=>{throw new Error('想定外の例外');}};");
    const job2=new ImportJob({root,handoffFile:'',date:'2026-09-20',today:'2026-09-21',testCommand:'skip'});
    const warns2=await job2.updateWeatherSafe();
    console.log(JSON.stringify({r1:{ok:r1.ok,added:r1.added},keep:d1['2026-09-11'].day,has10:!!d1['2026-09-10'],has14:!!d1['2026-09-14'],has15:!!d1['2026-09-15'],js:js1.startsWith('// UBER_LOG 天気データ')&&js1.includes('window.UBER_WEATHER'),
      r2:{ok:r2.ok,error:r2.error},r3:{ok:r3.ok,error:r3.error},unchanged:before===after,warns,warns2}));
  })();`);
check(WF.r1.ok && WF.r1.added.join() === '2026-09-10,2026-09-12,2026-09-13,2026-09-14' && WF.has10 && WF.has14 && !WF.has15 && WF.js,
  `未登録の過去日だけ追加（${WF.r1.added.join(', ')}）・今日（9/15）は取らない`, WF.r1);
check(WF.keep === '手で確認した値（書き換えない）', '登録済みの日（9/11）は書き換えない');
check(!WF.r2.ok && /ネットワークなし/.test(WF.r2.error) && !WF.r3.ok && /秒で終わりませんでした/.test(WF.r3.error) && WF.unchanged, '取得できない・時間切れでも例外にならず、天気データは変更しない', [WF.r2, WF.r3]);
check(WF.warns.length === 1 && /取込には影響なし/.test(WF.warns[0]) && WF.warns2.length === 1 && /想定外の例外/.test(WF.warns2[0]), '取込の中では天気の失敗は警告だけ（取込全体を止めない）', [WF.warns, WF.warns2]);

// ============================================================
section('5. 同期マージ（経費・手動項目・公式項目を失わない／二重にしない）');
const SY = run(`
  const H=require(${JSON.stringify(path.join(ROOT, 'tools', 'official-import', 'spec', 'sync-harness.js'))});
  (async()=>{
    const cloud=H.createCloud();
    const A=H.createDevice({storage:H.createStorage(),cloud});
    const B=H.createDevice({storage:H.createStorage(),cloud});
    const D='2099-11-20';
    // 両端末に同じ日のデータがある状態（v75 まではこの統合で dayOff・officialImport・sales.tip が両端末から消えていた）
    B.store.addExpense(D,{category:'駐輪',amount:100,memo:'b'});
    const log=A.store.getDailyLog(D);
    Object.assign(log,{dayOff:true,weatherNote:'手動メモ（将来項目の代わり）',weather:{type:'rain',source:'manual',raw:'雨',observedDate:D},officialImport:{source:'t'},sales:{delivery:1000,quest:0,adjustment:0,other:0,total:1000,tip:100,updatedAt:'2099-11-20T00:00:00Z'}});
    A.store.addExpense(D,{category:'バイクシェア',amount:1527,memo:'a'});
    await A.flushPush();
    await B.pull();
    const b1=JSON.parse(JSON.stringify(B.day(D)));
    await B.flushPush(); await A.pull(); await A.pull(); await B.pull();
    const a2=A.day(D), b2=B.day(D);
    // クラウド側に expenses が無い（古い形式）でも端末の経費を消さない
    const merged=A.sync.mergeDailyLog({date:D,expenses:[{id:'k1',category:'交通費',amount:200}],deliveries:[],quests:[]},{date:D,deliveries:[],quests:[]});
    const mergedRev=A.sync.mergeDailyLog({date:D,deliveries:[],quests:[]},{date:D,expenses:[{id:'k2',category:'交通費',amount:300}],deliveries:[],quests:[]});
    // 過去日の編集は対象日を同期する（今日ではない）
    A.store.addExpense('2099-01-15',{category:'必要経費',amount:50,memo:''});
    const pending=[...A.sync.pendingSyncDates];
    console.log(JSON.stringify({b1:{weather:b1.weather&&b1.weather.type,dayOff:b1.dayOff,note:b1.weatherNote,oi:!!b1.officialImport,tip:b1.sales&&b1.sales.tip,exp:(b1.expenses||[]).length},
      a2:(a2.expenses||[]).map(e=>e.category).sort(),b2:(b2.expenses||[]).map(e=>e.category).sort(),a2DayOff:a2.dayOff,a2Tip:a2.sales.tip,a2Weather:a2.weather&&a2.weather.type,
      exA:A.store.getCalculatedMetrics(a2).totalExpenses,merged:(merged.expenses||[]).length,mergedRev:(mergedRev.expenses||[]).length,pending}));
  })().catch(e=>{console.error(e);process.exit(1);});`);
check(SY.b1.dayOff === true && SY.b1.note === '手動メモ（将来項目の代わり）' && SY.b1.oi && SY.b1.tip === 100 && SY.b1.exp === 2, '両端末に同じ日がある状態で同期: 手動休み・手動項目・officialImport・うちチップを失わない・経費は両方の和集合', SY.b1);
check(SY.a2.join() === 'バイクシェア,駐輪' && SY.b2.join() === 'バイクシェア,駐輪' && SY.exA === 1627, '12. 両端末で入れた経費は1件ずつ（同期を繰り返しても重複しない）・必要経費 ¥1,627', SY);
check(SY.a2DayOff === true && SY.a2Tip === 100 && SY.a2Weather === 'rain' && SY.b1.weather === 'rain', '往復同期後も手動休み・うちチップ・天気（weather）が残る');
check(SY.merged === 1 && SY.mergedRev === 1, '片方に expenses が無いだけで、もう片方の経費を空配列で上書きしない');
check(SY.pending.includes('2099-01-15'), '過去日の経費は対象日（2099-01-15）を同期する（今日ではない）', SY.pending);

// ============================================================
section('6. 公式再取込（手動データを消さない・何度でも同じ結果）');
const RI = run(`const {syncOfficialImportedDay}=require(${STORE});
  const target={date:'2099-10-01',dayOff:false,memoUser:'x',weather:{type:'sunny',source:'jma',raw:'晴',observedDate:'2099-10-01'},expenses:[{id:'e1',category:'バイクシェア',amount:1527}],deletedExpenseIds:['e0'],
    deliveries:[{id:'t1',fee:500,evaluation:'OK',evaluationReason:'近い'},{id:'tap1',completedAt:'09:00',restaurant:'',fee:null}],quests:[],sales:{delivery:500,quest:0,adjustment:0,other:0,total:500}};
  const seed={date:'2099-10-01',officialImport:{source:'t'},tripsCount:2,deliveriesCount:3,officialPoints:3,totalDistanceKm:5,
    deliveries:[{id:'t1',fee:600,points:2},{id:'t2',fee:400,points:1}],quests:[{id:'q1',amount:300}],adjustments:[{id:'a1',amount:-100}],
    sales:{delivery:1000,quest:300,adjustment:-100,other:0,total:1200}};
  const c1=syncOfficialImportedDay(target,seed); const snap=JSON.stringify(target); const c2=syncOfficialImportedDay(target,seed);
  console.log(JSON.stringify({c1,c2,same:snap===JSON.stringify(target),weather:target.weather&&target.weather.type,exp:target.expenses.length,del:target.deletedExpenseIds,memo:target.memoUser,
    trips:target.deliveries.map(d=>d.id),ev:target.deliveries[0].evaluation,archive:(target.manualTapsArchive||[]).map(d=>d.id),sales:target.sales.total,adj:target.sales.adjustment,cnt:target.deliveriesCount}));`);
check(RI.c1 === true && RI.c2 === false && RI.same, '同じ公式データを2回反映しても変化なし（idempotent）');
check(RI.exp === 1 && RI.del.join() === 'e0' && RI.memo === 'x' && RI.weather === 'sunny', '13. 公式再取込で経費・削除済み経費の記録・手動項目・天気（weather）を消さない');
check(RI.trips.join() === 't1,t2' && RI.ev === 'OK' && RI.archive.join() === 'tap1', 'tripは公式に合わせる（重複なし）・○×評価は残す・手動タップは消さず退避');
check(RI.sales === 1200 && RI.adj === -100 && RI.cnt === 3, '売上・件数は公式値（調整はマイナスのまま）');

// ============================================================
section('7. 旧売上テキスト取込（チップ・調整の符号・その他）');
const L = run(`const {parseUberSalesText:p}=require(${STORE});
  const f=x=>({d:x.deliverySales,t:x.tipSales,st:x.tipStatus,o:x.otherSales,a:x.adjustmentSales,tot:x.totalSales});
  console.log(JSON.stringify({A:f(p('配達\\n¥3,000\\nチップ\\n¥200\\n総売上\\n¥3,000')),B:f(p('配達\\n¥2,800\\nチップ\\n¥200\\n総売上\\n¥3,000')),C:f(p('配達\\n¥3,000\\nチップ\\n¥200')),
    adj1:f(p('配達\\n¥1,000\\n調整\\n-¥607\\n総売上\\n¥393')),adj2:f(p('配達\\n¥1,000\\n調整\\n−607円')),adj3:f(p('配達 ¥1,000\\n調整 ¥-300')),adj4:f(p('配達\\n¥1,000\\n調整 2026-09-22\\n¥500')),
    adj5:f(p('配達\\n¥1,000\\n調整\\n+¥250'))}));`);
check(L.A.st === 'included' && L.A.d === 3000 && L.A.t === 200 && L.A.o === 0 && L.A.tot === 3000, 'パターンA（配達にチップ込み）: 配達報酬 ¥3,000・うちチップ ¥200・その他 ¥0', L.A);
check(L.B.st === 'separate' && L.B.d === 3000 && L.B.t === 200 && L.B.o === 0 && L.B.tot === 3000, 'パターンB（配達とチップが別）: 配達報酬 ¥3,000（¥2,800＋¥200）・うちチップ ¥200', L.B);
check(L.C.st === 'unknown' && L.C.d === 3000 && L.C.t === 0 && L.C.o === 0, 'パターンC（総売上で判定できない）: 数字を入れず警告（配達・チップ・その他の複数箇所に入れない）', L.C);
check(L.adj1.a === -607 && L.adj1.tot === 393 && L.adj2.a === -607 && L.adj3.a === -300, '調整のマイナス（-¥607・−607円・¥-300）を絶対値にしない', [L.adj1, L.adj2, L.adj3]);
check(L.adj4.a === 500 && L.adj5.a === 250, '日付の「-」をマイナスと誤認しない・プラス調整はプラス', [L.adj4, L.adj5]);

// ============================================================
section('8. 日本時間（端末のタイムゾーンに関係なく）');
for (const tz of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
  const T = run(`const {getTodayDateString:g,getCurrentTimeString:t}=require(${STORE});
    console.log(JSON.stringify({a:g(new Date('2026-10-12T15:30:00Z')),b:g(new Date('2026-10-12T14:59:00Z')),c:t(new Date('2026-10-12T15:30:00Z')),
      d:g(new Date('2026-12-31T15:00:00Z'))}));`, { TZ: tz });
  check(T.a === '2026-10-13' && T.b === '2026-10-12' && T.c === '00:30' && T.d === '2027-01-01', `TZ=${tz}: UTC 15:30 → 日本時間 10/13 00:30・UTC 14:59 → 10/12・年またぎも日本時間`, T);
}

// ============================================================
section('9. データ整合性監査スクリプト');
const AUDIT = path.join(ROOT, 'tools', 'data-audit', 'data-integrity-audit.js');
const ok = spawnSync(process.execPath, [AUDIT, '--today', '2026-10-13', '--json'], { encoding: 'utf8' });
const okJ = JSON.parse(ok.stdout);
check(ok.status === 0 && okJ.ok && okJ.mismatches.length === 0, `同梱データ: 不整合なし（月 ${okJ.months.length}・今月 ${okJ.thisMonth.sales}円）`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-audit-'));
const bad = JSON.parse(JSON.stringify(FIXTURE));
bad['2099-10-06'].expenses = [exp('ex_bike', 'バイクシェア', 1527), exp('neg', '駐輪', -100)]; // 9/29 と同じ経費ID・マイナス経費
bad['2099-10-06'].sales.total = 999; // 保存された総売上と内訳の不一致
bad['2099-10-06'].deliveriesCount = 'abc'; // 数値でない
bad['2099-10-01'].sales.adjustment = 800; // 調整イベント（+500 −300）と不一致
bad['2099-13-01'] = { date: '2099-13-01', deliveries: [], quests: [] }; // 実在しない日付
bad['2099-10-02'].deliveries[1].id = bad['2099-10-02'].deliveries[0].id; // 同じ日のトリップID重複
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(badFile, JSON.stringify({ version: '1.2', dailyLogs: bad }));
const ng = spawnSync(process.execPath, [AUDIT, '--file', badFile, '--today', TODAY, '--now', '2099-12-31T00:00:00Z', '--json'], { encoding: 'utf8' });
const ngJ = JSON.parse(ng.stdout);
const has = (date, field) => ngJ.problems.some(p => p.level === 'error' && p.date === date && p.field.startsWith(field));
check(ng.status === 1 && !ngJ.ok, '不整合のあるバックアップでは exit 1');
check(has('2099-10-06', 'expenses.id') && has('2099-10-06', 'expenses[1].amount') && has('2099-10-06', 'sales.total') && has('2099-10-06', 'deliveriesCount') &&
  has('2099-10-01', 'sales.adjustment') && has('2099-13-01', 'date') && has('2099-10-02', 'deliveries.id') && has('2099-10-09', 'date'),
  '経費IDの重複・マイナス経費・総売上と内訳の不一致・数値でない件数・調整の符号/合計・不正な日付・トリップID重複・未来日の実績を日付つきで検出', ngJ.problems.filter(p => p.level === 'error').map(p => `${p.date} ${p.field}`));
const okFx = JSON.parse(JSON.stringify(FIXTURE));
delete okFx['2099-10-09']; // 未来日を除いた正しい人工データ
const okFile = path.join(tmp, 'ok.json');
fs.writeFileSync(okFile, JSON.stringify({ version: '1.2', dailyLogs: okFx }));
const ok2 = spawnSync(process.execPath, [AUDIT, '--file', okFile, '--today', TODAY, '--now', '2099-12-31T00:00:00Z', '--json'], { encoding: 'utf8' });
const ok2J = JSON.parse(ok2.stdout);
check(ok2.status === 0 && ok2J.thisMonth.sales === 12850 && ok2J.thisMonth.expenses === 400 && ok2J.thisMonth.workedDays === '3 / 7日', `正しいバックアップ（同梱データ＋人工データ）: 不整合なし・今月 ¥${ok2J.thisMonth.sales}・必要経費 ¥${ok2J.thisMonth.expenses}・稼働 ${ok2J.thisMonth.workedDays}`, ok2J.mismatches);
// 同期の確認（バックアップの _sync・公式データの新旧・更新時刻・天気）
const syncBk = JSON.parse(JSON.stringify(okFx));
syncBk['2099-10-06'].expenses = [{ ...exp('ex_t', '必要経費', 10), updatedAt: 'きのう' }];        // 読めない更新時刻
syncBk['2099-10-02'].weather = { type: 'snowstorm', source: 'manual' };                             // 不正な天気
syncBk['2026-10-12'] = { date: '2026-10-12', officialImport: { source: 'official-import-v1', importedAt: '2026-10-12T06:35:24.909Z' }, // 途中の古い公式データ（同梱は新しい）
  tripsCount: 17, deliveriesCount: 20, deliveries: [], quests: [], expenses: [], sales: { delivery: 6472, quest: 600, adjustment: 0, other: 0, total: 7072 } };
const syncMeta = { appVersion: '20261013_v76', pendingDates: ['2099-10-06'], conflicts: [{ key: '2099-10-02|vehicleType', date: '2099-10-02', field: 'vehicleType', local: 'a', cloud: 'b' }], status: { lastResult: 'error', lastError: 'offline' } };
const syncFile = path.join(tmp, 'sync.json');
fs.writeFileSync(syncFile, JSON.stringify({ version: '1.2', dailyLogs: syncBk, _sync: syncMeta }));
const sy = spawnSync(process.execPath, [AUDIT, '--file', syncFile, '--today', TODAY, '--now', '2099-12-31T00:00:00Z', '--json'], { encoding: 'utf8' });
const syJ = JSON.parse(sy.stdout);
const hasP = (level, field, re) => syJ.problems.some(p => p.level === level && p.field.startsWith(field) && (!re || re.test(p.message)));
check(hasP('warn', 'appVersion', /20261013_v76/) && hasP('warn', 'pending') && hasP('warn', 'conflict:vehicleType') && hasP('warn', 'sync', /offline/),
  '同期の確認: 古い版・未送信・競合・同期エラーを表示（バックアップの _sync）', syJ.problems.filter(p => p.level !== 'info').map(p => `${p.date} ${p.field}`));
check(hasP('warn', 'officialImport', /端末の公式データが古い/), '同期の確認: 端末の公式データが同梱データより古い（途中取込のまま）ことを表示');
check(hasP('error', 'expenses[0].updatedAt') && hasP('error', 'weather') && sy.status === 1, '同期の更新時刻が読めない・天気の値が不正 → error（exit 1）');

// v80: 移動手段の旧名称・同義の競合・空の日・重複した稼働記録・あり得ない形・端末とクラウドの差分（_sync.cloudIndex）
const D80 = require(path.join(ROOT, 'js', 'data-diagnostics.js'));
const v80 = JSON.parse(JSON.stringify(okFx));
v80['2099-10-03'] = { ...(v80['2099-10-03'] || { date: '2099-10-03', deliveries: [], quests: [] }), vehicleType: 'レンタサイクル' };
v80['2099-10-04'] = { date: '2099-10-04', workStartedAt: null, workSessions: [], deliveries: [], quests: [] };              // 空の日
v80['2099-10-05'] = { date: '2099-10-05', deliveries: [], quests: [], workSessions: [{ id: 's1', start: '09:00', end: '12:00' }, { id: 's2', start: '09:00', end: '12:00' }] };
v80['2099-10-07'] = { date: '2099-10-07', deliveries: [], quests: [], expenses: [{ id: 'exp_leak', category: '交通費', amount: 300, memo: '' }] }; // クラウドに無い手動のデータ
const cloudDays = {};
['2099-10-01', '2099-10-02', '2099-10-03', '2099-10-05'].forEach(d => { if (v80[d]) cloudDays[d] = D80.daySignature(v80[d]); });
const v80Meta = { appVersion: null, pendingDates: [], conflicts: [{ key: '2099-10-03|vehicleType', date: '2099-10-03', field: 'vehicleType', local: 'バイクシェア利用', cloud: 'レンタサイクル' }], status: { lastResult: 'ok' }, cloudIndex: { at: '2099-10-08T00:00:00Z', days: cloudDays } };
const v80File = path.join(tmp, 'v80.json');
fs.writeFileSync(v80File, JSON.stringify({ version: '1.2', dailyLogs: v80, _sync: v80Meta }));
const v8 = spawnSync(process.execPath, [AUDIT, '--file', v80File, '--today', TODAY, '--now', '2099-12-31T00:00:00Z', '--json'], { encoding: 'utf8' });
const v8J = JSON.parse(v8.stdout);
const hasV = (level, date, field, re) => v8J.problems.some(p => p.level === level && (!date || p.date === date) && p.field.startsWith(field) && (!re || re.test(p.message)));
check(hasV('info', '2099-10-03', 'vehicleType', /旧名称「レンタサイクル」/) && hasV('info', '2099-10-03', 'conflict:vehicleType', /同義/), '監査: 移動手段の旧名称と、同義の旧名称どうしの競合を表示（保存値は変えない）');
check(hasV('info', '-', 'emptyDays', /2099-10-04/) && hasV('warn', '2099-10-05', 'workSessions', /二重/), '監査: 空の日（消さない）・同じ時間の稼働記録の二重を表示');
check(hasV('warn', '2099-10-07', 'unsent', /送信漏れ/) && hasV('info', '-', 'days', /端末だけ/) && !hasV('warn', '2099-10-04', 'unsent'), '監査: 端末とクラウドの差分（送信漏れは手動のデータがある日だけ。空の日は送信漏れにしない）');
const shape = D80.checkDailyLogs({ '2099-10-01': { date: '2099-10-01', deliveries: {}, expenses: 'x', manualUpdatedAt: [] } }, {});
check(['deliveries', 'expenses', 'manualUpdatedAt'].every(f => shape.some(p => p.level === 'error' && p.field === f)), '監査: あり得ない形（配列であるべき項目が配列でない等）を error');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
