'use strict';

// 認証・target選択のみ。実ブラウザ、本番取込、ファイル書込みは使用しない。
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { selectUberPage, checkAuthStatus, determineAuthState, CdpClient } = require('../lib/browser-fetcher');
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
  } finally { mock.restoreAll(); }
});
