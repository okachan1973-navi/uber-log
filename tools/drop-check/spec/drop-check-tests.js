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

test('基礎データ（Excel由来）に本人データを持たない・本人評価は3段階＋未検証は評価ではない', () => {
  B.forEach(b => assert.ok(!('my' in b), b.name));
  assert.deepStrictEqual(Object.keys(DATA.rating_levels), ['ok', 'caution', 'avoid']);
  assert.deepStrictEqual(Object.values(DATA.rating_levels).map(v => v.icon + v.label), ['🟢問題なし', '🟡注意', '🔴避けたい']);
  assert.deepStrictEqual(D.RATINGS, ['ok', 'caution', 'avoid']);
  assert.ok(!D.RATINGS.includes('unverified'), '未検証は4段階目の評価ではない');
  const u = D.ratingInfo(B[0], DATA);
  assert.deepStrictEqual([u.icon, u.label, u.verified, u.code], ['⚪', '未検証', false, null]);
  assert.ok(!/地雷|絶対|拒否/.test(JSON.stringify(DATA.rating_levels)));
});

// ---- 本人評価・本人メモ（保存・読み込み） ----
function memStorage() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, raw: m }; }
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 2, 0, 0, tick++)).toISOString();

test('未検証 → 問題なし／注意／避けたい（初めて付けた時点で本人確認済み）', () => {
  ['ok', 'caution', 'avoid'].forEach((code, i) => {
    const st = memStorage();
    const p = D.createPersonalStore(st, clock);
    const b = B[i];
    assert.strictEqual(p.get(b.id), null);
    assert.strictEqual(p.setRating(b, code), true);
    const it = p.get(b.id);
    assert.strictEqual(it.rating, code);
    assert.ok(it.verified_at && it.rating_updated_at);
    assert.deepStrictEqual(it.ref, { name: b.name, ward: b.ward, address: b.address });
    const v = D.attachPersonal(B, p.all()).find(x => x.id === b.id);
    const r = D.ratingInfo(v, DATA);
    assert.deepStrictEqual([r.code, r.verified, r.label], [code, true, DATA.rating_levels[code].label]);
  });
  assert.throws(() => D.createPersonalStore(memStorage()).setRating(B[0], 'unverified'));
});

test('評価の変更・未検証に戻す（評価だけ消えメモは残る）', () => {
  const st = memStorage();
  const p = D.createPersonalStore(st, clock);
  const b = B[5];
  p.setRating(b, 'ok');
  const firstVerified = p.get(b.id).verified_at;
  p.setRating(b, 'avoid');
  assert.strictEqual(p.get(b.id).rating, 'avoid');
  assert.strictEqual(p.get(b.id).verified_at, firstVerified, '確認日は最初のまま');
  p.setNote(b, 'EVまで遠い');
  p.clearRating(b);
  assert.strictEqual(p.get(b.id).rating, null);
  assert.strictEqual(p.get(b.id).verified_at, null);
  assert.strictEqual(p.get(b.id).note, 'EVまで遠い');
  assert.strictEqual(D.ratingInfo(D.attachPersonal(B, p.all()).find(x => x.id === b.id), DATA).label, '未検証');
  p.setNote(b, '');
  assert.strictEqual(p.get(b.id), null, '評価もメモも無くなった記録は消す');
});

test('本人メモ: 保存・変更・20文字まで・1行（改行は空白）', () => {
  const p = D.createPersonalStore(memStorage(), clock);
  const b = B[7];
  assert.strictEqual(D.NOTE_MAX, 20);
  p.setNote(b, '3階経由');
  assert.strictEqual(p.get(b.id).note, '3階経由');
  p.setNote(b, ' インターホン2回\n館内歩く ');
  assert.strictEqual(p.get(b.id).note, 'インターホン2回 館内歩く');
  p.setNote(b, 'あ'.repeat(20));
  assert.strictEqual(D.noteLength(p.get(b.id).note), 20);
  assert.throws(() => p.setNote(b, 'あ'.repeat(21)), /20文字/);
  assert.strictEqual(p.get(b.id).note, 'あ'.repeat(20), '上限超えは保存しない');
  assert.strictEqual(D.noteLength('EV🚲遠い'), 5, '絵文字も1文字');
});

test('保存した評価・メモは読み込み直しても残る（localStorage 相当）', () => {
  const st = memStorage();
  const p1 = D.createPersonalStore(st, clock);
  p1.setRating(B[10], 'avoid');
  p1.setNote(B[10], '入口迷う');
  const saved = JSON.parse(st.raw[D.PERSONAL_KEY]);
  assert.strictEqual(saved.schema, 'uber_drop_personal/1');
  assert.ok(Array.isArray(saved.items[B[10].id].tags), '将来の理由タグ用の欄');
  const p2 = D.createPersonalStore(st, clock);
  p2.load();
  assert.deepStrictEqual([p2.get(B[10].id).rating, p2.get(B[10].id).note], ['avoid', '入口迷う']);
  const broken = memStorage(); broken.setItem(D.PERSONAL_KEY, '{壊れたデータ');
  const p3 = D.createPersonalStore(broken, clock);
  assert.deepStrictEqual(p3.load().items, {}, '壊れていても落ちない');
});

test('検索結果・区フィルターに本人評価とメモが反映（メモでも検索できる）', () => {
  const p = D.createPersonalStore(memStorage(), clock);
  const rise = B.find(b => b.name === '阿波座ライズタワーズ フラッグ46');
  p.setRating(rise, 'avoid');
  p.setNote(rise, '館内歩く');
  const v = D.attachPersonal(B, p.all());
  const hit = D.search(v, { query: 'ライズ' })[0];
  assert.strictEqual(D.ratingInfo(hit, DATA).code, 'avoid');
  assert.strictEqual(hit.my.note, '館内歩く');
  assert.strictEqual(D.search(v, { query: '', ward: '西区' }).find(x => x.id === rise.id).my.rating, 'avoid');
  assert.deepStrictEqual(D.search(v, { query: '館内歩く' }).map(x => x.name), ['阿波座ライズタワーズ フラッグ46']);
  assert.strictEqual(D.search(v, { query: '' }).length, 44, '評価しても44件のまま');
});

test('Excel再取込で本人データが消えない（id は名前・住所の変更でも引き継ぐ／控えの名前でも付け直す）', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reimport-'));
  fs.copyFileSync(path.join(ROOT, 'data', 'uber_drop_buildings.json'), path.join(tmp, 'uber_drop_buildings.json'));
  const xlsx = path.join(tmp, 'changed.xlsx');
  // 元の Excel は読むだけ。一時コピーで「名前の表記変更」「番地の変更」「物件の追加」をした版を作る
  const py = `
import openpyxl, sys, shutil
src = sys.argv[1]; dst = sys.argv[2]
shutil.copyfile(src, dst)
wb = openpyxl.load_workbook(dst)
ws = wb.worksheets[0]
ws.cell(row=3, column=2).value = '阿波座ライズタワーズ・フラッグ46（表記変更）'
ws.cell(row=4, column=3).value = '大阪市西区南堀江3丁目16-99'
ws.append(['西区', 'テスト追加タワー', '大阪市西区九条1丁目', 30, '注意', None, 'https://example.invalid/'])
s = wb.worksheets[1]
for r in range(2, s.max_row + 1):
    if s.cell(row=r, column=1).value == '西区':
        s.cell(row=r, column=2).value = 9
wb.save(dst)
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const excelPath = path.join(require('os').homedir(), 'Desktop', '大阪市_タワマン一覧_Uber配達用.xlsx');
  const before = fs.statSync(excelPath).mtimeMs;
  execFileSync('python', ['-c', py, excelPath, xlsx], { env });
  // 取込前に本人データを付けておく（端末保存は基礎データと別）
  const st = memStorage();
  const p = D.createPersonalStore(st, clock);
  const rise = B.find(b => b.name === '阿波座ライズタワーズ フラッグ46');
  const horie = B.find(b => b.name === 'シエリアタワー大阪堀江');
  p.setRating(rise, 'avoid'); p.setNote(rise, '館内長い');
  p.setRating(horie, 'ok');
  const savedBefore = st.raw[D.PERSONAL_KEY];
  execFileSync('python', [path.join(ROOT, 'tools', 'drop-check', 'import_excel.py'), xlsx, '--out-dir', tmp], { env });
  const next = JSON.parse(fs.readFileSync(path.join(tmp, 'uber_drop_buildings.json'), 'utf8')).buildings;
  assert.strictEqual(next.length, 45);
  const nRise = next.find(b => b.name === '阿波座ライズタワーズ・フラッグ46（表記変更）');
  const nHorie = next.find(b => b.name === 'シエリアタワー大阪堀江');
  assert.strictEqual(nRise.id, rise.id, '名前の表記が変わっても同じ区・所在地なら同じ id');
  assert.strictEqual(nHorie.id, horie.id, '番地が変わっても同じ名前なら同じ id');
  assert.ok(B.every(b => next.some(n => n.id === b.id)), '既存44件の id はすべて残る');
  assert.strictEqual(st.raw[D.PERSONAL_KEY], savedBefore, '取込は本人データ（端末保存）に触れない');
  const v = D.attachPersonal(next, p.all());
  assert.deepStrictEqual([v.find(x => x.id === rise.id).my.rating, v.find(x => x.id === rise.id).my.note], ['avoid', '館内長い']);
  assert.strictEqual(v.find(x => x.id === horie.id).my.rating, 'ok');
  // 万一 id が変わっても、本人データに控えた物件名で付け直す
  const renamedId = B.map(b => (b.id === horie.id ? Object.assign({}, b, { id: 'bld_new_id' }) : b));
  assert.strictEqual(D.attachPersonal(renamedId, p.all()).find(x => x.id === 'bld_new_id').my.rating, 'ok');
  assert.strictEqual(fs.statSync(excelPath).mtimeMs, before, '元の Excel は変更しない');
  fs.rmSync(tmp, { recursive: true, force: true });
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
