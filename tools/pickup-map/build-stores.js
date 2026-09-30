#!/usr/bin/env node
/**
 * ピックアップ店舗マスタの再集計・検証・出力
 *
 *   node tools/pickup-map/build-stores.js            … 再集計して data/ に書き出し（検証NGなら exit 1）
 *   node tools/pickup-map/build-stores.js --check    … 書き出さずに検証だけ（差分があれば exit 1）
 *   node tools/pickup-map/build-stores.js --verify-geo … 国土地理院逆ジオコーダで座標の区・町名を再確認（開発時のみ・ネット必須）
 *
 * 流れ: js/store.js（CONFIRMED_SEED_DATA.dailyLogs）→ 店舗名正規化 → 店舗マスタの name_keys と照合
 *       → 既存店舗は pickup_count 等を更新 / 未登録の店名は新店舗として追加（coordinate_status=needs_review）
 * 住所・座標は data/uber_pickup_stores.json に固定保存されたものだけを使う（ここでジオコーディングはしない）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MASTER_JSON = path.join(ROOT, 'data', 'uber_pickup_stores.json');
const POINTS_JSON = path.join(ROOT, 'data', 'uber_map_points.json');
const BUNDLE_JS = path.join(ROOT, 'data', 'uber_pickup_stores.js');

const PickupStores = require(path.join(ROOT, 'js', 'pickup-stores.js'));

// 大阪市の概略範囲（これを外れる座標は誤りとみなす）
const OSAKA_CITY_BBOX = { south: 34.56, north: 34.78, west: 135.38, east: 135.62 };

// 国土地理院 市区町村コード（大阪市24区）
const OSAKA_WARD_CODES = {
  '27102': '都島区', '27103': '福島区', '27104': '此花区', '27106': '西区', '27107': '港区', '27108': '大正区',
  '27109': '天王寺区', '27111': '浪速区', '27113': '西淀川区', '27114': '東淀川区', '27115': '東成区', '27116': '生野区',
  '27117': '旭区', '27118': '城東区', '27119': '阿倍野区', '27120': '住吉区', '27121': '東住吉区', '27122': '西成区',
  '27123': '淀川区', '27124': '鶴見区', '27125': '住之江区', '27126': '平野区', '27127': '北区', '27128': '中央区'
};

// カテゴリ判定（category_override があればそちらを優先）
const CATEGORY_RULES = [
  ['mcdonalds', /^マクドナルド/],
  ['convenience', /セブン|7-Eleven|ローソン/],
  ['gyudon_teishoku', /すき家|吉野家|松屋|松のや|なか卯|やよい軒|かつ丼|オリジン|ほっかほっか亭|弁当|宇奈とと|とりげん|おむすび|おにぎり|PACKN/],
  ['cafe', /スターバックス|ブルーボトル|COFFEE|珈琲|エッグスンシングス|クロワッサン|ベーカリー|アサイー|サンドイッチ|my ?bowl|マイボウル/i],
  ['fastfood', /バーガーキング|ケンタッキー|KFC|モスバーガー|ピザハット|ミスタードーナツ|銀だこ|たこ家/],
  ['drug_super', /ウエルシア|コクミン|アカカベ|グルメシティ|CoDeLi/]
];
const CATEGORY_LABELS = {
  mcdonalds: 'マクドナルド', convenience: 'コンビニ', gyudon_teishoku: '牛丼・定食・弁当', cafe: 'カフェ・パン',
  fastfood: 'ファストフード', drug_super: 'ドラッグ・スーパー', other: 'その他'
};

function categorize(name) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'other';
}

function fnvId(s) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(s, 'utf8')) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; }
  return 'st_' + h.toString(36);
}

function loadSeedLogs() {
  const storeModule = require(path.join(ROOT, 'js', 'store.js'));
  return storeModule.getConfirmedSeedData().dailyLogs;
}

function kanjiToInt(s) {
  const d = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (s === '十') return 10;
  if (s.includes('十')) { const [a, b] = s.split('十'); return (a ? d[a] : 1) * 10 + (b ? d[b] : 0); }
  return Number(String(s).split('').map(c => d[c]).join(''));
}

/** 住所「大阪府大阪市西区九条1-14-19」→ { ward:'西区', town:'九条', chome:1 } */
function parseOsakaAddress(address) {
  const m = String(address || '').normalize('NFKC').match(/大阪市(.+?区)(.+?)(\d+)(?:丁目|-|番)/);
  if (!m) return null;
  return { ward: m[1], town: m[2].replace(/曽根崎/, '曾根崎'), chome: Number(m[3]) };
}

/** 逆ジオコーダ結果（muniCd / lv01Nm）が住所の区・町・丁目と整合するか */
function reverseMatchesAddress(address, rev) {
  const a = parseOsakaAddress(address);
  if (!a || !rev) return { ok: false, reason: '住所または逆ジオコード結果なし' };
  const ward = OSAKA_WARD_CODES[rev.muniCd];
  if (ward !== a.ward) return { ok: false, reason: `区が不一致（住所:${a.ward} / 座標:${ward || rev.muniCd}）` };
  const lv = String(rev.lv01Nm || '');
  const m = lv.match(/^(.+?)([一二三四五六七八九十]+)丁目$/);
  const town = m ? m[1] : lv;
  if (!a.town.startsWith(town) && !town.startsWith(a.town)) return { ok: false, reason: `町名が不一致（住所:${a.town} / 座標:${lv}）` };
  if (m && kanjiToInt(m[2]) !== a.chome) return { ok: false, reason: `丁目が不一致（住所:${a.chome}丁目 / 座標:${lv}）` };
  return { ok: true, reason: `${ward} ${lv}` };
}

async function fetchReverse(lat, lng) {
  const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); if (j && j.results) return j.results; }
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}

function rebuild(master, dailyLogs) {
  const agg = PickupStores.aggregatePickups(dailyLogs, master);
  const byId = new Map(agg.stores.map(s => [s.id, s]));
  const today = new Date().toISOString().slice(0, 10);

  const stores = master.stores.map(st => {
    const a = byId.get(st.id);
    const next = Object.assign({}, st);
    next.category = st.category_override || categorize(st.canonical_name);
    next.pickup_count = a ? a.pickup_count : 0;
    next.first_pickup = a ? a.first_pickup : null;
    next.last_pickup = a ? a.last_pickup : null;
    next.active_days = a ? a.active_days : 0;
    next.original_names = a ? a.original_names : (st.original_names || []);
    return next;
  });

  // 未登録の店名 → 新店舗として追加（座標は入れない）
  const added = agg.unregistered.map(u => ({
    id: fnvId(u.name_keys[0]),
    canonical_name: u.canonical_name,
    name_keys: u.name_keys,
    category: categorize(u.canonical_name),
    address: null,
    latitude: null,
    longitude: null,
    coordinate_status: 'needs_review',
    coordinate_source: null,
    address_source: null,
    address_evidence: null,
    geocode_check: null,
    same_building: null,
    notes: `${today} 自動追加: 住所・座標が未登録。既存店舗の別表記なら既存店舗の name_keys に移すこと。`,
    pickup_count: u.pickup_count,
    first_pickup: u.first_pickup,
    last_pickup: u.last_pickup,
    active_days: u.active_days,
    original_names: u.original_names
  }));

  const all = stores.concat(added).sort((x, y) => y.pickup_count - x.pickup_count || x.canonical_name.localeCompare(y.canonical_name, 'ja'));
  const dates = Object.keys(dailyLogs).sort();
  const summary = {
    period: { from: dates[0] || null, to: dates[dates.length - 1] || null, days: dates.length },
    total_trips: agg.totalTrips,
    total_pickups: all.reduce((s, x) => s + x.pickup_count, 0),
    store_count: all.filter(s => s.pickup_count > 0).length,
    confirmed_count: all.filter(s => s.pickup_count > 0 && s.coordinate_status === 'confirmed').length,
    needs_review_count: all.filter(s => s.pickup_count > 0 && s.coordinate_status !== 'confirmed').length,
    trips_without_restaurant: agg.missingName.length
  };
  return { master: Object.assign({}, master, { generated_from: 'js/store.js CONFIRMED_SEED_DATA.dailyLogs', summary, category_labels: CATEGORY_LABELS, stores: all }), added, agg };
}

function validate(result, dailyLogs) {
  const errors = [];
  const warnings = [];
  const { master, agg } = result;
  const s = master.summary;

  // A. トリップ数 = pickup_count 合計
  if (s.total_pickups + s.trips_without_restaurant !== s.total_trips) errors.push(`A: トリップ数 ${s.total_trips} ≠ pickup合計 ${s.total_pickups}（店名なし ${s.trips_without_restaurant}）`);
  if (s.trips_without_restaurant) warnings.push(`A: 店名なしトリップ ${s.trips_without_restaurant} 件`);

  // B. 正規化前後で件数が減っていない（生の店名ごとの件数合計 = 店舗ごとの original_name_counts 合計）
  let raw = 0;
  PickupStores.listDeliveries(dailyLogs).forEach(({ delivery }) => { if (delivery.restaurant && String(delivery.restaurant).trim()) raw++; });
  if (raw !== s.total_pickups) errors.push(`B: 正規化前 ${raw} 件 ≠ 正規化後 ${s.total_pickups} 件`);

  // C. 同一照合キーが複数店舗に登録されていない / 重複の疑い
  const keyOwner = new Map();
  master.stores.forEach(st => st.name_keys.forEach(k => {
    if (keyOwner.has(k)) errors.push(`C: 照合キー「${k}」が ${keyOwner.get(k)} と ${st.canonical_name} の両方に登録`);
    keyOwner.set(k, st.canonical_name);
  }));
  const ids = new Set();
  master.stores.forEach(st => { if (ids.has(st.id)) errors.push(`C: ID重複 ${st.id}`); ids.add(st.id); });
  // 片方のキーがもう片方を含む店舗は重複の疑い（例: 「ガスト」と「ガスト港弁天町店」）→ 警告のみ（自動統合はしない）
  const flat = master.stores.map(st => ({ st, key: st.name_keys[0] }));
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const a = flat[i].key, b = flat[j].key;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) warnings.push(`C: 重複の疑い「${flat[i].st.canonical_name}」⇔「${flat[j].st.canonical_name}」（証拠がないため別店舗のまま）`);
  }

  // D. 別店舗の誤統合チェック: 1店舗に集約した表記を一覧化（検証ログで目視）
  // E/F. 座標チェック
  const coordGroups = new Map();
  master.stores.forEach(st => {
    if (st.coordinate_status !== 'confirmed') {
      if (st.latitude != null || st.longitude != null) errors.push(`E: 要確認の「${st.canonical_name}」に座標が入っている`);
      return;
    }
    if (!st.address) errors.push(`E: 座標確認済みの「${st.canonical_name}」に住所がない`);
    const { latitude: lat, longitude: lng } = st;
    if (typeof lat !== 'number' || typeof lng !== 'number') { errors.push(`E: 「${st.canonical_name}」の座標が数値でない`); return; }
    const b = OSAKA_CITY_BBOX;
    if (lat < b.south || lat > b.north || lng < b.west || lng > b.east) errors.push(`F: 「${st.canonical_name}」の座標 ${lat},${lng} が大阪市の範囲外`);
    const rev = st.geocode_check && st.geocode_check.reverse;
    if (!rev) warnings.push(`E: 「${st.canonical_name}」は逆ジオコード確認が未実施（--verify-geo で確認）`);
    else {
      const m = reverseMatchesAddress(st.address, rev);
      if (!m.ok) errors.push(`E: 「${st.canonical_name}」座標と住所が不一致: ${m.reason}`);
    }
    const ck = lat.toFixed(5) + ',' + lng.toFixed(5);
    if (!coordGroups.has(ck)) coordGroups.set(ck, []);
    coordGroups.get(ck).push(st);
  });
  coordGroups.forEach(list => {
    if (list.length < 2) return;
    const buildings = new Set(list.map(x => x.same_building || ''));
    if (buildings.size !== 1 || buildings.has('')) warnings.push(`E: 同一座標の店舗に same_building 未設定: ${list.map(x => x.canonical_name).join(' / ')}`);
  });

  // 未登録店舗
  result.added.forEach(a => warnings.push(`新店舗: 「${a.canonical_name}」${a.pickup_count}回（needs_review で追加）`));
  if (agg.unregistered.length && !result.added.length) errors.push('未登録店舗の追加に失敗');
  return { errors, warnings };
}

function writeOutputs(master, points) {
  const json = JSON.stringify(master, null, 2) + '\n';
  fs.writeFileSync(MASTER_JSON, json);
  const bundle = [
    '// 自動生成ファイル（tools/pickup-map/build-stores.js）。直接編集しないこと。',
    '// 正本: data/uber_pickup_stores.json（店舗マスタ）/ data/uber_map_points.json（重要地点）',
    'window.UBER_PICKUP_STORE_MASTER = ' + JSON.stringify(master) + ';',
    'window.UBER_MAP_POINTS = ' + JSON.stringify(points) + ';',
    ''
  ].join('\n');
  fs.writeFileSync(BUNDLE_JS, bundle);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const master = JSON.parse(fs.readFileSync(MASTER_JSON, 'utf8'));
  const points = JSON.parse(fs.readFileSync(POINTS_JSON, 'utf8'));
  const dailyLogs = loadSeedLogs();

  if (args.has('--verify-geo')) {
    const queue = master.stores.filter(st => st.coordinate_status === 'confirmed');
    const worker = async () => {
      for (let st = queue.shift(); st; st = queue.shift()) {
        const rev = await fetchReverse(st.latitude, st.longitude);
        if (!rev) { console.log(`  ! 逆ジオコード失敗: ${st.canonical_name}`); continue; }
        st.geocode_check = Object.assign({}, st.geocode_check, { reverse: { muniCd: rev.muniCd, lv01Nm: rev.lv01Nm } });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const p of points.points) {
      const rev = await fetchReverse(p.latitude, p.longitude);
      console.log(`  地点 ${p.name}: ${rev ? (OSAKA_WARD_CODES[rev.muniCd] || rev.muniCd) + ' ' + rev.lv01Nm : '取得失敗'}`);
    }
  }

  const result = rebuild(master, dailyLogs);
  const { errors, warnings } = validate(result, dailyLogs);
  const s = result.master.summary;

  console.log('=== ピックアップ店舗マスタ 検証 ===');
  console.log(`期間: ${s.period.from} 〜 ${s.period.to}（${s.period.days}日）`);
  console.log(`A 総トリップ ${s.total_trips} / pickup合計 ${s.total_pickups}`);
  console.log(`店舗数 ${s.store_count}（座標確認済み ${s.confirmed_count} / 要確認 ${s.needs_review_count}）`);
  console.log('上位10店舗:');
  result.master.stores.slice(0, 10).forEach((st, i) => console.log(`  ${i + 1}. ${st.canonical_name} ${st.pickup_count}回`));
  if (args.has('--verbose')) {
    console.log('D 表記統合一覧（複数表記を1店舗に集約したもの）:');
    result.master.stores.filter(st => st.original_names.length > 1).forEach(st => console.log(`  ${st.canonical_name} ← ${st.original_names.join(' | ')}`));
  }
  warnings.forEach(w => console.log('WARN ' + w));
  errors.forEach(e => console.log('ERROR ' + e));

  if (args.has('--check')) {
    const current = fs.readFileSync(MASTER_JSON, 'utf8');
    const next = JSON.stringify(result.master, null, 2) + '\n';
    if (current !== next) { console.log('ERROR data/uber_pickup_stores.json が最新の store.js と不一致（build-stores.js を実行）'); process.exit(1); }
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length) { console.log('検証エラーのため書き出しを中止'); process.exit(1); }
  writeOutputs(result.master, points);
  console.log('書き出し: data/uber_pickup_stores.json, data/uber_pickup_stores.js');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { rebuild, validate, categorize, parseOsakaAddress, reverseMatchesAddress, OSAKA_WARD_CODES };
