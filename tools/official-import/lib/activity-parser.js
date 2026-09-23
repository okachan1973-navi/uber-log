/**
 * UBER_LOG 公式取込 v1 — Uberアクティビティ一覧テキスト解析（ブラウザ／Node共用）
 *
 * 入力: Uber（ドライバー向けWeb）のアクティビティ一覧をコピーしたテキスト
 * 出力: Delivery / クエスト / 調整 などのイベント配列（推測補完なし）
 *
 * 1イベントの典型形:
 *   Delivery                      ← 種別ラベル（MISC / QUEST のようなカテゴリ行が先に来ることもある）
 *   Tuesday, September 22nd, 2026 ← 日付（無い行は直前に出た日付を引き継ぐ）
 *   19:48                         ← 時刻
 *   ￥483                         ← 金額（-￥607 などの符号付きも可）
 *   View Details                  ← 任意（URL・trip UUID・activity UUID があれば保持）
 *
 * 将来の自動取得（Uber Web 巡回）でも、同じ形のテキストを activity.txt に保存すれば
 * このパーサーがそのまま受け口になる。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UberActivityParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const URL_RE = /https?:\/\/[^\s"'<>]+/i;
  // 小数表記（例: ￥750.00）も受け付ける。円に端数は無いので .00 以外はそのまま小数で返し、検証で止める
  const MONEY_RE = /([+\-−–]?)\s*[¥￥]\s*([+\-−–]?)\s*(\d[\d,]*)(?:\.(\d{1,2}))?/;
  const TIME_RE = /(?:^|[^\d:])(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?(?![\d:])/;
  const JP_TIME_RE = /(午前|午後)?\s*(\d{1,2})\s*時\s*(\d{1,2})\s*分/;
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
    jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  const DETAILS_RE = /^(view details|詳細を表示|詳細を見る|詳細)$/i;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toHalfWidth(s) {
    return String(s)
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/：/g, ':').replace(/，/g, ',').replace(/　/g, ' ');
  }

  // 日付表記 → YYYY-MM-DD（年が無い表記は defaultYear を使用）
  function parseDate(text, defaultYear) {
    const s = toHalfWidth(text);
    let m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    m = s.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m && defaultYear) return `${defaultYear}-${pad2(m[1])}-${pad2(m[2])}`;
    // Tuesday, September 22nd, 2026 / Sep 22, 2026 / Tue, Sep 22
    m = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i);
    if (m) {
      const year = m[3] || defaultYear;
      if (!year) return null;
      return `${year}-${pad2(MONTHS[m[1].toLowerCase()])}-${pad2(m[2])}`;
    }
    return null;
  }

  function parseTime(text) {
    const s = toHalfWidth(text);
    let m = s.match(JP_TIME_RE);
    if (m) {
      let h = parseInt(m[2], 10);
      if (m[1] === '午後' && h < 12) h += 12;
      if (m[1] === '午前' && h === 12) h = 0;
      return `${pad2(h)}:${pad2(m[3])}`;
    }
    m = s.match(TIME_RE);
    if (m) {
      let h = parseInt(m[1], 10);
      const ap = m[3] ? m[3].toLowerCase() : null;
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
      if (h > 23 || parseInt(m[2], 10) > 59) return null;
      return `${pad2(h)}:${m[2]}`;
    }
    return null;
  }

  function parseMoney(text) {
    const s = toHalfWidth(text);
    const m = s.match(MONEY_RE);
    if (!m) return null;
    const neg = /[\-−–]/.test(m[1] + m[2]);
    let value = parseInt(m[3].replace(/,/g, ''), 10);
    if (m[4] && parseInt(m[4], 10) !== 0) value += parseInt(m[4].padEnd(2, '0'), 10) / 100;
    return neg ? -value : value;
  }

  // 1行から 日付・時刻・金額・URL・UUID・ラベル を取り出す
  function tokenizeLine(line, defaultYear) {
    const raw = line.trim();
    const out = { raw, date: null, time: null, amount: null, url: null, uuid: null, label: null, details: false };
    if (!raw) return out;
    let rest = toHalfWidth(raw);

    const url = rest.match(URL_RE);
    if (url) {
      out.url = url[0];
      rest = rest.replace(url[0], ' ');
    }
    const uuidSrc = out.url || rest;
    const uuid = uuidSrc.match(UUID_RE);
    if (uuid) {
      out.uuid = uuid[0].toLowerCase();
      rest = rest.replace(UUID_RE, ' ');
    }
    const money = rest.match(MONEY_RE);
    if (money) {
      out.amount = parseMoney(money[0]);
      rest = rest.replace(money[0], ' ');
    }
    const date = parseDate(rest, defaultYear);
    if (date) {
      out.date = date;
      rest = rest
        .replace(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/, ' ')
        .replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日(\s*[（(][^）)]*[）)])?/, ' ')
        .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?/ig, ' ')
        .replace(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s*\d{4})?/i, ' ')
        .replace(/[（(]\s*[月火水木金土日]\s*[）)]/, ' ');
    }
    const time = parseTime(rest);
    if (time) {
      out.time = time;
      rest = rest.replace(JP_TIME_RE, ' ').replace(/\d{1,2}:\d{2}(\s*[AaPp]\.?\s*[Mm]\.?)?/, ' ');
    }
    rest = rest.replace(/[•・|,、]/g, ' ').replace(/\s+/g, ' ').trim();
    if (DETAILS_RE.test(rest)) {
      out.details = true;
      rest = '';
    }
    out.label = rest || null;
    return out;
  }

  // ラベル群から種別を判定
  function classify(labels) {
    const joined = labels.join(' / ');
    const lower = labels.map(l => l.toLowerCase());
    const category = labels.find(l => /^(misc|quest|delivery|adjustment)$/i.test(l)) || null;
    const titles = labels.filter(l => !/^(misc|quest)$/i.test(l));
    const title = titles.length ? titles.join(' ') : (category || '');

    if (lower.some(l => /^(delivery|デリバリー|配達|uber eats)$/.test(l))) return { type: 'delivery', category, title };
    if (/(合計|total|総額|売上合計)/i.test(joined)) return { type: 'statementTotal', category, title };
    if (/(保証|promotion|incentive|boost|ブースト|キャンペーン|紹介)/i.test(joined)) return { type: 'special', category, title };
    if (/(チップ|\btip\b)/i.test(joined)) return { type: 'tip', category, title };
    if (/(調整|adjust)/i.test(joined)) return { type: 'adjustment', category, title };
    if (/(クエスト|quest)/i.test(joined)) return { type: 'quest', category, title };
    return { type: 'unknown', category, title };
  }

  /**
   * テキスト全体を解析してイベント配列を返す
   * @param {string} text
   * @param {{ defaultYear?: number|string }} opts
   */
  function parseActivityText(text, opts = {}) {
    const defaultYear = opts.defaultYear ? String(opts.defaultYear) : null;
    const lines = String(text || '').replace(/\r\n?/g, '\n').split(/\n|\t/);
    const events = [];
    const warnings = [];
    let ctxDate = null;
    let cur = null;

    const start = () => ({ labels: [], date: ctxDate, dateFromLine: false, time: null, amount: null, url: null, uuids: [], details: false, lines: [] });
    const flush = () => {
      if (!cur) return;
      if (cur.amount === null) {
        if (cur.labels.length) warnings.push(`金額の無い行を無視: ${cur.lines.join(' / ')}`);
      } else {
        events.push(cur);
      }
      cur = null;
    };

    lines.forEach((line) => {
      const t = tokenizeLine(line, defaultYear);
      if (!t.raw) return;

      if (t.date) {
        if (cur && cur.amount !== null) flush();
        ctxDate = t.date;
        if (cur) { cur.date = t.date; cur.dateFromLine = true; }
      }
      if (t.label) {
        if (cur && cur.amount !== null) flush();
        if (!cur) cur = start();
        cur.labels.push(t.label);
      }
      if (t.time) {
        if (cur && cur.time && cur.amount !== null) flush();
        if (!cur) cur = start();
        cur.time = t.time;
      }
      if (t.amount !== null) {
        if (cur && cur.amount !== null) flush();
        if (!cur) cur = start();
        cur.amount = t.amount;
      }
      const target = cur || events[events.length - 1];
      if (target) {
        if (t.url) target.url = t.url;
        if (t.uuid && !target.uuids.includes(t.uuid)) target.uuids.push(t.uuid);
        if (t.details) target.details = true;
        target.lines.push(t.raw);
      }
    });
    flush();

    let statementTotal = null;
    const result = [];
    events.forEach((e, i) => {
      const cls = classify(e.labels);
      const ev = {
        seq: i + 1,
        type: cls.type,
        category: cls.category,
        title: cls.title,
        labels: e.labels,
        date: e.date,
        time: e.time,
        amount: e.amount,
        url: e.url,
        tripUuid: null,
        activityUuid: null,
        uuids: e.uuids,
        raw: e.lines.join(' | ')
      };
      e.uuids.forEach(u => {
        if (e.url && /\/trips?\//i.test(e.url) && e.url.toLowerCase().includes(u)) ev.tripUuid = u;
        else if (!ev.activityUuid) ev.activityUuid = u;
      });
      if (!ev.tripUuid && ev.type === 'delivery' && e.uuids.length === 1 && e.url && /trip/i.test(e.url)) ev.tripUuid = e.uuids[0];
      if (cls.type === 'statementTotal') statementTotal = { date: ev.date, amount: ev.amount, raw: ev.raw };
      else result.push(ev);
    });

    return { events: result, statementTotal, warnings };
  }

  /**
   * クエストの重複排除（既存ルールの自動化）
   * - 同時刻・同額で「クエスト（MISC）」と「N回乗車クエスト（QUEST）」の2行 → 同一報酬として1回のみ計上
   * - ¥0クエスト → イベントとして記録するが売上には加算しない
   * - それ以外の同時刻・同額の重なり → 推測で消さず「重複候補」（decisions で指示があるまで止める）
   * @param {Array} quests type==='quest' のイベント
   * @param {{ questDuplicates?: Object<string,'count_once'|'count_all'> }} decisions
   */
  function dedupeQuests(quests, decisions = {}) {
    const out = quests.map(q => ({ ...q, counted: false, reason: '' }));
    const groups = new Map();
    out.forEach(q => {
      if (q.amount === 0) {
        q.reason = '¥0クエスト（売上非加算）';
        return;
      }
      const key = `${q.date || ''}|${q.time || ''}|${q.amount}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    });
    const candidates = [];
    const decided = (decisions && decisions.questDuplicates) || {};
    groups.forEach((list, key) => {
      if (list.length === 1) {
        list[0].counted = true;
        return;
      }
      const shortKey = key.split('|').slice(1).join('|'); // "20:09|800"
      const decision = decided[key] || decided[shortKey];
      const isBase = q => /^(クエスト|quest)$/i.test((q.title || '').trim()) || /^misc$/i.test(q.category || '');
      const isVariant = q => /\d+\s*回.*クエスト|\d+\s*(trips?|rides?|deliver(y|ies)).*quest/i.test(q.title || '') || /^quest$/i.test(q.category || '');
      const knownPair = list.length === 2 && (
        (isBase(list[0]) && isVariant(list[1]) && !isBase(list[1])) ||
        (isBase(list[1]) && isVariant(list[0]) && !isBase(list[0]))
      );
      if ((knownPair && decision !== 'count_all') || decision === 'count_once') {
        const keep = list.find(isBase) || list[0];
        keep.counted = true;
        list.filter(q => q !== keep).forEach(q => {
          q.reason = knownPair
            ? '同時刻・同額の「クエスト」「回数クエスト」重複表示のため計上しない'
            : 'ユーザー確認済みの重複として計上しない';
          q.duplicateOfSeq = keep.seq;
        });
      } else if (decision === 'count_all') {
        list.forEach(q => { q.counted = true; q.reason = 'ユーザー確認済み: 別報酬として計上'; });
      } else {
        list.forEach(q => { q.reason = '重複候補（要確認）'; });
        candidates.push({ key: shortKey, items: list.map(q => ({ seq: q.seq, title: q.title, category: q.category, time: q.time, amount: q.amount })) });
      }
    });
    return { quests: out, duplicateCandidates: candidates };
  }

  // 画面表示用の簡易集計（取込補助画面で使用）
  function summarize(parsed, date) {
    const inDay = parsed.events.filter(e => !date || e.date === date || e.date === null);
    const count = type => inDay.filter(e => e.type === type).length;
    const deliveries = inDay.filter(e => e.type === 'delivery');
    const quests = dedupeQuests(inDay.filter(e => e.type === 'quest'));
    const adjustments = inDay.filter(e => e.type === 'adjustment');
    return {
      delivery: count('delivery'),
      quest: count('quest'),
      adjustment: count('adjustment'),
      unknown: inDay.filter(e => ['unknown', 'tip', 'special'].includes(e.type)).length,
      otherDates: parsed.events.length - inDay.length,
      deliverySales: deliveries.reduce((s, e) => s + e.amount, 0),
      questSales: quests.quests.filter(q => q.counted).reduce((s, q) => s + q.amount, 0),
      adjustmentSales: adjustments.reduce((s, e) => s + e.amount, 0),
      duplicateCandidates: quests.duplicateCandidates.length,
      undatedEvents: inDay.filter(e => e.date === null).length
    };
  }

  return { parseActivityText, dedupeQuests, summarize, parseDate, parseTime, parseMoney, toHalfWidth, tokenizeLine };
});
