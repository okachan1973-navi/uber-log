#!/usr/bin/env node
/**
 * 版番号の一本化: version.json の version を唯一の元にして、各ファイルの版番号へ反映する
 *
 *   node tools/release-check/version.js          … version.json の版を各ファイルへ反映
 *   node tools/release-check/version.js --check  … 反映済みか確認だけ（ずれていれば exit 1）
 *   node tools/release-check/version.js --bump   … 版を上げて（YYYYMMDD_v{N+1}・releasedAt 更新）各ファイルへ反映
 *
 * 反映先:
 *   index.html       … 読込番号（?v=）・Service Worker 登録・window.UBER_LOG_APP_VERSION（設定画面の表示もこれを使う）
 *   sw.js            … SW_VERSION（キャッシュ名）
 *   pickup-map.html / route-judge.html … 同じサイト内のファイルの読込番号（?v=）。取込で store.js・店舗データが変わっても古いキャッシュを使わない
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const VERSION_RE = /\d{8}_v\d+/g;

// ファイルごとの「版番号の場所」。CDN など外部の URL（http〜）の ?v= は対象外
const TARGETS = [
  { file: 'index.html', find: src => src.match(VERSION_RE) || [], apply: (src, v) => src.replace(VERSION_RE, v) },
  { file: 'sw.js', find: src => src.match(VERSION_RE) || [], apply: (src, v) => src.replace(VERSION_RE, v) },
  ...['pickup-map.html', 'route-judge.html'].map(file => ({
    file,
    find: src => [...src.matchAll(/(?:src|href)="(?!https?:)[^"?]+\?v=([^"]+)"/g)].map(m => m[1]),
    apply: (src, v) => src.replace(/((?:src|href)="(?!https?:)[^"?]+\?v=)[^"]+"/g, `$1${v}"`)
  }))
];

function readVersion() {
  const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  if (!/^\d{8}_v\d+$/.test(j.version || '')) throw new Error(`version.json の version 形式が想定外です: ${j.version}`);
  return j;
}

function localIso(d) {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** 版を上げる（公式取込の bumpVersion と同じ規則: 日付は今日、番号は +1） */
function bump(now = new Date()) {
  const raw = fs.readFileSync(VERSION_FILE, 'utf8');
  const j = readVersion();
  const n = parseInt(j.version.split('_v')[1], 10) + 1;
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const next = `${ymd}_v${n}`;
  const out = raw.replace(`"version": "${j.version}"`, `"version": "${next}"`).replace(/"releasedAt": "[^"]*"/, `"releasedAt": "${localIso(now)}"`);
  fs.writeFileSync(VERSION_FILE, out, 'utf8');
  return { from: j.version, to: next };
}

/** 各ファイルの版番号の状況（ずれている場所の一覧） */
function inspect(version) {
  return TARGETS.map(t => {
    const src = fs.readFileSync(path.join(ROOT, t.file), 'utf8');
    const found = t.find(src);
    const wrong = [...new Set(found.filter(x => x !== version))];
    return { file: t.file, count: found.length, wrong };
  });
}

function apply(version) {
  return TARGETS.map(t => {
    const file = path.join(ROOT, t.file);
    const src = fs.readFileSync(file, 'utf8');
    const next = t.apply(src, version);
    if (next !== src) fs.writeFileSync(file, next, 'utf8');
    return { file: t.file, changed: next !== src };
  });
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--bump')) {
    const b = bump();
    console.log(`版を更新: ${b.from} → ${b.to}`);
  }
  const { version } = readVersion();
  if (args.has('--check')) {
    const res = inspect(version);
    res.forEach(r => console.log(`  ${r.wrong.length ? '✕' : '✓'} ${r.file}（${r.count}か所）${r.wrong.length ? ' 古い版: ' + r.wrong.join(', ') : ''}`));
    const bad = res.filter(r => r.wrong.length || !r.count);
    console.log(bad.length ? `ERROR 版番号が version.json（${version}）とずれています: node tools/release-check/version.js で反映` : `版番号はすべて ${version} と一致`);
    process.exit(bad.length ? 1 : 0);
  }
  const res = apply(version);
  res.forEach(r => console.log(`  ${r.changed ? '更新' : '変更なし'} ${r.file}`));
  console.log(`版番号を ${version} に統一しました`);
}

if (require.main === module) main();
module.exports = { readVersion, inspect, apply, bump, TARGETS };
