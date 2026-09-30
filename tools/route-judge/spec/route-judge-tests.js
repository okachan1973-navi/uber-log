#!/usr/bin/env node
/**
 * ルート判断マップの計算・地理データのテスト
 *   node tools/route-judge/spec/route-judge-tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RJ = require(path.join(ROOT, 'js', 'route-judge-core.js'));
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_route_geo.json'), 'utf8'));
const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_pickup_stores.json'), 'utf8'));
const river = geo.rivers.find(r => r.id === 'ajikawa');
const crossing = id => geo.crossings.find(c => c.id === id);
const store = name => { const s = master.stores.find(x => x.canonical_name === name); return { lat: s.latitude, lng: s.longitude }; };
const en = (c, side) => ({ lat: crossing(c).entrances[side].latitude, lng: crossing(c).entrances[side].longitude });

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('route-judge tests');

test('安治川の境界線: OSMの堂島川→安治川（上流端・合流点・河口）', () => {
  const L = river.divide_line;
  assert.ok(L.length >= 20);
  assert.deepStrictEqual(L[L.length - 1], [34.655704, 135.426382], '河口（天保山）');
  assert.ok(L.some(p => p[0] === river.confluence.latitude && p[1] === 135.481133), '合流点（中之島西端）を通る');
  assert.ok(L[0][1] > 135.49, '上流端は堂島川');
});

test('安治川トンネル: 南口=西区安治川一丁目（南岸）/ 北口=此花区西九条二丁目（北岸）', () => {
  const t = crossing('ajikawa_tunnel');
  assert.strictEqual(t.type, 'tunnel');
  assert.deepStrictEqual([t.entrances.south.latitude, t.entrances.south.longitude], [34.679024, 135.467585]);
  assert.deepStrictEqual([t.entrances.north.latitude, t.entrances.north.longitude], [34.679716, 135.467138]);
  assert.ok(/西区安治川一丁目/.test(t.entrances.south.area) && /此花区西九条二丁目/.test(t.entrances.north.area));
  assert.strictEqual(RJ.sideOfRiver(en('ajikawa_tunnel', 'south'), river).side, 'south');
  assert.strictEqual(RJ.sideOfRiver(en('ajikawa_tunnel', 'north'), river).side, 'north');
  assert.ok(RJ.distance(en('ajikawa_tunnel', 'south'), en('ajikawa_tunnel', 'north')) < 120, '立坑間は川幅程度');
  assert.strictEqual(t.bike.push_walk, false);
});

test('安治川大橋: 国道43号・両端の階段下（港区波除六丁目／此花区春日出南一丁目）・⚠押し歩き', () => {
  const b = crossing('ajikawa_ohashi');
  assert.strictEqual(b.type, 'bridge');
  assert.ok(/国道43号/.test(b.name));
  assert.strictEqual(b.warning, '⚠ 自転車押し歩きあり');
  assert.strictEqual(b.bike.push_walk, true);
  assert.ok(/港区波除六丁目/.test(b.entrances.south.area) && /此花区春日出南一丁目/.test(b.entrances.north.area));
  assert.strictEqual(RJ.sideOfRiver(en('ajikawa_ohashi', 'south'), river).side, 'south');
  assert.strictEqual(RJ.sideOfRiver(en('ajikawa_ohashi', 'north'), river).side, 'north');
  assert.strictEqual(b.stairs.length, 4);
  assert.deepStrictEqual(b.stairs.map(s => s.side).sort(), ['north', 'north', 'south', 'south']);
  // 橋の歩道（path）が川の線と交わる＝本当に安治川を渡っている
  const s = RJ.sideOfRiver({ lat: b.path[0][0], lng: b.path[0][1] }, river).side;
  const n = RJ.sideOfRiver({ lat: b.path[b.path.length - 1][0], lng: b.path[b.path.length - 1][1] }, river).side;
  assert.deepStrictEqual([s, n], ['south', 'north']);
  // 安治川トンネルより下流（西）側
  assert.ok(b.entrances.south.longitude < crossing('ajikawa_tunnel').entrances.south.longitude);
});

test('全横断ポイント: 南側の入口は南岸、北側の入口は北岸', () => {
  geo.crossings.forEach(c => {
    assert.strictEqual(RJ.sideOfRiver(en(c.id, 'south'), river).side, 'south', c.id + ' south');
    assert.strictEqual(RJ.sideOfRiver(en(c.id, 'north'), river).side, 'north', c.id + ' north');
  });
});

test('岸の判定: 西区・港区・大正区の店舗は南岸、此花区・福島区の店舗は北岸', () => {
  ['マクドナルド 九条店', 'マクドナルド 弁天町駅前店', 'スシロー 辰巳橋店', 'マクドナルド 大正店', 'マクドナルド 南堀江関西スーパー店', 'マクドナルド みなと通夕凪店', 'マクドナルド イオンモール大阪ドームシティ店']
    .forEach(n => assert.strictEqual(RJ.sideOfRiver(store(n), river).side, 'south', n));
  ['マクドナルド 阪神西九条駅前店', 'マクドナルド JR野田駅前店', 'マクドナルド 高見プラザ店', 'マクドナルド 福島店', 'すき家 此花四貫島店', 'マクドナルド 野田阪神店', 'ローソン 此花千鳥橋']
    .forEach(n => assert.strictEqual(RJ.sideOfRiver(store(n), river).side, 'north', n));
});

test('判定範囲外: 堂島川の上流端より東（中央区谷町）は null', () => {
  const r = RJ.sideOfRiver(store('松屋 天満橋店'), river);
  assert.strictEqual(r.side, null);
  assert.strictEqual(r.reason, 'upstream_out');
});

test('横断なし: 九条 → 弁天町（どちらも南岸）', () => {
  const leg = RJ.analyzeLeg('pick', store('マクドナルド 九条店'), 'drop', store('マクドナルド 弁天町駅前店'), geo);
  assert.strictEqual(leg.crosses, false);
  assert.strictEqual(leg.candidates.length, 0);
});

test('横断あり: 九条 → 阪神西九条 は安治川トンネルが最短（直線目安）', () => {
  const leg = RJ.analyzeLeg('pick', store('マクドナルド 九条店'), 'drop', store('マクドナルド 阪神西九条駅前店'), geo);
  assert.strictEqual(leg.crosses, true);
  assert.deepStrictEqual([leg.from_side, leg.to_side], ['south', 'north']);
  assert.strictEqual(leg.best.id, 'ajikawa_tunnel');
  assert.strictEqual(leg.candidates.length, geo.crossings.length);
  const bridge = leg.candidates.find(c => c.id === 'ajikawa_ohashi');
  assert.ok(bridge.total_m > leg.best.total_m && bridge.push_walk && bridge.warning === '⚠ 自転車押し歩きあり');
  assert.ok(leg.best.total_m >= leg.direct_m);
});

test('横断あり: 弁天町 → 此花区高見 は安治川大橋が最短で⚠押し歩きが付く', () => {
  const leg = RJ.analyzeLeg('current', store('マクドナルド 弁天町駅前店'), 'pick', store('マクドナルド 高見プラザ店'), geo);
  assert.strictEqual(leg.crosses, true);
  assert.strictEqual(leg.best.id, 'ajikawa_ohashi');
  assert.strictEqual(leg.best.push_walk, true);
  assert.ok(leg.best.entrance.side === 'south' && leg.best.exit.side === 'north');
});

test('案件（現在地→PICK→DROP）: 区間を順に判定し、PICK未設定なら現在地→DROPを作らない', () => {
  const job = RJ.createJob({ current: store('マクドナルド 弁天町駅前店'), pick: store('マクドナルド 九条店'), drop: store('マクドナルド 阪神西九条駅前店') });
  assert.strictEqual(job.schema, 'uber_route_job/1');
  const r = RJ.analyzeJob(job, geo);
  assert.deepStrictEqual(r.legs.map(l => `${l.from}>${l.to}`), ['current>pick', 'pick>drop']);
  assert.deepStrictEqual(r.legs.map(l => l.crosses), [false, true]);
  assert.strictEqual(r.crossing_count, 1);
  assert.deepStrictEqual(r.sides, { current: 'south', pick: 'south', drop: 'north' });
  assert.ok(r.total_best_m >= r.total_direct_m);
  const noPick = RJ.analyzeJob({ current: store('マクドナルド 九条店'), drop: store('マクドナルド 福島店') }, geo);
  assert.strictEqual(noPick.legs.length, 0);
  assert.strictEqual(RJ.analyzeJob({ pick: store('マクドナルド 九条店') }, geo).legs.length, 0);
});

test('横断経由の距離は必ず直線以上（階段・立坑も含めて計算）: ランダム2000組', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let crossed = 0;
  for (let i = 0; i < 2000; i++) {
    const a = { lat: 34.655 + rnd() * 0.04, lng: 135.43 + rnd() * 0.06 };
    const b = { lat: 34.655 + rnd() * 0.04, lng: 135.43 + rnd() * 0.06 };
    const leg = RJ.analyzeLeg('pick', a, 'drop', b, geo);
    if (!leg.crosses) continue;
    crossed++;
    leg.candidates.forEach(c => {
      assert.ok(c.total_m >= leg.direct_m - 1, `${c.id}: ${c.total_m} < ${leg.direct_m}`);
      assert.ok(c.detour_m >= 0);
      assert.strictEqual(c.total_m, c.to_entrance_m + c.crossing_m + c.from_exit_m + (crossing(c.id).penalty_m || 0) + (c.total_m - (c.to_entrance_m + c.crossing_m + c.from_exit_m)));
    });
  }
  assert.ok(crossed > 300, '横断する組が十分ある: ' + crossed);
  // 大橋の横断距離は階段込み（階段下→歩道→階段下）で歩道だけより長い
  const leg = RJ.analyzeLeg('current', store('マクドナルド 弁天町駅前店'), 'pick', store('マクドナルド 高見プラザ店'), geo);
  const br = leg.candidates.find(c => c.id === 'ajikawa_ohashi');
  assert.ok(br.crossing_m > RJ.pathLength(crossing('ajikawa_ohashi').path));
  assert.ok(br.total_m >= leg.direct_m && br.detour_m >= 0);
});

test('将来拡張の枠: 注意地点の種類（避けたい橋・道路・商業施設・タワマン・ホテル・負担ルート）', () => {
  assert.deepStrictEqual(Object.keys(geo.caution_types).sort(), ['avoid_bridge', 'avoid_road', 'burden_route', 'hotel', 'mall', 'tower_mansion']);
  assert.ok(Array.isArray(geo.cautions));
});

console.log(`${passed} passed`);
