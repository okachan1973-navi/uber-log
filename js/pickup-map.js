/**
 * UBER_LOG ピックアップ店舗マップ
 * - 集計: js/store.js の CONFIRMED_SEED_DATA を js/pickup-stores.js で店舗マスタと照合（開くたびに再集計）
 * - 座標: data/uber_pickup_stores.js（店舗マスタ）に固定保存された値だけを使う。外部ジオコーディングはしない。
 * - ナビ: 店舗詳細の「🚲 現在地から自転車で行く」で Google Maps（出発地=現在地／目的地=保存済み緯度経度／自転車）を開く。
 *   この地図は実績を見る専用、実際の移動は Google Maps に任せる。
 */
(function () {
  'use strict';

  const master = window.UBER_PICKUP_STORE_MASTER;
  const mapPoints = window.UBER_MAP_POINTS || { points: [], routes: [], point_types: {}, route_types: {} };
  const PS = window.PickupStores;

  const WEST_OSAKA_CENTER = [34.6765, 135.4735];
  const MOBILE_MQ = '(max-width: 820px)';
  // size: ピンの見た目 / hit: タップ領域（見た目より少し広い透明の枠）
  const TIER_STYLE = {
    high: { color: '#ef4444', size: 46, hit: [46, 60], label: '10回以上' },
    mid: { color: '#f97316', size: 36, hit: [42, 50], label: '5〜9回' },
    low: { color: '#3b82f6', size: 26, hit: [38, 42], label: '1〜4回' }
  };
  const CATEGORY_ORDER = ['mcdonalds', 'convenience', 'gyudon_teishoku', 'cafe', 'fastfood', 'drug_super', 'other'];
  const STATUS_LABEL = { confirmed: '座標確認済み', needs_review: '要確認', unknown: '未登録' };
  const EVIDENCE_LABEL = { official: '公式店舗情報', map_directory: '地図・店舗情報サイト', delivery_listing: 'デリバリー掲載情報' };
  const SUGGEST_LIMIT = 8;
  const NO_ROUTE_MESSAGE = '座標未確認のためルート案内できません';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

  const state = { tier: 'all', category: 'all', query: '', selectedId: null, suggestIndex: -1 };
  let map, storeLayer, pointLayer, hereLayer;
  const markers = new Map();

  function showAlert(html, info) {
    const el = $('pm-alert');
    el.innerHTML = html;
    el.classList.toggle('info', !!info);
    el.hidden = false;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('pm-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  function formatStamp(stamp, withTime) {
    if (!stamp) return '—';
    const [d, t] = stamp.split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const wd = '日月火水木金土'[new Date(y, mo - 1, da).getDay()];
    return `${mo}/${da}（${wd}）` + (withTime && t ? ' ' + t : '');
  }

  // ---- データ準備 ----
  function buildData() {
    const logs = getConfirmedSeedData().dailyLogs;
    const agg = PS.aggregatePickups(logs, master);
    const stores = agg.stores.concat(agg.unregistered).map(s => Object.assign(s, {
      tier: PS.pickupTier(s.pickup_count),
      hasCoord: PS.routeDestination(s) !== null,
      routeUrl: PS.googleMapsBikeUrl(s),
      routeAppUrl: PS.googleMapsAppUrl(s),
      search: fold([s.canonical_name, s.address, s.same_building].concat(s.original_names || []).join(' '))
    }));
    stores.sort((a, b) => b.pickup_count - a.pickup_count || a.canonical_name.localeCompare(b.canonical_name, 'ja'));
    // 同順位（同じ回数）は同じ順位番号
    let rank = 0, prev = null;
    stores.forEach((s, i) => { if (s.pickup_count !== prev) { rank = i + 1; prev = s.pickup_count; } s.rank = rank; });
    const dates = Object.keys(logs).sort();
    return { agg, stores, byId: new Map(stores.map(s => [s.id, s])), period: { from: dates[0], to: dates[dates.length - 1] } };
  }

  // 同じ建物（同一座標）の店舗は表示位置だけ円周上に少しずらす（保存座標・ルートの目的地は変えない）
  function displayPositions(stores) {
    const groups = new Map();
    stores.filter(s => s.hasCoord).forEach(s => {
      const k = s.latitude.toFixed(5) + ',' + s.longitude.toFixed(5);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const pos = new Map();
    groups.forEach(list => {
      if (list.length === 1) { pos.set(list[0].id, [list[0].latitude, list[0].longitude]); return; }
      const r = 0.00013; // 約13m
      list.forEach((s, i) => {
        const a = (2 * Math.PI * i) / list.length - Math.PI / 2;
        pos.set(s.id, [s.latitude + r * Math.sin(a), s.longitude + (r * Math.cos(a)) / Math.cos(s.latitude * Math.PI / 180)]);
        s.displayShifted = true;
      });
    });
    return pos;
  }

  function pinIcon(store) {
    const st = TIER_STYLE[store.tier];
    const w = st.size, h = Math.round(st.size * 1.3);
    const [hw, hh] = st.hit;
    const fs = store.tier === 'low' ? 10 : store.tier === 'mid' ? 12 : 15;
    const svg = `<div class="pm-pin-hit"><svg width="${w}" height="${h}" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M20 51c0 0 18-19.5 18-32A18 18 0 0 0 2 19c0 12.5 18 32 18 32z" fill="${st.color}" stroke="#fff" stroke-width="2.5"/>
      <text x="20" y="${store.pickup_count >= 10 ? 25.5 : 25}" text-anchor="middle" class="pm-pin-label" style="font-size:${fs * (40 / w)}px">${store.pickup_count}</text>
    </svg></div>`;
    return L.divIcon({ className: 'pm-pin', html: svg, iconSize: [hw, hh], iconAnchor: [hw / 2, hh], popupAnchor: [0, -h + 4] });
  }

  // ---- ルートボタン ----
  function routeButtonHtml(s) {
    if (!s.routeUrl) return `<div class="pm-route-disabled" role="note">${NO_ROUTE_MESSAGE}</div>`;
    return `<a class="pm-route-btn" href="${esc(s.routeUrl)}" target="_blank" rel="noopener" data-app-url="${esc(s.routeAppUrl)}"
      aria-label="${esc(s.canonical_name)}へ現在地から自転車で行く（Google マップ）">🚲 現在地から自転車で行く</a>`;
  }

  // ホーム画面に追加したアプリ表示（iOS）ではウェブのリンクが Safari の簡易表示で開き Google Maps アプリへ渡らないため、
  // アプリの URL スキームを先に試し、開けなければウェブ版へ切り替える。
  function isIosStandalone() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    return ios && standalone;
  }

  function openRouteWithAppFallback(appUrl, webUrl) {
    let left = false;
    const onLeave = () => { if (document.visibilityState === 'hidden') left = true; };
    const onPageHide = () => { left = true; };
    document.addEventListener('visibilitychange', onLeave);
    window.addEventListener('pagehide', onPageHide);
    window.location.href = appUrl;
    setTimeout(() => {
      document.removeEventListener('visibilitychange', onLeave);
      window.removeEventListener('pagehide', onPageHide);
      if (!left) window.location.href = webUrl; // アプリ未インストール → Google Maps ウェブ版
    }, 1600);
  }

  function onRouteClick(e) {
    const a = e.target.closest('a.pm-route-btn');
    if (!a) return;
    const appUrl = a.getAttribute('data-app-url');
    if (appUrl && isIosStandalone()) {
      e.preventDefault();
      openRouteWithAppFallback(appUrl, a.href);
    }
    // それ以外（PC・Android・iPhone Safari）は通常のリンクとして Google Maps を開く
  }

  // ---- 店舗詳細（地図のポップアップと要確認リストで共通） ----
  function storeDetailHtml(s) {
    const cat = (master.category_labels || {})[s.category] || 'その他';
    const names = (s.original_names || []).map(n => `<li>${esc(n)}（${s.original_name_counts ? s.original_name_counts[n] : ''}回）</li>`).join('');
    const evidence = EVIDENCE_LABEL[s.address_evidence] || '';
    return `<div class="pm-pop" data-store-id="${esc(s.id)}">
      <p class="pm-pop-name">${esc(s.canonical_name)}</p>
      <div class="pm-pop-meta">
        <span class="pm-pop-count tier-${s.tier}">ピックアップ ${s.pickup_count}回</span>
        <span class="pm-pop-cat">${s.rank}位・${esc(cat)}</span>
      </div>
      <div class="pm-pop-addr">${esc(s.address || '住所未登録')}</div>
      ${routeButtonHtml(s)}
      <div class="pm-pop-dates">初回 ${esc(formatStamp(s.first_pickup))} ／ 最終 ${esc(formatStamp(s.last_pickup))}</div>
      ${s.same_building ? `<div class="pm-pop-note">同一建物: ${esc(s.same_building)}${s.displayShifted ? '（重なり回避のため表示位置のみずらしています。ルートは正しい住所へ）' : ''}</div>` : ''}
      ${s.notes && !s.hasCoord ? `<div class="pm-pop-note">${esc(s.notes)}</div>` : ''}
      <details><summary>詳細・根拠</summary>
        <dl>
          <dt>初回</dt><dd>${esc(formatStamp(s.first_pickup, true))}</dd>
          <dt>最終</dt><dd>${esc(formatStamp(s.last_pickup, true))}</dd>
          <dt>稼働日数</dt><dd>${s.active_days}日</dd>
          <dt>座標</dt><dd>${esc(STATUS_LABEL[s.coordinate_status] || s.coordinate_status)}${s.hasCoord ? `（${esc(PS.routeDestination(s))}）` : ''}</dd>
          <dt>住所根拠</dt><dd>${esc(s.address_source || '—')}${evidence ? `（${esc(evidence)}）` : ''}</dd>
          <dt>座標根拠</dt><dd>${esc(s.coordinate_source || '—')}</dd>
        </dl>
        <div>Uber上の表記:</div><ul>${names}</ul>
      </details>
    </div>`;
  }

  function popupSizeOptions() {
    const el = $('pm-map');
    const w = el.clientWidth, h = el.clientHeight;
    return {
      maxWidth: Math.max(200, Math.min(300, w - 56)),
      minWidth: Math.max(180, Math.min(250, w - 56)),
      maxHeight: Math.max(200, h - 70),
      autoPanPadding: [12, 12],
      keepInView: true
    };
  }

  // ---- 地図 ----
  function initMap() {
    map = L.map('pm-map', { zoomControl: true });
    const gsiStd = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
    });
    const gsiPale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
    });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });
    gsiStd.addTo(map);
    L.control.layers({ '地理院 標準地図': gsiStd, '地理院 淡色地図': gsiPale, 'OpenStreetMap': osm }, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
    addLocateControl();
    // 九条〜西九条〜弁天町を中心に大阪西部を初期表示
    map.setView(WEST_OSAKA_CENTER, isMobile() ? 13 : 14);
    storeLayer = L.layerGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);
    hereLayer = L.layerGroup().addTo(map);
    // 画面サイズに合わせてポップアップが画面外に出ないようにする
    // 狭い地図では、開いている間だけ四隅のボタン（ズーム・現在地・レイヤー）を隠して店舗詳細に重ならないようにする
    const container = map.getContainer();
    map.on('popupopen', e => {
      container.classList.toggle('pm-popup-open', container.clientWidth < 600);
      Object.assign(e.popup.options, popupSizeOptions());
      e.popup.update();
    });
    map.on('popupclose', () => container.classList.remove('pm-popup-open'));
  }

  // ---- 現在地（押したときだけ1回取得。常時監視はしない） ----
  function addLocateControl() {
    const Locate = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('button', 'pm-locate-btn', wrap);
        btn.type = 'button';
        btn.id = 'pm-locate';
        btn.title = '現在地を表示';
        btn.setAttribute('aria-label', '現在地を表示');
        btn.textContent = '◎';
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(btn, 'click', () => locateOnce(btn));
        return wrap;
      }
    });
    new Locate().addTo(map);
  }

  function locateOnce(btn) {
    if (!('geolocation' in navigator)) { toast('この端末では現在地を取得できません'); return; }
    if (window.isSecureContext === false) { toast('現在地は公開版（https）で開いたときに使えます'); return; }
    btn.classList.add('busy');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      btn.classList.remove('busy');
      btn.disabled = false;
      const ll = [pos.coords.latitude, pos.coords.longitude];
      const acc = Math.round(pos.coords.accuracy || 0);
      hereLayer.clearLayers();
      if (acc > 0) L.circle(ll, { radius: acc, color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false }).addTo(hereLayer);
      L.marker(ll, { icon: L.divIcon({ className: 'pm-here-dot', html: '<div></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(hereLayer);
      map.flyTo(ll, Math.max(map.getZoom(), 16), { duration: 0.6 });
      toast(`現在地を表示しました（誤差 約${acc}m）`, 2500);
    }, err => {
      btn.classList.remove('busy');
      btn.disabled = false;
      const msg = err && err.code === 1 ? '位置情報の利用が許可されていません（地図はそのまま使えます）'
        : err && err.code === 3 ? '現在地の取得がタイムアウトしました。もう一度押してください'
          : '現在地を取得できませんでした';
      toast(msg, 4500);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function renderPoints() {
    const ptTypes = mapPoints.point_types || {};
    const rtTypes = mapPoints.route_types || {};
    (mapPoints.routes || []).forEach(r => {
      const t = rtTypes[r.type] || {};
      L.polyline(r.coordinates, { color: t.color || '#a855f7', weight: 6, opacity: 0.9, dashArray: t.dash || null })
        .bindPopup(`<div class="pm-pop"><p class="pm-pop-name">${esc(r.name)}</p><div>${esc(r.description || '')}</div><details><summary>根拠</summary>${esc(r.source || '')}</details></div>`)
        .addTo(pointLayer);
    });
    (mapPoints.points || []).forEach(p => {
      const t = ptTypes[p.type] || {};
      const glyph = p.type === 'tunnel' ? 'T' : p.type === 'bridge' ? '橋' : '!';
      const icon = L.divIcon({ className: 'pm-point-icon', html: `<div style="background:${t.color || '#a855f7'}">${glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      L.marker([p.latitude, p.longitude], { icon, zIndexOffset: 2000, title: p.name })
        .bindPopup(`<div class="pm-pop"><p class="pm-pop-name">${esc(p.name)}</p><div>${esc(p.area || '')}</div><div>${esc(p.description || '')}</div><details><summary>根拠</summary>${esc(p.source || '')}</details></div>`)
        .addTo(pointLayer);
    });
  }

  function renderMarkers(stores) {
    const pos = displayPositions(stores);
    stores.filter(s => s.hasCoord).forEach(s => {
      const m = L.marker(pos.get(s.id), { icon: pinIcon(s), title: `${s.canonical_name}（${s.pickup_count}回）`, alt: s.canonical_name, zIndexOffset: s.pickup_count * 10, riseOnHover: true });
      m.bindPopup(storeDetailHtml(s), popupSizeOptions());
      m.on('popupopen', () => selectInList(s.id));
      markers.set(s.id, m);
    });
  }

  // ---- フィルター ----
  function matches(s) {
    if (state.tier !== 'all' && s.tier !== state.tier) return false;
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (state.query && !s.search.includes(state.query)) return false;
    return true;
  }

  function applyFilters(data) {
    storeLayer.clearLayers();
    const visible = data.stores.filter(matches);
    visible.forEach(s => { const m = markers.get(s.id); if (m) storeLayer.addLayer(m); });
    renderRanking(visible);
    return visible;
  }

  function rankRowHtml(s, cls) {
    return `<span class="pm-rank-no">${s.rank}位</span>
        <span class="pm-rank-name">${esc(s.canonical_name)}${s.hasCoord ? '' : '<span class="pm-badge-review">要確認</span>'}
          <span class="pm-rank-sub">${esc(s.address || s.notes || '住所未登録')}</span></span>
        <span class="pm-rank-count tier-${s.tier}">${s.pickup_count}</span>`;
  }

  function renderRanking(list) {
    const ol = $('pm-ranking');
    $('pm-rank-count').textContent = `${list.length}店舗 / ${list.reduce((a, s) => a + s.pickup_count, 0)}回`;
    if (!list.length) { ol.innerHTML = '<li class="pm-empty">該当する店舗はありません</li>'; return; }
    ol.innerHTML = list.map(s => `<li class="pm-rank-item${s.hasCoord ? '' : ' no-coord'}${s.id === state.selectedId ? ' selected' : ''}" data-id="${esc(s.id)}" tabindex="0" role="button">${rankRowHtml(s)}</li>`).join('');
  }

  function selectInList(id) {
    state.selectedId = id;
    document.querySelectorAll('.pm-rank-item.selected').forEach(el => el.classList.remove('selected'));
    const el = document.querySelector(`.pm-rank-item[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.add('selected');
      // スマホではランキングが地図の下にあるので、選択時にページをスクロールさせない
      if (!isMobile()) el.scrollIntoView({ block: 'nearest' });
    }
  }

  /** ランキング・検索・ピンのどこから選んでも同じ店舗詳細を開く */
  function focusStore(data, id) {
    const s = data.byId.get(id);
    if (!s) return;
    if (!s.hasCoord) {
      const d = $('pm-review'); d.open = true;
      const li = document.querySelector(`#pm-review-list li[data-id="${CSS.escape(id)}"]`);
      if (li) {
        li.scrollIntoView({ block: 'center', behavior: 'smooth' });
        li.classList.add('flash');
        setTimeout(() => li.classList.remove('flash'), 1800);
      }
      return;
    }
    const m = markers.get(id);
    if (!storeLayer.hasLayer(m)) storeLayer.addLayer(m);
    if (isMobile()) $('pm-map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    let opened = false;
    const open = () => { if (opened) return; opened = true; map.off('moveend', open); m.openPopup(); };
    map.once('moveend', open);
    setTimeout(open, 900); // アニメーションが走らない環境向けの保険
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
    selectInList(id);
  }

  // ---- 検索候補 ----
  function renderSuggest(data) {
    const ul = $('pm-suggest');
    const input = $('pm-search');
    if (!state.query) { ul.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    const hits = data.stores.filter(matches);
    const shown = hits.slice(0, SUGGEST_LIMIT);
    state.suggestIndex = -1;
    ul.innerHTML = shown.length
      ? shown.map(s => `<li class="pm-suggest-item${s.hasCoord ? '' : ' no-coord'}" role="option" data-id="${esc(s.id)}">
          <span class="pm-suggest-name">${esc(s.canonical_name)}${s.hasCoord ? '' : '<span class="pm-badge-review">要確認</span>'}<span class="pm-suggest-sub">${esc(s.address || s.notes || '住所未登録')}</span></span>
          <span class="pm-rank-count tier-${s.tier}">${s.pickup_count}</span></li>`).join('')
        + (hits.length > shown.length ? `<li class="pm-suggest-more">ほか ${hits.length - shown.length} 店舗（下のランキングにすべて表示）</li>` : '')
      : '<li class="pm-suggest-empty">該当する店舗はありません（回数・カテゴリの絞り込みも確認）</li>';
    ul.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeSuggest() {
    $('pm-suggest').hidden = true;
    $('pm-search').setAttribute('aria-expanded', 'false');
  }

  function pickFromSearch(data, id) {
    closeSuggest();
    $('pm-search').blur(); // スマホのキーボードを閉じて地図を広く見せる
    focusStore(data, id);
  }

  // ---- パネル ----
  function renderStats(data) {
    const s = data.stores;
    const confirmed = s.filter(x => x.hasCoord);
    const review = s.filter(x => !x.hasCoord);
    $('pm-stats').innerHTML = `
      <div class="pm-stat"><b>${data.agg.totalPickups}</b><span>ピックアップ（トリップ ${data.agg.totalTrips}）</span></div>
      <div class="pm-stat"><b>${s.length}</b><span>店舗（正規化後）</span></div>
      <div class="pm-stat"><b>${confirmed.length}</b><span>座標確認済み（${confirmed.reduce((a, x) => a + x.pickup_count, 0)}回）</span></div>
      <div class="pm-stat review"><b>${review.length}</b><span>要確認（${review.reduce((a, x) => a + x.pickup_count, 0)}回）</span></div>`;
    $('pm-review-count').textContent = `${review.length}店舗`;
    // 座標のない店舗も地図ポップアップと同じ店舗詳細UI（ルートボタンは無効表示）
    $('pm-review-list').innerHTML = review.length ? review.map(x => `<li data-id="${esc(x.id)}">${storeDetailHtml(Object.assign({}, x, {
      notes: x.notes || (x.unregistered ? '店舗マスタ未登録の新しい店名（tools/pickup-map/build-stores.js で登録）' : '座標未確定')
    }))}</li>`).join('') : '<li>なし</li>';
    $('pm-footer').innerHTML = `<b>${data.agg.totalPickups}</b> pickups / <b>${s.length}</b> stores ・ ${esc(data.period.from)}〜${esc(data.period.to)} ・ 座標確認済み ${confirmed.length} / 要確認 ${review.length}`;
  }

  function renderCategoryChips(data) {
    const labels = master.category_labels || {};
    const present = new Set(data.stores.map(s => s.category));
    const chips = ['all'].concat(CATEGORY_ORDER.filter(c => present.has(c)));
    $('pm-cat-filter').innerHTML = chips.map(c => `<button type="button" class="pm-chip${c === 'all' ? ' active' : ''}" data-cat="${c}">${esc(c === 'all' ? 'すべて' : labels[c] || c)}</button>`).join('');
  }

  function bindUi(data) {
    const input = $('pm-search');
    const onQuery = () => {
      state.query = fold(input.value);
      $('pm-search-clear').hidden = !input.value;
      applyFilters(data);
      renderSuggest(data);
    };
    input.addEventListener('input', onQuery);
    input.addEventListener('focus', () => { if (state.query) renderSuggest(data); });
    input.addEventListener('keydown', e => {
      const items = [...$('pm-suggest').querySelectorAll('.pm-suggest-item')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        state.suggestIndex = (state.suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('active', i === state.suggestIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = items[state.suggestIndex] || items[0];
        if (target) pickFromSearch(data, target.dataset.id);
      } else if (e.key === 'Escape') {
        closeSuggest();
      }
    });
    $('pm-suggest').addEventListener('click', e => {
      const li = e.target.closest('.pm-suggest-item');
      if (li) pickFromSearch(data, li.dataset.id);
    });
    $('pm-search-clear').addEventListener('click', () => { input.value = ''; onQuery(); input.focus(); });
    document.addEventListener('click', e => { if (!e.target.closest('.pm-search-wrap')) closeSuggest(); });

    $('pm-tier-filter').addEventListener('click', e => {
      const b = e.target.closest('[data-tier]'); if (!b) return;
      state.tier = b.dataset.tier;
      $('pm-tier-filter').querySelectorAll('.pm-chip').forEach(x => x.classList.toggle('active', x === b));
      applyFilters(data);
    });
    $('pm-cat-filter').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      state.category = b.dataset.cat;
      $('pm-cat-filter').querySelectorAll('.pm-chip').forEach(x => x.classList.toggle('active', x === b));
      applyFilters(data);
    });
    const onPick = e => {
      const li = e.target.closest('.pm-rank-item'); if (!li) return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      focusStore(data, li.dataset.id);
    };
    $('pm-ranking').addEventListener('click', onPick);
    $('pm-ranking').addEventListener('keydown', onPick);
    $('pm-layer-stores').addEventListener('change', e => { e.target.checked ? storeLayer.addTo(map) : map.removeLayer(storeLayer); });
    $('pm-layer-points').addEventListener('change', e => { e.target.checked ? pointLayer.addTo(map) : map.removeLayer(pointLayer); });
    $('pm-jump-list').addEventListener('click', () => $('pm-ranking-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    document.addEventListener('click', onRouteClick);

    const syncHeaderHeight = () => document.documentElement.style.setProperty('--pm-header-h', document.querySelector('.pm-header').offsetHeight + 'px');
    syncHeaderHeight();
    window.addEventListener('resize', () => { syncHeaderHeight(); map.invalidateSize(); });
  }

  function init() {
    if (typeof L === 'undefined') { showAlert('地図ライブラリ（Leaflet）を読み込めませんでした。ネット接続を確認してください。'); return; }
    if (!master || !PS || typeof getConfirmedSeedData !== 'function') { showAlert('店舗マスタまたは store.js を読み込めませんでした。'); return; }
    const data = buildData();
    if (data.agg.totalPickups !== data.agg.totalTrips) {
      showAlert(`集計不一致: トリップ ${data.agg.totalTrips} 件に対しピックアップ ${data.agg.totalPickups} 件（店名なし ${data.agg.missingName.length} 件）`);
    } else if (data.agg.unregistered.length) {
      showAlert(`店舗マスタ未登録の新しい店名が ${data.agg.unregistered.length} 件あります（要確認に表示）。<br><code>node tools/pickup-map/build-stores.js</code> で登録してください。`, true);
    }
    initMap();
    renderPoints();
    renderMarkers(data.stores);
    renderCategoryChips(data);
    renderStats(data);
    bindUi(data);
    applyFilters(data);
    window.__pickupMap = { data, map, markers }; // 自動テスト用
  }

  document.addEventListener('DOMContentLoaded', init);
})();
