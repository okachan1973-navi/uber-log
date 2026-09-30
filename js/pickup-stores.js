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

  const api = { normalizeDisplayName, restaurantKey, aggregatePickups, pickupTier, listDeliveries, routeDestination, googleMapsBikeUrl, googleMapsAppUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PickupStores = api;
})(typeof window !== 'undefined' ? window : globalThis);
