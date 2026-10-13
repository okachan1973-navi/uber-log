#!/usr/bin/env node
/**
 * 天気データ（気象庁の過去の観測・大阪）を取得して data/uber_weather.json / .js に保存する（開発用・PC で実行）
 *
 *   node tools/weather/fetch-jma-weather.js                 … Uber 運用開始（2026-09-10）〜昨日を取得して保存（発表済みの値で更新）
 *   node tools/weather/fetch-jma-weather.js --missing-only  … まだ登録されていない過去日だけを追加（登録済みの日は書き換えない）
 *   node tools/weather/fetch-jma-weather.js --check         … 保存済みデータの確認だけ（ネット接続なし。JSON と .js の一致・分類規則・日付）
 *
 * 公式取込（tools/official-import の import-job.js）は反映後に updateWeather({ missingOnly: true }) を呼ぶ。
 * 取得できなくても取込は止めない（警告として記録するだけ。保存済みの天気データは変更しない）。
 * 取得元は気象庁の公開ページ（APIキー不要・無料）。外部への送信はしない。分類規則は tools/weather/jma-weather.js。
 * 今日（まだ終わっていない日）と、天気概況がまだ発表されていない日は保存しない（画面は「—」。次の取込で再確認）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./jma-weather.js');

const START = '2026-09-10'; // Uber 運用開始日

function jstToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function toJs(data) {
  return '// UBER_LOG 天気データ（気象庁 過去の気象データ・大阪）。tools/weather/fetch-jma-weather.js が生成（手で編集しない）\n' +
    `window.UBER_WEATHER = ${JSON.stringify(data)};\n`;
}

const filesOf = root => ({ json: path.join(root, 'data', 'uber_weather.json'), js: path.join(root, 'data', 'uber_weather.js') });

// 運用開始日〜昨日の日付
function pastDates(today) {
  const out = [];
  const [y, m, d] = START.split('-').map(Number);
  for (let dt = new Date(y, m - 1, d); ; dt.setDate(dt.getDate() + 1)) {
    const s = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if (s >= today) break;
    out.push(s);
  }
  return out;
}

/**
 * 天気データを更新する
 * @param {{root:string, missingOnly?:boolean, today?:string, fetchImpl?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, added:string[], updated:string[], unpublished:string[], total:number, error?:string}>} 失敗しても throw しない
 */
async function updateWeather(opts) {
  const root = opts.root;
  const today = opts.today || jstToday();
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 20000;
  const files = filesOf(root);
  const result = { ok: false, added: [], updated: [], unpublished: [], total: 0 };
  try {
    const prev = fs.existsSync(files.json) ? JSON.parse(fs.readFileSync(files.json, 'utf8')) : { days: {} };
    const days = { ...(prev.days || {}) };
    const targets = pastDates(today).filter(d => !opts.missingOnly || !days[d]);
    if (!targets.length) { result.ok = true; result.total = Object.keys(days).length; return result; }
    const months = [...new Set(targets.map(d => d.slice(0, 7)))];
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number);
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let html;
      try {
        const res = await fetchImpl(W.pageUrl(y, m), ctrl ? { signal: ctrl.signal } : {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      } finally { if (timer) clearTimeout(timer); }
      W.parseDailyPage(html, y, m).filter(r => targets.includes(r.date)).forEach(r => {
        const e = W.toEntry(r);
        if (!e) { result.unpublished.push(r.date); return; }
        if (!days[r.date]) result.added.push(r.date);
        else if (JSON.stringify(days[r.date]) !== JSON.stringify(e)) result.updated.push(r.date);
        days[r.date] = e;
      });
    }
    if (result.added.length || result.updated.length || !fs.existsSync(files.json)) {
      const dates = Object.keys(days).sort();
      const data = {
        source: { name: '気象庁 過去の気象データ検索（日ごとの値・主な要素）', station: W.STATION.name, prec_no: W.STATION.prec_no, block_no: W.STATION.block_no, urlTemplate: W.pageUrl('YYYY', 'MM'),
          rule: '昼（06:00-18:00）の天気概況で分類。雨・雪・みぞれ・ひょう・あられを含めば雨、それ以外は最初の天気（快晴・晴→晴／薄曇・曇→曇）' },
        fetchedAt: new Date().toISOString(),
        range: dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : '',
        days: Object.fromEntries(dates.map(d => [d, days[d]]))
      };
      fs.mkdirSync(path.dirname(files.json), { recursive: true });
      fs.writeFileSync(files.json, JSON.stringify(data, null, 1) + '\n', 'utf8');
      fs.writeFileSync(files.js, toJs(data), 'utf8');
    }
    result.total = Object.keys(days).length;
    result.ok = true;
  } catch (e) {
    result.error = e.name === 'AbortError' ? `気象庁のページの取得が ${Math.round(timeoutMs / 1000)}秒で終わりませんでした` : e.message;
  }
  return result;
}

function check(root) {
  const files = filesOf(root);
  const data = JSON.parse(fs.readFileSync(files.json, 'utf8'));
  const errors = [];
  if (fs.readFileSync(files.js, 'utf8') !== toJs(data)) errors.push('data/uber_weather.js が data/uber_weather.json と一致しない（fetch-jma-weather.js を実行）');
  const today = jstToday();
  Object.entries(data.days || {}).forEach(([date, e]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < START) errors.push(`${date}: 日付が不正、または運用開始日より前`);
    if (date >= today) errors.push(`${date}: 今日以降の天気が入っている（今日はまだ確定していない）`);
    if (!W.TYPES.includes(e.type)) errors.push(`${date}: 不明な分類 ${e.type}`);
    if (W.classify(e.day) !== e.type) errors.push(`${date}: 分類が規則と違う（${e.day} → ${W.classify(e.day)} / 保存 ${e.type}）`);
  });
  const n = Object.keys(data.days || {}).length;
  console.log(errors.length ? errors.map(e => 'ERROR ' + e).join('\n') : `天気データは最新の規則と一致（${n}日・${data.range || ''}）`);
  return errors.length ? 1 : 0;
}

if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..', '..');
  if (process.argv.includes('--check')) process.exit(check(ROOT));
  updateWeather({ root: ROOT, missingOnly: process.argv.includes('--missing-only') }).then(r => {
    if (!r.ok) { console.error('ERROR ' + r.error); process.exit(1); }
    console.log(`保存: ${r.total}日・追加 ${r.added.length}日${r.added.length ? `（${r.added.join(', ')}）` : ''}・更新 ${r.updated.length}日${r.unpublished.length ? `・天気概況が未発表 ${r.unpublished.join(', ')}` : ''}`);
  });
}

module.exports = { updateWeather, check, toJs, pastDates, START };
