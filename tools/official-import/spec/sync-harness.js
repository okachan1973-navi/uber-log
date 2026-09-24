/**
 * 端末・クラウド同期の再現用ハーネス（テスト専用）
 *
 * 本物の js/store.js と js/cloud-sync.js を、端末（またはタブ）ごとに独立した JS 実行環境（vm）で読み込む。
 * - 同じ storage を渡せば「同じ端末の別タブ／別インスタンス」、別の storage なら「別端末」。
 * - cloud は Supabase の uber_daily_logs / uber_benchmarks を模したメモリ上の表（全端末で共有）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.UBER_LOG_ROOT ? path.resolve(process.env.UBER_LOG_ROOT) : path.resolve(__dirname, '..', '..', '..');
const SRC = {
  store: fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8'),
  sync: fs.readFileSync(path.join(ROOT, 'js', 'cloud-sync.js'), 'utf8')
};

function createStorage(initial = {}) {
  const map = { ...initial };
  return {
    map,
    getItem: k => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: k => { delete map[k]; },
    clear: () => Object.keys(map).forEach(k => delete map[k])
  };
}

function createCloud() {
  const tables = { uber_daily_logs: new Map(), uber_benchmarks: new Map() };
  let online = true;
  const clone = v => JSON.parse(JSON.stringify(v));
  const from = table => ({
    select() {
      return {
        eq: async () => {
          if (!online) return { data: null, error: { message: 'offline' } };
          return { data: [...tables[table].values()].map(r => clone(r)), error: null };
        }
      };
    },
    async upsert(row) {
      if (!online) return { error: { message: 'offline' } };
      const key = row.date || row.id;
      tables[table].set(key, { ...clone(row), updated_at: new Date().toISOString() });
      if (api.onUpsert) await api.onUpsert(row);
      return { error: null };
    }
  });
  const api = {
    onUpsert: null,
    tables,
    setOnline(v) { online = v; },
    row(date) { const r = tables.uber_daily_logs.get(date); return r ? clone(r.data) : null; },
    client: { from }
  };
  return api;
}

/**
 * 端末（またはタブ）を1つ起動する
 * @param {{storage, cloud?, loggedIn?:boolean}} opts
 */
function createDevice({ storage, cloud = null, loggedIn = true, lazySession = false }) {
  const listeners = {};
  const document = { visibilityState: 'visible', readyState: 'complete', addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } };
  // lazySession: 本物の supabase-client.js と同じく、isReady()/getSession() が呼ばれるまでセッション（ログイン状態）を復元しない
  let restored = !lazySession;
  const window = {
    localStorage: storage,
    addEventListener: (ev, fn) => { (listeners[`w:${ev}`] = listeners[`w:${ev}`] || []).push(fn); },
    supabaseManager: cloud ? {
      isReady: () => { restored = true; return true; },
      isLoggedIn: () => loggedIn && restored,
      getSession: async () => { restored = true; return loggedIn ? {} : null; },
      getUserId: () => 'user-1',
      onAuthChange: () => {},
      client: cloud.client
    } : undefined,
    location: { protocol: 'https:' }
  };
  const ctx = {
    window, document, localStorage: storage, navigator: { onLine: true },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, JSON, Date, Math, Promise, Map, Set, Array, Object, Number, String, Boolean, RegExp, Error, isNaN, parseInt, parseFloat
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC.store, ctx, { filename: 'store.js' });
  vm.runInContext(SRC.sync, ctx, { filename: 'cloud-sync.js' });
  vm.runInContext('window.cloudSync = cloudSync;', ctx);
  const store = ctx.window.store;
  const sync = ctx.window.cloudSync;
  return {
    store,
    sync,
    window,
    storage,
    fire(ev) { (listeners[ev] || []).concat(listeners[`w:${ev}`] || []).forEach(fn => fn({ key: 'uber_log_v1_data' })); },
    async flushPush() { await sync.pushPendingChanges(); },
    async pull() { await sync.pullAndSync(); },
    day(date) { return store.state.dailyLogs[date]; },
    bikeIds(date) { return ((store.state.dailyLogs[date] || {}).expenses || []).filter(e => /バイク/.test(e.category || '')).map(e => e.id); },
    profit(date) { return store.getCalculatedMetrics(store.getDailyLog(date)).netProfit; },
    hasB(date) { return store.getDayAttributes(date).some(a => a.key === 'bike_share'); },
    storedExpenseIds(date) {
      const raw = storage.getItem('uber_log_v1_data');
      const d = raw ? JSON.parse(raw).dailyLogs[date] : null;
      return ((d && d.expenses) || []).map(e => e.id);
    }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { createStorage, createCloud, createDevice, sleep };
