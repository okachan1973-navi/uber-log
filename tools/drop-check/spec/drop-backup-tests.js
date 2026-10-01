#!/usr/bin/env node
/**
 * DROP個人データ JSON バックアップ（js/drop-backup.js）の単体テスト
 *   node tools/drop-check/spec/drop-backup-tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const B = require(path.join(ROOT, 'js', 'drop-backup.js'));
const D = require(path.join(ROOT, 'js', 'drop-check-core.js'));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'uber_drop_buildings.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.log('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

/** localStorage 相当。書き込み系が呼ばれたら記録する */
function memStorage(init) {
  const m = Object.assign({}, init || {});
  const writes = [];
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { writes.push(['setItem', k]); m[k] = String(v); },
    removeItem: k => { writes.push(['removeItem', k]); delete m[k]; },
    clear: () => { writes.push(['clear']); Object.keys(m).forEach(k => delete m[k]); },
    raw: m, writes
  };
}

// 現行の保存形式（js/drop-check-core.js の createPersonalStore）＋未知の項目
const SAMPLE = {
  schema: 'uber_drop_personal/1',
  updated_at: '2026-10-01T12:00:05.000Z',
  future_top_level: { a: 1 },
  items: {
    bld_b64ef0b3d7: {
      rating: 'avoid', note: '館内長い', tags: ['elevator'],
      verified_at: '2026-10-01T11:00:00.000Z', rating_updated_at: '2026-10-01T11:30:00.000Z', note_updated_at: '2026-10-01T11:31:00.000Z', updated_at: '2026-10-01T11:31:00.000Z',
      ref: { name: '大阪ひびきの街 ザ・サンクタスタワー', ward: '西区', address: '大阪市西区新町1丁目14-21' },
      unknown_field: { nested: [1, 'x', null] }
    },
    bld_x: { rating: null, note: 'メモだけ', tags: [], verified_at: null, rating_updated_at: '2026-10-01T10:00:00.000Z', note_updated_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T10:00:00.000Z', ref: { name: 'X', ward: '北区', address: '' } }
  }
};
const RAW = JSON.stringify(SAMPLE);
const NOW = new Date(2026, 9, 1, 21, 23, 45);

console.log('drop-backup tests');

test('保存データがあれば書き出せる（source_data は保存内容と完全一致・source_raw は保存文字列そのもの）', () => {
  const st = memStorage({ uber_drop_personal_v1: RAW });
  const b = B.buildBackup(st, { now: NOW });
  assert.strictEqual(b.backup_schema, 'uber_drop_backup/1');
  assert.strictEqual(b.source_storage_key, 'uber_drop_personal_v1');
  assert.strictEqual(b.source_present, true);
  assert.strictEqual(b.source_item_count, 2);
  assert.deepStrictEqual(b.source_data, JSON.parse(RAW));
  assert.strictEqual(b.source_raw, RAW);
  // JSON にしても往復で同じ
  const back = JSON.parse(B.toJson(b));
  assert.deepStrictEqual(back.source_data, JSON.parse(RAW));
  assert.strictEqual(back.source_raw, RAW);
});

test('rating・note・各日時・ref・tags・未知の項目が欠落しない', () => {
  const b = JSON.parse(B.toJson(B.buildBackup(memStorage({ uber_drop_personal_v1: RAW }), { now: NOW })));
  const it = b.source_data.items.bld_b64ef0b3d7;
  assert.strictEqual(it.rating, 'avoid');
  assert.strictEqual(it.note, '館内長い');
  ['verified_at', 'rating_updated_at', 'note_updated_at', 'updated_at'].forEach(k => assert.strictEqual(it[k], SAMPLE.items.bld_b64ef0b3d7[k], k));
  assert.deepStrictEqual(it.ref, SAMPLE.items.bld_b64ef0b3d7.ref);
  assert.deepStrictEqual(it.tags, ['elevator']);
  assert.deepStrictEqual(it.unknown_field, { nested: [1, 'x', null] });
  assert.deepStrictEqual(b.source_data.future_top_level, { a: 1 });
  assert.strictEqual(b.source_data.items.bld_x.rating, null, 'null もそのまま');
});

test('0件でも書き出せる（保存なし／items が空）', () => {
  const none = B.buildBackup(memStorage(), { now: NOW });
  assert.deepStrictEqual([none.source_present, none.source_item_count, none.source_data, none.source_raw], [false, 0, null, null]);
  assert.ok(B.toJson(none).length > 0);
  const empty = B.buildBackup(memStorage({ uber_drop_personal_v1: '{"schema":"uber_drop_personal/1","updated_at":null,"items":{}}' }), { now: NOW });
  assert.deepStrictEqual([empty.source_present, empty.source_item_count], [true, 0]);
  assert.deepStrictEqual(empty.source_data.items, {});
});

test('壊れた保存データも原文のまま書き出す（解釈できない旨を記録）', () => {
  const b = B.buildBackup(memStorage({ uber_drop_personal_v1: '{壊れた' }), { now: NOW });
  assert.strictEqual(b.source_raw, '{壊れた');
  assert.strictEqual(b.source_data, null);
  assert.ok(b.source_parse_error);
  const thrower = { getItem() { throw new Error('denied'); } };
  const t = B.buildBackup(thrower, { now: NOW });
  assert.ok(t.source_read_error && t.source_present === false, '読めない環境でも落ちない');
  assert.strictEqual(B.buildBackup(null, { now: NOW }).source_present, false);
});

test('端末メモ: なしでも・ありでも書き出せる（改行は空白、30文字まで）', () => {
  assert.strictEqual(B.buildBackup(memStorage(), { now: NOW }).device_memo, null);
  assert.strictEqual(B.buildBackup(memStorage(), { now: NOW, deviceMemo: '  ' }).device_memo, null);
  assert.strictEqual(B.buildBackup(memStorage(), { now: NOW, deviceMemo: '12Proホーム' }).device_memo, '12Proホーム');
  assert.strictEqual(B.buildBackup(memStorage(), { now: NOW, deviceMemo: 'a\nb' }).device_memo, 'a b');
  assert.strictEqual(B.buildBackup(memStorage(), { now: NOW, deviceMemo: 'あ'.repeat(40) }).device_memo.length, 30);
});

test('メタ情報: 書き出し日時（現地・UTC）・アプリ版・UA・表示モード・ページの場所。端末識別子は持たない', () => {
  const b = B.buildBackup(memStorage(), { now: NOW, appVersion: '20261002_v52', userAgent: 'UA', displayMode: 'standalone', origin: 'https://uber-log.pages.dev' });
  assert.ok(/^2026-10-01T21:23:45[+-]\d\d:\d\d$/.test(b.exported_at), b.exported_at);
  assert.strictEqual(b.exported_at_utc, NOW.toISOString());
  assert.deepStrictEqual([b.app_version, b.user_agent, b.display_mode, b.page_origin], ['20261002_v52', 'UA', 'standalone', 'https://uber-log.pages.dev']);
  assert.deepStrictEqual(Object.keys(b), ['backup_schema', 'exported_at', 'exported_at_utc', 'app_version', 'device_memo', 'user_agent', 'display_mode', 'page_origin',
    'source_storage_key', 'source_present', 'source_item_count', 'source_parse_error', 'source_read_error', 'source_data', 'source_raw']);
});

test('書き出しで保存領域を変更しない（setItem / removeItem / clear を呼ばない・内容も同じ）', () => {
  const st = memStorage({ uber_drop_personal_v1: RAW, uber_drop_view_v1: '{"sort":"rating"}', other: 'x' });
  const before = JSON.stringify(st.raw);
  B.readSource(st); B.buildBackup(st, { now: NOW, deviceMemo: 'PC' }); B.buildBackup(st);
  assert.deepStrictEqual(st.writes, []);
  assert.strictEqual(JSON.stringify(st.raw), before);
});

test('drop-backup.js は Supabase・通信・保存領域への書き込みを使わない（コード上の確認）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'drop-backup.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // コメントを除く
  ['supabase', 'fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'setItem', 'removeItem', '.clear(', 'cloudSync', 'indexedDB'].forEach(w =>
    assert.ok(!src.includes(w), '使っていない: ' + w));
});

test('ファイル名: uber_drop_backup[_英数字の端末メモ]_YYYY-MM-DD_HHMM.json', () => {
  assert.strictEqual(B.fileName(NOW), 'uber_drop_backup_2026-10-01_2123.json');
  assert.strictEqual(B.fileName(NOW, '12ProHome'), 'uber_drop_backup_12ProHome_2026-10-01_2123.json');
  assert.strictEqual(B.fileName(NOW, '12Pro ホーム'), 'uber_drop_backup_12Pro_2026-10-01_2123.json', '日本語・空白は除く');
  assert.strictEqual(B.fileName(NOW, 'ホーム'), 'uber_drop_backup_2026-10-01_2123.json', '英数字が無ければ付けない');
  assert.strictEqual(B.fileName(NOW, '../a/b?c'), 'uber_drop_backup_abc_2026-10-01_2123.json', '記号は除く');
});

test('現行の本人データ保存（createPersonalStore）で作ったデータをそのまま書き出せる', () => {
  const st = memStorage();
  const p = D.createPersonalStore(st, () => '2026-10-01T00:00:00.000Z');
  p.setRating(DATA.buildings[0], 'caution');
  p.setNote(DATA.buildings[1], 'テスト');
  const raw = st.raw[D.PERSONAL_KEY];
  assert.strictEqual(B.SOURCE_KEY, D.PERSONAL_KEY, '同じキー');
  const b = B.buildBackup(st, { now: NOW });
  assert.strictEqual(b.source_raw, raw);
  assert.deepStrictEqual(b.source_data, JSON.parse(raw));
  assert.strictEqual(b.source_item_count, 2);
});

console.log(`${passed} passed`);
