/**
 * UBER_LOG 公式取込 v1 — パイプライン本体（Node専用）
 *
 *   inbox/<date>/activity.txt + inbox/<date>/screenshots/*  （生データ・Git管理外）
 *        │ prepare: 一覧テキスト解析 ＋ スクショ読取テンプレート作成
 *        ▼
 *   staging/<date>.screens.json  （Claude Code がスクショを読んで記入。読めない項目は "UNKNOWN"）
 *        │ validate: 照合・MAP crop・検証 → staging/<date>.json
 *        ▼
 *   apply: 検証PASS時のみ js/store.js（CONFIRMED_SEED_DATA）・js/trip-maps.js・assets/maps へ反映
 *
 * 将来の自動取得（Uber Web巡回）は inbox/<date>/ に activity.txt とスクショを置くだけで、
 * 以降の照合・検証・反映はこのパイプラインをそのまま使える。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const parser = require('./activity-parser.js');

const IMPORTER = 'official-import-v1';
const UNKNOWN = 'UNKNOWN';
const MAX_SCREENSHOT_WIDTH = 800;
const IMAGE_EXT = /\.(png|jpe?g)$/i;

// ------------------------------------------------------------
// パス
// ------------------------------------------------------------
function getPaths(root, date, opts = {}) {
  const toolDir = path.join(root, 'tools', 'official-import');
  const inboxDir = opts.inboxDir || path.join(toolDir, 'inbox', date);
  const stagingDir = opts.stagingDir || path.join(toolDir, 'staging');
  return {
    root,
    toolDir,
    inboxDir,
    activityFile: path.join(inboxDir, 'activity.txt'),
    screenshotDir: opts.screenshotDir || path.join(inboxDir, 'screenshots'),
    decisionsFile: path.join(inboxDir, 'decisions.json'),
    stagingDir,
    screensFile: path.join(stagingDir, `${date}.screens.json`),
    stagingFile: path.join(stagingDir, `${date}.json`),
    workDir: path.join(stagingDir, date, 'maps'),
    storeFile: path.join(root, 'js', 'store.js'),
    tripMapsFile: path.join(root, 'js', 'trip-maps.js'),
    mapsDir: path.join(root, 'assets', 'maps'),
    cropScript: path.join(toolDir, 'lib', 'crop_map.py')
  };
}

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定してください（例: 2026-09-23）: ${date}`);
  }
}

const mmdd = date => date.slice(5, 7) + date.slice(8, 10);
const yen = n => (n < 0 ? '-' : '') + '¥' + Math.abs(n).toLocaleString('en-US');
const round2 = n => Math.round(n * 100) / 100;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function listScreenshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => IMAGE_EXT.test(f)).sort((a, b) => a.localeCompare(b, 'ja'));
}

function durationToSeconds(s) {
  if (s === null || s === undefined) return null;
  const str = parser.toHalfWidth(String(s)).replace(/\s+/g, '');
  const m = str.match(/^(?:(\d+)時間)?(?:(\d+)分)?(?:(\d+)秒)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}
function formatHms(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// 既存データ（js/store.js の CONFIRMED_SEED_DATA）の読み書き
// 既存ブロックの書式を崩さないよう、対象日のブロックだけを差し替え／挿入する
// ------------------------------------------------------------
const SEED_START = 'const CONFIRMED_SEED_DATA = ';
const SEED_END = '\n};\n\nfunction getConfirmedSeedData';

function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('store.js の構造を解析できません（括弧の対応が取れません）');
}

function readSeed(storeFile) {
  const raw = fs.readFileSync(storeFile, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const src = raw.replace(/\r\n/g, '\n');
  const s = src.indexOf(SEED_START);
  const e = src.indexOf(SEED_END);
  if (s < 0 || e < 0) throw new Error('store.js に CONFIRMED_SEED_DATA が見つかりません');
  const litStart = s + SEED_START.length;
  const litEnd = e + 2; // 最後の "}" の直後
  const data = JSON.parse(src.slice(litStart, litEnd));
  const blocks = [];
  const re = /\n {4}"(\d{4}-\d{2}-\d{2})": \{/g;
  re.lastIndex = litStart;
  let m;
  while ((m = re.exec(src)) && m.index < litEnd) {
    const keyStart = m.index + 5; // 行頭インデント（4スペース）の直後 = キーの " の位置
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(src, open);
    blocks.push({ date: m[1], keyStart, end: close + 1 });
    re.lastIndex = close;
  }
  return { raw, src, eol, litStart, litEnd, data, blocks };
}

function serializeDay(date, log) {
  const body = JSON.stringify(log, null, 2).split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n');
  return `"${date}": ${body}`;
}

function writeSeedDay(storeFile, date, log) {
  const seed = readSeed(storeFile);
  const text = serializeDay(date, log);
  let src = seed.src;
  const existing = seed.blocks.find(b => b.date === date);
  if (existing) {
    src = src.slice(0, existing.keyStart) + text + src.slice(existing.end);
  } else {
    const after = seed.blocks.find(b => b.date > date);
    if (after) {
      src = src.slice(0, after.keyStart) + text + ',\n    ' + src.slice(after.keyStart);
    } else {
      const last = seed.blocks[seed.blocks.length - 1];
      src = src.slice(0, last.end) + ',\n    ' + text + src.slice(last.end);
    }
  }
  fs.writeFileSync(storeFile, seed.eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
  // 書込後の再読込検証（JSONとして壊れていないこと・対象日が意図どおりであること）
  const check = readSeed(storeFile);
  if (JSON.stringify(check.data.dailyLogs[date]) !== JSON.stringify(log)) {
    throw new Error('store.js への書込後検証に失敗しました');
  }
}

function readTripMaps(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const src = raw.replace(/\r\n/g, '\n');
  const start = src.indexOf('{');
  const end = src.lastIndexOf('\n};', src.indexOf('if (typeof module'));
  const catalog = JSON.parse(src.slice(start, end + 2));
  return { raw, src, eol, end, catalog };
}

function addTripMapEntries(file, entries) {
  if (!entries.length) return;
  const tm = readTripMaps(file);
  const text = entries.map(({ id, entry }) => [
    `  "${id}": {`,
    `    "map": "${entry.map}",`,
    `    "full": "${entry.full}",`,
    `    "cropped": true,`,
    `    "box": [${entry.box.join(', ')}],`,
    `    "origFile": ${JSON.stringify(entry.origFile)}`,
    `  }`
  ].join('\n')).join(',\n');
  const hasEntries = Object.keys(tm.catalog).length > 0;
  const src = tm.src.slice(0, tm.end) + (hasEntries ? ',\n' : '\n') + text + tm.src.slice(tm.end);
  fs.writeFileSync(file, tm.eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
  const check = readTripMaps(file);
  entries.forEach(({ id }) => {
    if (!check.catalog[id]) throw new Error(`trip-maps.js への書込後検証に失敗: ${id}`);
  });
}

// ------------------------------------------------------------
// prepare: 一覧解析 ＋ スクショ読取テンプレート
// ------------------------------------------------------------
const SCREEN_FIELDS = ['date', 'time', 'amount', 'durationStr', 'distanceKm', 'restaurant', 'area', 'points'];

function screenTemplate(file) {
  return {
    file,
    kind: 'delivery',
    date: UNKNOWN,
    time: UNKNOWN,
    amount: UNKNOWN,
    baseFee: null,
    tip: null,
    durationStr: UNKNOWN,
    distanceKm: UNKNOWN,
    restaurant: UNKNOWN,
    area: UNKNOWN,
    points: UNKNOWN,
    note: ''
  };
}

function prepare(root, date, opts = {}) {
  assertDate(date);
  const p = getPaths(root, date, opts);
  if (!fs.existsSync(p.activityFile)) {
    throw new Error(`activity.txt がありません: ${p.activityFile}\n取込補助画面（tools/official-import/index.html）で保存してください。`);
  }
  const files = listScreenshots(p.screenshotDir);
  const parsed = parser.parseActivityText(fs.readFileSync(p.activityFile, 'utf8'), { defaultYear: date.slice(0, 4) });
  const summary = parser.summarize(parsed, date);

  const existing = readJson(p.screensFile, null);
  const byFile = new Map((existing && existing.screenshots || []).map(s => [s.file, s]));
  const screens = {
    date,
    importer: IMPORTER,
    howTo: [
      '各スクショを実際に見て、表示どおりの値を記入する（推測・逆算・補完は禁止）。読めない項目は "UNKNOWN" のまま残す。',
      'date: 見出しの日付（例 2026-09-22） / time: 見出しの時刻を24時間表記（午後12時53分 → 12:53）',
      'amount: 見出しの金額（最終売上。チップ込み） / baseFee・tip: 売り上げ欄にチップがある場合のみ数値、無ければ null',
      'durationStr: 「時間」欄（例 52分31秒） / distanceKm: 「距離」欄の数値（例 6.81） / points: 「Nポイントを獲得」のN',
      'restaurant: 店舗名（表示どおり） / area: 配達先（丁目まで。先頭の都道府県コード27等は除く。番地・部屋番号・氏名は絶対に書かない）',
      'kind: Delivery詳細なら "delivery"。1日の合計画面なら "summary"（daySummary に記入）。無関係な画像なら "other"（検証で止まる）'
    ],
    screenshots: files.map(f => byFile.get(f) || screenTemplate(f)),
    daySummary: (existing && existing.daySummary) || null
  };
  const removed = [...byFile.keys()].filter(f => !files.includes(f));
  writeJson(p.screensFile, screens);

  const pending = screens.screenshots.filter(s => SCREEN_FIELDS.some(k => isUnknown(s[k])) && s.kind === 'delivery').map(s => s.file);
  return { paths: p, parsed, summary, files, pending, removed };
}

// ------------------------------------------------------------
// スクショ記入値の正規化
// ------------------------------------------------------------
function isUnknown(v) {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim().toUpperCase() === UNKNOWN);
}

function normalizeArea(area) {
  let a = parser.toHalfWidth(String(area)).replace(/\s+/g, '');
  a = a.replace(/^\d{2}(?=\D)/, ''); // 先頭の都道府県コード（例: 27大阪市…）
  return a;
}

// 番地・号・部屋番号・郵便番号など、丁目より細かい情報が含まれていないか
function privacyIssue(area) {
  if (/丁目.*\d/.test(area)) return '丁目より後ろに数字（番地等）が含まれています';
  if (/(\d+\s*番地?|\d+\s*号|号室|〒|\d+-\d+|\d+F\b|階)/i.test(area)) return '番地・部屋番号などが含まれています';
  return null;
}

function normalizeScreen(s, date) {
  const errors = [];
  const out = { file: s.file, kind: s.kind || 'delivery', note: s.note || '', tripUuid: s.tripUuid || null };
  if (!['delivery', 'summary', 'other'].includes(out.kind)) errors.push(`kind が不正: ${out.kind}`);
  if (out.kind !== 'delivery') return { screen: out, errors };

  SCREEN_FIELDS.forEach(k => {
    if (isUnknown(s[k])) errors.push(`${k} が UNKNOWN`);
  });
  if (errors.length) return { screen: out, errors };

  out.date = parser.parseDate(String(s.date), date.slice(0, 4));
  out.time = parser.parseTime(String(s.time));
  out.amount = typeof s.amount === 'number' ? s.amount : parser.parseMoney(String(s.amount)) ?? (/^-?\d+$/.test(String(s.amount).trim()) ? Number(s.amount) : null);
  out.durationStr = parser.toHalfWidth(String(s.durationStr)).replace(/\s+/g, '');
  out.durationSeconds = durationToSeconds(out.durationStr);
  out.distanceKm = typeof s.distanceKm === 'number' ? s.distanceKm : parseFloat(parser.toHalfWidth(String(s.distanceKm)));
  out.points = Number(s.points);
  out.restaurant = String(s.restaurant).trim();
  out.area = normalizeArea(s.area);
  out.baseFee = isUnknown(s.baseFee) ? null : Number(s.baseFee);
  out.tip = isUnknown(s.tip) ? null : Number(s.tip);

  if (!out.date) errors.push(`date を解釈できません: ${s.date}`);
  else if (out.date !== date) errors.push(`取込日と異なる日付のスクショ: ${out.date}`);
  if (!out.time) errors.push(`time を解釈できません: ${s.time}`);
  if (!Number.isInteger(out.amount) || out.amount <= 0) errors.push(`amount が不正: ${s.amount}`);
  if (!out.durationSeconds || out.durationSeconds <= 0) errors.push(`durationStr が不正: ${s.durationStr}`);
  if (!Number.isFinite(out.distanceKm) || out.distanceKm < 0) errors.push(`distanceKm が不正: ${s.distanceKm}`);
  if (!Number.isInteger(out.points) || out.points < 1) errors.push(`points が不正: ${s.points}`);
  if (!out.restaurant) errors.push('restaurant が空');
  const priv = privacyIssue(out.area);
  if (priv) errors.push(`配達先（area）に個人情報の可能性: ${priv}`);
  if ((out.baseFee === null) !== (out.tip === null)) errors.push('baseFee と tip は両方記入するか両方 null にしてください');
  if (out.baseFee !== null && out.baseFee + out.tip !== out.amount) {
    errors.push(`基本料金 ${yen(out.baseFee)} ＋ チップ ${yen(out.tip)} が最終売上 ${yen(out.amount)} と一致しません`);
  }
  return { screen: out, errors };
}

// ------------------------------------------------------------
// MAP crop（既存規格 420x233 / 公式スクショからの切り抜きのみ）
// ------------------------------------------------------------
function runCropBatch(p, jobs) {
  if (!jobs.length) return [];
  fs.mkdirSync(p.workDir, { recursive: true });
  const jobFile = path.join(p.workDir, 'jobs.json');
  writeJson(jobFile, jobs);
  const py = process.env.UBER_IMPORT_PYTHON || 'python';
  const r = spawnSync(py, [p.cropScript, 'batch', jobFile], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) {
    const msg = (r.stderr || r.error && r.error.message || '').trim();
    return jobs.map(j => ({ ok: false, src: j.src, reason: `MAP切り抜き処理を実行できません（Python / Pillow）: ${msg}` }));
  }
  return JSON.parse(r.stdout);
}

// ------------------------------------------------------------
// validate: 照合・既存データとの突合・検証
// ------------------------------------------------------------
function buildStaging(root, date, opts = {}) {
  assertDate(date);
  const p = getPaths(root, date, opts);
  const checks = [];
  const warnings = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || '' }); return !!ok; };
  // finish() は途中終了時にも呼ばれるため、集計値は先に宣言しておく
  let trips, rec, questResult, actAdjustments, points, distance, seconds, tripSum, questSales, adjustmentSales, otherSales, totalSales;

  // 1. activity.txt
  if (!fs.existsSync(p.activityFile)) {
    check('activity.txt', false, `ファイルがありません: ${p.activityFile}`);
    return finish();
  }
  const activityText = fs.readFileSync(p.activityFile, 'utf8');
  const parsed = parser.parseActivityText(activityText, { defaultYear: date.slice(0, 4) });
  parsed.warnings.forEach(w => warnings.push(w));
  const decisions = readJson(p.decisionsFile, {}) || {};

  const undated = parsed.events.filter(e => !e.date);
  const dayEvents = parsed.events.filter(e => e.date === date);
  const otherDates = parsed.events.filter(e => e.date && e.date !== date);
  if (otherDates.length) warnings.push(`取込日以外のイベント ${otherDates.length} 件は対象外として無視しました`);

  // 同一UUIDの重複行（貼り付けの重複）は1件に統合
  const seenUuid = new Map();
  const events = [];
  dayEvents.forEach(e => {
    const key = e.tripUuid || e.activityUuid;
    if (key && seenUuid.has(key)) {
      const prev = seenUuid.get(key);
      if (prev.type === e.type && prev.time === e.time && prev.amount === e.amount) {
        warnings.push(`同一UUIDの重複行を1件に統合: ${e.type} ${e.time} ${yen(e.amount)}`);
        return;
      }
    }
    if (key) seenUuid.set(key, e);
    events.push(e);
  });

  const actDeliveries = events.filter(e => e.type === 'delivery');
  questResult = parser.dedupeQuests(events.filter(e => e.type === 'quest'), decisions);
  actAdjustments = events.filter(e => e.type === 'adjustment');
  const unknownEvents = events.filter(e => ['unknown', 'tip', 'special'].includes(e.type));

  check('activity.txt 読込', actDeliveries.length > 0, `Delivery ${actDeliveries.length} / クエスト ${questResult.quests.length} / 調整 ${actAdjustments.length}`);
  check('日付不明イベントなし', undated.length === 0,
    undated.map(e => `${e.type} ${e.time || '時刻不明'} ${yen(e.amount)}`).join('、'));
  check('未分類イベントなし', unknownEvents.length === 0,
    unknownEvents.map(e => `[${e.type === 'special' ? '特別報酬（自動取込対象外）' : e.type === 'tip' ? 'チップ単独' : '未分類'}] ${e.title || e.raw} ${e.time || ''} ${yen(e.amount)}`).join('、'));
  check('時刻不明のDeliveryなし', actDeliveries.every(e => e.time), actDeliveries.filter(e => !e.time).map(e => yen(e.amount)).join('、'));
  check('クエスト重複候補なし', questResult.duplicateCandidates.length === 0,
    questResult.duplicateCandidates.map(c => `${c.key}: ${c.items.map(i => `${i.category || ''} ${i.title}`).join(' / ')}（decisions.json の questDuplicates で count_once / count_all を指定）`).join('、'));

  // 2. スクショ
  const files = listScreenshots(p.screenshotDir);
  const screensDoc = readJson(p.screensFile, null);
  if (!screensDoc) {
    check('スクショ読取結果', false, `${p.screensFile} がありません（prepare を実行し、スクショを読んで記入してください）`);
    return finish();
  }
  const screenErrors = [];
  const screens = [];
  const listed = new Set((screensDoc.screenshots || []).map(s => s.file));
  files.filter(f => !listed.has(f)).forEach(f => screenErrors.push(`${f}: 読取結果が未記入（prepare を再実行）`));
  (screensDoc.screenshots || []).forEach(s => {
    if (!files.includes(s.file)) {
      screenErrors.push(`${s.file}: screenshots フォルダに画像がありません`);
      return;
    }
    const { screen, errors } = normalizeScreen(s, date);
    errors.forEach(e => screenErrors.push(`${s.file}: ${e}`));
    if (screen.kind === 'other') screenErrors.push(`${s.file}: Delivery詳細ではない画像（kind: other）。取り除くか確認してください`);
    screens.push(screen);
  });
  check('スクショ全件読取済み（UNKNOWNなし・値が正常）', screenErrors.length === 0, screenErrors.join('\n'));

  const deliveryScreens = screens.filter(s => s.kind === 'delivery' && s.time && Number.isInteger(s.amount));

  // 3. activity ↔ スクショ 照合（日付・時刻・金額が完全一致したものだけを同一tripとする）
  const matchErrors = [];
  const groups = new Map();
  const keyOf = (t, a) => `${t}|${a}`;
  actDeliveries.forEach(e => {
    const k = keyOf(e.time, e.amount);
    if (!groups.has(k)) groups.set(k, { acts: [], screens: [] });
    groups.get(k).acts.push(e);
  });
  deliveryScreens.forEach(s => {
    const k = keyOf(s.time, s.amount);
    if (!groups.has(k)) groups.set(k, { acts: [], screens: [] });
    groups.get(k).screens.push(s);
  });
  trips = [];
  groups.forEach((g, k) => {
    const [time, amount] = k.split('|');
    if (g.acts.length !== g.screens.length) {
      if (!g.screens.length) matchErrors.push(`一覧 ${time} ${yen(+amount)} に一致するスクショがありません`);
      else if (!g.acts.length) matchErrors.push(`スクショ ${g.screens.map(s => s.file).join(', ')}（${time} ${yen(+amount)}）に一致する一覧Deliveryがありません`);
      else matchErrors.push(`${time} ${yen(+amount)}: 一覧 ${g.acts.length} 件に対しスクショ ${g.screens.length} 件（件数不一致）`);
      return;
    }
    if (g.acts.length > 1) warnings.push(`${time} ${yen(+amount)} の同時刻・同額Deliveryが ${g.acts.length} 件（ファイル名順に対応付け）`);
    g.acts.forEach((a, i) => {
      const s = g.screens[i];
      if (a.tripUuid && s.tripUuid && a.tripUuid !== s.tripUuid) {
        matchErrors.push(`${time} ${yen(+amount)}: trip UUID が一致しません（一覧 ${a.tripUuid} / スクショ ${s.tripUuid}）`);
        return;
      }
      trips.push({ activity: a, screen: s });
    });
  });
  trips.sort((a, b) => a.screen.time.localeCompare(b.screen.time) || a.screen.file.localeCompare(b.screen.file));
  check('Delivery件数一致（一覧 = スクショ = 照合済み）',
    matchErrors.length === 0 && actDeliveries.length === deliveryScreens.length && trips.length === actDeliveries.length,
    [`一覧 ${actDeliveries.length} / スクショ ${deliveryScreens.length} / 照合 ${trips.length}`].concat(matchErrors).join('\n'));

  const actDeliverySum = actDeliveries.reduce((s, e) => s + e.amount, 0);
  tripSum = trips.reduce((s, t) => s + t.screen.amount, 0);
  check('配達報酬合計一致（一覧合計 = 各trip金額合計）', actDeliverySum === tripSum, `一覧 ${yen(actDeliverySum)} / trip ${yen(tripSum)}`);

  points = trips.reduce((s, t) => s + t.screen.points, 0);
  distance = round2(trips.reduce((s, t) => s + t.screen.distanceKm, 0));
  seconds = trips.reduce((s, t) => s + t.screen.durationSeconds, 0);
  questSales = questResult.quests.filter(q => q.counted).reduce((s, q) => s + q.amount, 0);
  adjustmentSales = actAdjustments.reduce((s, e) => s + e.amount, 0);

  const summaryShot = screensDoc.daySummary || null;
  const cmp = (label, actual, expected, fmt = v => v) =>
    (expected === null || expected === undefined || isUnknown(expected))
      ? `${label} ${fmt(actual)}`
      : `${label} ${fmt(actual)}（公式サマリー ${fmt(expected)}）`;
  const sumOk = (actual, expected) => expected === null || expected === undefined || isUnknown(expected) || actual === expected;
  const sPoints = summaryShot && summaryShot.points;
  const sDist = summaryShot && summaryShot.distanceKm;
  const sDur = summaryShot && summaryShot.durationStr ? durationToSeconds(summaryShot.durationStr) : null;
  const sTotal = summaryShot && summaryShot.total;
  check('配達件数 = ポイント合計', trips.every(t => Number.isInteger(t.screen.points)) && sumOk(points, sPoints), cmp('ポイント合計', points, sPoints));
  check('距離 = trip距離合計', sumOk(distance, sDist === null || sDist === undefined ? sDist : round2(Number(sDist))), cmp('距離', distance, sDist, v => `${v}km`));
  check('配達時間 = trip時間合計', sumOk(seconds, sDur), cmp('配達時間', seconds, sDur, formatHms));
  check('クエスト = 重複排除後合計', Number.isInteger(questSales),
    `${yen(questSales)}（計上 ${questResult.quests.filter(q => q.counted).length} 件 / 非計上 ${questResult.quests.filter(q => !q.counted).length} 件）`);
  check('調整 = 符号付き合計', Number.isInteger(adjustmentSales), yen(adjustmentSales));

  // 4. 既存データとの突合（既存trip ID・○×評価等を守る。二重登録しない）
  const seed = readSeed(p.storeFile);
  const existing = seed.data.dailyLogs[date] || null;
  const tm = readTripMaps(p.tripMapsFile);
  rec = reconcile(date, existing, trips, questResult.quests, actAdjustments, tm.catalog);
  rec.warnings.forEach(w => warnings.push(w));
  check('既存データとの整合（既存trip・クエスト・調整を削除/上書きしない）', rec.errors.length === 0, rec.errors.join('\n'));

  otherSales = existing && existing.sales ? Number(existing.sales.other) || 0 : 0;
  totalSales = tripSum + questSales + adjustmentSales + otherSales;
  const signed = n => (n < 0 ? `- ${yen(-n)}` : `+ ${yen(n)}`);
  const totalMsgs = [`${yen(tripSum)} ${signed(questSales)} ${signed(adjustmentSales)}${otherSales ? ` ${signed(otherSales)}（その他）` : ''} = ${yen(totalSales)}`];
  let totalOk = true;
  if (parsed.statementTotal && parsed.statementTotal.date === date) {
    totalOk = parsed.statementTotal.amount === totalSales;
    totalMsgs.push(`一覧の合計表示 ${yen(parsed.statementTotal.amount)}`);
  }
  if (!sumOk(totalSales, sTotal)) totalOk = false;
  if (!isUnknown(sTotal) && sTotal !== undefined) totalMsgs.push(`公式サマリー ${yen(sTotal)}`);
  check('総売上 = 配達報酬 + クエスト + 調整 + その他', totalOk, totalMsgs.join(' / '));

  // 5. アプリ側のクエスト重複排除ロジックとの整合（取込後にアプリ表示で誤って除外されないこと）
  const appDedupe = appDeduplicateQuests(root, rec.log ? rec.log.quests : []);
  check('アプリのクエスト表示ロジックと整合', appDedupe.length === 0, appDedupe.join('、'));

  // 6. MAP（公式スクショからの切り抜きのみ。既存MAPは上書きしない）
  const mapMissingOk = new Set((decisions.mapMissingOk || []).map(String));
  const jobs = [];
  rec.tripIds.forEach((id, i) => {
    const t = trips[i];
    if (tm.catalog[id]) {
      t.map = { status: 'existing' };
      return;
    }
    const stem = `${String(i + 1).padStart(2, '0')}_${sha256(t.screen.file).slice(0, 8)}`;
    t.map = { status: 'pending', work: path.join(p.workDir, `map_${stem}.png`), workFull: path.join(p.workDir, `full_${stem}.png`) };
    jobs.push({ src: path.join(p.screenshotDir, t.screen.file), map: t.map.work, full: t.map.workFull });
  });
  const cropResults = runCropBatch(p, jobs);
  const mapErrors = [];
  const sizeErrors = [];
  trips.forEach(t => {
    if (!t.map || t.map.status !== 'pending') return;
    const r = cropResults.find(c => path.resolve(c.src) === path.resolve(p.screenshotDir, t.screen.file));
    if (r && r.size && r.size[0] > MAX_SCREENSHOT_WIDTH) {
      sizeErrors.push(`${t.screen.file}: 幅 ${r.size[0]}px（画面全体ではなく Delivery詳細部分だけを切り取ってください）`);
    }
    if (r && r.ok) {
      t.map = { ...t.map, status: 'cropped', box: r.box };
    } else if (mapMissingOk.has(t.screen.file)) {
      t.map = { status: 'none', reason: (r && r.reason) || '不明' };
      warnings.push(`${t.screen.file}: MAPなしで登録（decisions.json の mapMissingOk で確認済み）`);
    } else {
      t.map = { status: 'failed', reason: (r && r.reason) || '不明' };
      mapErrors.push(`${t.screen.file}（${t.screen.time} ${yen(t.screen.amount)}）: ${t.map.reason}`);
    }
  });
  check('スクショ画像サイズ（Delivery詳細部分のみ）', sizeErrors.length === 0, sizeErrors.join('\n'));
  const mapped = trips.filter(t => t.map && ['existing', 'cropped'].includes(t.map.status)).length;
  check('MAP（公式スクショから切り抜き）', mapErrors.length === 0,
    [`${mapped}/${trips.length}`].concat(mapErrors.map(e => `MAPなし: ${e}（スクショを撮り直すか、MAPなしで良ければ decisions.json の mapMissingOk にファイル名を追加）`)).join('\n'));

  return finish();

  function finish() {
    const failed = checks.filter(c => !c.ok);
    const staging = {
      date,
      importer: IMPORTER,
      generatedAt: new Date().toISOString(),
      source: {
        activityFile: path.relative(root, p.activityFile),
        activitySha256: fs.existsSync(p.activityFile) ? sha256(fs.readFileSync(p.activityFile)) : null,
        screenshots: listScreenshots(p.screenshotDir).map(f => ({ file: f, sha256: sha256(fs.readFileSync(path.join(p.screenshotDir, f))) }))
      },
      deliveries: !trips ? [] : trips.map((t, i) => ({
        id: rec && rec.tripIds[i],
        status: rec && rec.tripStatus[i],
        activity: { time: t.activity.time, amount: t.activity.amount, tripUuid: t.activity.tripUuid, activityUuid: t.activity.activityUuid, url: t.activity.url },
        screen: t.screen,
        map: t.map || null
      })),
      quests: !questResult ? [] : questResult.quests.map(q => ({ time: q.time, category: q.category, title: q.title, amount: q.amount, counted: q.counted, reason: q.reason })),
      adjustments: !actAdjustments ? [] : actAdjustments.map(a => ({ time: a.time, title: a.title, amount: a.amount, activityUuid: a.activityUuid })),
      summary: !trips || !rec ? {} : {
        trips: trips.length,
        deliveriesCount: points,
        deliverySales: tripSum,
        questSales,
        adjustmentSales,
        otherSales,
        totalSales,
        distanceKm: distance,
        durationSeconds: seconds,
        durationText: formatHms(seconds),
        maps: `${trips.filter(t => t.map && ['existing', 'cropped'].includes(t.map.status)).length}/${trips.length}`
      },
      validation: {
        status: failed.length ? 'FAIL' : 'PASS',
        checks,
        errors: failed.map(c => `${c.name}: ${c.detail}`),
        warnings
      },
      plan: !rec ? null : { changed: rec.changed, log: rec.log, isNewDay: !existing }
    };
    if (!opts.dryRun) writeJson(p.stagingFile, staging);
    return staging;
  }
}

function appDeduplicateQuests(root, quests) {
  if (!quests || !quests.length) return [];
  const storeFile = path.join(root, 'js', 'store.js');
  const code = `
    global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
    const m=require(${JSON.stringify(storeFile)});
    const q=JSON.parse(process.argv[1]);
    console.log(JSON.stringify(m.deduplicateQuests(q).filter(x=>x.isDuplicateIgnored).map(x=>x.time+' '+x.title+' ¥'+x.amount)));`;
  const r = spawnSync(process.execPath, ['-e', code, JSON.stringify(quests)], { encoding: 'utf8' });
  if (r.status !== 0) return [`store.js を読み込めません: ${r.stderr}`];
  return JSON.parse(r.stdout).map(s => `アプリ表示で重複扱いになるクエスト: ${s}`);
}

// 既存日のデータと取込データを突き合わせ、反映後の1日分データを作る
function reconcile(date, existing, trips, quests, adjustments, catalog) {
  const errors = [];
  const warnings = [];
  const md = mmdd(date);
  const tripIds = [];
  const tripStatus = [];

  if (existing && existing.sales && Number(existing.sales.guaranteeBonus) > 0) {
    errors.push('特別保証（guaranteeBonus）を含む日は自動取込の対象外です（手動で確認してください）');
  }

  // --- trip
  const exTrips = (existing && existing.deliveries) || [];
  const used = new Set();
  let nextNo = exTrips.reduce((mx, d) => {
    const m = String(d.id || '').match(new RegExp(`^del_${md}_(\\d+)$`));
    return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
  }, 0);
  const newDeliveries = [];
  trips.forEach(t => {
    const s = t.screen;
    const cands = exTrips.filter(d => !used.has(d) && d.completedAt === s.time && Number(d.fee) === s.amount);
    if (cands.length > 1) {
      errors.push(`既存tripに ${s.time} ${yen(s.amount)} が複数あり対応付けできません`);
    }
    const ex = cands[0];
    if (ex) {
      used.add(ex);
      const diffs = [];
      if (ex.distanceKm !== null && ex.distanceKm !== undefined && round2(Number(ex.distanceKm)) !== round2(s.distanceKm)) diffs.push(`距離 ${ex.distanceKm}→${s.distanceKm}`);
      if (ex.durationStr && durationToSeconds(ex.durationStr) !== s.durationSeconds) diffs.push(`時間 ${ex.durationStr}→${s.durationStr}`);
      if (ex.points !== undefined && ex.points !== null && Number(ex.points) !== s.points) diffs.push(`ポイント ${ex.points}→${s.points}`);
      if (diffs.length) errors.push(`既存trip ${ex.id}（${s.time} ${yen(s.amount)}）と公式スクショが不一致: ${diffs.join(', ')}`);
      if (ex.restaurant && ex.restaurant !== s.restaurant) warnings.push(`${ex.id}: 店舗名の表記差（既存「${ex.restaurant}」を維持 / スクショ「${s.restaurant}」）`);
      if (ex.area && ex.area !== s.area) warnings.push(`${ex.id}: 配達先の表記差（既存「${ex.area}」を維持 / スクショ「${s.area}」）`);
      // 既存値は維持し、欠けている項目だけ補完
      const merged = { ...ex };
      if (!merged.restaurant) merged.restaurant = s.restaurant;
      if (!merged.area) merged.area = s.area;
      if (merged.distanceKm === null || merged.distanceKm === undefined) merged.distanceKm = s.distanceKm;
      if (!merged.durationStr) merged.durationStr = s.durationStr;
      if (merged.points === null || merged.points === undefined) merged.points = s.points;
      if (s.baseFee !== null && merged.baseFee === undefined) { merged.baseFee = s.baseFee; merged.tip = s.tip; }
      newDeliveries.push(merged);
      tripIds.push(ex.id);
      tripStatus.push('existing');
    } else {
      let id;
      do { nextNo += 1; id = `del_${md}_${nextNo}`; } while (exTrips.some(d => d.id === id));
      if (catalog[id]) warnings.push(`${id}: 既存のMAPカタログ登録をそのまま使用（上書きしない）`);
      const memo = [];
      if (s.points === 2) memo.push('ダブル配達（2件完了/2pt）');
      else if (s.points === 3) memo.push('トリプル配達（3件完了/3pt）');
      else if (s.points > 3) memo.push(`${s.points}件完了/${s.points}pt`);
      if (s.baseFee !== null) memo.push(`最終売上¥${s.amount}（基本料金¥${s.baseFee}＋チップ¥${s.tip}）`);
      const d = {
        id,
        index: 0,
        completedAt: s.time,
        restaurant: s.restaurant,
        area: s.area,
        fee: s.amount
      };
      if (s.baseFee !== null) { d.baseFee = s.baseFee; d.tip = s.tip; }
      Object.assign(d, { distanceKm: s.distanceKm, durationStr: s.durationStr, points: s.points, memo: memo.join('／') });
      newDeliveries.push(d);
      tripIds.push(id);
      tripStatus.push('new');
    }
  });
  exTrips.filter(d => !used.has(d)).forEach(d => {
    errors.push(`既存trip ${d.id}（${d.completedAt} ${yen(Number(d.fee))}）がUber一覧／スクショに見つかりません（削除はしません）`);
  });
  newDeliveries
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.completedAt.localeCompare(b.d.completedAt) || a.i - b.i)
    .forEach(({ d }, n) => { d.index = n + 1; });
  const ordered = [...newDeliveries].sort((a, b) => a.index - b.index);

  // --- クエスト（計上分のみ保持。重複表示・¥0クエストは note に記録）
  // Uber一覧は新しい順のため、保存は時刻順（既存データと同じ並び）にそろえる
  const byTime = (a, b) => String(a.time || '').localeCompare(String(b.time || '')) || (a.seq || 0) - (b.seq || 0);
  quests = [...quests].sort(byTime);
  adjustments = [...adjustments].sort(byTime);
  const counted = quests.filter(q => q.counted);
  const notCounted = quests.filter(q => !q.counted);
  const exQuests = ((existing && existing.quests) || []).filter(q => !q.isDuplicateIgnored && Number(q.amount) > 0);
  const usedQ = new Set();
  let nextQ = ((existing && existing.quests) || []).reduce((mx, q) => {
    const m = String(q.id || '').match(new RegExp(`^quest_${md}_(\\d+)$`));
    return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
  }, 0);
  const newQuests = counted.map(q => {
    const ex = exQuests.find(x => !usedQ.has(x) && x.time === q.time && Number(x.amount) === q.amount);
    if (ex) { usedQ.add(ex); return ex; }
    nextQ += 1;
    const notes = notCounted
      .filter(n => n.duplicateOfSeq === q.seq)
      .map(n => `公式一覧は「${q.title} ${yen(q.amount)}」「${n.title} ${yen(n.amount)}」の2表示だが同一報酬のため1件のみ計上（二重計上防止）`);
    const quest = { id: `quest_${md}_${nextQ}`, time: q.time, title: q.title, amount: q.amount, isDuplicateIgnored: false };
    if (notes.length) quest.note = notes.join('。');
    return quest;
  });
  exQuests.filter(x => !usedQ.has(x)).forEach(x => {
    errors.push(`既存クエスト ${x.id}（${x.time} ${yen(Number(x.amount))}）がUber一覧に見つかりません（削除はしません）`);
  });
  const zeroNotes = notCounted.filter(n => n.amount === 0).map(n => `${n.time || ''}の「${n.title}」¥0は報酬0のため売上非加算`);
  if (zeroNotes.length && newQuests.length) {
    const lastNew = [...newQuests].reverse().find(q => !exQuests.includes(q));
    if (lastNew) lastNew.note = [lastNew.note, zeroNotes.join('。')].filter(Boolean).join('。');
  }

  // --- 調整（Uber側の売上調整。経費ではない）
  const exAdj = (existing && existing.adjustments) || [];
  const usedA = new Set();
  let nextA = exAdj.reduce((mx, a) => {
    const m = String(a.id || '').match(new RegExp(`^adj_${md}_(\\d+)$`));
    return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
  }, 0);
  const newAdj = adjustments.map(a => {
    const ex = exAdj.find(x => !usedA.has(x) && x.time === a.time && Number(x.amount) === a.amount);
    if (ex) { usedA.add(ex); return ex; }
    nextA += 1;
    const generic = /^(調整|adjustment|misc)$/i;
    const official = (a.labels || []).filter(l => !generic.test(l)).join(' ') || a.title || '調整';
    return { id: `adj_${md}_${nextA}`, time: a.time, eventType: '調整', officialTitle: official, amount: a.amount };
  });
  exAdj.filter(x => !usedA.has(x)).forEach(x => {
    errors.push(`既存の調整 ${x.id}（${x.time} ${yen(Number(x.amount))}）がUber一覧に見つかりません（削除はしません）`);
  });
  if (existing && existing.sales && !exAdj.length && Number(existing.sales.adjustment) && !adjustments.length) {
    errors.push(`既存の売上調整 ${yen(Number(existing.sales.adjustment))} がUber一覧に見つかりません`);
  }

  // --- 1日分データ
  const deliverySales = ordered.reduce((s, d) => s + Number(d.fee), 0);
  const questSales = newQuests.reduce((s, q) => s + Number(q.amount), 0);
  const adjustmentSales = newAdj.reduce((s, a) => s + Number(a.amount), 0);
  const otherSales = existing && existing.sales ? Number(existing.sales.other) || 0 : 0;
  const points = ordered.reduce((s, d) => s + Number(d.points || 0), 0);
  const distance = round2(ordered.reduce((s, d) => s + Number(d.distanceKm || 0), 0));
  const hasNewTrips = tripStatus.includes('new');

  let log;
  if (existing) {
    log = JSON.parse(JSON.stringify(existing));
    delete log.officialImport;
    log.deliveries = ordered;
    log.quests = newQuests;
    if (newAdj.length || log.adjustments) log.adjustments = newAdj;
    log.sales = { ...(existing.sales || {}), delivery: deliverySales, quest: questSales, adjustment: adjustmentSales, other: otherSales, total: deliverySales + questSales + adjustmentSales + otherSales };
    if (hasNewTrips || !existing.tripsCount) {
      log.tripsCount = ordered.length;
      log.officialPoints = points;
      log.deliveriesCount = points;
      log.totalDistanceKm = distance;
    } else if (existing.tripsCount !== ordered.length || existing.deliveriesCount !== points) {
      errors.push(`既存の件数（${existing.tripsCount}trip/${existing.deliveriesCount}件）と取込（${ordered.length}trip/${points}件）が不一致`);
    }
  } else {
    log = {
      date,
      workStartedAt: null,
      workEndedAt: null,
      workMinutes: null,
      totalDistanceKm: distance,
      tripsCount: ordered.length,
      officialPoints: points,
      deliveriesCount: points,
      workSessions: [],
      deliveries: ordered,
      quests: newQuests
    };
    if (newAdj.length) log.adjustments = newAdj;
    log.sales = { delivery: deliverySales, quest: questSales, adjustment: adjustmentSales, other: 0, total: deliverySales + questSales + adjustmentSales };
    log.expenses = [];
  }
  const base = existing ? (() => { const c = JSON.parse(JSON.stringify(existing)); delete c.officialImport; return c; })() : null;
  const changed = !base || JSON.stringify(base) !== JSON.stringify(log);
  return { errors, warnings, log, changed, tripIds, tripStatus };
}

// ------------------------------------------------------------
// apply: 検証PASS時のみ反映
// ------------------------------------------------------------
function bumpVersion(root) {
  const vFile = path.join(root, 'version.json');
  if (!fs.existsSync(vFile)) return null;
  const v = readJson(vFile, {});
  const m = String(v.version || '').match(/^(\d{8})_v(\d+)$/);
  if (!m) throw new Error(`version.json の version 形式が想定外です: ${v.version}`);
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const next = `${ymd}_v${parseInt(m[2], 10) + 1}`;
  const tz = -now.getTimezoneOffset();
  const iso = new Date(now.getTime() + tz * 60000).toISOString().slice(0, 19) +
    `${tz >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, '0')}:${String(Math.abs(tz) % 60).padStart(2, '0')}`;
  ['index.html', 'sw.js', 'version.json'].forEach(f => {
    const file = path.join(root, f);
    if (!fs.existsSync(file)) return;
    let c = fs.readFileSync(file, 'utf8').split(v.version).join(next);
    if (f === 'version.json') c = c.replace(/"releasedAt": "[^"]*"/, `"releasedAt": "${iso}"`);
    fs.writeFileSync(file, c, 'utf8');
  });
  return { from: v.version, to: next };
}

function apply(root, date, opts = {}) {
  const staging = buildStaging(root, date, opts);
  if (staging.validation.status !== 'PASS') return { applied: false, staging };
  const p = getPaths(root, date, opts);
  const plan = staging.plan;
  if (!plan.changed) return { applied: false, unchanged: true, staging };

  // MAP: 新規切り抜き分のみ assets/maps へコピー（既存ファイルは上書きしない）
  const entries = [];
  staging.deliveries.forEach(d => {
    if (!d.map || d.map.status !== 'cropped') return;
    const mapRel = `assets/maps/map_${d.id}.png`;
    const fullRel = `assets/maps/full_${d.id}.png`;
    [mapRel, fullRel].forEach(rel => {
      if (fs.existsSync(path.join(root, rel))) throw new Error(`既存MAPファイルがあるため上書きしません: ${rel}`);
    });
    entries.push({ id: d.id, entry: { map: mapRel, full: fullRel, box: d.map.box, origFile: d.screen.file }, work: d.map.work, workFull: d.map.workFull });
  });
  fs.mkdirSync(p.mapsDir, { recursive: true });
  entries.forEach(e => {
    fs.copyFileSync(e.work, path.join(root, e.entry.map));
    fs.copyFileSync(e.workFull, path.join(root, e.entry.full));
  });
  addTripMapEntries(p.tripMapsFile, entries);

  const log = { ...plan.log, officialImport: { source: IMPORTER, importedAt: staging.generatedAt } };
  writeSeedDay(p.storeFile, date, log);
  const version = opts.skipVersionBump ? null : bumpVersion(root);
  return { applied: true, staging, version, addedMaps: entries.map(e => e.id) };
}

// ------------------------------------------------------------
// report: 反映後の日次・週次・月次・クエスト進捗（アプリの計算ロジックで算出）
// ------------------------------------------------------------
function report(root, date) {
  assertDate(date);
  const code = `
    global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
    global.window={localStorage:global.localStorage};
    const m=require(${JSON.stringify(path.join(root, 'js', 'store.js'))});
    const {TRIP_MAP_CATALOG}=require(${JSON.stringify(path.join(root, 'js', 'trip-maps.js'))});
    const s=m.store, d=${JSON.stringify(date)};
    const log=s.getDailyLog(d); const x=s.getCalculatedMetrics(log);
    const r=s.getRevenueSummary(d); const a=s.getAnalytics(); const q=s.getQuestProgress();
    const logs=s.getAllDailyLogs();
    const ids=logs.flatMap(l=>(l.deliveries||[]).map(t=>t.id));
    const month=logs.filter(l=>l.date.startsWith(d.slice(0,7)));
    console.log(JSON.stringify({
      day:{trips:x.tripsCount,count:x.count,delivery:x.deliverySales,quest:x.questSales,adjustment:x.adjustmentSales,total:x.totalSales,expenses:x.totalExpenses,profit:x.netProfit,distance:log.totalDistanceKm,seconds:x.workSeconds,maps:(log.deliveries||[]).filter(t=>TRIP_MAP_CATALOG[t.id]).length},
      week:r.thisWeek, month:r.thisMonth,
      monthTrips:month.reduce((n,l)=>n+(l.tripsCount||0),0),
      analytics:{regular:a.totalRegularSalesSum,days:a.activeDaysCount,avgDaily:a.avgDailyEarnings,avgPer:a.avgPerDelivery,avgHourly:a.avgHourlyWage,seconds:a.totalSecondsSum,distance:a.totalDistanceSum},
      quest:{title:q.title,current:q.currentCount,target:q.targetCount,remaining:q.remainingCount},
      maps:{mapped:ids.filter(i=>TRIP_MAP_CATALOG[i]).length,total:ids.length}
    }));`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`集計に失敗しました: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

module.exports = {
  IMPORTER,
  getPaths,
  prepare,
  buildStaging,
  apply,
  report,
  readSeed,
  readTripMaps,
  writeSeedDay,
  reconcile,
  durationToSeconds,
  formatHms,
  normalizeArea,
  privacyIssue,
  yen,
  listScreenshots
};
