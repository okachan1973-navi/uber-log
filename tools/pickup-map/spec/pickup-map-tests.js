#!/usr/bin/env node
/**
 * ピックアップ店舗マップのテスト
 *   node tools/pickup-map/spec/pickup-map-tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PS = require(path.join(ROOT, 'js', 'pickup-stores.js'));
const build = require(path.join(ROOT, 'tools', 'pickup-map', 'build-stores.js'));
const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_pickup_stores.json'), 'utf8'));
const dailyLogs = require(path.join(ROOT, 'js', 'store.js')).getConfirmedSeedData().dailyLogs;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('pickup-map tests');

test('全角・英語併記・空白ゆれを同じ照合キーにする', () => {
  const k = PS.restaurantKey('マクドナルド 九条店');
  assert.strictEqual(PS.restaurantKey('マクドナルド 九　条　店 McDonald\'s KUJO'), k);
  assert.strictEqual(PS.restaurantKey('マクドナルド 九 条 店 McDonald\'s KUJO'), k);
  assert.strictEqual(PS.restaurantKey('マクドナルド ＪＲ野田駅前店 McDonald\'s JR NODA EKI-MAE'), PS.restaurantKey('マクドナルド JR野田駅前店'));
  assert.strictEqual(PS.restaurantKey('スシロー 辰巳橋店 (Sushiro TATSUMIBASHI)'), PS.restaurantKey('スシロー 辰巳橋店'));
  assert.strictEqual(PS.restaurantKey('コクミンドラッグ西九条店'), PS.restaurantKey('コクミンドラッグ 西九条店'));
});

test('英語だけの店名や英字始まりの店名を消さない', () => {
  assert.strictEqual(PS.normalizeDisplayName('CoDeLi 大阪九条駅前店'), 'CoDeLi 大阪九条駅前店');
  assert.strictEqual(PS.normalizeDisplayName('【塩のおにぎり屋】PACKN-TO'), '【塩のおにぎり屋】PACKN-TO');
});

test('「ガスト」と「ガスト 港弁天町店」を統合しない', () => {
  const idx = new Map();
  master.stores.forEach(s => s.name_keys.forEach(k => idx.set(k, s.id)));
  assert.notStrictEqual(idx.get(PS.restaurantKey('ガスト')), idx.get(PS.restaurantKey('ガスト 港弁天町店')));
});

test('A/B: 全トリップが店舗に割り当てられ件数が一致する', () => {
  const agg = PS.aggregatePickups(dailyLogs, master);
  assert.strictEqual(agg.unregistered.length, 0, '未登録店名: ' + agg.unregistered.map(u => u.canonical_name).join(','));
  assert.strictEqual(agg.totalPickups, agg.totalTrips);
  assert.strictEqual(agg.stores.reduce((a, s) => a + s.pickup_count, 0), agg.totalTrips);
});

test('G: 9/28時点の上位店舗は指示書の手動集計と一致', () => {
  const upto = {};
  Object.keys(dailyLogs).filter(d => d <= '2026-09-28').forEach(d => { upto[d] = dailyLogs[d]; });
  const agg = PS.aggregatePickups(upto, master);
  assert.strictEqual(agg.totalTrips, 172);
  const count = name => (agg.stores.find(s => s.canonical_name === name) || {}).pickup_count;
  assert.strictEqual(count('マクドナルド 九条店'), 13);
  assert.strictEqual(count('バーガーキング 九条店'), 7);
  assert.strictEqual(count('マクドナルド みなと通夕凪店'), 7);
  assert.strictEqual(count('スシロー 辰巳橋店'), 6);
  assert.strictEqual(count('マクドナルド JR野田駅前店'), 6);
  assert.strictEqual(count('マクドナルド 弁天町駅前店'), 6);
  assert.strictEqual(count('ケンタッキーフライドチキン イオンモール大阪ドームシティ店'), 5);
});

test('新しい店名は既存店舗に混ぜず needs_review で追加される', () => {
  const logs = JSON.parse(JSON.stringify(dailyLogs));
  logs['2099-01-01'] = { date: '2099-01-01', deliveries: [{ id: 'x', completedAt: '12:00', restaurant: 'テスト新店 九条店' }] };
  const r = build.rebuild(master, logs);
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.added[0].coordinate_status, 'needs_review');
  assert.strictEqual(r.added[0].latitude, null);
  const { errors } = build.validate(r, logs);
  assert.deepStrictEqual(errors, []);
});

test('E/F: 確認済み座標は住所の区・町・丁目と一致し、要確認店舗に座標がない', () => {
  master.stores.forEach(s => {
    if (s.coordinate_status === 'confirmed') {
      const m = build.reverseMatchesAddress(s.address, s.geocode_check && s.geocode_check.reverse);
      assert.ok(m.ok, `${s.canonical_name}: ${m.reason}`);
    } else {
      assert.strictEqual(s.latitude, null, s.canonical_name);
      assert.strictEqual(s.longitude, null, s.canonical_name);
    }
  });
});

test('安治川トンネルは南=西区安治川 / 北=此花区西九条', () => {
  const pts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_map_points.json'), 'utf8')).points;
  const s = pts.find(p => p.id === 'ajikawa_tunnel_s');
  const n = pts.find(p => p.id === 'ajikawa_tunnel_n');
  assert.ok(s.area.includes('西区安治川'));
  assert.ok(n.area.includes('此花区西九条'));
  assert.ok(n.latitude > s.latitude, '北口は南口より北');
});

test('Google Maps: 座標あり店舗は保存済み緯度経度・自転車モードのURLになる', () => {
  const st = master.stores.find(s => s.canonical_name === 'マクドナルド 九条店');
  const url = new URL(PS.googleMapsBikeUrl(st));
  assert.strictEqual(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
  assert.strictEqual(url.searchParams.get('api'), '1');
  assert.strictEqual(url.searchParams.get('travelmode'), 'bicycling');
  assert.strictEqual(url.searchParams.get('destination'), `${st.latitude.toFixed(6)},${st.longitude.toFixed(6)}`);
  assert.strictEqual(url.searchParams.get('destination'), '34.675293,135.474182');
  assert.ok(!url.searchParams.has('origin'), '出発地は指定しない（Google Maps 側の現在地を使う）');
  assert.ok(!/%E3|マクドナルド/.test(url.href), '店名は渡さない（同名店舗への誤誘導防止）');
});

test('Google Maps: iOSアプリ用URLも同じ座標・自転車モード', () => {
  const st = master.stores.find(s => s.canonical_name === 'スシロー 辰巳橋店');
  const app = PS.googleMapsAppUrl(st);
  assert.ok(app.startsWith('comgooglemaps://?'));
  const q = new URLSearchParams(app.split('?')[1]);
  assert.strictEqual(q.get('daddr'), `${st.latitude.toFixed(6)},${st.longitude.toFixed(6)}`);
  assert.strictEqual(q.get('directionsmode'), 'bicycling');
  assert.ok(!q.has('saddr'));
});

test('Google Maps: 座標確認済みの全98店舗でURLが作れ、目的地が各店舗の保存座標', () => {
  const confirmed = master.stores.filter(s => s.coordinate_status === 'confirmed');
  assert.strictEqual(confirmed.length, 98);
  confirmed.forEach(s => {
    const dest = new URL(PS.googleMapsBikeUrl(s)).searchParams.get('destination').split(',').map(Number);
    assert.ok(Math.abs(dest[0] - s.latitude) < 1e-6 && Math.abs(dest[1] - s.longitude) < 1e-6, s.canonical_name);
  });
});

test('Google Maps: 座標なし・要確認・不正座標ではURLを作らない（ルート無効）', () => {
  const review = master.stores.filter(s => s.coordinate_status !== 'confirmed');
  assert.strictEqual(review.length, 3);
  review.forEach(s => {
    assert.strictEqual(PS.googleMapsBikeUrl(s), null, s.canonical_name);
    assert.strictEqual(PS.googleMapsAppUrl(s), null, s.canonical_name);
  });
  const base = master.stores.find(s => s.coordinate_status === 'confirmed');
  assert.strictEqual(PS.googleMapsBikeUrl(Object.assign({}, base, { coordinate_status: 'needs_review' })), null);
  assert.strictEqual(PS.googleMapsBikeUrl(Object.assign({}, base, { latitude: null })), null);
  assert.strictEqual(PS.googleMapsBikeUrl(Object.assign({}, base, { latitude: NaN })), null);
  assert.strictEqual(PS.googleMapsBikeUrl(Object.assign({}, base, { latitude: 0, longitude: 0 })), null);
  assert.strictEqual(PS.googleMapsBikeUrl(Object.assign({}, base, { latitude: '34.6' })), null);
  assert.strictEqual(PS.googleMapsBikeUrl(null), null);
});

test('data/uber_pickup_stores.js が JSON と同期している', () => {
  const js = fs.readFileSync(path.join(ROOT, 'data', 'uber_pickup_stores.js'), 'utf8');
  const m = js.match(/window\.UBER_PICKUP_STORE_MASTER = (.*);\n/);
  assert.ok(m);
  assert.deepStrictEqual(JSON.parse(m[1]), master);
});

console.log(`${passed} passed`);
