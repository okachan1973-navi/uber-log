#!/usr/bin/env node
/**
 * 履歴タブ（日別アコーディオン）のブラウザテスト（Microsoft Edge ヘッドレス + DevTools Protocol, iPhone相当）
 *   node tools/history/spec/history-e2e.js [--shots <dir>] [--base <公開URL>]
 * 新しいブラウザ（未ログイン）で、アプリ同梱の公式取込データを使って確認する（日別の数値は確定済みの過去日 9/19・9/22・9/24・10/5 で確認）。
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-e2e-'));
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

async function openApp(b, base, { width, height }) {
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
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  await s('Page.navigate', { url: `${base}/index.html` });
  // Service Worker が有効になった瞬間の自動リロードを待つ
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (await ev('document.readyState === "complete" && !!window.store')) break; } catch (e) { /* 読み込み中 */ } }
  for (let i = 0; i < 40; i++) { try { if (await ev(`!('serviceWorker' in navigator) || !!navigator.serviceWorker.controller`)) break; } catch (e) { /* リロード中 */ } await sleep(250); }
  await sleep(1000);
  for (let i = 0; i < 40; i++) { try { if (await ev('document.readyState === "complete" && !!window.store')) break; } catch (e) { /* リロード中 */ } await sleep(250); }
  const tap = async (x, y) => {
    await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4 }] });
    await sleep(40);
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const tapSel = async (sel, scroll = true) => {
    if (scroll) { await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`); await sleep(250); }
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await tap(r.x, r.y);
    await sleep(250);
  };
  const shot = async name => { if (!SHOTS) return; const { data } = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const close = async () => { await b.send('Target.closeTarget', { targetId }); await b.send('Target.disposeBrowserContext', { browserContextId }); };
  return { s, ev, tapSel, shot, close, errors };
}

// 閉じた行の検査（各行が1行に収まっているか）
const ROWS_JS = `[...document.querySelectorAll('#history-list-container .history-card .hr-line')].map(h => { const kids = [...h.children].map(c => c.getBoundingClientRect()); const r = h.getBoundingClientRect();
  return { date: h.closest('.history-card').dataset.date, t: [...h.children].map(c => c.textContent.trim()).join(' '), h: r.height, oneLine: kids.every(k => Math.abs((k.top + k.bottom) / 2 - (kids[0].top + kids[0].bottom) / 2) < 3), over: h.scrollWidth > h.clientWidth + 1,
    right: Math.max(...kids.map(k => k.right)), boxRight: r.right, badges: h.querySelectorAll('.day-attr-badge').length }; })`;
// 展開内の3ブロックを {見出し: {項目: 値}} で読む
const DETAIL_JS = date => `(() => { const c = document.querySelector('.history-card[data-date="${date}"]'); const out = { open: c.classList.contains('expanded'), icon: c.querySelector('.expand-icon').textContent, blocks: {}, notes: [], heads: [] };
  c.querySelectorAll('.hd-block').forEach(b => { const head = b.querySelector('.hd-head').textContent.trim(); out.heads.push(head); const rows = {}; b.querySelectorAll('.hd-row').forEach(r => { rows[r.querySelector('.hd-label').textContent.trim()] = r.querySelector('.hd-val').textContent.trim(); }); out.blocks[b.querySelector('.hd-head').lastChild.textContent.trim()] = rows; });
  c.querySelectorAll('.hd-note').forEach(n => out.notes.push(n.textContent.trim()));
  out.deliveries = c.querySelectorAll('.delivery-list > *').length; out.evalBtns = c.querySelectorAll('.btn-eval').length; out.sortBtn = !!c.querySelector('.btn-history-sort-toggle');
  out.text = c.querySelector('.history-card-body').textContent; return out; })()`;

async function run() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = BASE ? null : await startServer();
  const base = BASE || `http://127.0.0.1:${server.address().port}`;
  console.log('対象: ' + base);
  const b = await launch();
  try {
    for (const [w, h] of [[375, 812], [390, 844], [430, 932]]) {
      console.log(`\n[履歴 ${w}x${h} iPhone相当]`);
      const p = await openApp(b, base, { width: w, height: h });
      await p.tapSel('.bottom-nav [data-tab="history"]', false);
      await sleep(400);
      // 一覧表示に切り替え（カレンダー表示を記憶していても一覧で確認）
      await p.ev(`(() => { const btn = document.querySelector('[data-view="list"]'); if (btn) btn.click(); })()`);
      await sleep(200);
      const rows = await p.ev(ROWS_JS);
      // 同梱の公式データで配達がある日の数（アプリの稼働日判定とは別に数える。取込で日が増えても固定値で壊れない）
      const workedDays = await p.ev(`Object.values(getConfirmedSeedData().dailyLogs).filter(l => (l.deliveries || []).length > 0).length`);
      check(`稼働日が並ぶ（同梱データで配達のある ${workedDays}日）`, workedDays >= 21 && rows.length === workedDays, { rows: rows.length, workedDays });
      const fmt = /^\d{1,2}\/\d{1,2}\([月火水木金土日]\) 📦\d+件 🚲\d+\.\dkm 💰[\d,]+円 ▼$/;
      check('閉じた行は「10/5(月) 📦17件 🚲34.2km 💰10,666円 ▼」の形（日付・件数・距離小数1桁・総売上・▼）', rows.every(r => fmt.test(r.t)), rows.filter(r => !fmt.test(r.t)).map(r => r.t));
      check('10/5 の閉じた行', (rows.find(r => r.date === '2026-10-05') || {}).t === '10/5(月) 📦17件 🚲34.2km 💰10,666円 ▼', rows[0]);
      check('💰 は総売上（9/19 は 21,310円。経費を引いた利益ではない）', /💰21,310円/.test((rows.find(r => r.date === '2026-09-19') || {}).t), rows.find(r => r.date === '2026-09-19'));
      check(`全行が1行に収まる（折り返し・はみ出しなし）・高さ52px以下`, rows.every(r => r.oneLine && !r.over && r.h <= 52 && r.right <= r.boxRight + 1), rows.filter(r => !(r.oneLine && !r.over && r.h <= 52)).slice(0, 3));
      check('閉じた行に属性バッジ（B・調・🏆・♥）を出さない', rows.every(r => r.badges === 0));
      // 想定上の最大値（100件・100.0km・100,000円・10/31(土)）でも1行
      const worst = await p.ev(`(() => { const src = document.querySelector('#history-list-container .history-card'); const c = src.cloneNode(true); c.dataset.date = 'worst'; const h = c.querySelector('.hr-line');
        h.querySelector('.hr-date').textContent = '10/31(土)'; const big = ${w >= 430}; h.querySelector('.hr-count').textContent = big ? '📦100件' : '📦49件'; h.querySelector('.hr-dist').textContent = big ? '🚲100.0km' : '🚲99.9km'; h.querySelector('.hr-amount').textContent = big ? '💰100,000円' : '💰39,999円';
        src.parentNode.appendChild(c); const kids = [...h.children].map(k => k.getBoundingClientRect()); const r = { oneLine: kids.every(k => Math.abs((k.top + k.bottom) / 2 - (kids[0].top + kids[0].bottom) / 2) < 3), over: h.scrollWidth > h.clientWidth + 1, overBy: h.scrollWidth - h.clientWidth, h: h.getBoundingClientRect().height }; c.remove(); return r; })()`);
      check(w >= 430 ? '最大想定（10/31(土) 📦100件 🚲100.0km 💰100,000円）でも1行' : '大きめの日（10/31(土) 📦49件 🚲99.9km 💰39,999円）でも1行', worst.oneLine && !worst.over && worst.h <= 52, worst);
      const font = await p.ev(`(() => { const h = document.querySelector('.hr-line'); const f = c => parseFloat(getComputedStyle(h.querySelector(c)).fontSize); return { date: f('.hr-date'), count: f('.hr-count'), dist: f('.hr-dist'), amount: f('.hr-amount') }; })()`);
      check('v57より大きい文字（日付16・件数17・距離16・売上19px）・売上が一番大きい', font.date >= 16 && font.count >= 17 && font.dist >= 16 && font.amount >= 19 && font.amount > Math.max(font.date, font.count, font.dist), font);
      check('経費・利益は一覧に出さない', rows.every(r => !/経費|利益/.test(r.t)));
      const ver = await p.ev(`({ label: document.getElementById('settings-app-version-desc').textContent, running: window.UBER_LOG_APP_VERSION })`);
      check('設定画面のアプリバージョンは実際に動いている版（固定文字列ではない）', /^\d{8}_v\d+$/.test(ver.running) && ver.label.startsWith('v' + ver.running), ver);
      check('横スクロールなし', await p.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
      await p.shot(`history_${w}_list`);

      // 10/5 を開く
      await p.tapSel('.history-card[data-date="2026-10-05"] .history-card-header');
      let d = await p.ev(DETAIL_JS('2026-10-05'));
      check('タップで展開・▲', d.open && d.icon === '▲', { open: d.open, icon: d.icon });
      check('展開は 💰 収益・🚲 稼働・📊 効率 の3ブロック', d.heads.join(',') === '💰収益,🚲稼働,📊効率', d.heads);
      check('収益: 総売上 10,666円・配達報酬 5,016円・クエスト 5,650円・特別クエスト 0円', JSON.stringify(d.blocks['収益']) === JSON.stringify({ 総売上: '10,666円', 配達報酬: '5,016円', クエスト: '5,650円', 特別クエスト: '0円' }), d.blocks['収益']);
      check('稼働: 17件・34.2km・3時間46分（Uber公式の実働時間 226分）', JSON.stringify(d.blocks['稼働']) === JSON.stringify({ 配達件数: '17件', 走行距離: '34.2km', 実働時間: '3時間46分' }), d.blocks['稼働']);
      check('効率: 平均距離 2.0km・平均単価 627円・距離単価 312円/km・実働時給 2,819円', JSON.stringify(d.blocks['効率']) === JSON.stringify({ 平均距離: '2.0km', 平均単価: '627円', 距離単価: '312円/km', 実働時給: '2,819円' }), d.blocks['効率']);
      check('「プロモーション」「¥」表記を使わない', !/プロモーション|¥/.test(d.text.replace(/配達明細[\s\S]*$/, '')));
      check('配達明細（○/×評価・並び替え）は3ブロックの下に残る', d.deliveries > 0 && d.evalBtns > 0 && d.sortBtn, { n: d.deliveries, eval: d.evalBtns });
      const lay = await p.ev(`(() => { const c = document.querySelector('.history-card[data-date="2026-10-05"]'); const vals = [...c.querySelectorAll('.hd-val')].map(v => v.getBoundingClientRect().right); const blocks = c.querySelector('.hd-blocks').getBoundingClientRect(); const det = c.querySelector('.history-deliveries-detail').getBoundingClientRect();
        return { rightAligned: Math.max(...vals) - Math.min(...vals) < 1.5, blocksAboveDeliveries: blocks.bottom <= det.top + 1, rowH: c.querySelector('.hd-row').getBoundingClientRect().height }; })()`);
      check('数値の右端がそろう・3ブロックは配達明細の上', lay.rightAligned && lay.blocksAboveDeliveries, lay);
      await p.shot(`history_${w}_detail`);

      // 別の日を開くと前の日は閉じる（1日だけ展開）
      await p.tapSel('.history-card[data-date="2026-09-24"] .history-card-header');
      d = await p.ev(DETAIL_JS('2026-09-24'));
      const prev = await p.ev(`document.querySelector('.history-card[data-date="2026-10-05"]').classList.contains('expanded')`);
      check('別の日を開くと前の日は閉じる', d.open && !prev);
      check('9/24: 特別クエスト 8,890円（80回乗車クエスト）・クエスト 600円・総売上 17,189円', d.blocks['収益']['特別クエスト'] === '8,890円' && d.blocks['収益']['クエスト'] === '600円' && d.blocks['収益']['総売上'] === '17,189円' && d.notes.includes('80回乗車クエスト'), { r: d.blocks['収益'], n: d.notes });
      check('9/24: 効率は特別クエストを除く（平均単価 377円・実働時給 1,239円）', d.blocks['効率']['平均単価'] === '377円' && d.blocks['効率']['実働時給'] === '1,239円', d.blocks['効率']);
      await p.tapSel('.history-card[data-date="2026-09-19"] .history-card-header');
      d = await p.ev(DETAIL_JS('2026-09-19'));
      check('9/19: 新規保証 12,132円は特別クエストに・経費 −1,527円（バイクシェア利用）・利益 19,783円', d.blocks['収益']['特別クエスト'] === '12,132円' && d.blocks['収益']['経費'] === '−1,527円' && d.notes.includes('バイクシェア利用') && d.blocks['収益']['利益'] === '19,783円' && d.blocks['収益']['総売上'] === '21,310円', d.blocks['収益']);
      check('9/19: 実働時給は新規保証を除く（1,409円）', d.blocks['効率']['実働時給'] === '1,409円', d.blocks['効率']);
      await p.tapSel('.history-card[data-date="2026-09-22"] .history-card-header');
      d = await p.ev(DETAIL_JS('2026-09-22'));
      check('9/22: 売上調整 −607円・うちチップ・総売上 9,243円（内訳の合計＝総売上）', d.blocks['収益']['売上調整'] === '−607円' && Object.keys(d.blocks['収益']).some(k => /^うちチップ/.test(k)) && d.blocks['収益']['総売上'] === '9,243円', d.blocks['収益']);
      // 一覧 / カレンダー切替・下部ナビ6項目
      await p.tapSel('.history-view-btn[data-view="calendar"]');
      const cal = await p.ev(`({ cal: !document.getElementById('history-calendar-container').hidden, list: !document.getElementById('history-list-container').hidden, cells: document.getElementById('history-calendar-container').textContent.length })`);
      await p.tapSel('.history-view-btn[data-view="list"]');
      const back = await p.ev(`({ cal: !document.getElementById('history-calendar-container').hidden, list: !document.getElementById('history-list-container').hidden, rows: document.querySelectorAll('.hr-line').length })`);
      check('一覧 / カレンダー切替が動く', cal.cal && !cal.list && cal.cells > 0 && !back.cal && back.list && back.rows === workedDays, { cal, back, workedDays });
      const nav = await p.ev(`(() => { const items = [...document.querySelectorAll('.bottom-nav .nav-label')]; return { labels: items.map(e => e.textContent).join(' '), font: Math.min(...items.map(e => parseFloat(getComputedStyle(e).fontSize))), h: document.querySelector('.bottom-nav').getBoundingClientRect().height }; })()`);
      check('下部ナビは6項目のまま（稼働 履歴 分析 地雷 地図 ルート）', nav.labels === '稼働 履歴 分析 地雷 地図 ルート', nav);
      // もう一度タップで閉じる
      await p.tapSel('.history-card[data-date="2026-09-22"] .history-card-header');
      check('もう一度タップで閉じる（▼）', await p.ev(`(() => { const c = document.querySelector('.history-card[data-date="2026-09-22"]'); return !c.classList.contains('expanded') && c.querySelector('.expand-icon').textContent === '▼'; })()`));
      check('横スクロールなし', await p.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
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
