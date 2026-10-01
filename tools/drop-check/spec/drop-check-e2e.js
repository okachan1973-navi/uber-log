#!/usr/bin/env node
/**
 * 地雷タブ（DROP先照合）のブラウザテスト（Microsoft Edge ヘッドレス + DevTools Protocol, iPhone相当）
 *   node tools/drop-check/spec/drop-check-e2e.js [--shots <dir>] [--base <公開URL>]
 * 実機の音声認識は使えないため、音声は「疑似の音声認識」「音声認識なし」「権限拒否」の3通りで確認する。
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
const SIZES = [[320, 568], [360, 740], [390, 844], [402, 874], [430, 932]];
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots');
const BASE = arg('--base') ? arg('--base').replace(/\/$/, '') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passes = 0, failures = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log(`  ok  ${label}`); } else { failures++; console.log(`  NG  ${label}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
}

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-'));
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
  const listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify(Object.assign({ id: i, method, params }, sessionId ? { sessionId } : {}))); });
  return { proc, ws, send, on: fn => listeners.push(fn) };
}

async function openApp(b, base, { width, height, initScript }) {
  const { browserContextId } = await b.send('Target.createBrowserContext');
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const errors = [];
  b.on(m => { if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  if (initScript) await s('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  await s('Page.navigate', { url: `${base}/index.html` });
  // UBER LOG は Service Worker が有効になった瞬間に1回自動リロードするので、その完了を待つ
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev('document.readyState === "complete" && !!window.__dropCheck')) break; } catch (e) { /* 読み込み中 */ } }
  for (let i = 0; i < 40; i++) { try { if (await ev(`!('serviceWorker' in navigator) || !!navigator.serviceWorker.controller`)) break; } catch (e) { /* リロード中 */ } await sleep(250); }
  await sleep(1000);
  for (let i = 0; i < 40; i++) { try { if (await ev('document.readyState === "complete" && !!window.__dropCheck')) break; } catch (e) { /* リロード中 */ } await sleep(250); }
  const tap = async (x, y) => {
    await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4 }] });
    await sleep(40);
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const tapSel = async (sel, scroll = true) => {
    if (scroll) { await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`); await sleep(250); }
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await tap(r.x, r.y);
    await sleep(200);
  };
  const type = async text => {
    await ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await tapSel('#dc-query', false);
    await s('Input.insertText', { text });
    await sleep(200);
  };
  const results = () => ev(`({ names: [...document.querySelectorAll('#dc-list .dc-name')].map(e => e.textContent), none: document.querySelector('#dc-list .dc-none') ? document.querySelector('#dc-list .dc-none').textContent.replace(/\\s+/g, ' ').trim() : null, count: document.getElementById('dc-count').textContent })`);
  const shot = async name => { if (!SHOTS) return; const { data } = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const close = async () => { await b.send('Target.closeTarget', { targetId }); await b.send('Target.disposeBrowserContext', { browserContextId }); };
  return { s, ev, tap, tapSel, type, results, shot, close, errors };
}

const FAKE_SR = (transcript, error) => `
  window.webkitSpeechRecognition = window.SpeechRecognition = class {
    start() {
      setTimeout(() => { this.onstart && this.onstart(); }, 30);
      ${error ? `setTimeout(() => { this.onerror && this.onerror({ error: ${JSON.stringify(error)} }); this.onend && this.onend(); }, 80);`
    : `setTimeout(() => { this.onresult && this.onresult({ resultIndex: 0, results: [[{ transcript: ${JSON.stringify(transcript)} }]] }); this.onend && this.onend(); }, 120);`}
    }
    stop() { this.onend && this.onend(); }
  };`;
const NO_SR = 'Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true }); Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });';

async function run() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = BASE ? null : await startServer();
  const base = BASE || `http://127.0.0.1:${server.address().port}`;
  console.log('対象: ' + base);
  const b = await launch();
  try {
    for (const [w, h] of SIZES) {
      console.log(`\n[${w}x${h} iPhone相当]`);
      const p = await openApp(b, base, { width: w, height: h, initScript: NO_SR });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(400);
      const lay = await p.ev(`(() => { const q = document.getElementById('dc-query').getBoundingClientRect(), m = document.getElementById('dc-mic').getBoundingClientRect(); const chips = [...document.querySelectorAll('.dc-ward')]; const first = document.querySelector('#dc-list .dc-row');
        return { active: document.getElementById('tab-avoidance').classList.contains('active'), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
          qH: q.height, qFont: parseFloat(getComputedStyle(document.getElementById('dc-query')).fontSize), micW: m.width, micH: m.height, micRight: m.right,
          chipMinH: Math.min(...chips.map(c => c.getBoundingClientRect().height)), chipLabels: chips.map(c => c.childNodes[0].textContent),
          firstRowTop: first.getBoundingClientRect().top, firstRowH: first.getBoundingClientRect().height, nameFont: parseFloat(getComputedStyle(document.querySelector('.dc-name')).fontSize), total: document.querySelectorAll('#dc-list .dc-item').length }; })()`);
      check('下部ナビ「地雷」→ DROP先照合が開く（全44件）', lay.active && lay.total === 44, lay);
      check('横スクロールなし・🎙️が画面内', lay.sw <= lay.vw && lay.micRight <= lay.vw, lay);
      check('検索欄は大きく（高さ50px以上）・文字16px以上（iPhoneで自動ズームしない）', lay.qH >= 50 && lay.qFont >= 16, lay);
      check('🎙️・区ボタンは押しやすい大きさ（44px以上）', lay.micW >= 48 && lay.micH >= 50 && lay.chipMinH >= 44, lay);
      check('区ボタン: すべて・西区・港区・此花区・福島区・北区・中央区・その他', lay.chipLabels.join(',') === 'すべて,西区,港区,此花区,福島区,北区,中央区,その他', lay.chipLabels);
      check('最初の物件がスクロールなしで見える・名前は17px以上', lay.firstRowTop < h * 0.6 && lay.firstRowH >= 60 && lay.nameFont >= 17, lay);
      await p.shot(`${w}_1_open`);

      await p.type('ライズ');
      let r = await p.results();
      check('マンション名の部分検索「ライズ」→ 阿波座ライズタワーズ', r.names.join() === '阿波座ライズタワーズ フラッグ46', r);
      await p.shot(`${w}_2_rise`);
      await p.type('江之子島'); r = await p.results();
      check('町名検索「江之子島」', r.names.join() === '阿波座ライズタワーズ フラッグ46', r);
      await p.type('弁天1丁目'); r = await p.results();
      check('住所検索「弁天1丁目」→ 3件', r.names.length === 3, r);
      await p.type('アップル'); r = await p.results();
      check('「アップル」→ 淀屋橋アップルタワーレジデンス', r.names.join() === '淀屋橋アップルタワーレジデンス', r);
      await p.type('中之島'); r = await p.results();
      check('「中之島」→ 2件', r.names.length === 2 && r.names.every(n => /中之島/.test(n)), r);
      await p.type('存在しない物件'); r = await p.results();
      check('検索結果ゼロ → 「登録物件なし」（安全・問題なしとは書かない）', r.names.length === 0 && /登録物件なし/.test(r.none) && !/安全|問題ありません|問題なし/.test(r.none), r);
      await p.shot(`${w}_3_none`);
      await p.tapSel('#dc-clear', false);
      r = await p.results();
      check('×で検索クリア → 全44件', r.names.length === 44, r.count);

      await p.tapSel('.dc-ward[data-ward="西区"]');
      r = await p.results();
      check('区ボタン「西区」→ 西区の8件をあいうえお順', r.names.join('/') === '阿波座ライズタワーズ フラッグ46/大阪ひびきの街 ザ・サンクタスタワー/ザ・ファインタワー大阪肥後橋/シエリアタワー大阪堀江/ジオタワー新町/D’グラフォート大阪N.Y.タワーHIGOBASHI/プレミストタワー靱本町/プレミストタワー大阪新町ローレルコート', r.names);
      await p.type('新町'); r = await p.results();
      check('区フィルター＋検索（西区・新町）→ 3件', r.names.length === 3 && /^西区/.test(r.count), r);
      await p.ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      await p.tapSel('.dc-ward[data-ward="西区"]');
      r = await p.results();
      check('同じ区をもう一度押す → 解除（全44件）', r.names.length === 44, r.count);
      await p.tapSel('.dc-ward[data-ward="北区"]');
      check('北区 → 13件', (await p.results()).names.length === 13);
      await p.tapSel('.dc-ward[data-ward="all"]');
      check('「すべて」→ 解除（全44件）', (await p.results()).names.length === 44);

      // 詳細の開閉
      await p.type('島屋');
      await p.tapSel('#dc-list .dc-item:first-child .dc-row');
      let d = await p.ev(`(() => { const it = document.querySelector('#dc-list .dc-item:first-child'); const det = it.querySelector('.dc-detail'); return { open: !det.hidden, text: det.textContent.replace(/\\s+/g, ' '), link: !!det.querySelector('a[href^="https://"]'), rel: det.querySelector('.dc-rel') ? det.querySelector('.dc-rel').textContent.replace(/\\s+/g, ' ') : null, expanded: it.querySelector('.dc-row').getAttribute('aria-expanded') }; })()`);
      check('タップで詳細を開く（本人評価・本人メモ・所在地・階数・一般目安・備考・情報源）', d.open && d.expanded === 'true' && ['本人評価', '未検証', '本人メモ', '所在地', '階数', '一般目安', '備考', '情報源'].every(k => d.text.includes(k)) && d.link, d.text.slice(0, 200));
      const ed = await p.ev(`(() => { const it = document.querySelector('#dc-list .dc-item:first-child'); const bs = [...it.querySelectorAll('.dc-rbtn')].map(x => x.getBoundingClientRect()); const inp = it.querySelector('.dc-memo-input'); const sv = it.querySelector('.dc-memo-save').getBoundingClientRect();
        return { labels: [...it.querySelectorAll('.dc-rbtn')].map(x => x.textContent.trim()), minH: Math.min(...bs.map(r => r.height)), sameRow: bs.every(r => Math.abs(r.top - bs[0].top) < 1), right: Math.max(...bs.map(r => r.right), sv.right), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
          inputFont: parseFloat(getComputedStyle(inp).fontSize), inputH: inp.getBoundingClientRect().height, saveH: sv.height, unrate: !!it.querySelector('[data-unrate]'), count: it.querySelector('[data-count]').textContent }; })()`);
      check('評価ボタン3つ（🟢問題なし・🟡注意・🔴避けたい）が1列で押しやすい・未検証には「戻す」なし', ed.labels.join(',') === '🟢問題なし,🟡注意,🔴避けたい' && ed.minH >= 56 && ed.sameRow && ed.right <= ed.vw && ed.sw <= ed.vw && !ed.unrate, ed);
      check('メモ欄: 1行・文字17px（自動ズームしない）・保存ボタン44px以上・「0/20文字」表示', ed.inputFont >= 16 && ed.inputH >= 44 && ed.saveH >= 44 && ed.count === '0/20文字', ed);
      check('詳細に「同じ町への実走記録」（9/17 モス→島屋6丁目）を参考表示', !!d.rel && /島屋6丁目/.test(d.rel) && /モスバーガー/.test(d.rel), d.rel);
      await p.shot(`${w}_4_detail`);
      await p.tapSel('#dc-list .dc-item:first-child .dc-row');
      d = await p.ev(`document.querySelector('#dc-list .dc-item:first-child .dc-detail').hidden`);
      check('もう一度タップで閉じる', d === true);

      // スクロールしても検索欄が届く・下部ナビと重ならない
      await p.tapSel('#dc-clear', false);
      await p.ev('window.scrollTo(0, document.body.scrollHeight)');
      await sleep(300);
      const sc = await p.ev(`(() => { const q = document.getElementById('dc-query').getBoundingClientRect(); const hdr = document.querySelector('.top-header').getBoundingClientRect(); const nav = document.querySelector('.bottom-nav').getBoundingClientRect(); const last = document.querySelector('#dc-list .dc-item:last-child').getBoundingClientRect(); const legacy = document.querySelector('#avoidance-legacy > summary').getBoundingClientRect();
        return { qTop: q.top, hdrBottom: hdr.bottom, navTop: nav.top, legacyBottom: legacy.bottom, lastBottom: last.bottom, vh: innerHeight }; })()`);
      check('下までスクロールしても検索欄はヘッダー直下に残る', sc.qTop >= sc.hdrBottom - 1 && sc.qTop < sc.hdrBottom + 20, sc);
      check('最後の内容が下部ナビに隠れない', sc.legacyBottom <= sc.navTop + 1, sc);

      // 音声: 音声認識なし → 検索欄にフォーカスしてキーボードの音声入力を案内
      await p.ev('window.scrollTo(0, 0)');
      await p.tapSel('#dc-mic', false);
      await sleep(250);
      const fb = await p.ev(`({ focused: document.activeElement && document.activeElement.id, msg: document.getElementById('dc-voice').textContent, shown: !document.getElementById('dc-voice').hidden })`);
      check('🎙️（音声認識が無い端末）→ 検索欄にフォーカス・キーボードのマイク🎤を案内', fb.focused === 'dc-query' && fb.shown && /キーボードのマイク/.test(fb.msg), fb);

      // 従来の地雷DB（実走事例3件）が残っている
      await p.tapSel('#avoidance-legacy > summary');
      await sleep(250);
      const lg = await p.ev(`({ open: document.getElementById('avoidance-legacy').open, cards: document.querySelectorAll('#avoidance-benchmarks-list .avoidance-card').length, areas: document.querySelectorAll('#avoidance-areas-list .avoidance-card').length })`);
      check('従来の地雷DB（実走事例3件・方面）は折りたたみで残る', lg.open && lg.cards === 3 && lg.areas >= 1, lg);

      // 他のタブ・ナビが壊れていない
      await p.tapSel('.bottom-nav [data-tab="today"]', false);
      const other = await p.ev(`({ today: document.getElementById('tab-today').classList.contains('active'), avoid: document.getElementById('tab-avoidance').classList.contains('active'), nav: [...document.querySelectorAll('.bottom-nav .nav-label')].map(e => e.textContent).join(' ') })`);
      check('稼働タブへ戻れる・下部ナビ6項目のまま', other.today && !other.avoid && other.nav === '稼働 履歴 分析 地雷 地図 ルート', other);
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    for (const [w, h] of [[390, 844], [320, 568]]) {
      console.log(`\n[本人評価・本人メモ ${w}x${h}]`);
      const p = await openApp(b, base, { width: w, height: h, initScript: NO_SR });
      await p.ev(`(() => { try { localStorage.removeItem('uber_drop_personal_v1'); } catch (e) {} })()`);
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      const card = async () => p.ev(`(() => { const it = [...document.querySelectorAll('#dc-list .dc-item')].find(li => li.querySelector('.dc-name').textContent === '阿波座ライズタワーズ フラッグ46'); if (!it) return null;
        return { rate: it.querySelector('.dc-rate').textContent.trim(), cls: it.className, memo: it.querySelector('.dc-memo-line') ? it.querySelector('.dc-memo-line').textContent : null, saved: it.querySelector('.dc-saved') ? it.querySelector('.dc-saved').textContent : null,
          on: [...it.querySelectorAll('.dc-rbtn.on')].map(x => x.dataset.rate), unrate: it.querySelector('[data-unrate]') ? it.querySelector('[data-unrate]').textContent : null, open: it.classList.contains('open') }; })()`);
      const sel = '#dc-list .dc-item:first-child';
      // 物件検索 → タップ → 「避けたい」
      await p.type('ライズ');
      await p.tapSel(`${sel} .dc-row`);
      let c = await card();
      check('検索→物件をタップ → 詳細が開き「⚪ 未検証」', c.open && c.rate === '⚪ 未検証' && c.on.length === 0, c);
      await p.tapSel(`${sel} [data-rate="avoid"]`);
      c = await card();
      check('「🔴 避けたい」をタップ → 一覧のカードに即反映（左端も赤）・保存メッセージ', c.rate === '🔴 避けたい' && /rated/.test(c.cls) && /r-avoid/.test(c.cls) && c.on.join() === 'avoid' && /避けたい.*保存/.test(c.saved) && c.unrate === '未検証に戻す', c);
      await p.shot(`rate_${w}_avoid`);
      // 本人メモ
      await p.tapSel(`${sel} .dc-memo-input`);
      await p.s('Input.insertText', { text: '3階経由・館内長い' });
      await sleep(150);
      const cnt = await p.ev(`document.querySelector('${sel} [data-count]').textContent`);
      check('メモ入力中は文字数を表示（9/20文字）', cnt === '9/20文字', cnt);
      await p.tapSel(`${sel} [data-memo-save]`);
      c = await card();
      check('保存 → 一覧カードに「3階経由・館内長い」を1行表示', c.memo === '「3階経由・館内長い」' && /メモを保存/.test(c.saved), c);
      const vis = await p.ev(`(() => { const it = document.querySelector('${sel}'); const badge = it.querySelector('.dc-rate').getBoundingClientRect(); const st = document.querySelector('.dc-sticky').getBoundingClientRect(); return { badgeTop: badge.top, stickyBottom: st.bottom, vh: innerHeight }; })()`);
      check('保存後、カード先頭（本人評価バッジ）が検索欄の下に見えている', vis.badgeTop >= vis.stickyBottom && vis.badgeTop < vis.vh * 0.6, vis);
      await p.shot(`rate_${w}_memo`);
      // 別の評価へ変更・メモ変更
      await p.tapSel(`${sel} [data-rate="ok"]`);
      c = await card();
      check('評価を「🟢 問題なし」に変更', c.rate === '🟢 問題なし' && /r-ok/.test(c.cls) && c.on.join() === 'ok', c);
      await p.ev(`(() => { const i = document.querySelector('${sel} .dc-memo-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.tapSel(`${sel} .dc-memo-input`);
      await p.s('Input.insertText', { text: 'EV速い' });
      await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(200);
      c = await card();
      check('メモ変更（キーボードの完了キーでも保存）', c.memo === '「EV速い」', c);
      // 文字数上限
      await p.ev(`(() => { const i = document.querySelector('${sel} .dc-memo-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.tapSel(`${sel} .dc-memo-input`);
      await p.s('Input.insertText', { text: 'あいうえおかきくけこさしすせそたちつてとな' });
      await sleep(150);
      const lim = await p.ev(`({ count: document.querySelector('${sel} [data-count]').textContent, over: document.querySelector('${sel} [data-count]').classList.contains('over'), disabled: document.querySelector('${sel} [data-memo-save]').disabled })`);
      check('21文字 → 「21/20文字」を赤表示・保存ボタン無効', lim.count === '21/20文字' && lim.over && lim.disabled, lim);
      await p.ev(`(() => { const i = document.querySelector('${sel} .dc-memo-input'); i.value = 'EV速い'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      // 再読み込みしても残る
      await p.s('Page.reload', {});
      for (let i = 0; i < 40; i++) { await sleep(250); try { if (await p.ev('document.readyState === "complete" && !!window.__dropCheck')) break; } catch (e) { /* 読み込み中 */ } }
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      await p.type('ライズ');
      c = await card();
      check('再読み込み後も評価とメモが残る（🟢 問題なし・「EV速い」）', c.rate === '🟢 問題なし' && c.memo === '「EV速い」', c);
      // 区フィルター・検索結果でも反映、件数は44のまま
      await p.ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      await p.tapSel('.dc-ward[data-ward="西区"]');
      c = await card();
      const n = await p.ev(`document.querySelectorAll('#dc-list .dc-item').length`);
      check('区フィルター（西区）でも本人評価・メモを表示・8件のまま', c.rate === '🟢 問題なし' && c.memo === '「EV速い」' && n === 8, { c, n });
      await p.tapSel('.dc-ward[data-ward="all"]');
      check('全件は44件のまま', await p.ev(`document.querySelectorAll('#dc-list .dc-item').length`) === 44);
      // 未検証に戻す（2回押し）
      await p.type('ライズ');
      await p.tapSel(`${sel} .dc-row`);
      await p.tapSel(`${sel} [data-unrate]`);
      c = await card();
      check('「未検証に戻す」1回目は確認表示だけ（評価はそのまま）', c.rate === '🟢 問題なし' && c.unrate === 'もう一度押すと未検証に戻ります', c);
      await p.tapSel(`${sel} [data-unrate]`);
      c = await card();
      const stored = await p.ev(`JSON.parse(localStorage.getItem('uber_drop_personal_v1')).items`);
      const rec = Object.values(stored)[0];
      check('2回目で未検証に戻る（評価 null・メモは残る）', c.rate === '⚪ 未検証' && !/rated/.test(c.cls) && c.memo === '「EV速い」' && rec.rating === null && rec.note === 'EV速い', { c, rec });
      check('横スクロールなし', await p.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    console.log('\n[音声認識あり（疑似）390x844]');
    {
      const p = await openApp(b, base, { width: 390, height: 844, initScript: FAKE_SR('西区ライズ。') });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      await p.tapSel('#dc-mic', false);
      await sleep(600);
      const r = await p.ev(`({ q: document.getElementById('dc-query').value, names: [...document.querySelectorAll('#dc-list .dc-name')].map(e => e.textContent), micOn: document.getElementById('dc-mic').classList.contains('on') })`);
      check('🎙️ →「西区ライズ。」と発話 → 検索欄に反映・阿波座ライズタワーズ1件', r.q === '西区ライズ' && r.names.join() === '阿波座ライズタワーズ フラッグ46' && !r.micOn, r);
      await sleep(2000);
      const after = await p.ev(`document.getElementById('dc-voice').textContent`);
      check('正常に聞き取れたときは「反応しませんでした」を出さない', !/反応しませんでした/.test(after), after);
      await p.shot('voice_ok');
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    console.log('\n[ホーム画面アプリ表示（音声認識APIはあるが使えない環境）390x844]');
    {
      const p = await openApp(b, base, { width: 390, height: 844, initScript: FAKE_SR('西区ライズ') + 'Object.defineProperty(navigator, "standalone", { get: () => true });' });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      await p.tapSel('#dc-mic', false);
      await sleep(400);
      const r = await p.ev(`({ focused: document.activeElement && document.activeElement.id, msg: document.getElementById('dc-voice').textContent, q: document.getElementById('dc-query').value })`);
      check('ホーム画面アプリ → 音声認識を使わず検索欄にフォーカス・キーボードのマイク🎤を案内', r.focused === 'dc-query' && /ホーム画面アプリ/.test(r.msg) && /キーボードのマイク/.test(r.msg) && r.q === '', r);
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    console.log('\n[音声認識APIはあるが反応しない（疑似）390x844]');
    {
      const silent = 'window.webkitSpeechRecognition = window.SpeechRecognition = class { start() {} stop() {} abort() { window.__aborted = true; } };';
      const p = await openApp(b, base, { width: 390, height: 844, initScript: silent });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      await p.tapSel('#dc-mic', false);
      await sleep(2600);
      const r = await p.ev(`({ msg: document.getElementById('dc-voice').textContent, aborted: !!window.__aborted, micOn: document.getElementById('dc-mic').classList.contains('on') })`);
      check('2秒反応がなければ止めて「検索欄をタップしてキーボードのマイク🎤」を案内', r.aborted && /反応しませんでした/.test(r.msg) && /キーボードのマイク/.test(r.msg) && !r.micOn, r);
      await p.tapSel('#dc-mic', false);
      await sleep(300);
      const r2 = await p.ev(`({ focused: document.activeElement && document.activeElement.id })`);
      check('もう一度🎙️ → 検索欄にフォーカス（キーボード音声入力へ）', r2.focused === 'dc-query', r2);
      await p.type('アップル');
      check('文字検索は正常', (await p.results()).names.join() === '淀屋橋アップルタワーレジデンス');
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    console.log('\n[音声認識の権限拒否（疑似）390x844]');
    {
      const p = await openApp(b, base, { width: 390, height: 844, initScript: FAKE_SR('', 'not-allowed') });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      await p.tapSel('#dc-mic', false);
      await sleep(500);
      const r = await p.ev(`({ focused: document.activeElement && document.activeElement.id, msg: document.getElementById('dc-voice').textContent })`);
      check('権限拒否 → 落ちずにキーボードの音声入力へ案内', r.focused === 'dc-query' && /許可されていません/.test(r.msg) && /キーボードのマイク/.test(r.msg), r);
      await p.type('ライズ');
      check('拒否後も文字検索は正常', (await p.results()).names.join() === '阿波座ライズタワーズ フラッグ46');
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
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

setTimeout(() => { console.log('ERROR: テストが時間内に終わりませんでした（10分）'); process.exit(2); }, 10 * 60 * 1000).unref();
run().catch(e => { console.error(e); process.exit(1); });
