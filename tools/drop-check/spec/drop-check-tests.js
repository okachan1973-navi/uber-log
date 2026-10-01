#!/usr/bin/env node
/**
 * DROP先照合（地雷タブ）の単体テスト
 *   node tools/drop-check/spec/drop-check-tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const D = require(path.join(ROOT, 'js', 'drop-check-core.js'));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_drop_buildings.json'), 'utf8'));
const B = DATA.buildings;
const names = list => list.map(b => b.name);
const s = (query, ward) => D.search(B, { query, ward });

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('drop-check tests');

test('Excelの全44物件を欠落なく取込（区別集計シートと一致）', () => {
  assert.strictEqual(B.length, 44);
  assert.strictEqual(DATA.source.rows, 44);
  assert.deepStrictEqual(DATA.source.ward_counts_sheet, { 西区: 8, 福島区: 6, 港区: 4, 北区: 13, 此花区: 3, 中央区: 10 });
  const counts = {};
  B.forEach(b => { counts[b.ward] = (counts[b.ward] || 0) + 1; });
  assert.deepStrictEqual(counts, DATA.source.ward_counts_sheet);
  assert.deepStrictEqual(B.map(b => b.excel_row), Array.from({ length: 44 }, (_, i) => i + 2), 'Excel 2〜45行目を順に取込');
  assert.strictEqual(new Set(B.map(b => b.id)).size, 44);
});

test('Excelの全列を保持（区・マンション名・所在地・階数・Uber目安・備考・情報源）', () => {
  B.forEach(b => {
    ['ward', 'name', 'address', 'floors', 'excel_level', 'note', 'source_url'].forEach(k => assert.ok(k in b, `${b.name}: ${k}`));
    assert.ok(b.name && b.address && b.ward && Number.isInteger(b.floors), b.name);
    assert.ok(/^https?:\/\//.test(b.source_url), b.name);
    assert.ok(['要注意', '注意'].includes(b.excel_level), b.name);
  });
  const rise = B.find(b => b.name === '阿波座ライズタワーズ フラッグ46');
  assert.deepStrictEqual([rise.ward, rise.address, rise.floors, rise.excel_level, rise.town, rise.chome], ['西区', '大阪市西区江之子島2丁目1-37', 46, '要注意', '江之子島', 2]);
  assert.strictEqual(B.find(b => b.name === 'シティタワー大阪本町').note, '855戸級');
  assert.strictEqual(B.filter(b => b.note).length, 9);
});

test('Excel掲載だけで評価しない（本人評価は全件 未評価＝🟡未検証）', () => {
  B.forEach(b => {
    assert.strictEqual(b.my.rating, null, b.name);
    const r = D.ratingInfo(b, DATA.rating_levels);
    assert.deepStrictEqual([r.icon, r.label], ['🟡', '未検証']);
  });
  const a = D.ratingInfo({ my: { rating: 'A' } }, DATA.rating_levels);
  assert.strictEqual(a.label, '避けたい（実体験）', '将来 A 評価を付けたときの表示');
  assert.ok(!/地雷|絶対|拒否/.test(JSON.stringify(DATA.rating_levels)));
});

test('全物件に読み（あいうえお順用）と町名の読み', () => {
  B.forEach(b => {
    assert.ok(/^[ぁ-ゟー\s0-9a-z]+$/.test(b.reading), `${b.name}: ${b.reading}`);
    assert.ok(b.town && b.town_reading, b.name);
  });
});

test('区フィルター: 西区8・福島区6・港区4・北区13・此花区3・中央区10、その他0', () => {
  assert.strictEqual(s('', '西区').length, 8);
  assert.strictEqual(s('', '福島区').length, 6);
  assert.strictEqual(s('', '港区').length, 4);
  assert.strictEqual(s('', '北区').length, 13);
  assert.strictEqual(s('', '此花区').length, 3);
  assert.strictEqual(s('', '中央区').length, 10);
  assert.strictEqual(s('', 'other').length, 0);
  assert.strictEqual(s('', 'all').length, 44);
  assert.ok(s('', '西区').every(b => b.ward === '西区'));
  const chips = D.wardChips(B);
  assert.deepStrictEqual(chips.map(c => c.label), ['西区', '港区', '此花区', '福島区', '北区', '中央区', 'その他']);
});

test('あいうえお順（読み順）', () => {
  assert.deepStrictEqual(names(s('', '西区')), [
    '阿波座ライズタワーズ フラッグ46', '大阪ひびきの街 ザ・サンクタスタワー', 'ザ・ファインタワー大阪肥後橋', 'シエリアタワー大阪堀江',
    'ジオタワー新町', 'D’グラフォート大阪N.Y.タワーHIGOBASHI', 'プレミストタワー靱本町', 'プレミストタワー大阪新町ローレルコート'
  ]); // 靱本町（うつぼ…）は 大阪新町（おおさか…）より前
  assert.deepStrictEqual(names(s('', '此花区')), ['リバーガーデンECOシティ アリスの森', 'リバーガーデンシティアリス', 'ルナタワー・ハリウッドプレイス']);
  const all = s('', 'all');
  for (let i = 1; i < all.length; i++) assert.ok(D.byReading(all[i - 1], all[i]) <= 0, all[i - 1].name + ' / ' + all[i].name);
});

test('マンション名の部分一致（カタカナ・ひらがな・全角半角・英字）', () => {
  assert.deepStrictEqual(names(s('ライズ')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('らいず')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('ﾗｲｽﾞ')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('アップル')), ['淀屋橋アップルタワーレジデンス']);
  assert.deepStrictEqual(names(s('brillia')), ['Brillia Tower 堂島']);
  assert.deepStrictEqual(names(s('ザ・タワー大阪')), ['ザ・タワー大阪']);
  assert.deepStrictEqual(names(s('ザタワー大阪')), ['ザ・タワー大阪']);
  assert.ok(s('ザ タワー大阪').length === 2, '空白は AND（ザ・ファインタワー大阪肥後橋 も一致）');
  assert.ok(s('シティタワー').length === 5);
});

test('町名・住所での検索（読み・旧字体も）', () => {
  assert.deepStrictEqual(names(s('江之子島')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('えのこじま')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('中之島')).sort(), ['ザ・パークハウス中之島タワー', 'シエリアタワー中之島'].sort());
  assert.deepStrictEqual(names(s('曽根崎')), ['梅田ガーデンレジデンス']);
  assert.deepStrictEqual(names(s('曾根崎')), ['梅田ガーデンレジデンス']);
  assert.deepStrictEqual(names(s('江之子島2丁目')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('弁天1丁目')).length, 3);
  assert.deepStrictEqual(names(s('USJ')).length, 3, '備考も検索対象');
});

test('検索結果ゼロ', () => {
  assert.strictEqual(s('存在しない物件名').length, 0);
  assert.strictEqual(s('ライズ', '港区').length, 0);
});

test('区フィルター＋検索の併用・区名を含む音声入力', () => {
  assert.deepStrictEqual(names(s('新町', '西区')), ['大阪ひびきの街 ザ・サンクタスタワー', 'ジオタワー新町', 'プレミストタワー大阪新町ローレルコート']);
  assert.deepStrictEqual(names(s('西区 ライズ')), ['阿波座ライズタワーズ フラッグ46']);
  assert.deepStrictEqual(names(s('西区ライズ。')), ['阿波座ライズタワーズ フラッグ46'], '音声の句点・区名の連結');
  assert.strictEqual(s('北区').length, 13, '区名だけの入力は区で絞る');
  assert.deepStrictEqual(names(s('中央区 北浜')), ['The Kitahama', '北浜ミッドタワー', 'パークタワー北浜', 'プラウドタワー北浜'].sort((a, b) => D.byReading(B.find(x => x.name === a), B.find(x => x.name === b))), '漢字の町名「北浜」で英字名 The Kitahama（読み きたはま）も');
  const before = JSON.stringify(B);
  s('ライズ'); s('北浜');
  assert.strictEqual(JSON.stringify(B), before, '検索でデータを書き換えない');
  assert.ok(s('シティタワー', '北区').every(b => b.ward === '北区'));
});

test('data/uber_drop_buildings.js が JSON と同期', () => {
  const js = fs.readFileSync(path.join(ROOT, 'data', 'uber_drop_buildings.js'), 'utf8');
  const m = js.match(/window\.UBER_DROP_BUILDINGS = (.*);\n/);
  assert.ok(m);
  assert.deepStrictEqual(JSON.parse(m[1]), DATA);
});

console.log(`${passed} passed`);
