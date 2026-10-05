#!/usr/bin/env node
/**
 * 地雷タブ（DROP先照合）のブラウザテスト（Microsoft Edge ヘッドレス + DevTools Protocol, iPhone相当）
 *   node tools/drop-check/spec/drop-check-e2e.js [--shots <dir>] [--base <公開URL>]
 * 音声は iPhone キーボードの音声入力🎤を使う（専用ボタンなし）。実機の音声入力は使えないため、
 * 確定文字の一括挿入（insertText）と変換中→確定（IME composition）で「入力した瞬間に検索される」ことを確認する。
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

async function openApp(b, base, { width, height, initScript, desktop }) {
  const { browserContextId } = await b.send('Target.createBrowserContext');
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const errors = [];
  const requests = []; // Network.enable 後に送られた通信（URL）
  b.on(m => { if (m.sessionId === sessionId && m.method === 'Network.requestWillBeSent') { const st = m.params.initiator && m.params.initiator.stack; const frames = []; for (let x = st; x; x = x.parent) (x.callFrames || []).forEach(c => frames.push(c.url)); requests.push({ url: m.params.request.url, from: frames }); } });
  b.on(m => { if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });
  await s('Page.enable');
  await s('Runtime.enable');
  if (desktop) {
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  } else {
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
    await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await s('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  }
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
  const results = () => ev(`({ names: [...document.querySelectorAll('#dc-list .dc-name')].map(e => e.lastChild.textContent), none: document.querySelector('#dc-list .dc-none') ? document.querySelector('#dc-list .dc-none').textContent.replace(/\\s+/g, ' ').trim() : null, count: document.getElementById('dc-count').textContent })`);
  const shot = async name => { if (!SHOTS) return; const { data } = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const close = async () => { await b.send('Target.closeTarget', { targetId }); await b.send('Target.disposeBrowserContext', { browserContextId }); };
  return { s, ev, tap, tapSel, type, results, shot, close, errors, requests, browserContextId };
}

async function run() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = BASE ? null : await startServer();
  const base = BASE || `http://127.0.0.1:${server.address().port}`;
  console.log('対象: ' + base);
  const b = await launch();
  try {
    for (const [w, h] of SIZES) {
      console.log(`\n[${w}x${h} iPhone相当]`);
      const p = await openApp(b, base, { width: w, height: h });
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(400);
      const lay = await p.ev(`(() => { const q = document.getElementById('dc-query').getBoundingClientRect(), box = document.querySelector('.dc-sticky'); const cs = getComputedStyle(box); const chips = [...document.querySelectorAll('.dc-ward')]; const first = document.querySelector('#dc-list .dc-row');
        return { active: document.getElementById('tab-avoidance').classList.contains('active'), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
          qH: q.height, qW: q.width, qRight: q.right, inner: box.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          qFont: parseFloat(getComputedStyle(document.getElementById('dc-query')).fontSize),
          mic: !!document.getElementById('dc-mic') || !!document.getElementById('dc-voice') || /🎙/.test(document.getElementById('drop-check').innerHTML),
          chipMinH: Math.min(...chips.map(c => c.getBoundingClientRect().height)), chipLabels: chips.map(c => c.childNodes[0].textContent),
          firstRowTop: first.getBoundingClientRect().top, firstRowH: first.getBoundingClientRect().height, nameFont: parseFloat(getComputedStyle(document.querySelector('.dc-name')).fontSize), total: document.querySelectorAll('#dc-list .dc-item').length }; })()`);
      check('下部ナビ「地雷」→ DROP先照合が開く（全52件）', lay.active && lay.total === 52, lay);
      check('専用🎙️ボタン・音声案内表示が無い', !lay.mic, lay);
      check('検索欄は横幅いっぱい・横スクロールなし', Math.abs(lay.qW - lay.inner) < 1 && lay.qRight <= lay.vw && lay.sw <= lay.vw, lay);
      check('検索欄は大きく（高さ50px以上）・文字16px以上（iPhoneで自動ズームしない）', lay.qH >= 50 && lay.qFont >= 16, lay);
      check('区ボタンは押しやすい大きさ（44px以上）', lay.chipMinH >= 44, lay);
      check('区ボタン: 全・西・此花・港・福島・浪速・北・中央・他（配達で使う順・「区」なし）', lay.chipLabels.join(',') === '全,西,此花,港,福島,浪速,北,中央,他', lay.chipLabels);
      const chipRow = await p.ev(`(() => { const box = document.getElementById('dc-wards'); const bs = [...box.querySelectorAll('.dc-ward')]; const R = bs.map(b => b.getBoundingClientRect());
        return { fits: box.scrollWidth <= box.clientWidth, oneRow: R.every(r => Math.abs(r.top - R[0].top) < 1), minW: Math.min(...R.map(r => r.width)), minH: Math.min(...R.map(r => r.height)),
          font: Math.min(...bs.map(b => parseFloat(getComputedStyle(b).fontSize))), aria: bs.map(b => b.getAttribute('aria-label')).slice(0, 3) }; })()`);
      check('区ボタンは1列（2段にしない）・タップ領域 幅36px以上×高さ44px以上・文字16px', chipRow.oneRow && chipRow.minW >= 36 && chipRow.minH >= 44 && chipRow.font >= 16, chipRow);
      check('読み上げは正式な区名＋件数（すべて 52件・西区 8件…）', chipRow.aria.join() === 'すべて 52件,西区 8件,此花区 3件', chipRow.aria);
      if (w >= 390) check('390px以上: 9個すべて横スクロールなしで1画面に収まる', chipRow.fits, chipRow);
      const chipBox = await p.ev(`(() => { const box = document.getElementById('dc-wards'); const last = [...box.querySelectorAll('.dc-ward')].pop(); box.scrollLeft = box.scrollWidth; const r = last.getBoundingClientRect(); const out = { overflowX: getComputedStyle(box).overflowX, lastRight: r.right, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }; box.scrollLeft = 0; return out; })()`);
      check('区ボタンは最後（他）まで届く（狭い画面は横スクロール）・ページは横スクロールしない', chipBox.overflowX === 'auto' && chipBox.lastRight <= chipBox.vw + 1 && chipBox.sw <= chipBox.vw, chipBox);
      check('最初の物件がスクロールなしで見える・名前は17px以上・押しやすい高さ（44px以上）', lay.firstRowTop < h * 0.6 && lay.firstRowH >= 44 && lay.nameFont >= 17, lay);
      const cards = await p.ev(`(() => { const its = [...document.querySelectorAll('#dc-list .dc-item')]; const pitch = its.map(i => i.getBoundingClientRect().height + parseFloat(getComputedStyle(i).marginBottom));
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect(); const it = its.find(li => li.querySelector('.dc-name').textContent === '阿波座ライズタワーズ フラッグ46');
        const rows = it.querySelector('.dc-row'); const sub = it.querySelector('.dc-sub'), name = it.querySelector('.dc-name'), more = it.querySelector('.dc-more');
        const text = its.map(i => i.querySelector('.dc-row').textContent).join(' ');
        return { avg: pitch.reduce((a, b) => a + b, 0) / pitch.length, max: Math.max(...pitch), visible: its.filter(i => i.getBoundingClientRect().bottom <= nav.top).length,
          sub: sub.textContent, more: more.textContent, dot: it.querySelector('.dc-dot').textContent, subFont: parseFloat(getComputedStyle(sub).fontSize), nameFont: parseFloat(getComputedStyle(name).fontSize),
          nameText: name.textContent, layout: (() => { const R = e => e.getBoundingClientRect(); const n = R(name), m = R(more), s = R(sub), d = R(it.querySelector('.dc-dot')), row = R(rows);
            return { nameTopLeft: n.left < m.left && Math.abs(n.top - m.top) < 8, subBelowName: s.top >= n.bottom - 1 && Math.abs(s.left - n.left) < 1, moreRight: m.right <= row.right && m.left > n.left,
              dotBelowMore: d.top >= m.bottom - 1 && Math.abs(d.right - m.right) < 2, dotSmall: d.height <= n.height }; })(),
          sub2: sub.textContent,
          words: ['未検証', '問題なし', '注意', '避けたい', '一般目安', '要注意', '階', '備考', '情報源', 'tower.ne.jp'].filter(k => text.includes(k)), memoLine: !!document.querySelector('#dc-list .dc-memo-line') }; })()`);
      check('一覧カード: 左上＝物件名（アイコンなし）・左下＝区 町名丁目・右上＝詳細評価・右下＝丸アイコン', cards.nameText === '阿波座ライズタワーズ フラッグ46' && cards.sub === '西区 江之子島2丁目' && cards.more === '詳細評価' && cards.dot === '⚪' && Object.values(cards.layout).every(Boolean) && cards.subFont < cards.nameFont, cards);
      check('一覧カードは約半分の高さ（1件あたり70px以下・旧 約126px）', cards.avg <= 70, cards);
      check('一覧に評価の文字・一般目安・階数・備考・情報源・メモを出さない', cards.words.length === 0 && !cards.memoLine, cards.words);
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
      check('×で検索クリア → 全52件', r.names.length === 52, r.count);

      await p.tapSel('.dc-ward[data-ward="西区"]');
      r = await p.results();
      check('区ボタン「西区」→ 西区の8件をあいうえお順', r.names.join('/') === '阿波座ライズタワーズ フラッグ46/大阪ひびきの街 ザ・サンクタスタワー/ザ・ファインタワー大阪肥後橋/シエリアタワー大阪堀江/ジオタワー新町/D’グラフォート大阪N.Y.タワーHIGOBASHI/プレミストタワー靱本町/プレミストタワー大阪新町ローレルコート', r.names);
      await p.type('新町'); r = await p.results();
      check('区フィルター＋検索（西区・新町）→ 3件', r.names.length === 3 && /^西区/.test(r.count), r);
      await p.ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      await p.tapSel('.dc-ward[data-ward="西区"]');
      r = await p.results();
      check('同じ区をもう一度押す → 解除（全52件）', r.names.length === 52, r.count);
      await p.tapSel('.dc-ward[data-ward="北区"]');
      check('北区 → 13件', (await p.results()).names.length === 13);
      await p.tapSel('.dc-ward[data-ward="all"]');
      check('「すべて」→ 解除（全52件）', (await p.results()).names.length === 52);
      await p.tapSel('.dc-ward[data-ward="浪速区"]');
      r = await p.results();
      check('区ボタン「浪速区」→ 8件・すべて ⚪（未評価から開始）', r.names.length === 8 && /^浪速区 8件/.test(r.count) && await p.ev(`[...document.querySelectorAll('#dc-list .dc-dot')].every(e => e.textContent === '⚪')`), r);
      await p.tapSel('.dc-ward[data-ward="浪速区"]');
      await p.type('浪速区'); r = await p.results();
      check('「浪速区」で検索 → 8件', r.names.length === 8, r.count);
      await p.type('難波'); r = await p.results();
      check('「難波」→ 難波中・ローレル難波など', r.names.includes('ザ・なんばタワーレジデンス・イン・なんばパークス') && r.names.includes('ローレルタワー難波') && r.names.includes('ローレルコート難波'), r.names);
      await p.type('なんば'); r = await p.results();
      check('ひらがな「なんば」→ 浪速区のなんば物件', r.names.includes('なんばグランドマスターズタワー') && r.names.includes('ルネッサなんばタワー') && r.names.includes('ローレルタワー難波'), r.names);
      await p.type('湊町'); r = await p.results();
      check('町名「湊町」→ 4件', r.names.length === 4, r.names);
      await p.type('浪速区 クロス'); r = await p.results();
      check('区＋名前「浪速区 クロス」→ THE CROSS CITY TOWER', r.names.join() === 'THE CROSS CITY TOWER', r.names);
      await p.type('日本橋3丁目'); r = await p.results();
      check('住所「日本橋3丁目」→ エグゼレジデンスタワー', r.names.join() === 'エグゼレジデンスタワー', r.names);
      await p.tapSel('#dc-clear', false);

      // 詳細の開閉
      await p.type('島屋');
      await p.tapSel('#dc-list .dc-item:first-child .dc-row');
      let d = await p.ev(`(() => { const it = document.querySelector('#dc-list .dc-item:first-child'); const det = it.querySelector('.dc-detail'); return { open: !det.hidden, text: det.textContent.replace(/\\s+/g, ' '), link: !!det.querySelector('a[href^="https://"]'), memo: !!det.querySelector('.dc-memo-input'), rel: det.querySelector('.dc-rel') ? det.querySelector('.dc-rel').textContent.replace(/\\s+/g, ' ') : null, expanded: it.querySelector('.dc-row').getAttribute('aria-expanded') }; })()`);
      check('タップで詳細を開く（所在地・本人評価3ボタン・本人メモ）', d.open && d.expanded === 'true' && /大阪市此花区島屋6丁目/.test(d.text) && d.memo, d.text.slice(0, 200));
      check('詳細に一般目安・階数・備考・情報源・説明文・大きな「未検証」を出さない', !['一般目安', '要注意', '備考', '情報源', '未検証', '次の案件', 'Excel', '本人評価ではありません'].some(k => d.text.includes(k)) && !d.link && !/\d+階(?!経由)/.test(d.text.replace(/島屋6丁目/, '')), d.text.slice(0, 300));
      const ed = await p.ev(`(() => { const it = document.querySelector('#dc-list .dc-item:first-child'); const bs = [...it.querySelectorAll('.dc-rbtn')].map(x => x.getBoundingClientRect()); const inp = it.querySelector('.dc-memo-input'); const sv = it.querySelector('.dc-memo-save').getBoundingClientRect();
        return { labels: [...it.querySelectorAll('.dc-rbtn')].map(x => x.textContent.trim()), minH: Math.min(...bs.map(r => r.height)), sameRow: bs.every(r => Math.abs(r.top - bs[0].top) < 1), right: Math.max(...bs.map(r => r.right), sv.right), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
          inputFont: parseFloat(getComputedStyle(inp).fontSize), inputH: inp.getBoundingClientRect().height, saveH: sv.height, unrate: !!it.querySelector('[data-unrate]'), count: it.querySelector('[data-count]').textContent }; })()`);
      check('評価ボタン3つ（🟢問題なし・🟡注意・🔴避けたい）が1列で押しやすい・未検証には「戻す」なし', ed.labels.join(',') === '🟢問題なし,🟡注意,🔴避けたい' && ed.minH >= 48 && ed.sameRow && ed.right <= ed.vw && ed.sw <= ed.vw && !ed.unrate, ed);
      check('メモ欄: 1行・文字17px（自動ズームしない）・保存ボタン44px以上・「0/20文字」表示', ed.inputFont >= 16 && ed.inputH >= 44 && ed.saveH >= 44 && ed.count === '0/20文字', ed);
      check('詳細に「同じ町への実走記録」（9/17 モス）を1行で参考表示', !!d.rel && /実走記録/.test(d.rel) && /モスバーガー/.test(d.rel), d.rel);
      // 実走記録の参考枠（この町だけにある）を除いた高さ
      const dh = await p.ev(`(() => { const it = document.querySelector('#dc-list .dc-item:first-child'); const rel = it.querySelector('.dc-rel'); return it.getBoundingClientRect().height - (rel ? rel.getBoundingClientRect().height + parseFloat(getComputedStyle(rel).marginTop) : 0); })()`);
      check(`詳細を開いたカードはコンパクト（${w >= 390 ? 250 : 300}px以下・旧 390px幅で約630px）`, dh <= (w >= 390 ? 250 : 300), dh);
      const fit = await p.ev(`[...document.querySelectorAll('#dc-list .dc-item:first-child .dc-rbtn')].every(b => b.scrollWidth <= b.clientWidth + 1)`);
      check('評価ボタンの文字がはみ出さない', fit);
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

      // ひらがな・区＋名前（キーボード入力）
      await p.ev('window.scrollTo(0, 0)');
      await p.type('らいず'); r = await p.results();
      check('ひらがな「らいず」→ 阿波座ライズタワーズ', r.names.join() === '阿波座ライズタワーズ フラッグ46', r);
      await p.type('西区 ライズ'); r = await p.results();
      check('区＋名前「西区 ライズ」→ 1件', r.names.join() === '阿波座ライズタワーズ フラッグ46', r);
      // キーボードの音声入力🎤: 確定文字がまとめて入る → その場で検索に反映
      await p.type('西区ライズ。'); r = await p.results();
      check('キーボード音声入力相当（「西区ライズ。」を一括入力）→ 即時に1件', r.names.join() === '阿波座ライズタワーズ フラッグ46', r);
      // 変換中（未確定）→ 確定 でも入力が途切れず、確定文字で検索される
      await p.ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      await p.tapSel('#dc-query', false);
      await p.s('Input.imeSetComposition', { text: 'あっぷる', selectionStart: 4, selectionEnd: 4 });
      await sleep(150);
      await p.s('Input.insertText', { text: 'アップル' });
      await sleep(200);
      r = await p.results();
      const qv = await p.ev(`document.getElementById('dc-query').value`);
      check('日本語変換（あっぷる→アップル確定）→ 欄の文字が崩れず即時に1件', qv === 'アップル' && r.names.join() === '淀屋橋アップルタワーレジデンス', { qv, r });
      await p.tapSel('#dc-clear', false);

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
      const p = await openApp(b, base, { width: w, height: h });
      await p.ev(`(() => { try { localStorage.removeItem('uber_drop_personal_v1'); } catch (e) {} })()`);
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      const card = async () => p.ev(`(() => { const it = [...document.querySelectorAll('#dc-list .dc-item')].find(li => li.querySelector('.dc-name').lastChild.textContent === '阿波座ライズタワーズ フラッグ46'); if (!it) return null;
        const my = window.__dropCheck.personal.get(it.dataset.id) || {}; const inp = it.querySelector('.dc-memo-input');
        return { rate: it.querySelector('.dc-dot').textContent, rowText: it.querySelector('.dc-row').textContent.replace(/\\s+/g, ' ').trim(), cls: it.dataset.rating, memo: my.note || null, memoInput: inp ? inp.value : null, saved: it.querySelector('.dc-saved') ? it.querySelector('.dc-saved').textContent : null,
          on: [...it.querySelectorAll('.dc-rbtn.on')].map(x => x.dataset.rate), unrate: it.querySelector('[data-unrate]') ? it.querySelector('[data-unrate]').textContent : null, open: it.classList.contains('open') }; })()`);
      const sel = '#dc-list .dc-item:first-child';
      // 物件検索 → タップ → 「避けたい」
      await p.type('ライズ');
      await p.tapSel(`${sel} .dc-row`);
      let c = await card();
      check('検索→物件をタップ → 詳細が開き ⚪（未評価・ボタンはどれも未選択）', c.open && c.rate === '⚪' && c.cls === 'none' && c.on.length === 0, c);
      await p.tapSel(`${sel} [data-rate="avoid"]`);
      c = await card();
      check('「🔴 避けたい」をタップ → 一覧の丸アイコンが 🔴 に即反映（文字は出さない）・保存メッセージ', c.rate === '🔴' && c.cls === 'avoid' && !/避けたい/.test(c.rowText) && c.on.join() === 'avoid' && /避けたい.*保存/.test(c.saved) && c.unrate === '未検証に戻す', c);
      await p.shot(`rate_${w}_avoid`);
      // 本人メモ
      await p.tapSel(`${sel} .dc-memo-input`);
      await p.s('Input.insertText', { text: '3階経由・館内長い' });
      await sleep(150);
      const cnt = await p.ev(`document.querySelector('${sel} [data-count]').textContent`);
      check('メモ入力中は文字数を表示（9/20文字）', cnt === '9/20文字', cnt);
      await p.tapSel(`${sel} [data-memo-save]`);
      c = await card();
      check('保存 → 端末に保存・詳細のメモ欄に残る（一覧には出さない）', c.memo === '3階経由・館内長い' && c.memoInput === '3階経由・館内長い' && !/3階経由/.test(c.rowText) && /メモを保存/.test(c.saved), c);
      const vis = await p.ev(`(() => { const it = document.querySelector('${sel}'); const badge = it.querySelector('.dc-dot').getBoundingClientRect(); const st = document.querySelector('.dc-sticky').getBoundingClientRect(); return { badgeTop: badge.top, stickyBottom: st.bottom, vh: innerHeight }; })()`);
      check('保存後、カード先頭（丸アイコン・物件名）が検索欄の下に見えている', vis.badgeTop >= vis.stickyBottom && vis.badgeTop < vis.vh * 0.6, vis);
      await p.shot(`rate_${w}_memo`);
      // 別の評価へ変更・メモ変更
      await p.tapSel(`${sel} [data-rate="ok"]`);
      c = await card();
      check('評価を「🟢 問題なし」に変更', c.rate === '🟢' && c.cls === 'ok' && c.on.join() === 'ok', c);
      await p.ev(`(() => { const i = document.querySelector('${sel} .dc-memo-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.tapSel(`${sel} .dc-memo-input`);
      await p.s('Input.insertText', { text: 'EV速い' });
      await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(200);
      c = await card();
      check('メモ変更（キーボードの完了キーでも保存）', c.memo === 'EV速い', c);
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
      check('再読み込み後も評価とメモが残る（🟢・「EV速い」）', c.rate === '🟢' && c.memo === 'EV速い', c);
      // 区フィルター・検索結果でも反映、件数は52のまま
      await p.ev(`(() => { const i = document.getElementById('dc-query'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      await p.tapSel('.dc-ward[data-ward="西区"]');
      c = await card();
      const n = await p.ev(`document.querySelectorAll('#dc-list .dc-item').length`);
      check('区フィルター（西区）でも本人評価（🟢）を表示・メモ保持・8件のまま', c.rate === '🟢' && c.memo === 'EV速い' && n === 8, { c, n });
      await p.tapSel('.dc-ward[data-ward="all"]');
      check('全件は52件のまま', await p.ev(`document.querySelectorAll('#dc-list .dc-item').length`) === 52);
      // 未検証に戻す（2回押し）
      await p.type('ライズ');
      await p.tapSel(`${sel} .dc-row`);
      await p.tapSel(`${sel} [data-unrate]`);
      c = await card();
      check('「未検証に戻す」1回目は確認表示だけ（評価はそのまま）', c.rate === '🟢' && c.unrate === 'もう一度押すと未検証に戻ります', c);
      await p.tapSel(`${sel} [data-unrate]`);
      c = await card();
      const stored = await p.ev(`JSON.parse(localStorage.getItem('uber_drop_personal_v1')).items`);
      const rec = Object.values(stored)[0];
      check('2回目で未検証に戻る（⚪・評価 null・メモは残る）', c.rate === '⚪' && c.cls === 'none' && c.memo === 'EV速い' && c.memoInput === 'EV速い' && rec.rating === null && rec.note === 'EV速い', { c, rec });
      check('横スクロールなし', await p.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    for (const [w, h] of [[390, 844], [320, 568]]) {
      console.log(`\n[表示順 名前順／評価別 ${w}x${h}]`);
      const p = await openApp(b, base, { width: w, height: h });
      await p.ev(`(() => { try { localStorage.removeItem('uber_drop_personal_v1'); localStorage.removeItem('uber_drop_view_v1'); } catch (e) {} })()`);
      await p.s('Page.reload', {});
      for (let i = 0; i < 40; i++) { await sleep(250); try { if (await p.ev('document.readyState === "complete" && !!window.__dropCheck')) break; } catch (e) { /* 読み込み中 */ } }
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      // 一覧の並び（見出しごとに区切る）
      const listed = () => p.ev(`(() => { const out = { headers: [], groups: [], flat: [] }; let g = null;
        [...document.getElementById('dc-list').children].forEach(li => {
          if (li.classList.contains('dc-group-h')) { g = { code: li.dataset.group, text: li.textContent.trim(), names: [], dots: [] }; out.groups.push(g); out.headers.push(li.textContent.trim()); }
          else if (li.classList.contains('dc-item')) { const nm = li.querySelector('.dc-name').textContent; out.flat.push(nm); if (g) { g.names.push(nm); g.dots.push(li.dataset.rating); } }
        }); return out; })()`);
      const nameOrder = await p.ev(`window.DropCheck.search(window.__dropCheck.buildings, {}).map(b => b.name)`);
      const sortUi = await p.ev(`(() => { const bs = [...document.querySelectorAll('#dc-sort [data-sort]')]; return { labels: bs.map(b => b.textContent), pressed: bs.map(b => b.getAttribute('aria-pressed')), minH: Math.min(...bs.map(b => b.getBoundingClientRect().height)), right: Math.max(...bs.map(b => b.getBoundingClientRect().right)), vw: document.documentElement.clientWidth }; })()`);
      check('表示切替［名前順］［評価別］・初期は名前順・押しやすい（44px以上）・画面内', sortUi.labels.join() === '名前順,評価別' && sortUi.pressed.join() === 'true,false' && sortUi.minH >= 44 && sortUi.right <= sortUi.vw, sortUi);
      let L = await listed();
      check('名前順: 見出しなし・52件を五十音順（従来どおり）', L.headers.length === 0 && L.flat.length === 52 && L.flat.join('/') === nameOrder.join('/'), L.flat.slice(0, 5));

      // 本人評価を付ける（避けたい1・注意2・問題なし1）
      await p.ev(`(() => { const dc = window.__dropCheck; const by = n => dc.buildings.find(b => b.name === n);
        dc.personal.setRating(by('阿波座ライズタワーズ フラッグ46'), 'avoid'); dc.personal.setRating(by('ジオタワー新町'), 'caution'); dc.personal.setRating(by('ローレルタワー難波'), 'caution');
        dc.personal.setRating(by('ザ・タワー大阪'), 'ok'); dc.render(); })()`);
      await p.tapSel('#dc-sort [data-sort="rating"]', false);
      L = await listed();
      const inNameOrder = names => names.join('/') === nameOrder.filter(n => names.includes(n)).join('/');
      check('評価別: 🔴避けたい→🟡注意→🟢問題なし→⚪未検証 の4グループ（件数つき）', L.headers.join(',') === '🔴 避けたい（1）,🟡 注意（2）,🟢 問題なし（1）,⚪ 未検証（48）', L.headers);
      check('評価別: 各グループに正しい物件（丸アイコンと一致）・合計52件', L.groups[0].names.join() === '阿波座ライズタワーズ フラッグ46' && L.groups[1].names.slice().sort().join() === ['ジオタワー新町', 'ローレルタワー難波'].sort().join() && L.groups[2].names.join() === 'ザ・タワー大阪'
        && L.groups.every(g => g.dots.every(d => d === g.code)) && L.flat.length === 52, L.groups.map(g => [g.code, g.names.length]));
      check('評価別: 各グループ内は五十音順', L.groups.every(g => inNameOrder(g.names)), L.groups.map(g => g.names.slice(0, 3)));
      const rs = await p.ev(`(() => { const its = [...document.querySelectorAll('#dc-list .dc-item')]; const pitch = its.map(i => i.getBoundingClientRect().height + parseFloat(getComputedStyle(i).marginBottom)); return { avg: pitch.reduce((a, b) => a + b, 0) / pitch.length, sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }; })()`);
      check('評価別でもカードは70px以下・横スクロールなし', rs.avg <= 70 && rs.sw <= rs.vw, rs);
      await p.shot(`sort_${w}_rating`);

      // 区フィルター＋評価別
      await p.tapSel('.dc-ward[data-ward="西区"]');
      L = await listed();
      check('西区＋評価別: 西区8件だけを 🔴1・🟡1・⚪6 に分類', L.headers.join(',') === '🔴 避けたい（1）,🟡 注意（1）,⚪ 未検証（6）' && L.flat.length === 8, L.headers);
      await p.tapSel('.dc-ward[data-ward="西区"]');
      await p.tapSel('.dc-ward[data-ward="浪速区"]');
      L = await listed();
      check('浪速区＋評価別: 🟡1・⚪7', L.headers.join(',') === '🟡 注意（1）,⚪ 未検証（7）' && L.groups[0].names.join() === 'ローレルタワー難波', L.headers);
      await p.tapSel('.dc-ward[data-ward="浪速区"]');
      // 検索＋評価別（該当のあるグループだけ）
      await p.type('タワー大阪');
      L = await listed();
      check('検索＋評価別: 該当があるグループの見出しだけ表示', L.headers.length >= 1 && L.groups.every(g => g.names.length > 0) && L.groups.some(g => g.code === 'ok' && g.names.includes('ザ・タワー大阪')) && !L.headers.some(h => /避けたい/.test(h)), L.headers);
      await p.type('ライズ');
      L = await listed();
      check('検索1件＋評価別: 見出し1つ＋1件', L.headers.join() === '🔴 避けたい（1）' && L.flat.join() === '阿波座ライズタワーズ フラッグ46', L);

      // 評価変更 → 正しいグループへ即移動・未検証に戻す → ⚪へ
      await p.type('アップル');
      await p.tapSel('#dc-list .dc-item .dc-row');
      L = await listed();
      check('評価前: ⚪グループ', L.groups.length === 1 && L.groups[0].code === 'none', L.headers);
      await p.tapSel('#dc-list .dc-item [data-rate="ok"]');
      L = await listed();
      const stillOpen = await p.ev(`!!document.querySelector('#dc-list .dc-item.open [data-rate="ok"][aria-pressed="true"]')`);
      check('🟢 をタップ → すぐ 🟢問題なし グループへ移動（詳細は開いたまま）', L.headers.join() === '🟢 問題なし（1）' && stillOpen, L.headers);
      await p.tapSel('#dc-list .dc-item [data-unrate]');
      await p.tapSel('#dc-list .dc-item [data-unrate]');
      L = await listed();
      check('未検証に戻す → ⚪未検証 グループへ移動', L.headers.join() === '⚪ 未検証（1）', L.headers);
      await p.tapSel('#dc-clear', false);
      L = await listed();
      check('検索クリア → 🔴1・🟡2・🟢1・⚪48（アップルは⚪に戻った）', L.headers.join(',') === '🔴 避けたい（1）,🟡 注意（2）,🟢 問題なし（1）,⚪ 未検証（48）', L.headers);

      // 再読み込み後も評価別のまま・本人データは別キーで無傷
      await p.s('Page.reload', {});
      for (let i = 0; i < 40; i++) { await sleep(250); try { if (await p.ev('document.readyState === "complete" && !!window.__dropCheck')) break; } catch (e) { /* 読み込み中 */ } }
      await p.tapSel('.bottom-nav [data-tab="avoidance"]', false);
      await sleep(300);
      L = await listed();
      const st = await p.ev(`({ view: localStorage.getItem('uber_drop_view_v1'), schema: JSON.parse(localStorage.getItem('uber_drop_personal_v1')).schema, n: Object.values(JSON.parse(localStorage.getItem('uber_drop_personal_v1')).items).filter(x => x.rating).length, pressed: document.querySelector('#dc-sort [data-sort="rating"]').getAttribute('aria-pressed') })`);
      check('再読み込み後も評価別のまま（uber_drop_view_v1 に保存・本人データは別キーのまま）', st.view === '{"sort":"rating"}' && st.pressed === 'true' && st.schema === 'uber_drop_personal/1' && st.n === 4 && L.headers.length === 4, st);
      await p.tapSel('#dc-sort [data-sort="name"]', false);
      L = await listed();
      check('名前順に戻す → 見出しなし・52件五十音順・保存も名前順', L.headers.length === 0 && L.flat.join('/') === nameOrder.join('/') && await p.ev(`localStorage.getItem('uber_drop_view_v1')`) === '{"sort":"name"}', L.headers);
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      await p.close();
    }

    for (const [label, w, h, desktop] of [['iPhone 12 Pro相当', 390, 844, false], ['iPhone SE相当', 320, 568, false], ['PC', 1280, 800, true]]) {
      console.log(`\n[データ管理: JSONバックアップ書き出し ${label} ${w}x${h}]`);
      const p = await openApp(b, base, { width: w, height: h, desktop });
      const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-backup-dl-'));
      await b.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl, browserContextId: p.browserContextId, eventsEnabled: true });
      const click = async sel => { if (desktop) { await p.ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }); document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(200); } else await p.tapSel(sel); };
      // 現行形式＋未知の項目を持つ本人データを入れて読み込み直す
      const sample = { schema: 'uber_drop_personal/1', updated_at: '2026-10-01T12:00:05.000Z', extra_top: 1, items: {
        bld_b64ef0b3d7: { rating: 'avoid', note: '館内長い', tags: ['t1'], verified_at: '2026-10-01T11:00:00.000Z', rating_updated_at: '2026-10-01T11:30:00.000Z', note_updated_at: '2026-10-01T11:31:00.000Z', updated_at: '2026-10-01T11:31:00.000Z', ref: { name: '大阪ひびきの街 ザ・サンクタスタワー', ward: '西区', address: '大阪市西区新町1丁目14-21' }, future: { x: [1, null] } },
        bld_9213a54b72: { rating: null, note: 'メモのみ', tags: [], verified_at: null, rating_updated_at: '2026-10-01T10:00:00.000Z', note_updated_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T10:00:00.000Z', ref: { name: 'ローレルコート難波', ward: '浪速区', address: '大阪市浪速区湊町1丁目4-36' } } } };
      await p.ev(`localStorage.setItem('uber_drop_personal_v1', ${JSON.stringify(JSON.stringify(sample))}); localStorage.setItem('uber_drop_view_v1', '{"sort":"rating"}')`);
      await p.s('Page.reload', {});
      for (let i = 0; i < 40; i++) { await sleep(250); try { if (await p.ev('document.readyState === "complete" && !!window.__dropCheck && !!window.DropBackup')) break; } catch (e) { /* 読み込み中 */ } }
      await click('.bottom-nav [data-tab="avoidance"]');
      await sleep(300);
      const ui0 = await p.ev(`(() => { const d = document.getElementById('dc-backup'); const sm = d.querySelector('summary').getBoundingClientRect(); const legacy = document.getElementById('avoidance-legacy');
        return { closed: !d.open, summaryH: sm.height, summaryText: d.querySelector('summary').textContent.trim(), afterList: !!(document.getElementById('dc-list').compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING), beforeLegacy: !!(d.compareDocumentPosition(legacy) & Node.DOCUMENT_POSITION_FOLLOWING), cards: document.querySelectorAll('#dc-list .dc-item').length }; })()`);
      check('データ管理は一覧の下に閉じた1行だけ（メイン画面はそのまま・52件）', ui0.closed && ui0.summaryH <= 52 && ui0.afterList && ui0.beforeLegacy && ui0.cards === 52 && /データ管理/.test(ui0.summaryText), ui0);
      const snap = () => p.ev(`JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))`);
      const before = await snap();
      await click('#dc-backup > summary');
      await sleep(200);
      const ui1 = await p.ev(`(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { count: document.getElementById('dcb-count').textContent, memoH: r('dcb-memo').height, btnH: r('dcb-download').height, memoFont: parseFloat(getComputedStyle(document.getElementById('dcb-memo')).fontSize), right: Math.max(r('dcb-memo').right, r('dcb-download').right), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }; })()`);
      check('開くと「DROP個人データ 2件」・端末メモ欄・書き出しボタン（44px以上・文字16px）・横スクロールなし', ui1.count === '2件' && ui1.memoH >= 44 && ui1.btnH >= 44 && ui1.memoFont >= 16 && ui1.right <= ui1.vw && ui1.sw <= ui1.vw, ui1);
      await p.shot(`backup_${w}_open`);
      // 端末メモありで書き出す（通信を記録）
      await p.s('Network.enable');
      p.requests.length = 0;
      await p.ev(`(() => { const i = document.getElementById('dcb-memo'); i.value = '12ProHome'; })()`);
      await click('#dcb-download');
      let file = null;
      for (let i = 0; i < 40 && !file; i++) { await sleep(200); const fs2 = fs.readdirSync(dl).filter(n => !/\.crdownload$/.test(n)); if (fs2.length) file = fs2[0]; }
      const last = await p.ev('window.__dropBackupLast');
      const stored = await p.ev(`localStorage.getItem('uber_drop_personal_v1')`);
      const saved = file ? JSON.parse(fs.readFileSync(path.join(dl, file), 'utf8')) : null;
      check('端末メモありで書き出し → ファイル名 uber_drop_backup_12ProHome_YYYY-MM-DD_HHMM.json', !!last && /^uber_drop_backup_12ProHome_\d{4}-\d\d-\d\d_\d{4}\.json$/.test(last.name), last && last.name);
      check('実際にファイルが保存され、内容は画面で作った JSON と同じ', !!saved && JSON.stringify(saved) === JSON.stringify(JSON.parse(last.text)), file);
      check('source_data は書き出し直前の localStorage 値と完全一致・source_raw は保存文字列そのもの', !!saved && JSON.stringify(saved.source_data) === JSON.stringify(JSON.parse(stored)) && saved.source_raw === stored && saved.source_item_count === 2 && saved.source_present === true, saved && Object.keys(saved));
      check('rating・note・日時・ref・tags・未知の項目を保持', !!saved && saved.source_data.items.bld_b64ef0b3d7.rating === 'avoid' && saved.source_data.items.bld_b64ef0b3d7.note === '館内長い' && saved.source_data.items.bld_b64ef0b3d7.verified_at === '2026-10-01T11:00:00.000Z'
        && saved.source_data.items.bld_b64ef0b3d7.ref.name === '大阪ひびきの街 ザ・サンクタスタワー' && saved.source_data.items.bld_b64ef0b3d7.tags[0] === 't1' && JSON.stringify(saved.source_data.items.bld_b64ef0b3d7.future) === '{"x":[1,null]}' && saved.source_data.extra_top === 1);
      check('メタ情報（backup_schema・端末メモ・アプリ版・表示モード）', !!saved && saved.backup_schema === 'uber_drop_backup/1' && saved.device_memo === '12ProHome' && /^\d{8}_v\d+$/.test(saved.app_version) && saved.display_mode === 'browser' && saved.source_storage_key === 'uber_drop_personal_v1', saved && { m: saved.device_memo, v: saved.app_version });
      check('書き出し後も localStorage は完全に同じ（全キー）', (await snap()) === before);
      check('書き出しで通信しない（書き出し処理からの通信なし・Supabase や外部への通信なし）', !p.requests.some(r => r.from.some(u => /drop-backup\.js/.test(u))) && !p.requests.some(r => /supabase/i.test(r.url) || (!/^(blob|data):/.test(r.url) && new URL(r.url).origin !== new URL(base).origin)), p.requests);
      check('書き出したことを表示', /書き出しました: uber_drop_backup_12ProHome_.*（2件）/.test(await p.ev(`document.getElementById('dcb-status').textContent`)));
      // 一覧・評価別・区フィルター・評価変更はそのまま動く
      const list = await p.ev(`({ headers: [...document.querySelectorAll('#dc-list .dc-group-h')].map(e => e.textContent), n: document.querySelectorAll('#dc-list .dc-item').length })`);
      check('評価別（保存済みの表示モード）と本人評価がそのまま表示される', list.headers[0] === '🔴 避けたい（1）' && list.n === 52, list);
      // 0件: 保存データなしでも書き出せる（端末メモなし）
      await p.ev(`localStorage.removeItem('uber_drop_personal_v1')`);
      await click('#dc-backup > summary'); await sleep(150); await click('#dc-backup > summary'); await sleep(200);
      const zeroCount = await p.ev(`document.getElementById('dcb-count').textContent`);
      const before0 = await snap();
      await p.ev(`document.getElementById('dcb-memo').value = ''`);
      fs.readdirSync(dl).forEach(n => fs.unlinkSync(path.join(dl, n)));
      await click('#dcb-download');
      let file0 = null;
      for (let i = 0; i < 40 && !file0; i++) { await sleep(200); const fs2 = fs.readdirSync(dl).filter(n => !/\.crdownload$/.test(n)); if (fs2.length) file0 = fs2[0]; }
      const last0 = await p.ev('window.__dropBackupLast');
      const saved0 = file0 ? JSON.parse(fs.readFileSync(path.join(dl, file0), 'utf8')) : null;
      check('0件（保存データなし）でも端末メモなしで書き出せる', zeroCount === '0件（保存データなし）' && /^uber_drop_backup_\d{4}-\d\d-\d\d_\d{4}\.json$/.test(last0.name) && !!saved0 && saved0.source_present === false && saved0.source_item_count === 0 && saved0.source_data === null && saved0.device_memo === null, { zeroCount, name: last0.name });
      check('0件の書き出しでも localStorage を作らない・変えない', (await snap()) === before0 && await p.ev(`localStorage.getItem('uber_drop_personal_v1')`) === null);
      check('復元（インポート）の操作は置かない', await p.ev(`!document.querySelector('#dc-backup input[type="file"]') && !/復元|インポート|読み込む/.test(document.getElementById('dc-backup').textContent)`));
      check('横スクロールなし', await p.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
      check('JavaScript エラーなし', p.errors.length === 0, p.errors);
      fs.rmSync(dl, { recursive: true, force: true });
      await p.close();
    }

    console.log('\n[検索欄の属性（連絡先の自動入力を出しにくくする）390x844]');
    {
      const p = await openApp(b, base, { width: 390, height: 844 });
      const a = await p.ev(`(() => { const i = document.getElementById('dc-query'); const at = {}; [...i.attributes].forEach(x => { at[x.name] = x.value; }); return at; })()`);
      check('type=search・autocomplete=off・自動修正/大文字化/スペルチェック off', a.type === 'search' && a.autocomplete === 'off' && a.autocorrect === 'off' && a.autocapitalize === 'off' && a.spellcheck === 'false', a);
      const words = [a.name, a.placeholder, a['aria-label'], a.id].join(' ');
      check('name・placeholder・ラベルに連絡先と推測される語（名前・氏名・住所・電話・name・address 等）を含まない', !/名前|氏名|住所|電話|メール|name|address|street|city|zip|postal|phone|tel|email|contact/i.test(words), words);
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
