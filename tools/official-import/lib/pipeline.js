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
const structuredNormalizer = require('./structured-normalizer.js');

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
    structuredFile: path.join(inboxDir, 'structured.json'),
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
  if (s < 0) throw new Error('store.js に CONFIRMED_SEED_DATA が見つかりません');
  const litStart = s + SEED_START.length;
  const litEnd = findMatchingBrace(src, litStart) + 1; // シード末尾の "}" の直後（後続コードの並びに依存しない）
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
  const hasStructured = fs.existsSync(p.structuredFile);
  if (!fs.existsSync(p.activityFile)) {
    if (hasStructured) {
      const structData = readJson(p.structuredFile, {});
      const actTxt = structuredNormalizer.buildActivityTextFromStructured(structData.activity || structData, date);
      fs.mkdirSync(p.inboxDir, { recursive: true });
      fs.writeFileSync(p.activityFile, actTxt, 'utf8');
    } else {
      throw new Error(`activity.txt がありません: ${p.activityFile}\n取込補助画面（tools/official-import/index.html）で保存してください。`);
    }
  }
  const files = listScreenshots(p.screenshotDir);
  const parsed = parser.parseActivityText(fs.readFileSync(p.activityFile, 'utf8'), { defaultYear: date.slice(0, 4) });
  const summary = parser.summarize(parsed, date);

  const existing = readJson(p.screensFile, null);
  const byFile = new Map((existing && existing.screenshots || []).map(s => [s.file, s]));

  let screens;
  if (hasStructured && files.length === 0) {
    const structData = readJson(p.structuredFile, {});
    const rawTrips = Array.isArray(structData.trips) ? structData.trips : [];
    const seenUuids = new Set();
    const uniqueTrips = [];
    rawTrips.forEach(raw => {
      const meta = raw.data?.metadata || raw.metadata || {};
      const status = String(meta.statusType || raw.statusType || '').toUpperCase();
      if (status === 'CANCELED' || status === 'CANCELLED' || raw.title === 'キャンセル済み') return;
      const u = (raw.tripUuid || raw.uuid || meta.uuid || '').toLowerCase();
      if (u && seenUuids.has(u)) return;
      if (u) seenUuids.add(u);
      uniqueTrips.push(raw);
    });
    const structScreens = uniqueTrips.map((raw, idx) => {
      const { trip } = structuredNormalizer.normalizeTripDetail(raw, date);
      if (!trip || trip.isCanceled || trip.statusType === 'CANCELED') return null;
      const file = `structured_trip_${idx + 1}_${(trip ? trip.tripUuid : 'unknown').slice(0, 8)}.json`;
      return {
        file,
        kind: 'delivery',
        date: (trip && trip.date) || date,
        time: (trip && trip.time) || UNKNOWN,
        amount: (trip && trip.amount) || UNKNOWN,
        baseFee: (trip && trip.tip !== null) ? trip.baseFee : null,
        tip: (trip && trip.tip !== null) ? trip.tip : null,
        durationStr: (trip && trip.durationStr) || UNKNOWN,
        distanceKm: trip ? trip.distanceKm : UNKNOWN,
        restaurant: (trip && trip.restaurant) || UNKNOWN,
        area: (trip && trip.area) || UNKNOWN,
        points: (trip && trip.points) || UNKNOWN,
        note: trip && trip.tripLegCount > 1 ? `${trip.tripLegCount}件完了/${trip.tripLegCount}pt` : '',
        tripUuid: trip ? trip.tripUuid : null,
        tripLegCount: trip ? trip.tripLegCount : 1,
        legs: trip ? trip.legs : [],
        sequence: trip ? trip.sequence : null,
        sourceType: 'structured'
      };
    }).filter(Boolean);
    screens = {
      date,
      importer: IMPORTER,
      sourceType: 'structured',
      structuredFile: path.relative(root, p.structuredFile),
      screenshots: structScreens,
      daySummary: (existing && existing.daySummary) || null
    };
  } else {
    screens = {
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
  }
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

function privacyIssue(area) {
  return structuredNormalizer.privacyIssue(area);
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
  else if (out.date !== date) errors.push(`取込日と異なる日付の${s.sourceType === 'structured' ? 'データ' : 'スクショ'}: ${out.date}`);
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
  const generatedAt = new Date().toISOString(); // 反映後の officialImport.importedAt・変更履歴の日時
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
  const fractional = events.filter(e => !Number.isInteger(e.amount));
  check('金額が円単位', fractional.length === 0, fractional.map(e => `${e.type} ${e.time || ''} ${e.amount}`).join('、'));
  check('時刻不明のDeliveryなし', actDeliveries.every(e => e.time), actDeliveries.filter(e => !e.time).map(e => yen(e.amount)).join('、'));
  // 検証名は実際の状態を表す（候補0件のときだけ「なし」。候補があって止まるときは「あり・確認が必要」）
  const dupCount = questResult.duplicateCandidates.length;
  check(dupCount === 0 ? 'クエスト重複候補なし' : `クエスト重複候補あり（${dupCount}件・同じ報酬か別の報酬かの確認が必要）`, dupCount === 0,
    questResult.duplicateCandidates.map(c => `${c.key.replace('|', ' ¥')}: ${c.items.map(i => `「${(i.category ? i.category + ' ' : '') + i.title}」`).join(' と ')}（同じ報酬の2種類の表示なら count_once（1回だけ計上）、別々に受け取った報酬なら count_all（両方計上）を decisions.json の questDuplicates で指定）`).join('\n'));
  // 60分を超えて計上された達成表示と売上計上の組が一意に決まらない（数が合わない・順序が崩れる）ときは推測で組まずに止める
  const amb = questResult.payoutAmbiguities || [];
  check(amb.length === 0 ? 'クエスト達成表示と売上計上の対応が一意' : `クエスト達成表示と売上計上の対応が曖昧（${amb.length}件・保守で確認が必要）`, amb.length === 0,
    amb.map(a => `${yen(a.amount)}: 達成表示 ${a.variants.map(v => v.time).join('・')} / 売上計上 ${a.bases.map(b => b.time).join('・')}（同数・時刻順に組めないため自動で統合しません）`).join('\n'));

  // 2. 詳細（スクショ または 構造化データ）
  const files = listScreenshots(p.screenshotDir);
  const screensDoc = readJson(p.screensFile, null);
  if (!screensDoc) {
    check('詳細読取結果', false, `${p.screensFile} がありません（prepare を実行してください）`);
    return finish();
  }
  const isStructured = screensDoc.sourceType === 'structured';
  const screenErrors = [];
  const screens = [];
  if (!isStructured) {
    const listed = new Set((screensDoc.screenshots || []).map(s => s.file));
    files.filter(f => !listed.has(f)).forEach(f => screenErrors.push(`${f}: 読取結果が未記入（prepare を再実行）`));
  }
  (screensDoc.screenshots || []).forEach(s => {
    if (!isStructured && !files.includes(s.file)) {
      screenErrors.push(`${s.file}: screenshots フォルダに画像がありません`);
      return;
    }
    const { screen, errors } = normalizeScreen(s, date);
    if (s.legs) screen.legs = s.legs;
    if (s.tripLegCount) screen.tripLegCount = s.tripLegCount;
    if (s.sequence !== undefined) screen.sequence = s.sequence;
    if (s.tripUuid) screen.tripUuid = s.tripUuid;
    errors.forEach(e => screenErrors.push(`${s.file}: ${e}`));
    if (screen.kind === 'other') screenErrors.push(`${s.file}: Delivery詳細ではない画像（kind: other）。取り除くか確認してください`);
    screens.push(screen);
  });
  check(isStructured ? '構造化トリップ詳細読込（値が正常）' : 'スクショ全件読取済み（UNKNOWNなし・値が正常）', screenErrors.length === 0, screenErrors.join('\n'));

  // 同じDeliveryを2回撮ったスクショ（撮り直し等）は1枚として扱う。
  // 見出しの時刻・金額だけでなく、時間・距離・ポイント・店舗・配達先まで全て一致するものだけを同一とみなす
  // （同じ時刻・同じ金額でも中身が違えば別Deliveryとして残し、件数不一致で止める）。
  const sameDelivery = (a, b) => a.time === b.time && a.amount === b.amount && a.durationSeconds === b.durationSeconds &&
    round2(a.distanceKm) === round2(b.distanceKm) && a.points === b.points &&
    String(a.restaurant).replace(/\s+/g, '') === String(b.restaurant).replace(/\s+/g, '') &&
    String(a.area).replace(/\s+/g, '') === String(b.area).replace(/\s+/g, '') &&
    (a.baseFee ?? null) === (b.baseFee ?? null) && (a.tip ?? null) === (b.tip ?? null);
  const deliveryScreens = [];
  screens.filter(s => s.kind === 'delivery' && s.time && Number.isInteger(s.amount)).forEach(s => {
    const dup = deliveryScreens.find(k => sameDelivery(k, s));
    if (dup) {
      s.duplicateOf = dup.file;
      warnings.push(`${s.file} は ${dup.file} と同じDelivery（${s.time} ${yen(s.amount)}・時間/距離/店舗/配達先が一致）の重複スクショのため1枚として扱いました`);
      return;
    }
    deliveryScreens.push(s);
  });

  // 3. activity ↔ 詳細 照合
  //  (a) 構造化取込で一覧と詳細の両方に trip UUID があるものは UUID で同一tripとする（Uber の trip の識別子。金額・時刻が違っても同じ trip）。
  //      同じ取得で一覧と詳細の金額・時刻が違うときは、内訳（配送料＋チップ＝売り上げ）を検証済みのトリップ詳細の値を採用する
  //      （一覧は内訳の無い要約表示。2026-10-30 09:05 は一覧 ¥338 / 詳細 ¥676 で、時間・距離も詳細の方が全 leg 分）。一覧の値は記録だけ残し、止めない
  //  (b) それ以外（スクショ取込・UUID の無いもの）は従来どおり 日付・時刻・金額が完全一致したものだけを同一tripとする
  const matchErrors = [];
  const listDetailDiffs = [];
  trips = [];
  const uuidOf = x => (x && x.tripUuid ? String(x.tripUuid).toLowerCase() : null);
  let restActs = actDeliveries;
  let restScreens = deliveryScreens;
  if (isStructured) {
    const pairedScreens = new Set();
    const pairedActs = new Set();
    actDeliveries.forEach(a => {
      const u = uuidOf(a);
      const cands = u ? deliveryScreens.filter(s => !pairedScreens.has(s) && uuidOf(s) === u) : [];
      if (cands.length !== 1) return;
      const s = cands[0];
      pairedActs.add(a);
      pairedScreens.add(s);
      const t = { activity: a, screen: s };
      if (a.time !== s.time || a.amount !== s.amount) {
        t.listDiff = { listTime: a.time, listAmount: a.amount, detailTime: s.time, detailAmount: s.amount };
        listDetailDiffs.push({ tripUuid: u, ...t.listDiff });
        warnings.push(`一覧 ${a.time} ${yen(a.amount)} とトリップ詳細 ${s.time} ${yen(s.amount)}（trip ${u.slice(0, 8)}）が違うため、内訳つきのトリップ詳細の値を採用しました`);
      }
      trips.push(t);
    });
    restActs = actDeliveries.filter(a => !pairedActs.has(a));
    restScreens = deliveryScreens.filter(s => !pairedScreens.has(s));
  }
  const groups = new Map();
  const keyOf = (t, a) => `${t}|${a}`;
  restActs.forEach(e => {
    const k = keyOf(e.time, e.amount);
    if (!groups.has(k)) groups.set(k, { acts: [], screens: [] });
    groups.get(k).acts.push(e);
  });
  restScreens.forEach(s => {
    const k = keyOf(s.time, s.amount);
    if (!groups.has(k)) groups.set(k, { acts: [], screens: [] });
    groups.get(k).screens.push(s);
  });
  groups.forEach((g, k) => {
    const [time, amount] = k.split('|');
    if (g.acts.length !== g.screens.length) {
      if (!g.screens.length) matchErrors.push(isStructured ? `一覧 ${time} ${yen(+amount)} に一致するトリップ詳細がありません` : `一覧 ${time} ${yen(+amount)} に一致するスクショがありません`);
      else if (!g.acts.length) matchErrors.push(isStructured ? `トリップ詳細 ${g.screens.map(s => s.file).join(', ')}（${time} ${yen(+amount)}）に一致する一覧Deliveryがありません` : `スクショ ${g.screens.map(s => s.file).join(', ')}（${time} ${yen(+amount)}）に一致する一覧Deliveryがありません`);
      else matchErrors.push(isStructured ? `${time} ${yen(+amount)}: 一覧 ${g.acts.length} 件に対しトリップ詳細 ${g.screens.length} 件（件数不一致）` : `${time} ${yen(+amount)}: 一覧 ${g.acts.length} 件に対しスクショ ${g.screens.length} 件（件数不一致）`);
      return;
    }
    if (g.acts.length > 1) warnings.push(`${time} ${yen(+amount)} の同時刻・同額Deliveryが ${g.acts.length} 件（ファイル名順に対応付け）`);
    g.acts.forEach((a, i) => {
      const s = g.screens[i];
      if (a.tripUuid && s.tripUuid && a.tripUuid !== s.tripUuid) {
        matchErrors.push(isStructured ? `${time} ${yen(+amount)}: trip UUID が一致しません（一覧 ${a.tripUuid} / トリップ詳細 ${s.tripUuid}）` : `${time} ${yen(+amount)}: trip UUID が一致しません（一覧 ${a.tripUuid} / スクショ ${s.tripUuid}）`);
        return;
      }
      trips.push({ activity: a, screen: s });
    });
  });
  trips.sort((a, b) => a.screen.time.localeCompare(b.screen.time) || a.screen.file.localeCompare(b.screen.file));
  check(isStructured ? 'Delivery件数一致（一覧 = トリップ詳細 = 照合済み）' : 'Delivery件数一致（一覧 = スクショ = 照合済み）',
    matchErrors.length === 0 && actDeliveries.length === deliveryScreens.length && trips.length === actDeliveries.length,
    [`一覧 ${actDeliveries.length} / ${isStructured ? '詳細' : 'スクショ'} ${deliveryScreens.length} / 照合 ${trips.length}`].concat(matchErrors).join('\n'));

  const actDeliverySum = actDeliveries.reduce((s, e) => s + e.amount, 0);
  tripSum = trips.reduce((s, t) => s + t.screen.amount, 0);
  // 一覧と詳細の金額差（詳細を採用した分）を除いて一致すること
  const listDetailGap = listDetailDiffs.reduce((s, d) => s + d.detailAmount - d.listAmount, 0);
  check('配達報酬合計一致（一覧合計 = 各trip金額合計）', actDeliverySum + listDetailGap === tripSum,
    `一覧 ${yen(actDeliverySum)} / trip ${yen(tripSum)}${listDetailGap ? `（一覧と詳細の差 ${listDetailGap < 0 ? '-' : '+'}${yen(Math.abs(listDetailGap))} はトリップ詳細の値を採用）` : ''}`);

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
  rec = reconcile(date, existing, trips, questResult.quests, actAdjustments, tm.catalog, { at: generatedAt, structured: isStructured });
  rec.warnings.forEach(w => warnings.push(w));
  check('既存データとの整合（既存trip・クエスト・調整を削除しない・安全に照合できないものは更新しない）', rec.errors.length === 0, rec.errors.join('\n'));

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

  // 6. MAP（公式スクショからの切り抜き、または構造化取込時は構造化MAP情報保持）
  const mapMissingOk = new Set((decisions.mapMissingOk || []).map(String));
  const jobs = [];
  const mapErrors = [];
  const sizeErrors = [];

  if (isStructured) {
    trips.forEach((t, i) => {
      const id = rec.tripIds[i];
      if (tm.catalog[id]) {
        t.map = { status: 'existing' };
      } else {
        t.map = {
          status: 'structured',
          tripUuid: t.screen.tripUuid,
          legCount: t.screen.tripLegCount || 1,
          hasRouteMap: !!(t.screen.legs && t.screen.legs.some(l => l.customRouteMap))
        };
      }
    });
    check('MAP（構造化データ）', true, `${trips.length}/${trips.length}（Uber Web構造化データより取得）`);
  } else {
    rec.tripIds.forEach((id, i) => {
      const t = trips[i];
      if (tm.catalog[id]) {
        t.map = { status: 'existing' };
        return;
      }
      // 同じDeliveryの重複スクショ（撮り直し）がある場合は、それぞれ切り抜きを試して地図が切り抜けた方を使う
      const sources = [t.screen.file].concat(screens.filter(s => s.duplicateOf === t.screen.file).map(s => s.file));
      t.map = { status: 'pending', candidates: sources.map((file, k) => {
        const stem = `${String(i + 1).padStart(2, '0')}_${k}_${sha256(file).slice(0, 8)}`;
        const cand = { file, work: path.join(p.workDir, `map_${stem}.png`), workFull: path.join(p.workDir, `full_${stem}.png`) };
        jobs.push({ src: path.join(p.screenshotDir, file), map: cand.work, full: cand.workFull });
        return cand;
      }) };
    });
    const cropResults = runCropBatch(p, jobs);
    trips.forEach(t => {
      if (!t.map || t.map.status !== 'pending') return;
      const results = t.map.candidates.map(cand => ({ cand, r: cropResults.find(c => path.resolve(c.src) === path.resolve(p.screenshotDir, cand.file)) }));
      const okPick = results.find(x => x.r && x.r.ok);
      const r = okPick ? okPick.r : (results[0] && results[0].r);
      if (okPick) {
        t.map = { status: 'pending', work: okPick.cand.work, workFull: okPick.cand.workFull, sourceFile: okPick.cand.file };
        if (okPick.cand.file !== t.screen.file) warnings.push(`${t.screen.time} ${yen(t.screen.amount)}: MAP は重複スクショ ${okPick.cand.file} から切り抜き`);
      }
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
  }

  return finish();

  function finish() {
    const failed = checks.filter(c => !c.ok);
    const staging = {
      date,
      importer: IMPORTER,
      generatedAt,
      source: {
        activityFile: path.relative(root, p.activityFile),
        activitySha256: fs.existsSync(p.activityFile) ? sha256(fs.readFileSync(p.activityFile)) : null,
        screenshots: listScreenshots(p.screenshotDir).map(f => ({ file: f, sha256: sha256(fs.readFileSync(path.join(p.screenshotDir, f))) }))
      },
      deliveries: !trips ? [] : trips.map((t, i) => ({
        id: rec && rec.tripIds[i],
        status: rec && rec.tripStatus[i],
        changes: (rec && rec.tripChanges[i]) || [],
        listDiff: t.listDiff || null,
        activity: { time: t.activity.time, amount: t.activity.amount, tripUuid: t.activity.tripUuid, activityUuid: t.activity.activityUuid, url: t.activity.url },
        screen: t.screen,
        map: t.map || null
      })),
      quests: !questResult ? [] : questResult.quests.map(q => ({ time: q.time, category: q.category, title: q.title, amount: q.amount, counted: q.counted, reason: q.reason })),
      questDuplicateCandidates: !questResult ? [] : questResult.duplicateCandidates,
      adjustments: !actAdjustments ? [] : actAdjustments.map(a => ({ time: a.time, title: a.title, amount: a.amount, activityUuid: a.activityUuid })),
      // 既存の trip・クエスト・調整を Uber 公式の最新値へ更新した内容（変更前 → 変更後）
      officialUpdates: (rec && rec.updates) || [],
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

// クエスト・調整の照合（取込の各項目 → 既存の項目 or null）。Uber 一覧のクエスト・調整には保存できる識別子が無いため時刻で照合する。
//  1) 時刻・金額が完全一致 2) 残りで、同じ時刻の未照合が既存・取込とも1件だけのもの（金額が後から変わった項目。2件以上は推測で組まない）
function pairByTimeThenUnique(items, exItems, used) {
  const out = items.map(q => {
    const ex = exItems.find(x => !used.has(x) && x.time === q.time && Number(x.amount) === q.amount);
    if (ex) used.add(ex);
    return ex || null;
  });
  items.forEach((q, i) => {
    if (out[i]) return;
    const sameTimeIn = items.filter((y, j) => !out[j] && y.time === q.time);
    const cands = exItems.filter(x => !used.has(x) && x.time === q.time);
    if (sameTimeIn.length === 1 && cands.length === 1) { out[i] = cands[0]; used.add(cands[0]); }
  });
  return out;
}

// 公式の値の変更を履歴（officialHistory）に1件追加する。同じ内容の記録は重ねない（同じデータを何度取り込んでも結果が変わらない）
function withHistory(item, entry) {
  const hist = Array.isArray(item.officialHistory) ? item.officialHistory : [];
  const sig = e => JSON.stringify({ ...e, at: undefined });
  const last = [...hist].reverse().find(e => e.type === entry.type);
  if (last && sig(last) === sig(entry)) return item;
  return { ...item, officialHistory: hist.concat([entry]) };
}

// 既存日のデータと取込データを突き合わせ、反映後の1日分データを作る
// 既存の trip・クエスト・調整は ID を保ったまま Uber 公式の最新の値へ更新する（報酬の後からの変更・調整に追従）。
// 変更前後の値は officialHistory に残す。手入力の項目（○×評価・メモ・店舗名・配達先など）は変えない
function reconcile(date, existing, trips, quests, adjustments, catalog, opts = {}) {
  const errors = [];
  const warnings = [];
  const md = mmdd(date);
  const at = opts.at || null;
  const tripIds = [];
  const tripStatus = [];
  const tripChanges = [];
  const updates = [];

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
  // 既存 trip との照合（金額だけに頼らない。安全に同じ trip と言えないものは照合しない）
  //  1) trip UUID が同じ（Uber の trip の識別子。金額・時刻・距離が変わっても同じ trip）
  //  2) 完了時刻と金額が完全一致（UUID の無い既存 trip。両方に UUID があって違うものは除く）
  //  3) UUID の無い既存 trip で、完了時刻が同じ trip が既存・取込とも1件だけ・店舗も同じ（金額が後から変わった trip）
  // 公式の値への自動更新は Uber Web の構造化データ（opts.structured）だけ。スクショ取込は読み違いを更新として通さないよう、従来どおり違いがあれば止める
  const official = !!opts.structured;
  const uuidOf = x => (x && x.tripUuid ? String(x.tripUuid).toLowerCase() : null);
  const sameStore = (a, b) => String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, '');
  const matchOf = trips.map(() => null);
  const matchHow = trips.map(() => null);
  trips.forEach((t, i) => {
    const u = uuidOf(t.screen);
    if (!u) return;
    const cands = exTrips.filter(d => !used.has(d) && uuidOf(d) === u);
    if (cands.length > 1) errors.push(`既存tripに trip UUID ${u} が複数あり対応付けできません`);
    if (cands.length === 1) { matchOf[i] = cands[0]; matchHow[i] = 'uuid'; used.add(cands[0]); }
  });
  trips.forEach((t, i) => {
    if (matchOf[i]) return;
    const s = t.screen;
    const u = uuidOf(s);
    const cands = exTrips.filter(d => !used.has(d) && d.completedAt === s.time && Number(d.fee) === s.amount && !(u && uuidOf(d) && uuidOf(d) !== u));
    if (cands.length > 1) {
      errors.push(`既存tripに ${s.time} ${yen(s.amount)} が複数あり対応付けできません`);
    }
    if (cands.length) { matchOf[i] = cands[0]; matchHow[i] = 'time-amount'; used.add(cands[0]); }
  });
  trips.forEach((t, i) => {
    if (matchOf[i] || !official) return;
    const s = t.screen;
    const sameTimeIn = trips.filter((x, j) => !matchOf[j] && x.screen.time === s.time);
    const cands = exTrips.filter(d => !used.has(d) && !uuidOf(d) && d.completedAt === s.time);
    if (sameTimeIn.length === 1 && cands.length === 1 && sameStore(cands[0].restaurant, s.restaurant)) {
      matchOf[i] = cands[0]; matchHow[i] = 'time-store'; used.add(cands[0]);
    }
  });
  trips.forEach((t, i) => {
    const s = t.screen;
    const ex = matchOf[i];
    if (ex) {
      if (ex.restaurant && ex.restaurant !== s.restaurant) warnings.push(`${ex.id}: 店舗名の表記差（既存「${ex.restaurant}」を維持 / 公式「${s.restaurant}」）`);
      if (ex.area && ex.area !== s.area) warnings.push(`${ex.id}: 配達先の表記差（既存「${ex.area}」を維持 / 公式「${s.area}」）`);
      // Uber 公式の値（報酬・完了時刻・距離・時間・ポイント・leg）が変わっていれば最新の値へ更新する
      let merged = { ...ex };
      const changes = [];
      const update = (field, to, same = (a, b) => a === b) => {
        const from = merged[field];
        if (from === undefined || from === null || from === '' || to === undefined || to === null) return;
        if (same(from, to)) return;
        changes.push({ field, from, to });
        merged[field] = to;
      };
      update('fee', s.amount, (a, b) => Number(a) === b);
      update('completedAt', s.time);
      update('distanceKm', s.distanceKm, (a, b) => round2(Number(a)) === round2(b));
      update('durationStr', s.durationStr, (a, b) => durationToSeconds(a) === durationToSeconds(b));
      update('points', s.points, (a, b) => Number(a) === b);
      if (s.tripLegCount && merged.tripLegCount && merged.tripLegCount !== s.tripLegCount) {
        update('tripLegCount', s.tripLegCount);
        if (s.legs) merged.legs = s.legs;
      }
      if (merged.baseFee !== undefined) {
        if (s.baseFee !== null && (merged.baseFee !== s.baseFee || (merged.tip ?? null) !== (s.tip ?? null))) {
          changes.push({ field: 'baseFee', from: merged.baseFee, to: s.baseFee }, { field: 'tip', from: merged.tip ?? null, to: s.tip ?? null });
          merged.baseFee = s.baseFee;
          merged.tip = s.tip;
        } else if (s.baseFee === null && changes.some(c => c.field === 'fee')) {
          // 新しい公式データに内訳が無い: 古い内訳は金額と合わなくなるので外す（履歴に残す）
          changes.push({ field: 'baseFee', from: merged.baseFee, to: null }, { field: 'tip', from: merged.tip ?? null, to: null });
          delete merged.baseFee;
          delete merged.tip;
        }
      }
      if (changes.length && !official) {
        errors.push(`既存trip ${ex.id}（${s.time} ${yen(s.amount)}）と公式スクショが不一致: ${changes.map(c => `${c.field} ${c.from}→${c.to}`).join(', ')}`);
        merged = { ...ex };
        changes.length = 0;
      }
      if (changes.length) {
        merged = withHistory(merged, { type: 'update', at, match: matchHow[i], changes });
        updates.push({ kind: 'trip', id: ex.id, time: s.time, match: matchHow[i], changes });
        warnings.push(`${ex.id}（${s.time}）: Uber 公式の最新値に更新 — ${changes.map(c => `${c.field} ${c.from ?? '—'}→${c.to ?? '—'}`).join(', ')}`);
      }
      if (t.listDiff) merged = withHistory(merged, { type: 'list-detail', at, ...t.listDiff });
      if (!merged.restaurant) merged.restaurant = s.restaurant;
      if (!merged.area) merged.area = s.area;
      if (merged.distanceKm === null || merged.distanceKm === undefined) merged.distanceKm = s.distanceKm;
      if (!merged.durationStr) merged.durationStr = s.durationStr;
      if (merged.points === null || merged.points === undefined) merged.points = s.points;
      if (s.baseFee !== null && merged.baseFee === undefined) { merged.baseFee = s.baseFee; merged.tip = s.tip; }
      if (s.tripUuid && !merged.tripUuid) merged.tripUuid = s.tripUuid;
      if (s.tripLegCount && !merged.tripLegCount) merged.tripLegCount = s.tripLegCount;
      if (s.legs && !merged.legs) merged.legs = s.legs;
      if (s.sequence !== undefined && merged.sequence === undefined) merged.sequence = s.sequence;
      newDeliveries.push(merged);
      tripIds.push(ex.id);
      tripStatus.push(changes.length ? 'updated' : 'existing');
      tripChanges.push(changes);
    } else {
      let id;
      do { nextNo += 1; id = `del_${md}_${nextNo}`; } while (exTrips.some(d => d.id === id));
      if (catalog[id]) warnings.push(`${id}: 既存のMAPカタログ登録をそのまま使用（上書きしない）`);
      const memo = [];
      if (s.points === 2) memo.push('ダブル配達（2件完了/2pt）');
      else if (s.points === 3) memo.push('トリプル配達（3件完了/3pt）');
      else if (s.points > 3) memo.push(`${s.points}件完了/${s.points}pt`);
      if (s.baseFee !== null) memo.push(`最終売上¥${s.amount}（基本料金¥${s.baseFee}＋チップ¥${s.tip}）`);
      if (s.note) memo.push(s.note); // 公式表記の原文など（スクショ読取時の注記）
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
      if (s.tripUuid) d.tripUuid = s.tripUuid;
      if (s.tripLegCount) d.tripLegCount = s.tripLegCount;
      if (s.legs) d.legs = s.legs;
      if (s.sequence !== undefined) d.sequence = s.sequence;
      newDeliveries.push(t.listDiff ? withHistory(d, { type: 'list-detail', at, ...t.listDiff }) : d);
      tripIds.push(id);
      tripStatus.push('new');
      tripChanges.push([]);
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
  // 照合: 1) 時刻・金額が完全一致 2) 金額が後から変わったクエスト: その時刻の未照合が既存・取込とも1件だけのとき同じクエストとして金額を更新
  const qMatch = pairByTimeThenUnique(counted, exQuests, usedQ);
  const newQuests = counted.map((q, i) => {
    const ex = qMatch[i];
    if (ex && Number(ex.amount) === q.amount) return ex;
    if (ex) {
      const changes = [{ field: 'amount', from: Number(ex.amount), to: q.amount }];
      updates.push({ kind: 'quest', id: ex.id, time: q.time, match: 'time', changes });
      warnings.push(`${ex.id}（${q.time}）: Uber 公式の最新値に更新 — amount ${ex.amount}→${q.amount}`);
      return withHistory({ ...ex, amount: q.amount }, { type: 'update', at, match: 'time', changes });
    }
    nextQ += 1;
    const notes = notCounted
      .filter(n => n.duplicateOfSeq === q.seq)
      .map(n => (n.time && n.time !== q.time)
        ? `公式一覧は ${n.time}「${n.title} ${yen(n.amount)}」（達成表示）と ${q.time}「${q.title} ${yen(q.amount)}」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）`
        : `公式一覧は「${q.title} ${yen(q.amount)}」「${n.title} ${yen(n.amount)}」の2表示だが同一報酬のため1件のみ計上（二重計上防止）`);
    const quest = { id: `quest_${md}_${nextQ}`, time: q.time, title: q.title, amount: q.amount, isDuplicateIgnored: false };
    if (q.decision) quest.decision = q.decision;
    // クエスト名（回数クエストの名称）と種別（通常 normal / 特別 special）。会計上はどちらもクエスト報酬
    if (q.questName) quest.questName = String(q.questName).replace(/\s+/g, '');
    if (q.questType) quest.questType = q.questType;
    if (q.achievedAt && q.achievedAt !== q.time) quest.achievedAt = q.achievedAt;
    if (notes.length) quest.note = notes.join('。');
    return quest;
  });
  exQuests.filter(x => !usedQ.has(x)).forEach(x => {
    errors.push(`既存クエスト ${x.id}（${x.time} ${yen(Number(x.amount))}）がUber一覧に見つかりません（削除はしません）`);
  });
  const zeroNotes = notCounted.filter(n => n.amount === 0).map(n => `${n.time || ''}の「${n.title}」¥0は報酬0のため売上非加算`);
  if (zeroNotes.length && newQuests.length) {
    const lastNew = [...newQuests].reverse().find(q => !exQuests.some(x => x.id === q.id));
    if (lastNew) lastNew.note = [lastNew.note, zeroNotes.join('。')].filter(Boolean).join('。');
  }

  // --- 調整（Uber側の売上調整。経費ではない）
  const exAdj = (existing && existing.adjustments) || [];
  const usedA = new Set();
  let nextA = exAdj.reduce((mx, a) => {
    const m = String(a.id || '').match(new RegExp(`^adj_${md}_(\\d+)$`));
    return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
  }, 0);
  const aMatch = pairByTimeThenUnique(adjustments, exAdj, usedA);
  const newAdj = adjustments.map((a, i) => {
    const ex = aMatch[i];
    if (ex && Number(ex.amount) === a.amount) return ex;
    if (ex) {
      const changes = [{ field: 'amount', from: Number(ex.amount), to: a.amount }];
      updates.push({ kind: 'adjustment', id: ex.id, time: a.time, match: 'time', changes });
      warnings.push(`${ex.id}（${a.time}）: Uber 公式の最新値に更新 — amount ${ex.amount}→${a.amount}`);
      return withHistory({ ...ex, amount: a.amount }, { type: 'update', at, match: 'time', changes });
    }
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
  // 新しい trip がある・既存 trip の公式の値（ポイント・距離など）が変わった日は、件数・距離を取込結果から計算し直す
  const hasNewTrips = tripStatus.includes('new') || tripStatus.includes('updated');

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
  return { errors, warnings, log, changed, tripIds, tripStatus, tripChanges, updates };
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
  const vFileContent = fs.readFileSync(vFile, 'utf8').split(v.version).join(next)
    .replace(/"releasedAt": "[^"]*"/, `"releasedAt": "${iso}"`);
  fs.writeFileSync(vFile, vFileContent, 'utf8');
  // 反映先は版番号の一本化（tools/release-check/version.js）と同じ規則（index.html・sw.js・pickup-map.html・route-judge.html）
  const { TARGETS } = require('../../release-check/version.js');
  TARGETS.forEach(t => {
    const file = path.join(root, t.file);
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    const out = t.apply(src, next);
    if (out !== src) fs.writeFileSync(file, out, 'utf8');
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
    entries.push({ id: d.id, entry: { map: mapRel, full: fullRel, box: d.map.box, origFile: d.map.sourceFile || d.screen.file }, work: d.map.work, workFull: d.map.workFull });
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
    const r=s.getRevenueSummary(d); const a=s.getAnalytics(); const q=s.getQuestProgress(d);
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
