/**
 * 地図の「◎ 現在地」ボタン（配達マップ・ルート判断マップ共通）
 * - 押したときだけ位置を1回取得（常時追跡しない＝バッテリー消費を増やさない）
 * - 拒否・失敗してもメッセージを出すだけで、地図はそのまま使える
 *
 *   MapLocate.addLocateControl(map, {
 *     id: 'pm-locate', layer: L.layerGroup().addTo(map), toast: msg => ...,
 *     onLocated: ({ lat, lng, accuracy }) => ...   // 任意
 *   });
 */
(function (root) {
  'use strict';

  function locateOnce(map, btn, opts) {
    const toast = opts.toast || function () {};
    if (!('geolocation' in navigator)) { toast('この端末では現在地を取得できません'); return; }
    if (window.isSecureContext === false) { toast('現在地は公開版（https）で開いたときに使えます'); return; }
    btn.classList.add('busy');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      btn.classList.remove('busy');
      btn.disabled = false;
      const ll = [pos.coords.latitude, pos.coords.longitude];
      const acc = Math.round(pos.coords.accuracy || 0);
      const layer = opts.layer;
      layer.clearLayers();
      if (acc > 0) L.circle(ll, { radius: acc, color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false }).addTo(layer);
      L.marker(ll, { icon: L.divIcon({ className: 'pm-here-dot', html: '<div></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(layer);
      if (opts.flyTo !== false) map.flyTo(ll, Math.max(map.getZoom(), opts.minZoom || 16), { duration: 0.6 });
      toast(`現在地を表示しました（誤差 約${acc}m）`, 2500);
      if (typeof opts.onLocated === 'function') opts.onLocated({ lat: ll[0], lng: ll[1], accuracy: acc, at: new Date().toISOString() });
    }, err => {
      btn.classList.remove('busy');
      btn.disabled = false;
      const msg = err && err.code === 1 ? '位置情報の利用が許可されていません（地図はそのまま使えます）'
        : err && err.code === 3 ? '現在地の取得がタイムアウトしました。もう一度押してください'
          : '現在地を取得できませんでした';
      toast(msg, 4500);
      if (typeof opts.onError === 'function') opts.onError(err);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function addLocateControl(map, opts) {
    opts = opts || {};
    const Locate = L.Control.extend({
      options: { position: opts.position || 'topleft' },
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('button', 'pm-locate-btn', wrap);
        btn.type = 'button';
        btn.id = opts.id || 'pm-locate';
        btn.title = '現在地を表示';
        btn.setAttribute('aria-label', '現在地を表示');
        btn.textContent = '◎';
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(btn, 'click', () => locateOnce(map, btn, opts));
        return wrap;
      }
    });
    const control = new Locate();
    control.addTo(map);
    return control;
  }

  root.MapLocate = { addLocateControl };
})(typeof window !== 'undefined' ? window : globalThis);
