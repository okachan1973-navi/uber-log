#!/usr/bin/env node
/**
 * data/uber_route_geo.json（正本）→ data/uber_route_geo.js（ブラウザ用。file:// でも読めるように）
 *   node tools/route-judge/build-geo.js          … 書き出し
 *   node tools/route-judge/build-geo.js --check  … 同期しているか確認のみ
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'data', 'uber_route_geo.json');
const OUT = path.join(ROOT, 'data', 'uber_route_geo.js');

function bundleText(geo) {
  return [
    '// 自動生成ファイル（tools/route-judge/build-geo.js）。直接編集しないこと。正本: data/uber_route_geo.json',
    'window.UBER_ROUTE_GEO = ' + JSON.stringify(geo) + ';',
    ''
  ].join('\n');
}

const geo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const text = bundleText(geo);
if (process.argv.includes('--check')) {
  const ok = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === text;
  console.log(ok ? 'data/uber_route_geo.js は最新' : 'ERROR data/uber_route_geo.js が JSON と不一致（build-geo.js を実行）');
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(OUT, text);
console.log('書き出し: data/uber_route_geo.js');
