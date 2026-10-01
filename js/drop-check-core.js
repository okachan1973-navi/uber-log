/**
 * DROP先照合（地雷タブ）の検索ロジック（ブラウザ / Node 共通）
 * - 表記ゆれ: 全角/半角・大文字/小文字・空白・中黒・カタカナ/ひらがな・「曾/曽」・ヶ/ケ を吸収
 * - 検索対象: マンション名・読み・区・町名（読み含む）・住所・階数・備考・Excel目安
 * - 複数語は AND（「西区 ライズ」）。区名は語の中に含まれていても区フィルターとして扱う（音声の「西区ライズ」）
 */
(function (root) {
  'use strict';

  const WARD_ORDER = ['西区', '港区', '此花区', '福島区', '北区', '中央区'];

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
    const chips = WARD_ORDER.map(w => ({ id: w, label: w, count: counts[w] || 0 }));
    const other = Object.keys(counts).filter(w => !WARD_ORDER.includes(w)).reduce((s, w) => s + counts[w], 0);
    chips.push({ id: 'other', label: 'その他', count: other });
    return chips;
  }

  /** 本人評価の表示（Excel 掲載だけでは評価しない＝未評価は「未検証」） */
  function ratingInfo(b, levels) {
    const r = b.my && b.my.rating;
    const lv = (levels || {})[r];
    if (r && lv) return { code: r, icon: lv.icon, label: lv.label };
    return { code: null, icon: '🟡', label: '未検証' };
  }

  const api = { WARD_ORDER, normalize, haystack, parseQuery, search, wardChips, ratingInfo, byReading };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DropCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
