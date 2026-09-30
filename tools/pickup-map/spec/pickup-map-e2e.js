#!/usr/bin/env node
/**
 * 配達マップのブラウザ実機相当テスト（Microsoft Edge ヘッドレス + DevTools Protocol）
 *   node tools/pickup-map/spec/pickup-map-e2e.js [--shots <dir>]
 *
 * iPhone相当（UA・タッチ・DPR3）で 320/360/390/430px 幅を開き、実際にタップして
 *   検索→候補→店舗詳細→ルート / ランキング→店舗詳細→ルート / ピン直接タップ / 座標なし店舗 /
 *   現在地（許可・拒否） / ホーム画面アプリ表示時の Google Maps アプリ→ウェブ版フォールバック
 * を確認する。地図タイル・Leaflet の読み込みにネット接続が必要。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SIZES = [[320, 568], [360, 740], [390, 844], [430, 932]];
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0, passes = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log(`  ok  ${label}`); }
  else { failures++; console.log(`  NG  ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
}

// ---- 静的サーバー（localhost は secure context なので位置情報APIも動く） ----
function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---- DevTools Protocol ----
async function launchBrowser(profileDir) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=ja', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: 'ignore' });
  let info;
  for (let i = 0; i < 60 && !info; i++) { try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) { await sleep(250); } }
  if (!info) throw new Error('Edge を起動できません: ' + EDGE);
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify(Object.assign({ id: i, method, params }, sessionId ? { sessionId } : {})));
  });
  return { proc, ws, send, on: fn => listeners.push(fn), off: fn => listeners.splice(listeners.indexOf(fn), 1) };
}

async function openPage(b, url, { width, height, standalone = false, geo = 'grant' } = {}) {
  const { browserContextId } = await b.send('Target.createBrowserContext');
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  const origin = new URL(url).origin;
  if (geo === 'grant') {
    await b.send('Browser.grantPermissions', { origin, permissions: ['geolocation'], browserContextId });
    await s('Emulation.setGeolocationOverride', { latitude: 34.67345, longitude: 135.47400, accuracy: 15 });
  } else {
    await b.send('Browser.setPermission', { origin, browserContextId, permission: { name: 'geolocation' }, setting: 'denied' });
  }
  if (standalone) await s('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator, "standalone", { get: () => true });' });
  await s('Page.navigate', { url });
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev('!!(window.__pickupMap && document.querySelectorAll(".leaflet-marker-icon.pm-pin").length)')) break; } catch (e) { /* loading */ } }
  const tap = async (x, y) => {
    await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 6, radiusY: 6 }] });
    await sleep(40);
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const rectOf = async sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  const tapSel = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`); await sleep(350); const r = await rectOf(sel); await tap(r.cx, r.cy); return r; };
  const shot = async name => { if (!SHOTS) return; const { data } = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const close = async () => { await b.send('Target.closeTarget', { targetId }); await b.send('Target.disposeBrowserContext', { browserContextId }); };
  return { s, ev, tap, tapSel, rectOf, shot, close, targetId, browserContextId, sessionId };
}

// 新しいタブで開かれたURLを捕まえる（target=_blank の Google Maps リンク）
function watchNewTab(b, browserContextId) {
  let found = null;
  const fn = m => {
    if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') {
      const t = m.params.targetInfo;
      if (t.type === 'page' && t.browserContextId === browserContextId && /google\.com\/maps/.test(t.url)) found = found || t;
    }
  };
  b.on(fn);
  return { get: () => found, stop: () => b.off(fn) };
}

async function popupState(p) {
  return p.ev(`(() => {
    const pop = document.querySelector('.leaflet-popup');
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const m = document.getElementById('pm-map').getBoundingClientRect();
    const btn = pop.querySelector('.pm-route-btn');
    const br = btn ? btn.getBoundingClientRect() : null;
    // 地図のボタン（ズーム・現在地・レイヤー）が店舗詳細の上に重なっていないか
    const covered = [...document.querySelectorAll('.leaflet-control')].filter(c => {
      if (getComputedStyle(c).visibility === 'hidden') return false;
      const q = c.getBoundingClientRect();
      return q.width > 0 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top && !c.classList.contains('leaflet-control-attribution') && !c.classList.contains('leaflet-control-scale');
    }).map(c => c.className);
    const close = pop.querySelector('.leaflet-popup-close-button').getBoundingClientRect();
    const topAtClose = document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2);
    return {
      covered, closeTappable: !!topAtClose && !!topAtClose.closest('.leaflet-popup-close-button'),
      name: pop.querySelector('.pm-pop-name').textContent,
      id: pop.querySelector('.pm-pop').dataset.storeId,
      inMap: r.left >= m.left - 1 && r.right <= m.right + 1 && r.top >= m.top - 1 && r.bottom <= m.bottom + 1,
      inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      href: btn ? btn.href : null, appUrl: btn ? btn.dataset.appUrl : null,
      btnH: br && br.height, btnW: br && br.width, btnVisible: !!br && br.top >= 0 && br.bottom <= innerHeight,
      btnText: btn ? btn.textContent.trim() : null
    };
  })()`);
}

async function expectedUrl(p, id) {
  return p.ev(`(() => { const s = window.__pickupMap.data.byId.get(${JSON.stringify(id)}); return { url: s.routeUrl, lat: s.latitude, lng: s.longitude, name: s.canonical_name }; })()`);
}

function checkRouteUrl(label, href, exp) {
  let u = null; try { u = new URL(href); } catch (e) { /* */ }
  check(`${label}: Google Maps URL（目的地=保存座標・自転車・出発地=現在地）`,
    !!u && u.hostname === 'www.google.com' && u.pathname === '/maps/dir/' && u.searchParams.get('api') === '1' &&
    u.searchParams.get('travelmode') === 'bicycling' && !u.searchParams.has('origin') &&
    u.searchParams.get('destination') === `${exp.lat.toFixed(6)},${exp.lng.toFixed(6)}`, { href, exp });
}

async function run() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-e2e-'));
  const b = await launchBrowser(profile);
  await b.send('Target.setDiscoverTargets', { discover: true });
  try {
    for (const [w, h] of SIZES) {
      console.log(`\n[${w}x${h} iPhone相当]`);
      const p = await openPage(b, `${base}/pickup-map.html`, { width: w, height: h });

      const layout = await p.ev(`(() => { const m = document.getElementById('pm-map').getBoundingClientRect(); const s = document.querySelector('.pm-input').getBoundingClientRect();
        return { vw: innerWidth, sw: document.documentElement.scrollWidth, mapH: m.height, mapTop: m.top, searchH: s.height, searchFont: getComputedStyle(document.querySelector('.pm-input')).fontSize,
          pins: document.querySelectorAll('.leaflet-marker-icon.pm-pin').length, footer: document.getElementById('pm-footer').textContent,
          locate: document.getElementById('pm-locate').getBoundingClientRect().height, zoomBtn: document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect().height }; })()`);
      check('横スクロールなし', layout.sw <= layout.vw, layout);
      check('地図の高さが画面の50%以上', layout.mapH >= h * 0.5, { mapH: layout.mapH, h });
      check('検索欄が地図の上（スクロールせず届く）', layout.mapTop < h * 0.3 && layout.searchH >= 44, layout);
      check('検索欄の文字16px以上（iPhoneの自動ズーム防止）', parseFloat(layout.searchFont) >= 16, layout.searchFont);
      check('データ状態 189 pickups / 101 stores / 98 / 3', /189 pickups \/ 101 stores.*確認済み 98 \/ 要確認 3/.test(layout.footer) && layout.pins === 98, layout.footer);
      check('◎現在地・ズームボタン 40px以上', layout.locate >= 40 && layout.zoomBtn >= 40, layout);

      // ① 検索 → 候補 → 店舗詳細 → ルート
      await p.tapSel('#pm-search');
      await p.s('Input.insertText', { text: '九条' });
      await sleep(300);
      const sug = await p.ev(`(() => { const ul = document.getElementById('pm-suggest'); const items = [...ul.querySelectorAll('.pm-suggest-item')]; const r = ul.getBoundingClientRect(); return { visible: !ul.hidden, n: items.length, first: items[0] && items[0].textContent.trim().slice(0, 20), itemH: items[0] && items[0].getBoundingClientRect().height, right: r.right, vw: innerWidth }; })()`);
      check('検索「九条」→ 候補リスト表示', sug.visible && sug.n > 0 && /マクドナルド 九条店/.test(sug.first), sug);
      check('候補の行の高さ 48px以上・画面内', sug.itemH >= 48 && sug.right <= sug.vw, sug);
      await p.shot(`${w}_1_search`);
      await p.tapSel('.pm-suggest-item');
      await sleep(1600);
      let pop = await popupState(p);
      check('候補タップ → 地図上で店舗詳細が開く', !!pop && pop.name === 'マクドナルド 九条店', pop);
      check('店舗詳細が地図・画面からはみ出さない', !!pop && pop.inMap && pop.inViewport, pop);
      check('店舗詳細に地図ボタンが重ならず×で閉じられる', !!pop && pop.covered.length === 0 && pop.closeTappable, pop);
      check('ルートボタン: 表示文言・高さ44px以上・画面内', !!pop && pop.btnText === '🚲 現在地から自転車で行く' && pop.btnH >= 44 && pop.btnVisible, pop);
      let exp = await expectedUrl(p, pop.id);
      checkRouteUrl('検索→ルート', pop.href, exp);
      check('検索→ルート: iOSアプリ用URLも同じ座標・自転車', pop.appUrl === `comgooglemaps://?daddr=${encodeURIComponent(exp.lat.toFixed(6) + ',' + exp.lng.toFixed(6))}&directionsmode=bicycling`, pop.appUrl);
      await p.shot(`${w}_2_popup`);
      // ボタンを実際にタップ → 新しいタブで Google Maps が開く
      const tab = watchNewTab(b, p.browserContextId);
      await p.tapSel('.leaflet-popup .pm-route-btn');
      for (let i = 0; i < 20 && !tab.get(); i++) await sleep(250);
      tab.stop();
      const opened = tab.get();
      check('ルートボタンをタップ → Google Maps が開く', !!opened, opened);
      if (opened) { checkRouteUrl('タップで開いたURL', opened.url, exp); await b.send('Target.closeTarget', { targetId: opened.targetId }); }
      check('タップ後も地図ページはそのまま残る', await p.ev('location.pathname') === '/pickup-map.html');

      // ② ランキング → 店舗詳細 → ルート
      await p.ev(`(() => { const i = document.getElementById('pm-search'); i.value = ''; i.dispatchEvent(new Event('input')); i.blur(); document.querySelector('.leaflet-popup-close-button') && document.querySelector('.leaflet-popup-close-button').click(); })()`);
      await sleep(300);
      await p.tapSel('.pm-rank-item:nth-child(2)');
      await sleep(1800);
      pop = await popupState(p);
      const mapTop = await p.ev(`document.getElementById('pm-map').getBoundingClientRect().top`);
      check('ランキング2位タップ → 地図へ戻り店舗詳細が開く', !!pop && pop.name === 'バーガーキング 九条店' && mapTop >= -1 && mapTop < 140, { pop, mapTop });
      check('ランキング→店舗詳細が画面内・ボタン押せる', !!pop && pop.inViewport && pop.btnVisible && pop.btnH >= 44 && pop.covered.length === 0, pop);
      // ×で閉じると地図のボタンが戻る
      await p.tapSel('.leaflet-popup-close-button');
      await sleep(400);
      const back = await p.ev(`({ popup: !!document.querySelector('.leaflet-popup'), zoomVisible: getComputedStyle(document.querySelector('.leaflet-top')).visibility === 'visible' })`);
      check('×で閉じる → 地図のボタンが元に戻る', !back.popup && back.zoomVisible, back);
      if (pop) checkRouteUrl('ランキング→ルート', pop.href, await expectedUrl(p, pop.id));
      await p.shot(`${w}_3_ranking`);

      // ③ ピンを直接タップ（スシロー 辰巳橋店）
      await p.ev(`(() => { const m = window.__pickupMap; m.map.closePopup(); const s = [...m.data.stores].find(x => x.canonical_name === 'スシロー 辰巳橋店'); m.map.setView([s.latitude, s.longitude], 16, { animate: false }); window.__sid = s.id; })()`);
      await sleep(700);
      const pinRect = await p.ev(`(() => { const r = window.__pickupMap.markers.get(window.__sid).getElement().getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height * 0.4, w: r.width, h: r.height }; })()`);
      await p.tap(pinRect.cx, pinRect.cy);
      await sleep(900);
      pop = await popupState(p);
      check('ピンをタップ → 店舗詳細（ルートボタン付き）', !!pop && pop.name === 'スシロー 辰巳橋店' && !!pop.href, { pop, pinRect });
      if (pop) checkRouteUrl('ピン→ルート', pop.href, await expectedUrl(p, pop.id));
      const lowHit = await p.ev(`(() => { const m = window.__pickupMap; const s = m.data.stores.find(x => x.tier === 'low' && x.hasCoord); const e = m.markers.get(s.id).getElement(); const r = e.getBoundingClientRect(); const v = e.querySelector('svg').getBoundingClientRect(); return { hitW: r.width, hitH: r.height, visW: v.width, visH: v.height }; })()`);
      check('1〜4回の小ピン: 見た目は小さいままタップ領域だけ拡大', lowHit.hitW > lowHit.visW && lowHit.hitH >= lowHit.visH && lowHit.visW <= 26, lowHit);

      // ④ 座標なし店舗（ガスト 支店名なし）
      await p.ev(`void window.__pickupMap.map.closePopup()`);
      await p.tapSel('#pm-search');
      await p.s('Input.insertText', { text: 'ガスト' });
      await sleep(300);
      const gustId = await p.ev(`[...document.querySelectorAll('.pm-suggest-item')].find(li => /支店名なし/.test(li.textContent))?.dataset.id`);
      await p.tapSel(`.pm-suggest-item[data-id="${gustId}"]`);
      await sleep(900);
      const nocoord = await p.ev(`(() => { const li = document.querySelector('#pm-review-list li[data-id="${gustId}"]'); return { open: document.getElementById('pm-review').open, text: li && li.querySelector('.pm-route-disabled') && li.querySelector('.pm-route-disabled').textContent, hasBtn: !!(li && li.querySelector('.pm-route-btn')), anyPopup: !!document.querySelector('.leaflet-popup') }; })()`);
      check('座標なし店舗: ルートボタンなし・「座標未確認のためルート案内できません」', nocoord.open && nocoord.text === '座標未確認のためルート案内できません' && !nocoord.hasBtn && !nocoord.anyPopup, nocoord);
      const allNoCoord = await p.ev(`[...document.querySelectorAll('#pm-review-list > li')].map(li => !li.querySelector('.pm-route-btn') && !!li.querySelector('.pm-route-disabled'))`);
      check('要確認3店舗すべてルート無効', allNoCoord.length === 3 && allNoCoord.every(Boolean), allNoCoord);
      await p.shot(`${w}_4_nocoord`);
      await p.ev(`(() => { const i = document.getElementById('pm-search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

      // ⑤ 現在地（許可）
      await p.ev(`window.scrollTo(0, 0)`);
      await p.tapSel('#pm-locate');
      await sleep(1600);
      const here = await p.ev(`({ dot: !!document.querySelector('.pm-here-dot'), toast: document.getElementById('pm-toast').textContent, center: window.__pickupMap.map.getCenter(), zoom: window.__pickupMap.map.getZoom() })`);
      check('◎現在地（許可）→ 現在地マーカー表示・地図移動', here.dot && /現在地を表示/.test(here.toast) && Math.abs(here.center.lat - 34.67345) < 0.002 && here.zoom >= 16, here);
      await p.shot(`${w}_5_here`);
      await p.close();
    }

    // 位置情報を拒否しても地図は使える
    console.log('\n[位置情報を拒否した場合 390x844]');
    {
      const p = await openPage(b, `${base}/pickup-map.html`, { width: 390, height: 844, geo: 'deny' });
      await p.tapSel('#pm-locate');
      await sleep(1500);
      const r = await p.ev(`({ dot: !!document.querySelector('.pm-here-dot'), toast: document.getElementById('pm-toast').textContent, pins: document.querySelectorAll('.leaflet-marker-icon.pm-pin').length })`);
      check('拒否 → メッセージ表示・現在地マーカーなし', !r.dot && /許可されていません/.test(r.toast), r);
      await p.tapSel('.pm-rank-item:nth-child(1)');
      await sleep(1600);
      const pop = await popupState(p);
      check('拒否後も店舗選択・ルートボタンは普通に使える', r.pins === 98 && !!pop && !!pop.href, pop);
      await p.close();
    }

    // iPhoneのホーム画面アプリ表示: Google Maps アプリ（comgooglemaps://）を先に試し、開けなければウェブ版へ
    console.log('\n[ホーム画面アプリ表示（standalone）390x844]');
    {
      const p = await openPage(b, `${base}/pickup-map.html`, { width: 390, height: 844, standalone: true });
      await p.tapSel('.pm-rank-item:nth-child(1)');
      await sleep(1600);
      const pop = await popupState(p);
      const exp = await expectedUrl(p, pop.id);
      // アプリが開いた場合（ページが裏へ回る）→ ウェブ版へは切り替えない
      await p.ev(`(() => { window.__navs = []; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis || 'visible' }); })()`);
      await p.ev(`(() => { window.__vis = 'visible'; const a = document.querySelector('.leaflet-popup .pm-route-btn'); a.click(); setTimeout(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }, 200); })()`);
      await sleep(2300);
      const stay = await p.ev('location.href');
      check('アプリが開いたとき: ウェブ版へ二重に遷移しない', /pickup-map\.html/.test(stay), stay);
      // アプリがない場合（ページが表示されたまま）→ 1.6秒後に Google Maps ウェブ版へ
      await p.ev(`(() => { window.__vis = 'visible'; })()`);
      await p.tapSel('.leaflet-popup .pm-route-btn');
      let final = null;
      for (let i = 0; i < 24; i++) { await sleep(250); try { const u = await p.ev('location.href'); if (/google\.com\/maps/.test(u)) { final = u; break; } } catch (e) { /* 遷移中 */ } }
      check('アプリがないとき: Google Maps ウェブ版へ切り替わる', !!final, final);
      if (final) check('ウェブ版: 目的地=保存座標・自転車モード', /34\.675293,135\.474182|34\.675293%2C135\.474182/.test(decodeURIComponent(final)) && /bicycling|!3e1/.test(final), final.slice(0, 200));
      await p.close();
    }
  } finally {
    try { b.ws.close(); } catch (e) { /* */ }
    b.proc.kill();
    server.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
