#!/usr/bin/env node
/**
 * 天気データ（気象庁の過去の観測・大阪）を取得して data/uber_weather.json / .js に保存する（開発用・PC で実行）
 *
 *   node tools/weather/fetch-jma-weather.js            … Uber 運用開始（2026-09-10）〜今月を取得して保存（気象庁のページを月ごとに1回ずつ読む）
 *   node tools/weather/fetch-jma-weather.js --check    … 保存済みデータの確認だけ（ネット接続なし。JSON と .js の一致・分類規則・日付）
 *
 * 取得元は気象庁の公開ページ（APIキー不要・無料）。外部への送信はしない。分類規則は tools/weather/jma-weather.js。
 * 天気概況がまだ発表されていない日（直近の数日）は保存しない（画面は「—」）。発表後にもう一度実行すると入る。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./jma-weather.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_JSON = path.join(ROOT, 'data', 'uber_weather.json');
const OUT_JS = path.join(ROOT, 'data', 'uber_weather.js');
const START = '2026-09-10'; // Uber 運用開始日

function jstToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function toJs(data) {
  return '// UBER_LOG 天気データ（気象庁 過去の気象データ・大阪）。tools/weather/fetch-jma-weather.js が生成（手で編集しない）\n' +
    `window.UBER_WEATHER = ${JSON.stringify(data)};\n`;
}

function check() {
  const data = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  const errors = [];
  if (fs.readFileSync(OUT_JS, 'utf8') !== toJs(data)) errors.push('data/uber_weather.js が data/uber_weather.json と一致しない（fetch-jma-weather.js を実行）');
  Object.entries(data.days || {}).forEach(([date, e]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < START) errors.push(`${date}: 日付が不正、または運用開始日より前`);
    if (!W.TYPES.includes(e.type)) errors.push(`${date}: 不明な分類 ${e.type}`);
    if (W.classify(e.day) !== e.type) errors.push(`${date}: 分類が規則と違う（${e.day} → ${W.classify(e.day)} / 保存 ${e.type}）`);
  });
  const n = Object.keys(data.days || {}).length;
  console.log(errors.length ? errors.map(e => 'ERROR ' + e).join('\n') : `天気データは最新の規則と一致（${n}日・${data.range || ''}）`);
  process.exit(errors.length ? 1 : 0);
}

async function main() {
  if (process.argv.includes('--check')) return check();
  const today = jstToday();
  const prev = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) : { days: {} };
  const days = { ...(prev.days || {}) };
  const months = [];
  for (let [y, m] = START.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= today.slice(0, 7); m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
  let added = 0, pending = [];
  for (const [y, m] of months) {
    const res = await fetch(W.pageUrl(y, m));
    if (!res.ok) throw new Error(`気象庁のページを取得できません（${y}-${m}: HTTP ${res.status}）`);
    const rows = W.parseDailyPage(await res.text(), y, m);
    rows.filter(r => r.date >= START && r.date < today).forEach(r => {
      const e = W.toEntry(r);
      if (!e) { pending.push(r.date); return; }
      if (!days[r.date] || JSON.stringify(days[r.date]) !== JSON.stringify(e)) added++;
      days[r.date] = e;
    });
  }
  const dates = Object.keys(days).sort();
  const data = {
    source: { name: '気象庁 過去の気象データ検索（日ごとの値・主な要素）', station: W.STATION.name, prec_no: W.STATION.prec_no, block_no: W.STATION.block_no, urlTemplate: W.pageUrl('YYYY', 'MM'),
      rule: '昼（06:00-18:00）の天気概況で分類。雨・雪・みぞれ・ひょう・あられを含めば雨、それ以外は最初の天気（快晴・晴→晴／薄曇・曇→曇）' },
    fetchedAt: new Date().toISOString(),
    range: dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : '',
    days: Object.fromEntries(dates.map(d => [d, days[d]]))
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 1) + '\n', 'utf8');
  fs.writeFileSync(OUT_JS, toJs(data), 'utf8');
  console.log(`保存: ${dates.length}日（${data.range}）・更新 ${added}日${pending.length ? `・天気概況が未発表 ${pending.join(', ')}` : ''}`);
}

main().catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
