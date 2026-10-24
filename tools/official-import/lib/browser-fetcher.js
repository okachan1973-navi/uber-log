/**
 * UBER_LOG 公式取込 — Uber Driver Web 構造化自動取得モジュール
 *
 * Windows 11 の Edge または Chrome を専用プロファイルで安全に起動し、
 * 本人が手動ログインしたセッションを再利用して、対象日のアクティビティおよび詳細データを取得する。
 *
 * 【安全・法令遵守原則】
 * 1. パスワードやSMS認証コードをコードに保存しない。
 * 2. CAPTCHA回避・認証突破・レート制限回避は一切行わない。
 * 3. 認証切れ時は「Uberへの再ログインが必要」として安全停止する。
 * 4. 取得間隔を空け、サーバーに過剰な負荷をかけない。
 * 5. 外部 npm パッケージに依存せず、Node.js 組み込みモジュール（http, child_process, WebSocket）のみで動作。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PORT = 9223;
const DELAY_BETWEEN_TRIPS_MS = 1200; // 各trip詳細取得の間隔（サーバー負荷軽減）
const API_TIMEOUT_MS = 25000;        // Uber API 1回の上限（応答が無いまま止まらない）
const API_ATTEMPTS = 3;              // 失敗・応答なしのときは Uber画面を再読込して再試行（最大3回）

function uberPageRank(target) {
  if (!target || target.type !== 'page') return 99;
  try {
    const url = new URL(target.url);
    if (url.protocol !== 'https:') return 99;
    if (url.hostname === 'drivers.uber.com') {
      if (/^\/earnings\/activities\/?$/.test(url.pathname)) return 0;
      return /^\/(login|signin)(\/|$)/i.test(url.pathname) ? 2 : 1;
    }
    return url.hostname === 'auth.uber.com' ? 3 : 99;
  } catch (_) { return 99; }
}

function selectUberPage(targets) {
  return (Array.isArray(targets) ? targets : [])
    .filter(t => uberPageRank(t) < 99)
    .sort((a, b) => uberPageRank(a) - uberPageRank(b))[0] || null;
}

// 認証URLのクエリ（state等）はログへ出さない。
function targetSummary(target) {
  let url = '';
  try { const u = new URL(target.url); url = u.origin + u.pathname; } catch (_) {}
  return { id: target.id, type: target.type, title: target.title, url };
}

// ブラウザ実行ファイルの探索
function findBrowserExecutable() {
  if (process.env.UBER_BROWSER_EXE && fs.existsSync(process.env.UBER_BROWSER_EXE)) {
    return process.env.UBER_BROWSER_EXE;
  }
  const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localApp = process.env.LOCALAPPDATA || '';

  const candidates = [
    path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localApp ? path.join(localApp, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    localApp ? path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe') : null
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// 専用ユーザーデータディレクトリ（Git管理外・絶対パスを保証）
function getProfileDir(root) {
  const dir = path.resolve(root, 'tools', 'official-import', '.browser-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// HTTP GET ヘルパー (CDP API 用)
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON解析失敗: ${e.message} (${data.slice(0, 100)})`));
        }
      });
    }).on('error', reject);
  });
}

// HTTP リクエスト（CDP API 用。ステータスと本文を返す）
function httpRequest(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ACTIVITIES_URL = 'https://drivers.uber.com/earnings/activities';

// CDP で新しいタブを開く。Chromium 111 以降（Edge も同じ）は /json/new が PUT のみ（GET は 405 で開かない）
async function openCdpTab(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${url}`;
  let r = await httpRequest('PUT', endpoint);
  if (r.status !== 200) r = await httpRequest('GET', endpoint); // PUT を受け付けない古いブラウザ
  if (r.status !== 200) throw new Error(`Uberのタブを開けませんでした（HTTP ${r.status}: ${String(r.body).slice(0, 120)}）`);
  return JSON.parse(r.body);
}

// 簡易 CDP クライアント（Node.js 標準 WebSocket を使用）
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        return reject(new Error('Node.js に組み込み WebSocket がありません (Node v21+ が必要です)'));
      }
      let timer = null;
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (e) {
        return reject(e);
      }
      timer = setTimeout(() => {
        if (this.ws && this.ws.readyState !== 1) {
          try { this.ws.close(); } catch (e) {}
          reject(new Error('CDP接続タイムアウト'));
        }
      }, 5000);

      this.ws.onopen = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = err => {
        if (timer) clearTimeout(timer);
        reject(err);
      };
      this.ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(`CDPエラー: ${msg.error.message}`));
            else res(msg.result);
          }
        } catch (e) { /* ignore parse error */ }
      };
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDPコマンドタイムアウト (${method})`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: res => { clearTimeout(timer); resolve(res); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeoutMs);
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text;
      throw new Error(`ブラウザ実行エラー: ${desc}`);
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
  }
}

function bringBrowserWindowToFront(port = DEFAULT_PORT) {
  if (process.platform === 'win32') {
    try {
      const ps = spawn('powershell', ['-NoProfile', '-Command', `
        $ws = New-Object -ComObject WScript.Shell
        $conn = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue
        if ($conn) {
          $ws.AppActivate($conn.OwningProcess)
        }
        $ws.AppActivate("Uber")
      `], { windowsHide: true, stdio: 'ignore' });
      ps.unref();
    } catch (_) {}
  }
}

function getBrowserWindowInfo(port = DEFAULT_PORT) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const psScript = path.resolve(__dirname, '..', 'get-win-info.ps1');
      if (fs.existsSync(psScript)) {
        const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Port', String(port)], { windowsHide: true });
        let out = '';
        ps.stdout.on('data', d => { out += d; });
        ps.on('close', () => {
          try { resolve(JSON.parse(out.trim())); } catch (_) { resolve(null); }
        });
        ps.on('error', () => resolve(null));
        return;
      }
      resolve(null);
    } catch (_) { resolve(null); }
  });
}

// 新しく開いたUberのタブが一覧に現れるまで待つ（最大 timeoutMs）
async function waitForUberPage(port, timeoutMs = 15000, intervalMs = 500) {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    try {
      if (selectUberPage(await httpGetJson(`http://127.0.0.1:${port}/json/list`))) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * デバッグ用ブラウザプロセスを起動（または既存ポートに接続）
 */
async function launchOrConnectBrowser(root, opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const profileDir = getProfileDir(root);

  // 1. 既にポートで CDP が稼働しているか確認
  try {
    const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
    if (version && version.webSocketDebuggerUrl) {
      // 既に起動している場合、Uberアクティビティ画面が開かれているか確認
      // （Uberのタブがアカウント画面 account.uber.com などへ移っている／閉じられている場合は、アクティビティ画面を新しいタブで開く）
      let tabError = null;
      try {
        const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
        const uberPage = selectUberPage(targets);
        if (!uberPage) {
          await openCdpTab(port, ACTIVITIES_URL);
          await waitForUberPage(port);
        } else if (uberPage.id) {
          // 既存Uberページを前面化
          await httpGetJson(`http://127.0.0.1:${port}/json/activate/${uberPage.id}`).catch(() => {});
        }
      } catch (e) {
        // 接続自体は続ける。理由は呼び出し側のエラー表示に使う（握りつぶさない）
        tabError = e.message;
      }
      const windowInfo = await getBrowserWindowInfo(port);
      return { port, attached: true, version, windowInfo, tabError };
    }
  } catch (e) {
    // 未起動
  }

  const exe = findBrowserExecutable();
  if (!exe) {
    const err = new Error('Microsoft Edge または Google Chrome が見つかりません。');
    err.code = 'browser_not_found';
    throw err;
  }

  // 2. ブラウザを起動（Windows対話セッション WinSta0\\Default に確実に可視ウィンドウを生成）
  if (process.platform === 'win32') {
    const cmdPath = path.resolve(root, 'tools', 'official-import', 'launch-uber-edge.cmd');
    const cmdContent = `@echo off\r\nstart "" "${exe}" --new-window --remote-debugging-port=${port} --user-data-dir="${profileDir}" --no-first-run --no-default-browser-check https://drivers.uber.com/earnings/activities\r\n`;
    try { fs.writeFileSync(cmdPath, cmdContent, 'utf8'); } catch (_) {}

    // タスクスケジューラ経由で対話型デスクトップ（WinSta0\\Default）に起動
    try {
      const { execSync } = require('child_process');
      execSync(`schtasks /create /tn "UberEdgeLauncher" /tr "cmd.exe /c \\"${cmdPath}\\"" /sc once /st 23:59 /it /f`, { stdio: 'ignore' });
      execSync('schtasks /run /tn "UberEdgeLauncher"', { stdio: 'ignore' });
    } catch (_) {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath "${exe}" -ArgumentList @('--new-window','--remote-debugging-port=${port}','--user-data-dir="${profileDir}"','--no-first-run','--no-default-browser-check','https://drivers.uber.com/earnings/activities')`
      ], { windowsHide: true, stdio: 'ignore' });
      ps.unref();
    }
  } else {
    const child = spawn(exe, [
      '--new-window',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://drivers.uber.com/earnings/activities'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
  }

  // 起動待機（最大20秒: Windowsでの起動初期化を考慮）
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      if (version && version.webSocketDebuggerUrl) {
        const windowInfo = await getBrowserWindowInfo(port);
        return { port, attached: false, version, windowInfo };
      }
    } catch (e) {}
  }

  const err = new Error(`専用Edgeの起動にタイムアウトしました（ポート ${port}）。デスクトップの「Uber_Phase1_Edge起動.bat」から手動起動してください。`);
  err.code = 'launch_failed';
  throw err;
}

/**
 * Uber Driver Web に接続し、ログインセッション状態を確認する
 */
async function checkAuthStatus(root, opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  let targets;
  try {
    targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
  } catch (e) {
    return { ok: false, running: false, message: 'ブラウザが起動していません。' };
  }

  // 1. drivers.uber.com を最優先で探す（ログイン済みタブを即座に検出するため）
  const page = selectUberPage(targets);
  const winInfo = await getBrowserWindowInfo(port);
  const diagnostics = {
    cdpPort: port,
    windowInfo: winInfo,
    selectedTarget: page ? targetSummary(page) : null,
    targets: targets.map(targetSummary)
  };
  if (typeof opts.onDiagnostic === 'function') opts.onDiagnostic(diagnostics);
  if (!page) {
    // Uberの別画面（アカウント画面 account.uber.com など）だけが開いている場合は、その旨を伝える
    const otherUber = (targets || []).filter(t => t && t.type === 'page' && /^https:\/\/([a-z0-9-]+\.)*uber\.com\//i.test(t.url || ''))
      .map(t => targetSummary(t).url);
    const message = otherUber.length
      ? `専用EdgeのUberタブがアクティビティ画面ではありません（${otherUber.join(', ')}）。専用Edgeで ${ACTIVITIES_URL} を開いてから、もう一度実行してください。`
      : 'CDP専用ブラウザにUberのページがありません。表示中のEdgeとの接続先を確認してください。';
    return { ok: false, running: true, authenticated: false, needsLogin: false, unknown: true, ...diagnostics, message };
  }

  let client;
  try {
    client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();

    // DOM・URL・ページタイトルをもとに認証状態を正確に判定（Cookieに依存しない）
    const info = await client.evaluate(`(() => {
      const url = window.location.href;
      const locationUrl = new URL(url);
      const title = document.title || '';

      // 1. ログイン画面の判定（auth.uber.com、/login、サインイン/ログイン見出し・フォーム）
      const isAuthDomain = locationUrl.hostname === 'auth.uber.com';
      const isLoginPath = /^\\/(login|signin)(\\/|$)/i.test(locationUrl.pathname);
      const hasLoginForm = !!document.querySelector('input[type="tel"]') ||
                           !!document.querySelector('input[name="phone"]') ||
                           !!document.querySelector('input[name="email"]') ||
                           !!document.querySelector('input[type="password"]');
      const hasLoginTitle = title.includes('サインイン') || title.includes('ログイン') ||
                            title.includes('Sign In') || title.includes('Log In');

      const isLoginPage = isAuthDomain || isLoginPath || hasLoginTitle || (isAuthDomain && hasLoginForm);

      // 2. ドライバー画面の判定
      const isDrivers = locationUrl.protocol === 'https:' && locationUrl.hostname === 'drivers.uber.com';
      const isActivities = isDrivers && /^\\/earnings\\/activities\\/?$/.test(locationUrl.pathname);

      // 3. 本人用ページのDOM要素確認（売上・アクティビティ・Delivery・プロフィールなど）
      const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
      const hasEarningsContent = bodyText.includes('アクティビティ') ||
                                 bodyText.includes('売り上げ') ||
                                 bodyText.includes('売上') ||
                                 bodyText.includes('Delivery') ||
                                 bodyText.includes('Earnings') ||
                                 bodyText.includes('Activities');

      const hasProfileDom = !!document.querySelector('[data-testid*="profile"]') ||
                            !!document.querySelector('[data-testid*="avatar"]') ||
                            !!document.querySelector('[data-testid*="user-menu"]') ||
                            !!document.querySelector('[aria-label*="プロフィール"]') ||
                            !!document.querySelector('[aria-label*="アカウント"]') ||
                            !!document.querySelector('header img') ||
                            !!document.querySelector('button img[alt]');

      const hasActivityFeed = !!document.querySelector('[data-testid*="activity"]') ||
                              !!document.querySelector('table') ||
                              hasEarningsContent;

      const isDriverAuthenticated = isDrivers && !isLoginPage && hasProfileDom && hasActivityFeed;

      return {
        url,
        title,
        isLoginPage,
        isDrivers,
        isActivities,
        isDriverAuthenticated,
        hasProfileDom,
        hasActivityFeed
      };
    })()`);

    const state = determineAuthState(info);
    if (typeof opts.onDiagnostic === 'function') opts.onDiagnostic({ ...diagnostics,
      authenticated: state.authenticated, needsLogin: state.needsLogin,
      hasProfileDom: info.hasProfileDom, hasActivityFeed: info.hasActivityFeed });
    return { ...state, ...diagnostics };
  } catch (e) {
    return {
      ok: false,
      running: true,
      authenticated: false,
      needsLogin: false,
      unknown: true,
      ...diagnostics,
      message: `ページ状態の取得エラー: ${e.message}`
    };
  } finally {
    if (client) client.close();
  }
}

/**
 * ページ評価結果（info）から認証状態を判定する純粋関数
 */
function determineAuthState(info) {
  if (!info) {
    return {
      ok: false,
      running: true,
      authenticated: false,
      needsLogin: false,
      unknown: true,
      message: 'ページの読み込み中です。'
    };
  }

  // 1. ログイン画面が検出された場合
  if (info.isLoginPage) {
    return {
      ok: false,
      running: true,
      authenticated: false,
      needsLogin: true,
      currentUrl: targetSummary({ url: info.url }).url,
      title: info.title,
      message: 'CDP専用Edgeではログイン画面を検出しました。別のEdgeでログイン済みの場合は、接続先のプロセス／プロファイル確認が必要です。'
    };
  }

  // 2. ドライバー本人用画面（activities 等）が正常表示されている場合
  if (info.isDriverAuthenticated && info.isDrivers && !info.isLoginPage) {
    return {
      ok: true,
      running: true,
      authenticated: true,
      needsLogin: false,
      currentUrl: info.url,
      title: info.title,
      message: 'Uber Webにログイン済みです（自動取得の準備完了）。'
    };
  }

  // 3. 判定不能（読み込み中・その他のページ）
  return {
    ok: false,
    running: true,
    authenticated: false,
    needsLogin: false,
    unknown: true,
    currentUrl: info.url,
    title: info.title,
    message: 'Uber Driver Webの読み込み中または確認中です。'
  };
}

/**
 * 対象日のアクティビティフィードと詳細データを取得する
 *
 * @param {string} root UBER_LOG ルート
 * @param {string} date YYYY-MM-DD
 * @param {Object} opts
 * @param {(msg: string) => void} onProgress
 * @returns {Promise<Object>} 構造化データ
 */
async function fetchUberDataForDate(root, date, opts = {}, onProgress = () => {}) {
  // モックモード（テスト・検証用）
  // モックファイルが無いときに本物の Uber へつながないよう、指定されていれば必ずモックで完結する
  // { "__mockError": "..." } は取得失敗（応答なし等）の再現
  if (process.env.UBER_BROWSER_MOCK) {
    const mockFile = process.env.UBER_BROWSER_MOCK;
    if (!fs.existsSync(mockFile)) throw new Error(`モックデータがありません: ${mockFile}`);
    onProgress('モックデータを読込中...');
    const mockData = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    if (mockData.__mockError) throw new Error(mockData.__mockError);
    return mockData;
  }

  const port = opts.port || DEFAULT_PORT;
  onProgress('ブラウザの接続を確認中...');
  const conn = await launchOrConnectBrowser(root, { port });

  // 開いたばかりのタブは読み込み中のことがあるため、判定不能（unknown）の間だけ少し待って確認し直す（最大 約15秒）
  let auth = await checkAuthStatus(root, { port });
  for (let i = 0; i < (opts.authRetries == null ? 10 : opts.authRetries) && auth.unknown && auth.running && auth.selectedTarget; i++) {
    await new Promise(r => setTimeout(r, opts.authRetryMs || 1500));
    auth = await checkAuthStatus(root, { port });
  }
  if (!auth.ok || !auth.authenticated) {
    const base = auth.message || 'Uberへのログインが必要です。開いたブラウザでログインを完了してから再度実行してください。';
    throw new Error(conn && conn.tabError ? `${base}（${conn.tabError}）` : base);
  }

  const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find(t => t.id === auth.selectedTarget.id && uberPageRank(t) <= 1);
  if (!page) throw new Error('認証確認したUber Driver画面が変更されました。状態を再確認してください。');

  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();

  try {
    // 毎回 Uber画面を再読込してから取得する（何時間も開いたままの画面の状態を引きずらない）
    onProgress('Uber画面を再読込中...');
    await reloadUberPage(client);
    return await collectDay(client, date, onProgress, opts);
  } finally {
    client.close();
  }
}

// Uber画面を再読込して、読込完了（document.readyState === 'complete'）まで待つ
async function reloadUberPage(client, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const intervalMs = opts.intervalMs || 500;
  await client.send('Page.reload', { ignoreCache: true }, 10000);
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const st = await client.evaluate('({ ready: document.readyState, host: location.host })', 5000);
      if (st && st.ready === 'complete') return st;
    } catch (e) { /* 読込中は評価できないことがある */ }
  }
  throw new Error('Uber画面の再読込が終わりません');
}

/**
 * HTTP エラー応答の安全な診断情報（画面内で作る）。
 * 応答本文・Cookie・トークンは画面の外へ出さない。出すのは ステータス・許可したヘッダー・本文の種類と長さ・
 * JSON の最上位キー名・短い英数字のエラーコード・HTML に含まれる定型語（captcha 等）の有無だけ。
 */
const HTTP_DIAG_EXPR = `async res => {
  const short = (v, n) => v == null ? null : String(v).replace(/[^\\x20-\\x7e]/g, '').slice(0, n);
  const token = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(v) ? v : null;
  const d = { status: res.status, statusText: short(res.statusText, 40), redirected: !!res.redirected, finalPath: null,
    contentType: short(res.headers.get('content-type'), 80), contentLength: short(res.headers.get('content-length'), 12),
    retryAfter: short(res.headers.get('retry-after'), 40), bodyKind: 'unknown', bodyLength: null, jsonKeys: null, errorCode: null, hints: [] };
  try { d.finalPath = new URL(res.url).pathname.slice(0, 80); } catch (e) {}
  let text = '';
  try { text = await res.text(); } catch (e) { return d; }
  d.bodyLength = text.length;
  const t = text.trim();
  if (!t) { d.bodyKind = 'empty'; return d; }
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      d.bodyKind = 'json';
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        d.jsonKeys = Object.keys(j).filter(k => /^[A-Za-z0-9_.-]{1,40}$/.test(k)).slice(0, 10);
        const e = j.error && typeof j.error === 'object' ? j.error : {};
        d.errorCode = token(j.code) || token(e.code) || token(j.error) || token(j.status) || null;
      }
      return d;
    } catch (e) { /* JSON ではない */ }
  }
  d.bodyKind = /^<(!doctype|html)/i.test(t) ? 'html' : 'text';
  const low = t.toLowerCase();
  d.hints = ['captcha', 'challenge', 'rate limit', 'too many', 'blocked', 'access denied', 'forbidden', 'csrf', 'login', 'sign in']
    .filter(w => low.includes(w));
  return d;
}`;

// 診断情報を 1 行の日本語にする（ログ・画面用。本文そのものは含まない）
function describeHttpDiag(d) {
  if (!d) return '';
  const parts = [`HTTP ${d.status}${d.statusText ? ` ${d.statusText}` : ''}`];
  parts.push(`Content-Type: ${d.contentType || 'なし'}`);
  if (d.contentLength) parts.push(`Content-Length: ${d.contentLength}`);
  if (d.retryAfter) parts.push(`Retry-After: ${d.retryAfter}`);
  if (d.redirected) parts.push(`リダイレクトあり${d.finalPath ? `（${d.finalPath}）` : ''}`);
  parts.push(`本文: ${d.bodyKind}${d.bodyLength != null ? ` ${d.bodyLength}文字` : ''}`);
  if (d.jsonKeys && d.jsonKeys.length) parts.push(`JSONキー: ${d.jsonKeys.join(',')}`);
  if (d.errorCode) parts.push(`コード: ${d.errorCode}`);
  if (d.hints && d.hints.length) parts.push(`本文に含まれる語: ${d.hints.join(',')}`);
  return parts.join(' / ');
}

// HTTP 403 の利用者向けメッセージ。原因は確定できないため断定しない。
// 「ログイン」の語は使わない（import-job はこの語でログイン待ちと判断するため、403 を別の状態に変えてしまう）
function http403Message(label, diag) {
  return `${label}: Uber Web が HTTP 403（アクセス拒否）を返したため、取得を中止しました（自動の再試行・画面の再読込はしていません）。\n` +
    '原因はまだ確定していません（一時的なアクセス制限・認証状態・Uber 側の変更などが考えられます）。続けて何度も実行せず、時間を空けてから 1 回だけ取得し直してください。\n' +
    `診断: ${describeHttpDiag(diag)}`;
}

class UberHttpError extends Error {
  constructor(label, diag) {
    super(diag.status === 403 ? http403Message(label, diag) : `${label} failed with HTTP ${diag.status}（${describeHttpDiag(diag)}）`);
    this.name = 'UberHttpError';
    this.status = diag.status;
    this.diag = diag;
  }
}

/**
 * Uber Driver Web の API を画面内の fetch で呼ぶ（Cookie・CSRFトークン x-csrf-token: x をそのまま使う）
 * 1回ごとに上限時間を設け、失敗・応答なしなら Uber画面を再読込して再試行する。最後まで失敗したら例外（古いデータで代用しない）
 * HTTP 403（アクセス拒否）だけは再試行・再読込をせず、すぐに止める（繰り返すと制限を長引かせるおそれがあるため）
 */
async function uberApi(client, apiPath, body, label, onProgress = () => {}, opts = {}) {
  const attempts = opts.attempts || API_ATTEMPTS;
  const timeoutMs = opts.timeoutMs || API_TIMEOUT_MS;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await client.evaluate(`(async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ${timeoutMs});
        try {
          const res = await fetch(${JSON.stringify(apiPath)}, {
            method: 'POST', cache: 'no-store', signal: ctl.signal,
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
            body: ${JSON.stringify(JSON.stringify(body))}
          });
          if (!res.ok) return { __uberHttpError: await (${HTTP_DIAG_EXPR})(res) };
          return await res.json();
        } catch (e) {
          if (e && e.name === 'AbortError') throw new Error(${JSON.stringify(label)} + ' timed out (${timeoutMs}ms)');
          throw e;
        } finally { clearTimeout(timer); }
      })()`, timeoutMs + 15000);
      if (r && r.__uberHttpError) throw new UberHttpError(label, r.__uberHttpError);
      return r;
    } catch (e) {
      if (e instanceof UberHttpError && e.status === 403) throw e;
      lastErr = e;
      if (attempt < attempts) {
        onProgress(`${label} に失敗しました（${e.message}）。Uber画面を再読込して再試行します（${attempt + 1}/${attempts}回目）`);
        await reloadUberPage(client, opts.reload).catch(() => {});
      }
    }
  }
  throw new Error(`${label} を取得できませんでした（${attempts}回試行）: ${lastErr && lastErr.message}`);
}

const jstTime = ms => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// 対象日のアクティビティフィード（全ページ）と各 trip の詳細を取得する
async function collectDay(client, date, onProgress = () => {}, opts = {}) {
  const startedAt = new Date().toISOString();
  onProgress(`対象日（${date}）のアクティビティ一覧を取得中...`);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const nextDate = d.toISOString().slice(0, 10);

  // 1. アクティビティフィード（getWebActivityFeed）を全ページ取得
  const items = [];
  let cursor = null;
  for (let pageCount = 1; pageCount <= 20; pageCount++) {
    const data = await uberApi(client, '/earnings/api/getWebActivityFeed?localeCode=ja-JP',
      { startDateIso: date, endDateIso: nextDate, paginationOption: cursor ? { cursor } : {} }, 'getWebActivityFeed', onProgress, opts);
    items.push(...((data && data.data && data.data.activities) || (data && (data.feedItems || data.items)) || []));
    const pagination = (data && ((data.data && data.data.pagination) || data.paginationOption || data.pagination)) || {};
    cursor = pagination.nextCursor || null;
    if (!(pagination.hasMoreData && cursor)) break;
  }
  onProgress(`アクティビティ取得完了: 全 ${items.length} 件`);

  // Deliveryアイテムから tripUuid を抽出（キャンセル済みを除く）
  const deliveries = items.filter(it => {
    const status = String(it.status || it.statusType || '').toUpperCase();
    if (status === 'CANCELED' || status === 'CANCELLED' || it.activityTitle === 'キャンセル済み') return false;
    const t = (it.type || '').toUpperCase();
    const title = (it.activityTitle || '').toLowerCase();
    return t === 'TRIP' || t === 'CT' || title.includes('delivery');
  });
  const tripUuids = [...new Set(deliveries.map(it => it.uuid || it.tripUuid).filter(Boolean))];
  const lastAt = Math.max(0, ...deliveries.map(it => Number(it.recognizedAt) || 0));
  const lastTripAt = lastAt ? jstTime(lastAt * 1000) : null; // Uber Web 側の最終トリップ時刻（ログ・確認用）

  onProgress(`対象日の Delivery: ${tripUuids.length} 件（Uber Web の最終トリップ ${lastTripAt || '—'}）の詳細を取得します...`);

  // 2. 各 tripUuid の getTrip 詳細を取得
  const trips = [];
  const delayMs = opts.delayMs === undefined ? DELAY_BETWEEN_TRIPS_MS : opts.delayMs;
  for (let i = 0; i < tripUuids.length; i++) {
    const uuid = tripUuids[i];
    onProgress(`配達詳細取得中 (${i + 1}/${tripUuids.length}): ${uuid.slice(0, 8)}...`);
    trips.push(await uberApi(client, '/earnings/api/getTrip?localeCode=ja-JP', { tripUUID: uuid }, `getTrip ${uuid.slice(0, 8)}`, onProgress, opts));
    // サーバー負荷軽減のため待機
    if (i < tripUuids.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  const fetchedAt = new Date().toISOString();
  onProgress(`Uber Web から取得完了: 取得日時 ${jstTime(Date.parse(fetchedAt))}・Delivery ${trips.length} 件・最終トリップ ${lastTripAt || '—'}`);
  return {
    source: 'uber-driver-web',
    fetchedAt,
    fetchStartedAt: startedAt,
    lastTripAt,
    targetDate: date,
    activity: {
      feedItems: items
    },
    trips
  };
}

/**
 * 取得データを inbox/<date>/ に保存する
 */
function saveStructuredInbox(root, date, structuredData) {
  const normalizer = require('./structured-normalizer.js');
  const inboxDir = path.join(root, 'tools', 'official-import', 'inbox', date);
  fs.mkdirSync(inboxDir, { recursive: true });

  const structuredFile = path.join(inboxDir, 'structured.json');
  fs.writeFileSync(structuredFile, JSON.stringify(structuredData, null, 2) + '\n', 'utf8');

  // activity.txt も自動生成して保存（フォールバックおよび既存パイプライン互換のため）
  const activityFile = path.join(inboxDir, 'activity.txt');
  const actTxt = normalizer.buildActivityTextFromStructured(structuredData.activity || structuredData, date);
  fs.writeFileSync(activityFile, actTxt, 'utf8');

  return { structuredFile, activityFile };
}

module.exports = {
  UberHttpError,
  HTTP_DIAG_EXPR,
  describeHttpDiag,
  http403Message,
  selectUberPage,
  findBrowserExecutable,
  launchOrConnectBrowser,
  openCdpTab,
  checkAuthStatus,
  determineAuthState,
  fetchUberDataForDate,
  reloadUberPage,
  uberApi,
  collectDay,
  saveStructuredInbox,
  CdpClient
};
