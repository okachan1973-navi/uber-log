'use strict';

// 認証・target選択のみ。実ブラウザ、本番取込、ファイル書込みは使用しない。
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { selectUberPage, checkAuthStatus, determineAuthState, CdpClient, openCdpTab, launchOrConnectBrowser } = require('../lib/browser-fetcher');
const auth = { type: 'page', id: 'auth', title: 'Uber に登録またはサインイン',
  url: 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fdrivers.uber.com%2Fearnings%2Factivities&state=PRIVATE',
  webSocketDebuggerUrl: 'ws://localhost/auth' };
const activity = { type: 'page', id: 'activity', title: 'Uber | お支払い',
  url: 'https://drivers.uber.com/earnings/activities', webSocketDebuggerUrl: 'ws://localhost/activity' };

test('古いauthタブのnext_urlに惑わされずactivitiesを優先する', () => {
  assert.equal(selectUberPage([auth, activity]).id, 'activity');
  assert.equal(selectUberPage([activity, auth]).id, 'activity');
  assert.equal(selectUberPage([{ ...activity, id: 'other', url: 'https://drivers.uber.com/' }, auth, activity]).id, 'activity');
});

test('偽ホスト・別サイト・iframeを選択しない', () => {
  assert.equal(selectUberPage([
    { ...activity, url: 'https://drivers.uber.com.example.org/earnings/activities' },
    { ...activity, url: 'https://example.org/?next=https://drivers.uber.com' },
    { ...activity, type: 'iframe' }
  ]), null);
});

test('URLだけでは認証済みにしない', () => {
  const result = determineAuthState({ url: activity.url, isDrivers: true, isLoginPage: false, isDriverAuthenticated: false });
  assert.equal(result.authenticated, false);
  assert.equal(result.unknown, true);
});

test('実際のcheckAuthStatusの接続target・DOM判定・診断を確認', async () => {
  let targets = [auth, activity];
  let connected;
  let content = true;
  const diagnostics = [];
  mock.method(http, 'get', (_url, callback) => {
    const request = new EventEmitter();
    process.nextTick(() => {
      const response = new EventEmitter();
      callback(response);
      response.emit('data', JSON.stringify(targets));
      response.emit('end');
    });
    return request;
  });
  mock.method(CdpClient.prototype, 'connect', async function () { connected = this.wsUrl; });
  mock.method(CdpClient.prototype, 'close', () => {});
  mock.method(CdpClient.prototype, 'evaluate', async function (expression) {
    const target = targets.find(t => t.webSocketDebuggerUrl === this.wsUrl);
    return vm.runInNewContext(expression, {
      URL,
      window: { location: { href: target.url } },
      document: {
        title: target.title,
        body: { innerText: content && target.id === 'activity' ? 'アクティビティの詳細 Delivery' : '' },
        querySelector: selector => content && target.id === 'activity' && ['table', 'button img[alt]'].includes(selector) ? {} : null
      }
    });
  });
  try {
    let result = await checkAuthStatus('.', { onDiagnostic: d => diagnostics.push(d) });
    assert.equal(connected, activity.webSocketDebuggerUrl);
    assert.equal(result.selectedTarget.id, 'activity');
    assert.equal(result.authenticated, true);
    assert.equal(result.needsLogin, false);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);

    content = false;
    result = await checkAuthStatus('.');
    assert.equal(result.authenticated, false);
    assert.equal(result.unknown, true);

    targets = [auth];
    result = await checkAuthStatus('.');
    assert.equal(connected, auth.webSocketDebuggerUrl);
    assert.equal(result.selectedTarget.id, 'auth');
    assert.equal(result.authenticated, false);
    assert.equal(result.needsLogin, true);
    assert.equal(result.currentUrl, 'https://auth.uber.com/v2/');

    targets = [];
    result = await checkAuthStatus('.');
    assert.equal(result.selectedTarget, null);
    assert.equal(result.needsLogin, false);

    // 2026-10-16 の再発: Uberのタブがログイン済みのアカウント画面（account.uber.com）だけ → 取得対象にしない・理由をそのまま表示
    targets = [account];
    result = await checkAuthStatus('.');
    assert.equal(result.selectedTarget, null);
    assert.equal(result.needsLogin, false);
    assert.match(result.message, /アクティビティ画面ではありません（https:\/\/account\.uber\.com\/）/);
    assert.equal(result.message.includes('marketing_vistor_id'), false);
  } finally { mock.restoreAll(); }
});

const account = { type: 'page', id: 'account', title: 'Uber',
  url: 'https://account.uber.com/?entry_ctx=DRIVERS&entry_domain=drivers.uber.com&marketing_vistor_id=PRIVATE&next_url=https%3A%2F%2Fdrivers.uber.com%2Fnavigation',
  webSocketDebuggerUrl: 'ws://localhost/account' };

// CDP の HTTP エンドポイントの偽物（/json/new は Edge 111+ と同じく PUT のみ受け付ける）
function fakeCdp(state) {
  const respond = (callback, status, body) => process.nextTick(() => {
    const response = new EventEmitter();
    response.statusCode = status;
    callback(response);
    response.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    response.emit('end');
  });
  mock.method(http, 'get', (url, callback) => {
    const req = new EventEmitter();
    const p = new URL(url).pathname;
    if (p === '/json/version') respond(callback, 200, { webSocketDebuggerUrl: 'ws://localhost/browser' });
    else if (p === '/json/list') respond(callback, 200, state.targets);
    else respond(callback, 200, {});
    return req;
  });
  mock.method(http, 'request', (url, opts, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      state.requests.push(`${opts.method} ${url}`);
      if (/\/json\/new\?/.test(url) && opts.method === (state.acceptMethod || 'PUT')) {
        const t = { type: 'page', id: 'new', title: 'Uber | お支払い', url: decodeURIComponent(url.split('/json/new?')[1]), webSocketDebuggerUrl: 'ws://localhost/new' };
        state.targets = [...state.targets, t];
        respond(callback, 200, t);
      } else {
        respond(callback, 405, `Using unsafe HTTP verb ${opts.method} to invoke /json/new. This action supports only PUT verb.`);
      }
    };
    return req;
  });
}

test('/json/new は PUT で開く（Edge 155 は GET だと 405 でタブが開かない）・失敗は理由つきで返す', async () => {
  const state = { targets: [], requests: [] };
  fakeCdp(state);
  try {
    const t = await openCdpTab(9223, 'https://drivers.uber.com/earnings/activities');
    assert.equal(t.url, 'https://drivers.uber.com/earnings/activities');
    assert.deepEqual(state.requests, ['PUT http://127.0.0.1:9223/json/new?https://drivers.uber.com/earnings/activities']);

    state.acceptMethod = 'GET'; // PUT を受け付けない古いブラウザは GET で開く
    await openCdpTab(9223, 'https://drivers.uber.com/earnings/activities');
    assert.deepEqual(state.requests.slice(1).map(r => r.split(' ')[0]), ['PUT', 'GET']);

    state.acceptMethod = 'NONE';
    await assert.rejects(openCdpTab(9223, 'https://drivers.uber.com/earnings/activities'), /HTTP 405/);
  } finally { mock.restoreAll(); }
});

test('専用EdgeのUberタブがアカウント画面だけ → アクティビティ画面を新しいタブで開く（既存タブは動かさない）', async () => {
  const state = { targets: [account], requests: [] };
  fakeCdp(state);
  try {
    const r = await launchOrConnectBrowser('.', { port: 9223 });
    assert.equal(r.attached, true);
    assert.equal(r.tabError, null);
    assert.deepEqual(state.requests, ['PUT http://127.0.0.1:9223/json/new?https://drivers.uber.com/earnings/activities']);
    assert.equal(selectUberPage(state.targets).id, 'new');
    assert.equal(state.targets.find(t => t.id === 'account').url, account.url);

    // タブを開けなかった場合は握りつぶさず tabError で理由を返す
    const s2 = { targets: [account], requests: [], acceptMethod: 'NONE' };
    mock.restoreAll();
    fakeCdp(s2);
    const r2 = await launchOrConnectBrowser('.', { port: 9223 });
    assert.match(r2.tabError, /HTTP 405/);
  } finally { mock.restoreAll(); }
});

test('アカウント画面（account.uber.com）は取得対象のタブに選ばない', () => {
  assert.equal(selectUberPage([account]), null);
  assert.equal(selectUberPage([account, activity]).id, 'activity');
});
