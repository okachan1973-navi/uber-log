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
  assert.strictEqual(count('KFC イオンモール大阪ドームシティ店'), 5);
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

// ---- カテゴリ・ブランド・並び順・同一拠点・初期表示範囲 ----
const brandsDef = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_brands.json'), 'utf8'));
const byName = n => master.stores.find(s => s.canonical_name === n);

test('カテゴリ順: マクドナルド → ファーストフード（マクドナルドは独立カテゴリ）', () => {
  assert.deepStrictEqual(master.category_order.slice(0, 2), ['mcdonalds', 'fastfood']);
  assert.ok(master.stores.filter(s => s.brand_id === 'mcdonalds').every(s => s.category === 'mcdonalds'));
  assert.strictEqual(master.stores.filter(s => s.category === 'mcdonalds').length, 13);
});

test('ファーストフード: BK・KFC・モス・ミスド・ピザハットだけ（たこ焼き店は入れない）', () => {
  const ff = master.stores.filter(s => s.category === 'fastfood');
  assert.deepStrictEqual([...new Set(ff.map(s => s.brand_id))].sort(), ['burger_king', 'kfc', 'mister_donut', 'mos_burger', 'pizza_hut']);
  assert.strictEqual(byName('たこ家 輝 西九条店').category, 'other');
  assert.strictEqual(byName('築地銀だこ イオンモール大阪ドームシティ店').category, 'other');
});

test('KFC表記統一: 表示名はKFC、Uber上の原文は original_names に残る', () => {
  const kfc = master.stores.filter(s => s.brand_id === 'kfc');
  assert.deepStrictEqual(kfc.map(s => s.canonical_name).sort(), ['KFC うめきたグリーンプレイス店', 'KFC イオンモール大阪ドームシティ店']);
  assert.ok(!master.stores.some(s => /ケンタッキー/.test(s.canonical_name)));
  assert.ok(byName('KFC イオンモール大阪ドームシティ店').original_names.some(n => /ケンタッキーフライドチキン/.test(n)));
  assert.ok(PS.aggregatePickups(dailyLogs, master).stores.find(s => s.canonical_name === 'KFC イオンモール大阪ドームシティ店').pickup_count === 6);
});

test('今後の新店舗もブランドで自動整理（KFC表記・カテゴリ・連続配置）', () => {
  const mk = (id, name, n) => PS.annotateBrand({ id, canonical_name: name, pickup_count: n }, brandsDef);
  const a = mk('x1', 'ケンタッキーフライドチキン 弁天町店', 1);
  assert.strictEqual(a.canonical_name, 'KFC 弁天町店');
  assert.strictEqual(PS.resolveBrand('ケンタッキー 野田店', brandsDef).brand.id, 'kfc');
  assert.strictEqual(PS.resolveBrand('ローソンストア100 九条店', brandsDef).brand.id, 'lawson_store100');
  assert.strictEqual(PS.resolveBrand('ローソン 九条店', brandsDef).brand.id, 'lawson');
  assert.strictEqual(PS.resolveBrand('7-Eleven 大阪九条店', brandsDef).brand.id, 'seven_eleven');
  assert.strictEqual(PS.resolveBrand('魚屋のおむすび丸徳', brandsDef), null);
  const list = [mk('y1', 'やよい軒 弁天町店', 1), mk('b1', 'バーガーキング 野田店', 9), mk('y2', 'やよい軒 あ店', 5), mk('m1', '松のや 野田店', 2), mk('m2', '松屋 野田店', 2), mk('y3', 'やよい軒 九条店', 3)];
  const sorted = list.slice().sort(PS.compareByName).map(s => s.id);
  const pos = id => sorted.indexOf(id);
  const ys = ['y1', 'y2', 'y3'].map(pos).sort((x, y) => x - y);
  assert.strictEqual(ys[2] - ys[0], 2, 'やよい軒の3店舗が連続: ' + sorted.join(','));
});

test('名称順: どのカテゴリでも同じブランドが連続し、ブランド内は支店名順', () => {
  master.category_order.forEach(cat => {
    const list = master.stores.filter(s => s.category === cat).sort(PS.compareByName);
    const seen = new Set(); let prev = null;
    list.forEach(s => {
      if (!s.brand_id) { prev = null; return; }
      assert.ok(s.brand_id === prev || !seen.has(s.brand_id), `${cat}: ${s.brand_id} が離れて並ぶ`);
      seen.add(s.brand_id); prev = s.brand_id;
    });
  });
  const ff = master.stores.filter(s => s.category === 'fastfood').sort(PS.compareByName).map(s => s.canonical_name);
  assert.deepStrictEqual(ff, [
    'KFC イオンモール大阪ドームシティ店', 'KFC うめきたグリーンプレイス店',
    'バーガーキング 九条店', 'バーガーキング 御堂筋本町店',
    'ピザハット 阿波座店', 'ピザハット 大阪ナインモール九条店',
    'ミスタードーナツ 福島大開ショップ',
    'モスバーガー JR福島駅前店', 'モスバーガー JR野田店', 'モスバーガー 市岡みなと通り店'
  ]);
});

test('回数順: 多い順、同数は名称順', () => {
  const list = master.stores.slice().sort(PS.compareByCount);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    assert.ok(a.pickup_count > b.pickup_count || (a.pickup_count === b.pickup_count && PS.compareByName(a, b) < 0), `${a.canonical_name} / ${b.canonical_name}`);
  }
  const six = list.filter(s => s.pickup_count === 6).map(s => s.canonical_name);
  assert.deepStrictEqual(six, six.slice().sort((x, y) => PS.compareByName(byName(x), byName(y))));
  assert.strictEqual(list[0].canonical_name, 'マクドナルド 九条店');
});

test('既定の並び順: マクドナルドは回数順、それ以外は名称順', () => {
  assert.strictEqual(PS.defaultSortFor('mcdonalds', brandsDef), 'count');
  ['all', 'fastfood', 'convenience', 'gyudon_teishoku', 'cafe', 'drug_super', 'other'].forEach(c => assert.strictEqual(PS.defaultSortFor(c, brandsDef), 'name', c));
});

test('同一拠点: 松屋 九条店と松のや 九条店は同住所で同じ拠点、回数は別々', () => {
  const ya = byName('松屋 九条店'), noya = byName('松のや 九条店'), tenma = byName('松屋 天満橋店');
  assert.strictEqual(ya.address, noya.address);
  assert.ok(ya.site_id && ya.site_id === noya.site_id);
  assert.strictEqual(tenma.site_id, null, '住所の違う松屋 天満橋店はまとめない');
  assert.strictEqual(ya.pickup_count, 2);
  assert.strictEqual(noya.pickup_count, 3);
  assert.notStrictEqual(ya.id, noya.id);
  const site = master.sites.find(x => x.site_id === ya.site_id);
  assert.deepStrictEqual(site.store_ids.sort(), [ya.id, noya.id].sort());
  // 松屋と松のやが同じ住所にある拠点は1件だけ
  const mixed = master.sites.filter(x => x.store_ids.map(id => master.stores.find(s => s.id === id).brand_id).some(b => b === 'matsuya') && x.store_ids.map(id => master.stores.find(s => s.id === id).brand_id).some(b => b === 'matsunoya'));
  assert.strictEqual(mixed.length, 1);
  // どの拠点も全店舗の住所が完全一致
  master.sites.forEach(x => assert.strictEqual(new Set(x.store_ids.map(id => PS.addressKey(master.stores.find(s => s.id === id).address))).size, 1, x.label));
});

test('初期表示範囲: 確認済み全店舗が入り、余白は範囲の数%だけ', () => {
  const conf = master.stores.filter(s => s.coordinate_status === 'confirmed');
  const [[s, w], [n, e]] = PS.confirmedBounds(master.stores, 0.04);
  conf.forEach(st => assert.ok(st.latitude >= s && st.latitude <= n && st.longitude >= w && st.longitude <= e, st.canonical_name));
  const lats = conf.map(x => x.latitude), lngs = conf.map(x => x.longitude);
  const spanLat = Math.max(...lats) - Math.min(...lats), spanLng = Math.max(...lngs) - Math.min(...lngs);
  assert.ok(Math.abs((n - s) - spanLat * 1.08) < 1e-9 && Math.abs((e - w) - spanLng * 1.08) < 1e-9);
  assert.ok(n - s < 0.1 && e - w < 0.15, '大阪西部の範囲に収まる（府全体ではない）');
  assert.strictEqual(PS.confirmedBounds([], 0.04), null);
});

test('data/uber_pickup_stores.js が JSON と同期している', () => {
  const js = fs.readFileSync(path.join(ROOT, 'data', 'uber_pickup_stores.js'), 'utf8');
  const m = js.match(/window\.UBER_PICKUP_STORE_MASTER = (.*);\n/);
  assert.ok(m);
  assert.deepStrictEqual(JSON.parse(m[1]), master);
});

console.log(`${passed} passed`);
