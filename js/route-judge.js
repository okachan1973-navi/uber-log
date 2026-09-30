/**
 * UBER_LOG ルート判断マップ
 * 案件（現在地 → PICK → DROP）が安治川を越えるか、越えるならどの横断ポイント（トンネル／大橋／渡船／上流回り）が
 * 近いかを地図上で確認する。計算は js/route-judge-core.js、地理データは data/uber_route_geo.json。
 * 距離は直線の目安。道路の経路計算はしない。
 */
(function () {
  'use strict';

  const RJ = window.RouteJudge;
  const geo = window.UBER_ROUTE_GEO;
  const master = window.UBER_PICKUP_STORE_MASTER;
  const STORAGE_KEY = 'uber_route_judge_job_v1';
  // 九条・西九条・弁天町・安治川・此花区方面が入る範囲
  const INITIAL_BOUNDS = [[34.6645, 135.4485], [34.6905, 135.4865]];
  const POINT_LABEL = { current: '現在地', pick: 'PICK', drop: 'DROP' };
  const SIDE_SHORT = { north: '北岸', south: '南岸' };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const km = m => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm');
  const fold = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

  let map, hereLayer, jobLayer;
  let mode = 'pick';
  let job = loadJob();
  const markers = {};

  function loadJob() {
    try {
      const j = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (j && j.schema === 'uber_route_job/1') return j;
    } catch (e) { /* 保存できない環境でも動く */ }
    return RJ.createJob();
  }
  function saveJob() {
    job.updated_at = new Date().toISOString();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(job)); } catch (e) { /* noop */ }
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('rj-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3000);
  }

  // ---- 地図と固定レイヤー ----
  function initMap() {
    map = L.map('rj-map', { zoomControl: true, zoomSnap: 0.5 });
    const std = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' });
    const pale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' });
    pale.addTo(map); // 淡色地図のほうが川・横断ポイント・案件の線が目立つ
    L.control.layers({ '地理院 淡色地図': pale, '地理院 標準地図': std, 'OpenStreetMap': osm }, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
    hereLayer = L.layerGroup().addTo(map);
    window.MapLocate.addLocateControl(map, {
      id: 'rj-locate', layer: hereLayer, toast, minZoom: 15,
      onLocated: p => { job.current = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at, source: 'geolocation' }; saveJob(); refresh(); }
    });
    map.fitBounds(INITIAL_BOUNDS);
    const syncZoomClass = () => map.getContainer().classList.toggle('rj-zoom-low', map.getZoom() < 15);
    map.on('zoomend', syncZoomClass);
    syncZoomClass();
    drawGeo();
    jobLayer = L.layerGroup().addTo(map);
    map.on('click', e => placePoint(mode, e.latlng.lat, e.latlng.lng, 'map'));
  }

  const ll = p => [p[0], p[1]];

  function drawGeo() {
    const g = L.layerGroup().addTo(map);
    geo.rivers.forEach(r => {
      L.polyline(r.divide_line.map(ll), { color: '#22d3ee', weight: 10, opacity: 0.35, interactive: false }).addTo(g);
      L.polyline(r.divide_line.map(ll), { color: '#0891b2', weight: 2, opacity: 0.9, dashArray: '2 6', interactive: false }).addTo(g);
    });
    geo.crossings.forEach(c => {
      if (c.type === 'tunnel') drawTunnel(c, g);
      else if (c.type === 'bridge') drawBridge(c, g);
      else drawReference(c, g);
    });
  }

  function crossingPopup(c) {
    const sides = ['south', 'north'].map(s => `<div>・${esc(c.entrances[s].label)}：${esc(c.entrances[s].area)}</div>`).join('');
    return `<div class="rj-pop"><h3>${esc(c.name)}</h3>${c.warning ? `<div class="warnline">${esc(c.warning)}</div>` : ''}
      <div>${esc(c.summary)}</div>${sides}<small>${esc(c.bike && c.bike.note || '')}</small></div>`;
  }

  // 横断ポイントの入口ラベル（寄ったときだけ表示。引いた地図では重なって PICK/DROP を隠すため）
  function label(marker, text, dir) {
    marker.bindTooltip(text, { permanent: true, direction: dir || 'right', offset: [14, 0], className: 'rj-label rj-xlabel' });
    return marker;
  }

  function drawTunnel(c, g) {
    L.polyline(c.path.map(ll), { color: '#6366f1', weight: 6, dashArray: '6 6', opacity: 0.95 }).bindPopup(crossingPopup(c)).addTo(g);
    ['south', 'north'].forEach(s => {
      const e = c.entrances[s];
      const m = L.marker([e.latitude, e.longitude], {
        icon: L.divIcon({ className: 'rj-xicon tunnel', html: '<div>T</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        title: `${c.name} ${e.label}`, zIndexOffset: 800
      }).bindPopup(crossingPopup(c)).addTo(g);
      label(m, `トンネル${e.label.replace(/（.*）/, '')}`, s === 'north' ? 'left' : 'right');
    });
  }

  function drawBridge(c, g) {
    L.polyline(c.road_path.map(ll), { color: '#9ca3af', weight: 4, opacity: 0.6, interactive: false }).addTo(g);
    L.polyline(c.path.map(ll), { color: '#f97316', weight: 8, opacity: 0.95 }).bindPopup(crossingPopup(c)).addTo(g);
    c.stairs.forEach(st => L.polyline(st.path.map(ll), { color: '#dc2626', weight: 8, opacity: 1 }).bindPopup(crossingPopup(c)).addTo(g));
    ['south', 'north'].forEach(s => {
      const e = c.entrances[s];
      const m = L.marker([e.latitude, e.longitude], {
        icon: L.divIcon({ className: 'rj-xicon stairs', html: '<div>階</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: `${c.name} ${e.label}`, zIndexOffset: 800
      }).bindPopup(crossingPopup(c)).addTo(g);
      label(m, `大橋 ${s === 'south' ? '南' : '北'}階段`, 'left');
    });
    // 橋の中央に「⚠ 押し歩き」
    const a = c.path[0], b = c.path[c.path.length - 1];
    L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
      icon: L.divIcon({ className: 'rj-warnicon', html: '<div>⚠ 押し歩き</div>', iconSize: [0, 0] }),
      title: c.warning, zIndexOffset: 900
    }).bindPopup(crossingPopup(c)).addTo(g);
  }

  function drawReference(c, g) {
    L.polyline(c.path.map(ll), { color: '#6b7280', weight: 4, dashArray: '4 6', opacity: 0.9 }).bindPopup(crossingPopup(c)).addTo(g);
    ['south', 'north'].forEach(s => {
      const e = c.entrances[s];
      L.marker([e.latitude, e.longitude], {
        icon: L.divIcon({ className: 'rj-xicon ref', html: `<div>${c.type === 'ferry' ? '船' : '橋'}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: `${c.name}（参考） ${e.label}`, zIndexOffset: 500
      }).bindPopup(crossingPopup(c)).addTo(g);
    });
  }

  // ---- PICK / DROP ----
  function pinIcon(kind) {
    return L.divIcon({ className: `rj-pin ${kind}`, html: `<div class="pin"><span>${kind === 'pick' ? 'P' : 'D'}</span></div>`, iconSize: [34, 34], iconAnchor: [4, 46], popupAnchor: [13, -44] });
  }

  function placePoint(kind, lat, lng, source, extra) {
    if (kind !== 'pick' && kind !== 'drop') return;
    job[kind] = Object.assign({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), source }, extra || {});
    saveJob();
    if (kind === 'pick' && !job.drop) setMode('drop');
    else if (kind === 'drop') setMode(null);
    refresh();
  }

  function setMode(m) {
    mode = m;
    if (map) map.getContainer().classList.toggle('rj-placing', !!m);
    document.querySelectorAll('.rj-mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('rj-hint').textContent = m === 'pick' ? '地図をタップして PICK（ピックアップ地点）を置く'
      : m === 'drop' ? '地図をタップして DROP（配達先）を置く'
        : 'PICK・DROP はドラッグで調整できます。置き直すときは上のボタンを押してから地図をタップ';
  }

  function renderJobLayer(result) {
    jobLayer.clearLayers();
    ['pick', 'drop'].forEach(k => {
      if (!job[k]) { delete markers[k]; return; }
      const m = L.marker([job[k].lat, job[k].lng], { icon: pinIcon(k), draggable: true, zIndexOffset: 1500, title: POINT_LABEL[k] }).addTo(jobLayer);
      if (job[k].label) m.bindTooltip(`${POINT_LABEL[k]} ${job[k].label}`, { permanent: true, direction: 'top', offset: [14, -46], className: 'rj-label' });
      m.on('dragend', () => { const p = m.getLatLng(); job[k] = { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), source: 'drag' }; saveJob(); refresh(); });
      markers[k] = m;
    });
    // 区間ごとの線（直線）と、横断する区間は最短の横断ポイント経由の目安線
    result.legs.forEach(leg => {
      const a = job[leg.from], b = job[leg.to];
      const color = leg.from === 'current' ? '#2563eb' : '#db2777';
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color, weight: 3, opacity: 0.7, dashArray: '8 8', interactive: false }).addTo(jobLayer);
      if (leg.crosses && leg.best) {
        L.polyline([[a.lat, a.lng], [leg.best.entrance.lat, leg.best.entrance.lng], [leg.best.exit.lat, leg.best.exit.lng], [b.lat, b.lng]],
          { color, weight: 4, opacity: 0.9, interactive: false }).addTo(jobLayer);
      }
    });
  }

  // ---- 判定の表示 ----
  function legLine(leg) {
    const name = `${POINT_LABEL[leg.from]}→${POINT_LABEL[leg.to]}`;
    if (leg.crosses === null) return `<div class="row"><span class="leg">${name}</span><span class="na">判定範囲外（中之島より上流の地点を含む）・直線${km(leg.direct_m)}</span></div>`;
    if (!leg.crosses) return `<div class="row"><span class="leg">${name}</span><span class="ok">安治川 横断なし</span><span>（${SIDE_SHORT[leg.from_side]}どうし・直線${km(leg.direct_m)}）</span></div>`;
    const b = leg.best;
    return `<div class="row"><span class="leg">${name}</span><span class="cross">安治川を横断</span><span>${SIDE_SHORT[leg.from_side]}→${SIDE_SHORT[leg.to_side]}</span></div>
      <div class="row"><span>最短の目安: <b>${esc(b.short)}</b> 約${km(b.total_m)}（直線より+${km(b.detour_m)}）</span>${b.push_walk ? '<span class="rj-warn">⚠ 押し歩きあり</span>' : ''}</div>`;
  }

  function renderVerdict(result) {
    const v = $('rj-verdict');
    if (!job.pick) { v.innerHTML = '<div class="row">PICK を置くと、安治川を越えるかをここに表示します</div>'; return; }
    if (!result.legs.length) { v.innerHTML = `<div class="row">${job.current ? 'DROP' : '◎で現在地、または DROP'} を置くと判定します</div>`; return; }
    v.innerHTML = result.legs.map(legLine).join('');
  }

  function renderLegs(result) {
    const box = $('rj-legs');
    if (!result.legs.length) {
      box.innerHTML = `<div class="rj-card"><h2>判定</h2><div>現在地（◎）・PICK・DROP のうち、続く2地点がそろうと区間ごとに判定します。</div>
        <div class="rj-note">設定中: 現在地 ${job.current ? '✓' : '—'} ／ PICK ${job.pick ? '✓' : '—'} ／ DROP ${job.drop ? '✓' : '—'}</div></div>`;
      return;
    }
    box.innerHTML = result.legs.map(leg => {
      const head = `<div class="rj-leg-title"><span>${POINT_LABEL[leg.from]} → ${POINT_LABEL[leg.to]}</span><span>直線 ${km(leg.direct_m)}</span></div>`;
      if (leg.crosses === null) return `<div class="rj-card">${head}<div class="rj-note">${esc(leg.note)}。安治川の判定対象外です。</div></div>`;
      if (!leg.crosses) return `<div class="rj-card">${head}<div>安治川を越えない（${SIDE_SHORT[leg.from_side]}どうし）</div></div>`;
      const rows = leg.candidates.map((c, i) => `<li class="${i === 0 ? 'best' : ''}"><b>${esc(c.short)}</b><span>約${km(c.total_m)}（+${km(c.detour_m)}）</span>
        <small>${esc(c.entrance.label)} まで${km(c.to_entrance_m)} → 横断${km(c.crossing_m)} → ${esc(c.exit.label)} から${km(c.from_exit_m)}${c.warning ? ` ・<span class="rj-warn">${esc(c.warning)}</span>` : ''}${c.type === 'ferry' || c.type === 'upstream' ? '・参考' : ''}</small></li>`).join('');
      return `<div class="rj-card">${head}<div>安治川を横断：${SIDE_SHORT[leg.from_side]} → ${SIDE_SHORT[leg.to_side]}</div><ul class="rj-cands">${rows}</ul></div>`;
    }).join('') + '<p class="rj-note">距離は直線の目安（入口まで＋横断＋出口から）。実際の道路・信号・待ち時間は含みません。</p>';
  }

  function renderCrossings() {
    $('rj-crossings').innerHTML = geo.crossings.map(c => `<li><button type="button" data-cross="${esc(c.id)}">${esc(c.name)}${c.priority > 1 ? '（参考）' : ''}</button>
      ${c.warning ? `<b class="rj-warn" style="color:#fca5a5">${esc(c.warning)}</b>` : ''}<small>${esc(c.summary)}</small>
      <small>南側: ${esc(c.entrances.south.area)} ／ 北側: ${esc(c.entrances.north.area)}</small></li>`).join('');
    $('rj-crossings').addEventListener('click', e => {
      const b = e.target.closest('[data-cross]'); if (!b) return;
      const c = geo.crossings.find(x => x.id === b.dataset.cross);
      const pts = [c.entrances.south, c.entrances.north].map(p => [p.latitude, p.longitude]);
      $('rj-map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
      map.fitBounds(pts, { padding: [70, 70], maxZoom: 17 });
    });
  }

  function refresh() {
    const result = RJ.analyzeJob(job, geo);
    renderJobLayer(result);
    renderVerdict(result);
    renderLegs(result);
    window.__routeJudge = { map, job, result, geo, markers }; // 自動テスト用
    return result;
  }

  // ---- 店舗から PICK ----
  function bindStorePicker() {
    const stores = ((master && master.stores) || []).filter(s => s.coordinate_status === 'confirmed' && typeof s.latitude === 'number');
    const list = $('rj-store-list');
    const render = q => {
      const f = fold(q);
      const hits = stores.filter(s => !f || fold([s.canonical_name, s.address].concat(s.original_names || []).join(' ')).includes(f))
        .sort((a, b) => b.pickup_count - a.pickup_count).slice(0, 8);
      list.innerHTML = hits.map(s => `<li role="option" data-id="${esc(s.id)}"><span>${esc(s.canonical_name)}<small>${esc(s.address)}</small></span><b>${s.pickup_count}回</b></li>`).join('')
        || '<li>該当なし</li>';
    };
    $('rj-store-toggle').addEventListener('click', () => {
      const box = $('rj-store');
      box.hidden = !box.hidden;
      $('rj-store-toggle').setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) { render($('rj-store-input').value); $('rj-store-input').focus(); }
    });
    $('rj-store-input').addEventListener('input', e => render(e.target.value));
    list.addEventListener('click', e => {
      const li = e.target.closest('[data-id]'); if (!li) return;
      const s = stores.find(x => x.id === li.dataset.id);
      placePoint('pick', s.latitude, s.longitude, 'store', { label: s.canonical_name, store_id: s.id });
      $('rj-store').hidden = true;
      $('rj-store-toggle').setAttribute('aria-expanded', 'false');
      $('rj-store-input').blur();
      map.setView([s.latitude, s.longitude], Math.max(map.getZoom(), 15));
    });
  }

  function bindUi() {
    document.querySelectorAll('.rj-mode').forEach(b => b.addEventListener('click', () => setMode(mode === b.dataset.mode ? null : b.dataset.mode)));
    $('rj-clear').addEventListener('click', () => {
      job = RJ.createJob({ current: job.current }); // 現在地は残す（取り直しは◎）
      saveJob();
      setMode('pick');
      refresh();
      toast('PICK・DROP をクリアしました', 1800);
    });
    bindStorePicker();
  }

  function init() {
    if (typeof L === 'undefined' || !RJ || !geo) { $('rj-verdict').textContent = '地図または地理データを読み込めませんでした。ネット接続を確認してください。'; return; }
    initMap();
    renderCrossings();
    bindUi();
    setMode(job.pick ? (job.drop ? null : 'drop') : 'pick');
    const r = refresh();
    // 保存済みの案件があれば全体が見える位置へ
    const pts = ['current', 'pick', 'drop'].filter(k => job[k]).map(k => [job[k].lat, job[k].lng]);
    if (pts.length >= 2) map.fitBounds(pts.concat(INITIAL_BOUNDS), { padding: [30, 30] });
    return r;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
