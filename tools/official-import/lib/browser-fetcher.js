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

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
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
      try {
        const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
        const uberPage = selectUberPage(targets);
        if (!uberPage) {
          // Uberページが開かれていない場合は新規オープン
          await httpGetJson(`http://127.0.0.1:${port}/json/new?https://drivers.uber.com/earnings/activities`);
        } else if (uberPage.id) {
          // 既存Uberページを前面化
          await httpGetJson(`http://127.0.0.1:${port}/json/activate/${uberPage.id}`);
        }
      } catch (e) {
        // タブ操作の失敗は接続自体には影響させない
      }
      const windowInfo = await getBrowserWindowInfo(port);
      return { port, attached: true, version, windowInfo };
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
    return { ok: false, running: true, authenticated: false, needsLogin: false, unknown: true,
      ...diagnostics, message: 'CDP専用ブラウザにUberのページがありません。表示中のEdgeとの接続先を確認してください。' };
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
  if (process.env.UBER_BROWSER_MOCK) {
    const mockFile = process.env.UBER_BROWSER_MOCK;
    if (fs.existsSync(mockFile)) {
      onProgress('モックデータを読込中...');
      const mockData = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
      return mockData;
    }
  }

  const port = opts.port || DEFAULT_PORT;
  onProgress('ブラウザの接続を確認中...');
  await launchOrConnectBrowser(root, { port });

  const auth = await checkAuthStatus(root, { port });
  if (!auth.ok || !auth.authenticated) {
    throw new Error(auth.message || 'Uberへのログインが必要です。開いたブラウザでログインを完了してから再度実行してください。');
  }

  const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find(t => t.id === auth.selectedTarget.id && uberPageRank(t) <= 1);
  if (!page) throw new Error('認証確認したUber Driver画面が変更されました。状態を再確認してください。');

  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();

  try {
    onProgress(`対象日（${date}）のアクティビティ一覧を取得中...`);

    // 1. アクティビティフィード（getWebActivityFeed）を全ページ取得
    // ブラウザの fetch を利用し、Cookie・CSRFトークン（x-csrf-token: x）を自然に適用
    const feedResult = await client.evaluate(`(async () => {
      const targetDate = ${JSON.stringify(date)};
      const d = new Date(targetDate + 'T00:00:00+09:00');
      d.setDate(d.getDate() + 1);
      const nextDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

      let cursor = null;
      let allItems = [];
      let pageCount = 0;
      let hasMore = true;

      while (hasMore && pageCount < 20) {
        pageCount++;
        const payload = {
          startDateIso: targetDate,
          endDateIso: nextDate,
          paginationOption: cursor ? { cursor } : {}
        };
        const res = await fetch('/earnings/api/getWebActivityFeed?localeCode=ja-JP', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': 'x'
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          throw new Error('getWebActivityFeed failed with HTTP ' + res.status);
        }
        const data = await res.json();
        const items = data.data?.activities || data.feedItems || data.items || [];
        allItems.push(...items);

        const pagination = data.data?.pagination || data.paginationOption || data.pagination || {};
        cursor = pagination.nextCursor || null;
        hasMore = !!(pagination.hasMoreData && cursor);
      }
      return { items: allItems, totalItems: allItems.length };
    })()`);

    const items = feedResult.items || [];
    onProgress(`アクティビティ取得完了: 全 ${items.length} 件`);

    // Deliveryアイテムから tripUuid を抽出（キャンセル済みを除く）
    const deliveries = items.filter(it => {
      const status = String(it.status || it.statusType || '').toUpperCase();
      if (status === 'CANCELED' || status === 'CANCELLED' || it.activityTitle === 'キャンセル済み') return false;
      const t = (it.type || '').toUpperCase();
      const title = (it.activityTitle || '').toLowerCase();
      return t === 'TRIP' || t === 'CT' || title.includes('delivery');
    });
    const tripUuids = [...new Set(deliveries.map(d => d.uuid || d.tripUuid).filter(Boolean))];

    onProgress(`対象日の Delivery: ${tripUuids.length} 件の詳細を取得します...`);

    // 2. 各 tripUuid の getTrip 詳細を取得
    const trips = [];
    for (let i = 0; i < tripUuids.length; i++) {
      const uuid = tripUuids[i];
      onProgress(`配達詳細取得中 (${i + 1}/${tripUuids.length}): ${uuid.slice(0, 8)}...`);

      const tripDetail = await client.evaluate(`(async () => {
        const uuid = ${JSON.stringify(uuid)};
        const res = await fetch('/earnings/api/getTrip?localeCode=ja-JP', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': 'x'
          },
          body: JSON.stringify({ tripUUID: uuid })
        });
        if (!res.ok) {
          throw new Error('getTrip failed for ' + uuid + ' with HTTP ' + res.status);
        }
        return await res.json();
      })()`);

      trips.push(tripDetail);

      // サーバー負荷軽減のため待機
      if (i < tripUuids.length - 1) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_TRIPS_MS));
      }
    }

    const structuredData = {
      source: 'uber-driver-web',
      fetchedAt: new Date().toISOString(),
      targetDate: date,
      activity: {
        feedItems: items
      },
      trips
    };

    return structuredData;
  } finally {
    client.close();
  }
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
  selectUberPage,
  findBrowserExecutable,
  launchOrConnectBrowser,
  checkAuthStatus,
  determineAuthState,
  fetchUberDataForDate,
  saveStructuredInbox,
  CdpClient
};
