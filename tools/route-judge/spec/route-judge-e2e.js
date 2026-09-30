#!/usr/bin/env node
/**
 * ルート判断マップのブラウザテスト（Microsoft Edge ヘッドレス + DevTools Protocol, iPhone相当）
 *   node tools/route-judge/spec/route-judge-e2e.js [--shots <dir>] [--base <公開URL>]
 * 地図タイル・Leaflet の読み込みにネット接続が必要。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SIZES = [[320, 568], [360, 740], [390, 844], [430, 932]];
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots');
const BASE = arg('--base') ? arg('--base').replace(/\/$/, '') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// テストに使う実在地点（店舗マスタの確認済み座標）
const P = {
  kujo: { lat: 34.675293, lng: 135.474182, name: 'マクドナルド 九条店（南岸）' },
  nishikujo: { lat: 34.681774, lng: 135.466171, name: 'マクドナルド 阪神西九条駅前店（北岸）' },
  bentencho: { lat: 34.668415, lng: 135.461288, name: 'マクドナルド 弁天町駅前店（南岸）' }
};

let passes = 0, failures = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log(`  ok  ${label}`); } else { failures++; console.log(`  NG  ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
}

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

async function launch() {
  // ポートは Edge に空きを選ばせる（固定・乱数ポートだと残っている別の Edge とぶつかって止まることがある）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-e2e-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=ja', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let info;
  for (let i = 0; i < 80 && !info; i++) {
    await sleep(250);
    try { const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) { /* 起動待ち */ }
  }
  if (!info) throw new Error('Edge を起動できません: ' + EDGE);
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify(Object.assign({ id: i, method, params }, sessionId ? { sessionId } : {}))); });
  return { proc, ws, send };
}

async function openPage(b, url, { width, height, geo = null, deny = false, ready }) {
  const { browserContextId } = await b.send('Target.createBrowserContext');
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  const origin = new URL(url).origin;
  if (deny) await b.send('Browser.setPermission', { origin, browserContextId, permission: { name: 'geolocation' }, setting: 'denied' });
  else {
    await b.send('Browser.grantPermissions', { origin, permissions: ['geolocation'], browserContextId });
    if (geo) await s('Emulation.setGeolocationOverride', { latitude: geo.lat, longitude: geo.lng, accuracy: 12 });
  }
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  const nav = async u => {
    await s('Page.navigate', { url: u });
    for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev(ready)) break; } catch (e) { /* loading */ } }
  };
  await nav(url);
  const tap = async (x, y) => {
    await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4 }] });
    await sleep(40);
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const tapSel = async sel => {
    await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await tap(r.x, r.y);
  };
  // 地図上の緯度経度をタップ（地図を先に画面に出す）
  const tapLatLng = async (lat, lng) => {
    await ev(`(() => { document.getElementById('rj-map-wrap').scrollIntoView({ block: 'start' }); window.scrollBy(0, -60); })()`);
    await sleep(300);
    const pt = await ev(`(() => { const m = window.__routeJudge.map; const p = m.latLngToContainerPoint([${lat}, ${lng}]); const r = m.getContainer().getBoundingClientRect(); return { x: r.x + p.x, y: r.y + p.y, inside: p.x > 0 && p.y > 0 && p.x < r.width && p.y < r.height }; })()`);
    await tap(pt.x, pt.y);
    return pt;
  };
  const shot = async name => { if (!SHOTS) return; const { data } = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const close = async () => { await b.send('Target.closeTarget', { targetId }); await b.send('Target.disposeBrowserContext', { browserContextId }); };
  return { s, ev, nav, tap, tapSel, tapLatLng, shot, close };
}

function meters(a, b) {
  const R = 6371008.8, r = d => d * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const READY_RJ = '!!(window.__routeJudge && document.querySelectorAll(".rj-xicon.tunnel").length === 2)';

async function run() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = BASE ? null : await startServer();
  const base = BASE || `http://127.0.0.1:${server.address().port}`;
  console.log('対象: ' + base);
  const b = await launch();
  try {
    for (const [w, h] of SIZES) {
      console.log(`\n[${w}x${h} iPhone相当]`);
      const p = await openPage(b, `${base}/route-judge.html`, { width: w, height: h, geo: P.bentencho, ready: READY_RJ });
      await p.ev(`(() => { try { localStorage.clear(); } catch (e) {} })()`);
      await p.nav(`${base}/route-judge.html`);

      const lay = await p.ev(`(() => { const m = document.getElementById('rj-map').getBoundingClientRect(); const btns = [...document.querySelectorAll('.rj-mode, .rj-tool')].map(b => b.getBoundingClientRect());
        return { vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, mapH: m.height, mapTop: m.top, minBtnH: Math.min(...btns.map(r => r.height)), btnRight: Math.max(...btns.map(r => r.right)),
          verdict: document.getElementById('rj-verdict').textContent.trim(), locateH: document.getElementById('rj-locate').getBoundingClientRect().height }; })()`);
      check('横スクロールなし・ボタンが画面内', lay.sw <= lay.vw && lay.btnRight <= lay.vw, lay);
      check('地図の高さが画面の45%以上・上部に地点ボタン', lay.mapH >= h * 0.45 && lay.mapTop < h * 0.35, lay);
      check('PICK/DROP/店舗/クリア ボタン 44px以上・◎40px以上', lay.minBtnH >= 44 && lay.locateH >= 40, lay);

      // 安治川トンネル・安治川大橋の表示位置
      const x = await p.ev(`(() => { const m = window.__routeJudge.map; const geo = window.__routeJudge.geo; const out = { tunnel: [], stairs: [], warn: null, labels: [...document.querySelectorAll('.rj-label')].map(t => t.textContent) };
        m.eachLayer(l => { if (!(l instanceof L.Marker)) return; const el = l.getElement && l.getElement(); if (!el) return; const ll = l.getLatLng();
          if (el.classList.contains('tunnel')) out.tunnel.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
          if (el.classList.contains('stairs')) out.stairs.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
          if (el.classList.contains('rj-warnicon')) out.warn = { text: el.textContent, lat: ll.lat, lng: ll.lng }; });
        const t = geo.crossings.find(c => c.id === 'ajikawa_tunnel'), br = geo.crossings.find(c => c.id === 'ajikawa_ohashi');
        out.expTunnel = ['south', 'north'].map(s => [t.entrances[s].latitude, t.entrances[s].longitude]);
        out.expStairs = ['south', 'north'].map(s => [br.entrances[s].latitude, br.entrances[s].longitude]);
        out.redLines = [...document.querySelectorAll('path.leaflet-interactive')].filter(p => p.getAttribute('stroke') === '#dc2626').length;
        return out; })()`);
      const same = (a, e) => a.length === e.length && e.every(q => a.some(r => r[0] === q[0] && r[1] === q[1]));
      check('安治川トンネル: 南口・北口の入口マーカーが保存座標どおり', same(x.tunnel, x.expTunnel) && x.labels.includes('トンネル南口') && x.labels.includes('トンネル北口'), x);
      check('安治川大橋: 南北の階段下マーカー・赤い階段4本・「⚠ 押し歩き」表示', same(x.stairs, x.expStairs) && x.redLines === 4 && x.warn && x.warn.text === '⚠ 押し歩き', x);
      await p.shot(`${w}_1_initial`);

      // PICK（九条）→ DROP（西九条）を地図タップで置く
      check('初期モードは PICK', await p.ev(`document.querySelector('.rj-mode-pick').getAttribute('aria-pressed')`) === 'true');
      await p.tapLatLng(P.kujo.lat, P.kujo.lng);
      await sleep(400);
      let st = await p.ev(`({ job: window.__routeJudge.job, pickPin: !!document.querySelector('.rj-pin.pick'), dropMode: document.querySelector('.rj-mode-drop').getAttribute('aria-pressed') })`);
      check('地図タップ → PICK（緑P）表示・次は DROP モード', st.pickPin && st.job.pick && meters(st.job.pick, P.kujo) < 40 && st.dropMode === 'true', { pick: st.job.pick, d: st.job.pick && meters(st.job.pick, P.kujo) });
      await p.tapLatLng(P.nishikujo.lat, P.nishikujo.lng);
      await sleep(400);
      st = await p.ev(`({ job: window.__routeJudge.job, dropPin: !!document.querySelector('.rj-pin.drop'), verdict: document.getElementById('rj-verdict').textContent.replace(/\\s+/g, ' ').trim(), result: window.__routeJudge.result })`);
      check('地図タップ → DROP（ピンクD）表示', st.dropPin && st.job.drop && meters(st.job.drop, P.nishikujo) < 40, { drop: st.job.drop });
      const leg = st.result.legs.find(l => l.from === 'pick' && l.to === 'drop');
      check('判定: PICK→DROP は安治川を横断（南岸→北岸）・最短はトンネル', !!leg && leg.crosses && leg.from_side === 'south' && leg.to_side === 'north' && leg.best.id === 'ajikawa_tunnel' && /PICK→DROP/.test(st.verdict) && /安治川を横断/.test(st.verdict) && /トンネル/.test(st.verdict), { verdict: st.verdict });
      await p.shot(`${w}_2_pick_drop`);

      // ◎ 現在地（弁天町）→ 現在地→PICK の区間が加わる
      await p.tapSel('#rj-locate');
      await sleep(1500);
      st = await p.ev(`({ dot: !!document.querySelector('.pm-here-dot'), cur: window.__routeJudge.job.current, legs: window.__routeJudge.result.legs.map(l => [l.from, l.to, l.crosses]), verdict: document.getElementById('rj-verdict').textContent.replace(/\\s+/g, ' ').trim() })`);
      check('◎ 現在地 → 青い点・案件の現在地に保存', st.dot && st.cur && meters(st.cur, P.bentencho) < 5 && st.cur.source === 'geolocation', st.cur);
      check('案件 = 現在地→PICK→DROP（現在地→PICKは横断なし）', JSON.stringify(st.legs) === JSON.stringify([['current', 'pick', false], ['pick', 'drop', true]]) && /現在地→PICK/.test(st.verdict) && /横断なし/.test(st.verdict), st);
      await p.shot(`${w}_3_current`);

      // 店舗から PICK（高見プラザ・北岸）→ 現在地（弁天町・南岸）から大橋が最短で⚠押し歩き
      await p.tapSel('#rj-store-toggle');
      await sleep(200);
      await p.s('Input.insertText', { text: '高見' });
      await sleep(300);
      await p.tapSel('#rj-store-list li[data-id]');
      await sleep(900);
      st = await p.ev(`({ pick: window.__routeJudge.job.pick, legs: window.__routeJudge.result.legs, verdict: document.getElementById('rj-verdict').textContent.replace(/\\s+/g, ' ').trim(), sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth })`);
      const cp = st.legs.find(l => l.from === 'current');
      check('店舗から PICK（マクドナルド 高見プラザ店）', st.pick && st.pick.label === 'マクドナルド 高見プラザ店' && st.pick.source === 'store', st.pick);
      check('現在地(弁天町)→PICK(高見): 横断・最短は安治川大橋・⚠押し歩き表示', cp && cp.crosses && cp.best.id === 'ajikawa_ohashi' && cp.best.push_walk && /安治川大橋/.test(st.verdict) && /押し歩き/.test(st.verdict) && st.sw <= st.vw, { verdict: st.verdict });
      await p.shot(`${w}_4_bridge`);

      // 詳細パネル: 候補の一覧（トンネル・大橋・参考）
      const cands = await p.ev(`[...document.querySelectorAll('.rj-cands li b')].map(b => b.textContent)`);
      check('詳細: 横断候補にトンネル・安治川大橋・天保山渡船・上流回り', ['トンネル', '安治川大橋', '天保山渡船', '上流回り'].every(n => cands.includes(n)), cands);

      // 再読み込みしても案件が残る → クリアで PICK/DROP だけ消える
      await p.nav(`${base}/route-judge.html`);
      st = await p.ev(`({ job: window.__routeJudge.job, pins: document.querySelectorAll('.rj-pin').length })`);
      check('再読み込み後も案件（現在地・PICK・DROP）が残る', st.pins === 2 && st.job.current && st.job.pick && st.job.drop, { pins: st.pins });
      await p.tapSel('#rj-clear');
      await sleep(300);
      st = await p.ev(`({ job: window.__routeJudge.job, pins: document.querySelectorAll('.rj-pin').length, mode: document.querySelector('.rj-mode-pick').getAttribute('aria-pressed') })`);
      check('クリア → PICK・DROP を消し現在地は残す・PICKモードへ', st.pins === 0 && !st.job.pick && !st.job.drop && st.job.current && st.mode === 'true', st);
      await p.close();
    }

    console.log('\n[位置情報を拒否 390x844]');
    {
      const p = await openPage(b, `${base}/route-judge.html`, { width: 390, height: 844, deny: true, ready: READY_RJ });
      await p.tapSel('#rj-locate');
      await sleep(1200);
      const r = await p.ev(`({ dot: !!document.querySelector('.pm-here-dot'), toast: document.getElementById('rj-toast').textContent })`);
      check('拒否 → メッセージ・現在地なし', !r.dot && /許可されていません/.test(r.toast), r);
      await p.tapLatLng(P.kujo.lat, P.kujo.lng);
      await sleep(300);
      check('拒否後も PICK を置ける', await p.ev(`!!document.querySelector('.rj-pin.pick')`));
      await p.close();
    }

    console.log('\n[UBER LOG 下部ナビ（6項目）]');
    for (const [w, h] of SIZES) {
      const p = await openPage(b, `${base}/index.html`, { width: w, height: h, ready: '!!document.querySelector(".bottom-nav")' });
      const nav = await p.ev(`(() => { const items = [...document.querySelectorAll('.bottom-nav .nav-btn')]; return { vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
        items: items.map(b => ({ label: b.querySelector('.nav-label').textContent, w: Math.round(b.getBoundingClientRect().width), over: b.querySelector('.nav-label').scrollWidth > b.querySelector('.nav-label').clientWidth, right: b.getBoundingClientRect().right, href: b.getAttribute('href') })) }; })()`);
      const labels = nav.items.map(i => i.label).join(' ');
      check(`${w}px: 稼働 履歴 分析 地雷 地図 ルート・均等・はみ出しなし`, labels === '稼働 履歴 分析 地雷 地図 ルート' && nav.items.every(i => !i.over && i.right <= nav.vw + 0.5) && nav.sw <= nav.vw && Math.max(...nav.items.map(i => i.w)) - Math.min(...nav.items.map(i => i.w)) <= 1, nav);
      if (w === 390) {
        await p.tapSel('.bottom-nav a[href="route-judge.html"]');
        for (let i = 0; i < 80; i++) { await sleep(250); try { if (await p.ev(READY_RJ)) break; } catch (e) { /* 遷移中（読み込みが遅い回線でも20秒待つ） */ } }
        check('「🧭 ルート」タップ → ルート判断マップが開く', /route-judge\.html$/.test(await p.ev('location.pathname')) && await p.ev(READY_RJ));
      }
      await p.close();
    }
  } finally {
    try { b.ws.close(); } catch (e) { /* */ }
    b.proc.kill();
    if (server) server.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

// どこかで止まっても無限に待たない
setTimeout(() => { console.log('ERROR: テストが時間内に終わりませんでした（10分）'); process.exit(2); }, 10 * 60 * 1000).unref();
run().catch(e => { console.error(e); process.exit(1); });
