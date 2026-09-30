/**
 * UBER_LOG ピックアップ店舗マップ
 * - 集計: js/store.js の CONFIRMED_SEED_DATA を js/pickup-stores.js で店舗マスタと照合（開くたびに再集計）
 * - 座標: data/uber_pickup_stores.js（店舗マスタ）に固定保存された値だけを使う。外部ジオコーディングはしない。
 */
(function () {
  'use strict';

  const master = window.UBER_PICKUP_STORE_MASTER;
  const mapPoints = window.UBER_MAP_POINTS || { points: [], routes: [], point_types: {}, route_types: {} };
  const PS = window.PickupStores;

  const WEST_OSAKA_CENTER = [34.6765, 135.4735];
  const TIER_STYLE = {
    high: { color: '#ef4444', size: 46, label: '10回以上' },
    mid: { color: '#f97316', size: 36, label: '5〜9回' },
    low: { color: '#3b82f6', size: 26, label: '1〜4回' }
  };
  const CATEGORY_ORDER = ['mcdonalds', 'convenience', 'gyudon_teishoku', 'cafe', 'fastfood', 'drug_super', 'other'];
  const STATUS_LABEL = { confirmed: '座標確認済み', needs_review: '要確認', unknown: '未登録' };
  const EVIDENCE_LABEL = { official: '公式店舗情報', map_directory: '地図・店舗情報サイト', delivery_listing: 'デリバリー掲載情報' };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

  const state = { tier: 'all', category: 'all', query: '', selectedId: null };
  let map, storeLayer, pointLayer;
  const markers = new Map();

  function showAlert(html, info) {
    const el = $('pm-alert');
    el.innerHTML = html;
    el.classList.toggle('info', !!info);
    el.hidden = false;
  }

  function formatStamp(stamp) {
    if (!stamp) return '—';
    const [d, t] = stamp.split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const wd = '日月火水木金土'[new Date(y, mo - 1, da).getDay()];
    return `${y}/${String(mo).padStart(2, '0')}/${String(da).padStart(2, '0')}（${wd}）` + (t ? ' ' + t : '');
  }

  // ---- データ準備 ----
  function buildData() {
    const logs = getConfirmedSeedData().dailyLogs;
    const agg = PS.aggregatePickups(logs, master);
    const stores = agg.stores.concat(agg.unregistered).map(s => Object.assign(s, {
      tier: PS.pickupTier(s.pickup_count),
      hasCoord: s.coordinate_status === 'confirmed' && typeof s.latitude === 'number' && typeof s.longitude === 'number',
      search: fold([s.canonical_name, s.address, s.same_building].concat(s.original_names || []).join(' '))
    }));
    stores.sort((a, b) => b.pickup_count - a.pickup_count || a.canonical_name.localeCompare(b.canonical_name, 'ja'));
    // 同順位（同じ回数）は同じ順位番号
    let rank = 0, prev = null;
    stores.forEach((s, i) => { if (s.pickup_count !== prev) { rank = i + 1; prev = s.pickup_count; } s.rank = rank; });
    const dates = Object.keys(logs).sort();
    return { agg, stores, period: { from: dates[0], to: dates[dates.length - 1] } };
  }

  // 同じ建物（同一座標）の店舗は表示位置だけ円周上に少しずらす（保存座標は変えない）
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
    const fs = store.tier === 'low' ? 10 : store.tier === 'mid' ? 12 : 15;
    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 51c0 0 18-19.5 18-32A18 18 0 0 0 2 19c0 12.5 18 32 18 32z" fill="${st.color}" stroke="#fff" stroke-width="2.5"/>
      <text x="20" y="${store.pickup_count >= 10 ? 25.5 : 25}" text-anchor="middle" class="pm-pin-label" style="font-size:${fs * (40 / w)}px">${store.pickup_count}</text>
    </svg>`;
    return L.divIcon({ className: 'pm-pin', html: svg, iconSize: [w, h], iconAnchor: [w / 2, h], popupAnchor: [0, -h + 4] });
  }

  function popupHtml(s) {
    const cat = (master.category_labels || {})[s.category] || 'その他';
    const names = (s.original_names || []).map(n => `<li>${esc(n)}（${s.original_name_counts ? s.original_name_counts[n] : ''}回）</li>`).join('');
    const evidence = EVIDENCE_LABEL[s.address_evidence] || '';
    return `<div class="pm-pop">
      <p class="pm-pop-name">${esc(s.canonical_name)}</p>
      <span class="pm-pop-count tier-${s.tier}">${s.pickup_count}回 ピックアップ</span>
      <dl>
        <dt>住所</dt><dd>${esc(s.address || '未登録')}</dd>
        <dt>初回</dt><dd>${esc(formatStamp(s.first_pickup))}</dd>
        <dt>最終</dt><dd>${esc(formatStamp(s.last_pickup))}</dd>
        <dt>稼働日数</dt><dd>${s.active_days}日</dd>
        <dt>カテゴリ</dt><dd>${esc(cat)}</dd>
        <dt>座標</dt><dd>${esc(STATUS_LABEL[s.coordinate_status] || s.coordinate_status)}</dd>
      </dl>
      ${s.same_building ? `<div class="pm-pop-note">同一建物: ${esc(s.same_building)}${s.displayShifted ? '（重なり回避のため表示位置のみ少しずらしています）' : ''}</div>` : ''}
      <details><summary>根拠・Uber上の表記</summary>
        <div>住所の根拠: ${esc(s.address_source || '—')}${evidence ? `（${esc(evidence)}）` : ''}</div>
        <div>座標の根拠: ${esc(s.coordinate_source || '—')}</div>
        <div>Uber上の表記:</div><ul>${names}</ul>
      </details>
    </div>`;
  }

  // ---- 地図 ----
  function initMap() {
    map = L.map('pm-map', { zoomControl: true, preferCanvas: false });
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
    // 九条〜西九条〜弁天町を中心に大阪西部を初期表示
    map.setView(WEST_OSAKA_CENTER, window.matchMedia('(max-width: 820px)').matches ? 13 : 14);
    storeLayer = L.layerGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);
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
      const m = L.marker(pos.get(s.id), { icon: pinIcon(s), title: `${s.canonical_name}（${s.pickup_count}回）`, zIndexOffset: s.pickup_count * 10, riseOnHover: true });
      m.bindPopup(popupHtml(s), { maxWidth: 320 });
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
  }

  function renderRanking(list) {
    const ol = $('pm-ranking');
    $('pm-rank-count').textContent = `${list.length}店舗 / ${list.reduce((a, s) => a + s.pickup_count, 0)}回`;
    if (!list.length) { ol.innerHTML = '<li class="pm-empty">該当する店舗はありません</li>'; return; }
    ol.innerHTML = list.map(s => `<li class="pm-rank-item${s.hasCoord ? '' : ' no-coord'}${s.id === state.selectedId ? ' selected' : ''}" data-id="${esc(s.id)}" tabindex="0" role="button">
        <span class="pm-rank-no">${s.rank}位</span>
        <span class="pm-rank-name">${esc(s.canonical_name)}${s.hasCoord ? '' : '<span class="pm-badge-review">要確認</span>'}
          <span class="pm-rank-sub">${esc(s.address || s.notes || '住所未登録')}</span></span>
        <span class="pm-rank-count tier-${s.tier}">${s.pickup_count}</span>
      </li>`).join('');
  }

  function selectInList(id) {
    state.selectedId = id;
    document.querySelectorAll('.pm-rank-item.selected').forEach(el => el.classList.remove('selected'));
    const el = document.querySelector(`.pm-rank-item[data-id="${CSS.escape(id)}"]`);
    if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }
  }

  function focusStore(data, id) {
    const s = data.stores.find(x => x.id === id);
    if (!s) return;
    if (!s.hasCoord) {
      const d = $('pm-review'); d.open = true;
      const li = document.querySelector(`#pm-review-list li[data-id="${CSS.escape(id)}"]`);
      if (li) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const m = markers.get(id);
    if (!storeLayer.hasLayer(m)) storeLayer.addLayer(m);
    if (window.matchMedia('(max-width: 820px)').matches) $('pm-map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    let opened = false;
    const open = () => { if (opened) return; opened = true; map.off('moveend', open); m.openPopup(); };
    map.once('moveend', open);
    setTimeout(open, 900); // アニメーションが走らない環境向けの保険
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
    selectInList(id);
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
    $('pm-review-list').innerHTML = review.length ? review.map(x => `<li data-id="${esc(x.id)}"><b>${esc(x.canonical_name)}</b> ${x.pickup_count}回
      <small>${esc(x.notes || (x.unregistered ? '店舗マスタ未登録の新しい店名（tools/pickup-map/build-stores.js で登録）' : '座標未確定'))}</small>
      <small>Uber上の表記: ${esc((x.original_names || []).join(' / '))}</small></li>`).join('') : '<li>なし</li>';
    $('pm-footer').innerHTML = `<b>${data.agg.totalPickups}</b> pickups / <b>${s.length}</b> stores ・ ${esc(data.period.from)}〜${esc(data.period.to)} ・ 座標確認済み ${confirmed.length} / 要確認 ${review.length}`;
  }

  function renderCategoryChips(data) {
    const labels = master.category_labels || {};
    const present = new Set(data.stores.map(s => s.category));
    const chips = ['all'].concat(CATEGORY_ORDER.filter(c => present.has(c)));
    $('pm-cat-filter').innerHTML = chips.map(c => `<button type="button" class="pm-chip${c === 'all' ? ' active' : ''}" data-cat="${c}">${esc(c === 'all' ? 'すべて' : labels[c] || c)}</button>`).join('');
  }

  function bindUi(data) {
    $('pm-search').addEventListener('input', e => { state.query = fold(e.target.value); applyFilters(data); });
    $('pm-search').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = data.stores.find(matches);
      if (first) focusStore(data, first.id);
    });
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
    $('pm-panel-toggle').addEventListener('click', () => {
      const app = document.querySelector('.pm-app');
      const collapsed = app.classList.toggle('panel-collapsed');
      $('pm-panel-toggle').setAttribute('aria-expanded', String(!collapsed));
    });
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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
