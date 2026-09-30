/**
 * UBER_LOG ピックアップ店舗 正規化・集計ロジック（ブラウザ / Node 共通）
 *
 * - 店舗名の「照合キー」生成（全角→半角、英語併記の除去、空白除去）
 * - 店舗マスタ（data/uber-pickup-stores.js）の name_keys と照合して店舗単位に集計
 * - マスタに無い照合キーは「未登録店舗（座標なし）」として別枠で返す（推測で既存店舗に統合しない）
 *
 * 店舗名の統合ルール（別表記→同一店舗）は店舗マスタの name_keys にだけ持たせ、
 * ここには特定店舗名をハードコードしない。
 */
(function (root) {
  'use strict';

  // 末尾の英語（ローマ字）併記: "マクドナルド 九条店 McDonald's KUJO" / "スシロー 辰巳橋店 (Sushiro TATSUMIBASHI)"
  const TRAILING_LATIN_PAREN = /\s*\(\s*[A-Za-z][A-Za-z0-9\s'’.&\-\/,]*\)\s*$/;
  const TRAILING_LATIN = /\s+[A-Za-z][A-Za-z0-9\s'’.&\-\/,]*$/;
  const HAS_NON_ASCII = /[^\x00-\x7F]/;

  /** 表示用の正規化名（空白は1つに畳むが残す） */
  function normalizeDisplayName(raw) {
    let s = String(raw == null ? '' : raw).normalize('NFKC');
    s = s.replace(/[　\s]+/g, ' ').trim();
    s = s.replace(/[〜~]/g, '～');
    for (let i = 0; i < 2; i++) {
      const stripped = s.replace(TRAILING_LATIN_PAREN, '').replace(TRAILING_LATIN, '').trim();
      // 英語だけの店名（例: "CoDeLi"）を消し切らないよう、日本語が残る場合だけ採用
      if (stripped && stripped !== s && HAS_NON_ASCII.test(stripped)) s = stripped; else break;
    }
    return s;
  }

  /** 照合キー（空白を完全に除去）。似た名前を統合する処理はしない */
  function restaurantKey(raw) {
    return normalizeDisplayName(raw).replace(/\s+/g, '');
  }

  function buildKeyIndex(master) {
    const index = new Map();
    const stores = (master && master.stores) || [];
    stores.forEach(st => (st.name_keys || []).forEach(k => index.set(k, st)));
    return index;
  }

  function listDeliveries(dailyLogs) {
    const out = [];
    Object.keys(dailyLogs || {}).sort().forEach(date => {
      const log = dailyLogs[date] || {};
      (log.deliveries || []).forEach(d => out.push({ date, time: d.completedAt || '', delivery: d }));
    });
    return out;
  }

  /**
   * dailyLogs（store.js の CONFIRMED_SEED_DATA.dailyLogs 等）を店舗マスタで集計する。
   * 戻り値: { totalTrips, totalPickups, stores:[{...master, pickup_count, first_pickup, last_pickup, original_names}], unregistered:[...], missingName:[...] }
   */
  function aggregatePickups(dailyLogs, master) {
    const index = buildKeyIndex(master);
    const byId = new Map();
    const unregistered = new Map();
    const missingName = [];
    const deliveries = listDeliveries(dailyLogs);
    let totalTrips = 0;
    Object.values(dailyLogs || {}).forEach(l => { totalTrips += Array.isArray(l.deliveries) ? l.deliveries.length : 0; });

    const touch = (bucket, name, date, time) => {
      bucket.pickup_count++;
      const stamp = date + ' ' + time;
      if (!bucket.first_pickup || stamp < bucket.first_pickup) bucket.first_pickup = stamp;
      if (!bucket.last_pickup || stamp > bucket.last_pickup) bucket.last_pickup = stamp;
      bucket._dates.add(date);
      bucket._names[name] = (bucket._names[name] || 0) + 1;
    };

    deliveries.forEach(({ date, time, delivery }) => {
      const raw = delivery.restaurant;
      if (!raw || !String(raw).trim()) { missingName.push({ date, time, id: delivery.id }); return; }
      const key = restaurantKey(raw);
      const st = index.get(key);
      let bucket;
      if (st) {
        bucket = byId.get(st.id);
        if (!bucket) { bucket = Object.assign({}, st, { pickup_count: 0, first_pickup: null, last_pickup: null, _dates: new Set(), _names: {} }); byId.set(st.id, bucket); }
      } else {
        bucket = unregistered.get(key);
        if (!bucket) {
          bucket = { id: 'unregistered:' + key, canonical_name: normalizeDisplayName(raw), name_keys: [key], coordinate_status: 'unknown', address: null, latitude: null, longitude: null, category: 'other', pickup_count: 0, first_pickup: null, last_pickup: null, _dates: new Set(), _names: {}, unregistered: true };
          unregistered.set(key, bucket);
        }
      }
      touch(bucket, String(raw), date, time);
    });

    const finish = b => {
      const out = Object.assign({}, b);
      out.original_names = Object.keys(b._names).sort();
      out.original_name_counts = b._names;
      out.active_days = b._dates.size;
      delete out._dates; delete out._names;
      return out;
    };
    const sorter = (a, b) => b.pickup_count - a.pickup_count || a.canonical_name.localeCompare(b.canonical_name, 'ja');
    const stores = Array.from(byId.values()).map(finish).sort(sorter);
    const unreg = Array.from(unregistered.values()).map(finish).sort(sorter);
    const totalPickups = stores.concat(unreg).reduce((s, x) => s + x.pickup_count, 0);
    return { totalTrips, totalPickups, stores, unregistered: unreg, missingName };
  }

  /** 回数ティア（ピンの色・大きさ） */
  function pickupTier(count) {
    if (count >= 10) return 'high';
    if (count >= 5) return 'mid';
    return 'low';
  }

  // ---- Google Maps 自転車ルート ----
  // 目的地は店名ではなく店舗マスタの保存済み緯度経度（同名店舗への誤誘導防止）。
  // 出発地は指定しない → Google Maps 側が「現在地」を出発地にする。

  /** 座標確認済みで、ルート案内に使える緯度経度を返す（使えなければ null） */
  function routeDestination(store) {
    if (!store || store.coordinate_status !== 'confirmed') return null;
    const lat = store.latitude, lng = store.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
    return lat.toFixed(6) + ',' + lng.toFixed(6);
  }

  /** Google Maps URLs（公式のクロスプラットフォーム形式）。PC・Android・iPhone Safari で使う */
  function googleMapsBikeUrl(store) {
    const dest = routeDestination(store);
    if (!dest) return null;
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest) + '&travelmode=bicycling';
  }

  /** iOS の Google Maps アプリ用 URL スキーム（ホーム画面から開いたアプリ表示時に使う） */
  function googleMapsAppUrl(store) {
    const dest = routeDestination(store);
    if (!dest) return null;
    return 'comgooglemaps://?daddr=' + encodeURIComponent(dest) + '&directionsmode=bicycling';
  }

  // ---- ブランド ----
  // data/uber_brands.json の定義で「店名の先頭がどのブランドか」を判定する。店舗ごとの個別指定はしない。
  const TAGLINE_PREFIX = /^(【[^】]*】)+/; // 「【伝説のクロックムッシュ】サンドイッチ九条店」のような宣伝文句
  const lowerKey = s => restaurantKey(s).toLowerCase();
  // 別名は空白・大小文字の違いだけ吸収（英字だけの別名 "KFC" 等を消さないよう restaurantKey の英語併記除去は使わない）
  const aliasKey = s => String(s || '').normalize('NFKC').replace(/[　\s]+/g, '').toLowerCase();

  /** 店名 → { brand, alias }（最も長く一致した別名を採用。例: ローソンストア100 は ローソン より優先） */
  function resolveBrand(name, brandsDef) {
    const brands = (brandsDef && brandsDef.brands) || [];
    const key = lowerKey(name);
    const candidates = [key, key.replace(TAGLINE_PREFIX, '')];
    let best = null;
    brands.forEach(b => (b.aliases || [b.name]).forEach(a => {
      const ak = aliasKey(a);
      if (!ak || (best && ak.length <= best.aliasKey.length)) return;
      if (candidates.some(c => c.startsWith(ak))) best = { brand: b, alias: a, aliasKey: ak };
    }));
    return best;
  }

  /** 表示名から先頭のブランド別名を取り除いた残り（支店名）。空白・大小文字の違いは無視 */
  function stripAlias(displayName, alias) {
    const disp = normalizeDisplayName(displayName);
    const target = aliasKey(alias);
    let i = 0, j = 0;
    const lead = disp.match(TAGLINE_PREFIX);
    if (lead && !aliasKey(disp).startsWith(target)) i = lead[0].length;
    while (i < disp.length && j < target.length) {
      const c = disp[i].toLowerCase();
      if (/\s/.test(c)) { i++; continue; }
      if (c !== target[j]) return null;
      i++; j++;
    }
    return j === target.length ? disp.slice(i).trim() : null;
  }

  /** ブランドの表記統一（display 指定があるブランドだけ）。例: ケンタッキーフライドチキン ○○店 → KFC ○○店 */
  function brandDisplayName(name, match) {
    if (!match || !match.brand.display) return name;
    const rest = stripAlias(name, match.alias);
    if (rest === null) return name;
    if (!rest) return match.brand.display;
    return /^[（(【]/.test(rest) ? match.brand.display + rest : match.brand.display + ' ' + rest;
  }

  /** 店舗にブランド情報（brand_id / brand_name / brand_reading / branch_name）を付ける */
  function annotateBrand(store, brandsDef) {
    const match = resolveBrand(store.canonical_name, brandsDef);
    const out = Object.assign({}, store);
    if (!match) {
      out.brand_id = null; out.brand_name = null; out.brand_reading = null; out.branch_name = null;
      return out;
    }
    out.canonical_name = brandDisplayName(store.canonical_name, match);
    out.brand_id = match.brand.id;
    out.brand_name = match.brand.name;
    out.brand_reading = match.brand.reading || null;
    out.branch_name = stripAlias(store.canonical_name, match.alias) || '';
    return out;
  }

  // ---- 一覧用の表示 ----
  // canonical_name = 店舗の正式な識別名（検索・集計・店舗詳細・地図で使う。変えない）
  // display_name   = 一覧でブランド見出しの下に出す名前（ブランド名を除いた支店名）
  // address_short  = 一覧用の短い住所（区＋町名）。正式住所 address はそのまま残す

  /** 一覧用の表示名: ブランド店は支店名、ブランドのない店は正式名のまま */
  function listDisplayName(store) {
    if (store && store.brand_id && store.branch_name) return store.branch_name;
    return store ? store.canonical_name : '';
  }

  /** 一覧用の短縮住所: 「大阪府大阪市西区九条1-14-19」→「西区九条」（都道府県・市・丁目・番地・号を省く） */
  function shortAddress(address) {
    if (!address) return '';
    const a = String(address).normalize('NFKC').replace(/\s+/g, '');
    const m = a.match(/(?:.+?[都道府県])?(?:.+?市)?([^市]+?区)(.+?)(?=[0-9]|[一二三四五六七八九十]+丁目|番地|$)/);
    if (!m) return a.replace(/^.+?[都道府県]/, '').replace(/^.+?市/, '').replace(/[0-9-]+.*$/, '');
    return m[1] + m[2].replace(/[（(].*$/, '');
  }

  // ---- 並び順 ----
  const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('ja', { numeric: true, sensitivity: 'base' }) : null;
  const collate = (a, b) => collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);

  /** 名称順の第1キー: ブランドがあればブランドの読み（無ければブランド名）、無ければ宣伝文句を除いた店名 */
  function nameSortKey(store) {
    if (store.brand_id) return store.brand_reading || store.brand_name;
    return normalizeDisplayName(store.canonical_name).replace(TAGLINE_PREFIX, '').replace(/^Uberダイレクト\s*/, '');
  }

  /** 名称順: 同じブランドが必ず連続し、ブランド内は支店名順 */
  function compareByName(a, b) {
    return collate(nameSortKey(a), nameSortKey(b))
      || String(a.brand_id || '').localeCompare(String(b.brand_id || ''))
      || collate(a.branch_name != null && a.brand_id ? a.branch_name : a.canonical_name, b.branch_name != null && b.brand_id ? b.branch_name : b.canonical_name)
      || String(a.id).localeCompare(String(b.id));
  }

  /** 回数順: pickup_count の多い順、同数は名称順 */
  function compareByCount(a, b) {
    return (b.pickup_count || 0) - (a.pickup_count || 0) || compareByName(a, b);
  }

  /** カテゴリの既定の並び順（data/uber_brands.json の default_sort） */
  function defaultSortFor(category, brandsDef) {
    const d = (brandsDef && brandsDef.default_sort) || {};
    return d[category] || d['*'] || 'name';
  }

  // ---- 同一拠点（同じ住所の店舗） ----
  const addressKey = a => String(a || '').normalize('NFKC').replace(/[　\s]+/g, '').replace(/[‐－―ー−]/g, '-');

  /** 住所が完全に一致する店舗のグループ（2店舗以上）。pickup_count は合算しない */
  function groupSites(stores) {
    const map = new Map();
    stores.forEach(s => {
      if (!s.address) return;
      const k = addressKey(s.address);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    });
    return Array.from(map.entries()).filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, stores: list }));
  }

  // ---- 初期表示範囲 ----
  /** 座標確認済み店舗が全部入る範囲（上下左右に少し余白）。[[南, 西], [北, 東]] */
  function confirmedBounds(stores, padRatio) {
    const pts = stores.filter(s => routeDestination(s) !== null);
    if (!pts.length) return null;
    let s = 90, w = 180, n = -90, e = -180;
    pts.forEach(p => { s = Math.min(s, p.latitude); n = Math.max(n, p.latitude); w = Math.min(w, p.longitude); e = Math.max(e, p.longitude); });
    const pad = padRatio == null ? 0.04 : padRatio;
    const dy = (n - s) * pad, dx = (e - w) * pad;
    return [[s - dy, w - dx], [n + dy, e + dx]];
  }

  const api = {
    normalizeDisplayName, restaurantKey, aggregatePickups, pickupTier, listDeliveries, routeDestination, googleMapsBikeUrl, googleMapsAppUrl,
    resolveBrand, brandDisplayName, annotateBrand, listDisplayName, shortAddress, nameSortKey, compareByName, compareByCount, defaultSortFor, addressKey, groupSites, confirmedBounds
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PickupStores = api;
})(typeof window !== 'undefined' ? window : globalThis);
