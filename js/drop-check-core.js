/**
 * DROP先照合（地雷タブ）の検索ロジック（ブラウザ / Node 共通）
 * - 表記ゆれ: 全角/半角・大文字/小文字・空白・中黒・カタカナ/ひらがな・「曾/曽」・ヶ/ケ を吸収
 * - 検索対象: マンション名・読み・区・町名（読み含む）・住所・階数・備考・Excel目安
 * - 複数語は AND（「西区 ライズ」）。区名は語の中に含まれていても区フィルターとして扱う（音声の「西区ライズ」）
 */
(function (root) {
  'use strict';

  // 区ボタンの並び（本人が配達で使いやすい順）と表示用の短い名前。検索・絞り込みは正式な区名のまま
  const WARD_ORDER = ['西区', '此花区', '港区', '福島区', '浪速区', '北区', '中央区'];
  const WARD_SHORT = { all: '全', 西区: '西', 此花区: '此花', 港区: '港', 福島区: '福島', 浪速区: '浪速', 北区: '北', 中央区: '中央', other: '他' };

  function kataToHira(s) {
    return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  /** 検索用に正規化（照合キー） */
  function normalize(s) {
    let t = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
    t = t.replace(/[曾]/g, '曽').replace(/[ヶヵ]/g, 'ケ').replace(/[’'`´]/g, '');
    t = kataToHira(t);
    t = t.replace(/[\s・･\-－‐―ー〜~、。.,，．!！?？「」『』()（）［］\[\]]/g, function (c) { return c === 'ー' ? 'ー' : ''; });
    return t;
  }

  /** 物件ごとの検索用テキスト */
  function haystack(b) {
    return normalize([
      b.name, b.reading, b.ward, b.ward_reading, b.town, b.town_reading,
      b.town && b.chome ? b.town + b.chome + '丁目' : '', b.address,
      b.floors != null ? b.floors + '階' : '', b.note, b.excel_level,
      b.my && b.my.note
    ].filter(Boolean).join(' '));
  }

  /** 入力を「区フィルター」と「検索語」に分ける */
  function parseQuery(q, wards) {
    let rest = String(q == null ? '' : q).normalize('NFKC');
    const foundWards = [];
    (wards || WARD_ORDER).slice().sort((a, b) => b.length - a.length).forEach(w => {
      if (rest.includes(w)) { foundWards.push(w); rest = rest.split(w).join(' '); }
    });
    const terms = rest.split(/[\s、。,，]+/).map(normalize).filter(Boolean);
    return { wards: foundWards, terms };
  }

  const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('ja', { numeric: true, sensitivity: 'base' }) : null;
  function byReading(a, b) {
    const ra = (a.reading || a.name).replace(/\s+/g, ''), rb = (b.reading || b.name).replace(/\s+/g, '');
    return collator ? collator.compare(ra, rb) : (ra < rb ? -1 : ra > rb ? 1 : 0);
  }

  /**
   * 検索。opts = { query, ward }（ward: 区ボタンの選択。'all' または null で全区、'other' は主な区以外）
   * 戻り値: 読み（あいうえお）順の物件配列
   */
  const hayCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null; // データ本体は書き換えない
  function cachedHaystack(b) {
    if (!hayCache) return haystack(b);
    let h = hayCache.get(b);
    if (h === undefined) { h = haystack(b); hayCache.set(b, h); }
    return h;
  }

  /** 漢字の町名・区名を含む語は、読みに置き換えた語でも照合する（音声入力の「北浜」→英字名「The Kitahama」の読み） */
  function termVariants(t, readingMap) {
    const out = [t];
    let r = t;
    readingMap.forEach(([k, v]) => { if (r.includes(k)) r = r.split(k).join(v); });
    if (r !== t) out.push(r);
    return out;
  }

  function search(buildings, opts) {
    const o = opts || {};
    const allWards = Array.from(new Set(buildings.map(b => b.ward)));
    const pq = parseQuery(o.query, allWards.concat(WARD_ORDER));
    const readingMap = [];
    buildings.forEach(b => {
      if (b.town && b.town_reading) readingMap.push([normalize(b.town), normalize(b.town_reading)]);
    });
    readingMap.sort((a, b) => b[0].length - a[0].length);
    const termSets = pq.terms.map(t => termVariants(t, readingMap));
    return buildings.filter(b => {
      if (o.ward && o.ward !== 'all') {
        if (o.ward === 'other' ? WARD_ORDER.includes(b.ward) : b.ward !== o.ward) return false;
      }
      if (pq.wards.length && !pq.wards.includes(b.ward)) return false;
      const h = cachedHaystack(b);
      return termSets.every(vs => vs.some(v => h.includes(v)));
    }).sort(byReading);
  }

  /** 区ボタンの並びと件数（主な区を先に、データにある他の区は「その他」にまとめる） */
  function wardChips(buildings) {
    const counts = {};
    buildings.forEach(b => { counts[b.ward] = (counts[b.ward] || 0) + 1; });
    const chips = WARD_ORDER.map(w => ({ id: w, label: w, short: WARD_SHORT[w], count: counts[w] || 0 }));
    const other = Object.keys(counts).filter(w => !WARD_ORDER.includes(w)).reduce((s, w) => s + counts[w], 0);
    chips.push({ id: 'other', label: 'その他', short: WARD_SHORT.other, count: other });
    return chips;
  }

  // ---- 本人評価・本人メモ（基礎データとは別に保存。Excel を取り込み直しても消えない） ----
  // 保存形式（端末の localStorage: uber_drop_personal_v1。将来 Supabase の uber_metadata に1キーで載せられる形）
  // { schema, updated_at, items: { [物件id]: { rating: 'ok'|'caution'|'avoid'|null, note: string|null,
  //   tags: [] /* 将来の理由タグ用 */, verified_at, rating_updated_at, note_updated_at, updated_at,
  //   ref: { name, ward, address } /* 物件名の控え。万一 id が変わっても名前で付け直せる */ } } }
  const PERSONAL_KEY = 'uber_drop_personal_v1';
  const PERSONAL_SCHEMA = 'uber_drop_personal/1';
  const RATINGS = ['ok', 'caution', 'avoid'];
  const NOTE_MAX = 20;

  /** 文字数（日本語・絵文字も1文字として数える） */
  function noteLength(s) { return Array.from(String(s || '').normalize('NFC')).length; }

  /** 保存先（localStorage と同じ getItem/setItem を持つもの）を受け取って本人データを読み書きする */
  function createPersonalStore(storage, now) {
    const clock = now || (() => new Date().toISOString());
    let data = null;
    const empty = () => ({ schema: PERSONAL_SCHEMA, updated_at: null, items: {} });
    function load() {
      try {
        const raw = storage && storage.getItem(PERSONAL_KEY);
        const d = raw ? JSON.parse(raw) : null;
        data = d && d.schema === PERSONAL_SCHEMA && d.items ? d : empty();
      } catch (e) { data = empty(); }
      return data;
    }
    function persist() {
      data.updated_at = clock();
      try { storage && storage.setItem(PERSONAL_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
    }
    function touch(b) {
      if (!data) load();
      const cur = data.items[b.id] || { rating: null, note: null, tags: [], verified_at: null, rating_updated_at: null, note_updated_at: null, updated_at: null };
      cur.ref = { name: b.name, ward: b.ward, address: b.address };
      data.items[b.id] = cur;
      return cur;
    }
    function tidy(id) {
      const it = data.items[id];
      if (it && !it.rating && !it.note && !(it.tags && it.tags.length)) delete data.items[id];
    }
    return {
      load,
      all() { return (data || load()).items; },
      get(id) { return (data || load()).items[id] || null; },
      /** 本人評価を付ける・変える（初めて付けた時点で本人確認済み） */
      setRating(b, rating) {
        if (!RATINGS.includes(rating)) throw new Error('評価は ok / caution / avoid のいずれか');
        const it = touch(b);
        const t = clock();
        if (!it.verified_at) it.verified_at = t;
        it.rating = rating; it.rating_updated_at = t; it.updated_at = t;
        return persist();
      },
      /** 未検証に戻す（評価だけ消す。メモは残す） */
      clearRating(b) {
        if (!data) load();
        const it = data.items[b.id];
        if (!it) return true;
        const t = clock();
        it.rating = null; it.verified_at = null; it.rating_updated_at = t; it.updated_at = t;
        tidy(b.id);
        return persist();
      },
      /** 本人メモ（1行・最大 NOTE_MAX 文字。空なら削除） */
      setNote(b, note) {
        const text = String(note || '').replace(/[\r\n]+/g, ' ').trim();
        if (noteLength(text) > NOTE_MAX) throw new Error(`メモは${NOTE_MAX}文字まで`);
        const it = touch(b);
        const t = clock();
        it.note = text || null; it.note_updated_at = t; it.updated_at = t;
        tidy(b.id);
        return persist();
      }
    };
  }

  /** 物件に本人データ（my）を付けた表示用の配列を作る。id が見つからない記録は物件名の控えで付け直す */
  function attachPersonal(buildings, items) {
    const its = items || {};
    const byId = new Set(buildings.map(b => b.id));
    const orphanByName = {};
    Object.keys(its).forEach(id => { if (!byId.has(id) && its[id].ref && its[id].ref.name) orphanByName[normalize(its[id].ref.name)] = its[id]; });
    return buildings.map(b => Object.assign({}, b, { my: its[b.id] || orphanByName[normalize(b.name)] || null }));
  }

  /** 本人評価の表示（評価が無ければ「未検証」＝評価ではない状態） */
  function ratingInfo(b, data) {
    const r = b.my && b.my.rating;
    const lv = ((data && data.rating_levels) || {})[r];
    if (r && lv) return { code: r, icon: lv.icon, label: lv.label, verified: true };
    const u = (data && data.unverified) || { icon: '⚪', label: '未検証' };
    return { code: null, icon: u.icon, label: u.label, verified: false };
  }

  // 「評価別」表示のグループ順（null = 未検証）。並び順を変えるときはここだけ直す
  const RATING_GROUP_ORDER = ['avoid', 'caution', 'ok', null];

  /** 評価別にまとめる（各グループ内は渡された順＝五十音順のまま。空のグループは返さない） */
  function groupByRating(list, data, order) {
    const groups = (order || RATING_GROUP_ORDER).map(code => {
      const lv = code ? ((data && data.rating_levels) || {})[code] : ((data && data.unverified) || { icon: '⚪', label: '未検証' });
      return { code, icon: lv ? lv.icon : '', label: lv ? lv.label : String(code), items: [] };
    });
    list.forEach(b => {
      const r = b.my && b.my.rating;
      const g = groups.find(x => x.code === (RATINGS.includes(r) ? r : null));
      if (g) g.items.push(b);
    });
    return groups.filter(g => g.items.length);
  }

  // 一覧の表示モード（名前順／評価別）。本人評価とは別キーで端末に保存
  const VIEW_KEY = 'uber_drop_view_v1';
  const SORTS = ['name', 'rating'];
  function loadSort(storage) {
    try { const v = JSON.parse(storage.getItem(VIEW_KEY) || 'null'); return v && SORTS.includes(v.sort) ? v.sort : 'name'; } catch (e) { return 'name'; }
  }
  function saveSort(storage, sort) {
    try { storage.setItem(VIEW_KEY, JSON.stringify({ sort: SORTS.includes(sort) ? sort : 'name' })); return true; } catch (e) { return false; }
  }

  const api = { WARD_ORDER, WARD_SHORT, RATING_GROUP_ORDER, groupByRating, VIEW_KEY, loadSort, saveSort, normalize, haystack, parseQuery, search, wardChips, ratingInfo, byReading,
    PERSONAL_KEY, RATINGS, NOTE_MAX, noteLength, createPersonalStore, attachPersonal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DropCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
