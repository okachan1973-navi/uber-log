/**
 * UBER_LOG ローカルbackend（Windows PC 専用・127.0.0.1 のみで待受け。LAN・外部には公開しない）
 *
 *   http://localhost:8088/                         … 通常の UBER_LOG（リポジトリをそのまま配信）
 *   http://localhost:8088/tools/official-import/   … 公式取込画面（「取り込み実行」）
 *   /api/*                                         … 取込画面専用API（保存・既存取込パイプラインの実行・状況）
 *
 * 起動: デスクトップの「UBER_LOG」ショートカット（launcher.vbs）が自動で起動する。手動なら `node tools/official-import/server.js`
 * 環境変数（テスト・保守用）: UBER_LOG_PORT / UBER_LOG_ROOT / UBER_HANDOFF_PATH / UBER_IMPORT_TEST_CMD=skip
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ImportJob } = require('./lib/import-job.js');

const PORT = Number(process.env.UBER_LOG_PORT || 8088);
const HOST = '127.0.0.1';
const ROOT = path.resolve(process.env.UBER_LOG_ROOT || path.join(__dirname, '..', '..'));
const HANDOFF = process.env.UBER_HANDOFF_PATH || path.resolve(ROOT, '..', 'UBER_HANDOFF.txt');
const MAX_BODY = 200 * 1024 * 1024;
const LOG_DIR = path.join(ROOT, 'tools', 'official-import', 'logs');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const PRIVATE_PREFIXES = ['tools/official-import/inbox', 'tools/official-import/staging', 'tools/official-import/logs'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

let current = null; // 実行中・直近の取込ジョブ
const jobs = new Map();

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'server.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* ログ失敗は無視 */ }
}

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version; } catch (e) { return null; }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('送信データが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return send(res, 200, { app: 'uber-log-local', pid: process.pid, port: PORT, version: version(), busy: !!(current && current.state === 'running') });
  }
  // ブラウザの他サイトからの呼び出しを拒否（独自ヘッダー必須＝CORSプリフライトが通らない / Origin確認）
  if (req.headers['x-uber-log'] !== '1') return send(res, 403, { error: 'forbidden' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'forbidden origin' });

  let m;
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/inbox\/(\d{4}-\d{2}-\d{2})$/))) {
    const dir = path.join(ROOT, 'tools', 'official-import', 'inbox', m[1]);
    const activityFile = path.join(dir, 'activity.txt');
    const shotDir = path.join(dir, 'screenshots');
    return send(res, 200, {
      date: m[1],
      activity: fs.existsSync(activityFile) ? fs.readFileSync(activityFile, 'utf8').replace(/\r\n/g, '\n') : '',
      screenshots: fs.existsSync(shotDir) ? fs.readdirSync(shotDir).filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => a.localeCompare(b, 'ja')) : []
    });
  }
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/inbox\/(\d{4}-\d{2}-\d{2})\/screenshots\/([^/]+)$/))) {
    const name = path.basename(decodeURIComponent(m[2]));
    const file = path.join(ROOT, 'tools', 'official-import', 'inbox', m[1], 'screenshots', name);
    if (!/\.(png|jpe?g)$/i.test(name) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(name).toLowerCase()]);
  }
  if (req.method === 'POST' && url.pathname === '/api/import') {
    if (current && current.state === 'running') return send(res, 409, { error: '取込を実行中です。完了までお待ちください。', job: current.view() });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: `送信データを読めません: ${e.message}` }); }
    if (!validDate(payload.date)) return send(res, 400, { error: '日付が正しくありません' });
    if (payload.date > todayStr()) return send(res, 400, { error: '未来の日付は取り込めません' });
    const testCommand = process.env.UBER_IMPORT_TEST_CMD === 'skip' ? 'skip' : undefined;
    const job = new ImportJob({ root: ROOT, handoffFile: HANDOFF, date: payload.date, testCommand });
    current = job;
    jobs.set(job.id, job);
    log(`import start ${job.id} ${payload.date} files=${(payload.files || []).length} keep=${(payload.keep || []).length}`);
    job.run(payload).then(() => log(`import end ${job.id} state=${job.state} ${job.message}`));
    return send(res, 202, job.view());
  }
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/jobs\/(current|job_\d+)$/))) {
    const job = m[1] === 'current' ? current : jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'not found' });
    return send(res, 200, job.view());
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch (e) { return send(res, 400, 'bad request', 'text/plain'); }
  const norm = rel ? path.posix.normalize(rel) : '';
  if (norm.split('/').some(seg => seg.startsWith('.')) || PRIVATE_PREFIXES.some(p => norm === p || norm.startsWith(p + '/'))) {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  let file = path.join(ROOT, norm);
  if (!file.startsWith(ROOT)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  try {
    let st = fs.statSync(file);
    if (st.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

const handler = async (req, res) => {
  // DNS rebinding 対策: Host が localhost / 127.0.0.1 の時だけ応答
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) return send(res, 403, 'forbidden host', 'text/plain');
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    log(`error ${e.stack}`);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
};

// 待受けはループバックのみ（IPv4 127.0.0.1 ＋ ブラウザが localhost を IPv6 で引く場合の ::1）
const server = http.createServer(handler);
server.on('error', e => {
  log(`listen error ${e.code} ${e.message}`);
  console.error(e.code === 'EADDRINUSE' ? `ポート ${PORT} は別のプログラムが使用中です` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  log(`listening http://${HOST}:${PORT}/ root=${ROOT} pid=${process.pid}`);
  console.log(`UBER_LOG local: http://localhost:${PORT}/tools/official-import/`);
  const v6 = http.createServer(handler);
  v6.on('error', e => {
    log(`::1 listen skipped (${e.code})`);
    if (e.code === 'EADDRINUSE') {
      // localhost が IPv6 で別のプログラムに届いてしまうため、起動を中止する
      console.error(`ポート ${PORT} は別のプログラムが使用中です（::1）`);
      process.exit(1);
    }
  });
  v6.listen(PORT, '::1');
});
