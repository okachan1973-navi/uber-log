/**
 * 地雷タブ: DROP先照合ツール
 * Uber Driver の案件表示中に、DROP先のマンション名・町名・住所を数秒で照合する。
 * データ: window.UBER_DROP_BUILDINGS（data/uber_drop_buildings.js） 検索: window.DropCheck（js/drop-check-core.js）
 * 音声: 専用ボタンは持たず、iPhone キーボードの音声入力🎤を使う（入力イベントでそのまま即時検索される）。
 */
(function () {
  'use strict';

  const D = window.DropCheck;
  const DATA = window.UBER_DROP_BUILDINGS;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { ward: 'all', query: '', openId: null, drafts: {}, confirmClear: null, saved: null };
  let buildings = [];
  // 本人評価・本人メモ: 端末保存（localStorage: uber_drop_personal_v1）。物件データ（Excel 由来）とは別に持つ
  let personal = null;
  const views = () => D.attachPersonal(buildings, personal ? personal.all() : {});
  const byId = id => buildings.find(b => b.id === id);

  // ---- 表示 ----
  function renderWards() {
    const chips = [{ id: 'all', label: 'すべて', count: buildings.length }].concat(D.wardChips(buildings));
    $('dc-wards').innerHTML = chips.map(c => `<button type="button" class="dc-ward${state.ward === c.id ? ' on' : ''}" data-ward="${esc(c.id)}"
      aria-pressed="${state.ward === c.id}" ${c.count ? '' : 'disabled'}>${esc(c.label)}<small>${c.count}</small></button>`).join('');
  }

  // 参考: 同じ町（丁目）への実走記録（従来の地雷DBの実走事例）。物件の評価は変えない
  function relatedBenchmarks(b) {
    // store は store.js の const（window には載らない）。アプリ内で変えた評価もここに反映される
    const db = (typeof store !== 'undefined' && store.getAvoidanceDatabase) ? store.getAvoidanceDatabase() : window.AVOIDANCE_DATABASE;
    if (!db || !db.benchmarks || !b.town) return [];
    const key = b.ward + b.town + (b.chome ? b.chome + '丁目' : '');
    return db.benchmarks.filter(bm => String(bm.drop || '').normalize('NFKC').includes(key));
  }

  const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };

  /** 詳細の中の「本人評価・本人メモ」編集欄（別画面に移らずここで完結） */
  function editorHtml(b) {
    const r = D.ratingInfo(b, DATA);
    const my = b.my || {};
    const draft = state.drafts[b.id] != null ? state.drafts[b.id] : (my.note || '');
    const len = D.noteLength(draft);
    const over = len > D.NOTE_MAX;
    const btns = D.RATINGS.map(code => {
      const lv = DATA.rating_levels[code];
      const on = r.code === code;
      return `<button type="button" class="dc-rbtn r-${code}${on ? ' on' : ''}" data-rate="${code}" aria-pressed="${on}">${lv.icon}<span>${esc(lv.label)}</span></button>`;
    }).join('');
    const status = r.verified ? `本人確認済み・${fmtDate(my.rating_updated_at)}更新` : `${r.icon} 未検証`;
    const clearBtn = r.verified
      ? `<button type="button" class="dc-unrate" data-unrate="1">${state.confirmClear === b.id ? 'もう一度押すと未検証に戻ります' : '未検証に戻す'}</button>` : '';
    const savedMsg = state.saved && state.saved.id === b.id ? `<span class="dc-saved" role="status">${esc(state.saved.msg)}</span>` : '';
    return `<div class="dc-edit">
      <div class="dc-edit-h"><b>本人評価</b><span>${esc(status)}</span></div>
      <div class="dc-rbtns" role="group" aria-label="本人評価">${btns}</div>
      <div class="dc-edit-sub">${clearBtn}${savedMsg}</div>
      <label class="dc-edit-h" for="dc-memo-${esc(b.id)}"><b>本人メモ</b><span class="dc-memo-count${over ? ' over' : ''}" data-count>${len}/${D.NOTE_MAX}文字</span></label>
      <div class="dc-memo">
        <input id="dc-memo-${esc(b.id)}" class="dc-memo-input" type="text" enterkeyhint="done" autocomplete="off" value="${esc(draft)}"
               placeholder="例: EVまで遠い・3階経由" aria-describedby="dc-memo-help-${esc(b.id)}">
        <button type="button" class="dc-memo-save" data-memo-save="1"${over ? ' disabled' : ''}>保存</button>
      </div>
      <div id="dc-memo-help-${esc(b.id)}" class="dc-memo-help">次の案件で役立つ短いメモ（1行・${D.NOTE_MAX}文字まで）。空にして保存すると削除</div>
    </div>`;
  }

  function detailHtml(b) {
    const rows = [
      ['正式名称', esc(b.name)],
      ['所在地', esc(b.address)],
      ['階数', b.floors != null ? esc(b.floors) + '階' : '—'],
      ['一般目安', b.excel_level ? esc(b.excel_level) + '<small>（Excel 一覧の一般的な目安。本人評価ではありません）</small>' : '—'],
      ['備考', esc(b.note || '—')],
      ['情報源', b.source_url ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(decodeURI(b.source_url).replace(/^https?:\/\//, '').slice(0, 48))}…</a>` : '—']
    ];
    const rel = relatedBenchmarks(b);
    const relHtml = rel.length ? `<div class="dc-rel"><b>参考：同じ町（${esc(b.town)}${b.chome ? esc(b.chome) + '丁目' : ''}）への実走記録</b>${rel.map(bm => {
      const st = ((window.AVOIDANCE_DATABASE || {}).evaluationStatuses || {})[bm.status] || {};
      return `<div>${esc(bm.date)} ${esc(bm.title)} ${esc(st.icon || '')}${esc(st.label || bm.status)}<small>${esc(bm.memo || '')}</small></div>`;
    }).join('')}</div>` : '';
    return `${editorHtml(b)}<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${relHtml}`;
  }

  function renderList() {
    const res = D.search(views(), { query: state.query, ward: state.ward });
    const wardLabel = state.ward === 'all' ? '' : (state.ward === 'other' ? 'その他' : state.ward);
    const q = state.query.trim();
    const label = [wardLabel, q ? `「${q}」` : ''].filter(Boolean).join(' ');
    if (!res.length) {
      $('dc-count').innerHTML = '';
      $('dc-list').innerHTML = `<li class="dc-none"><b>登録物件なし</b><span>${esc(label)}に一致する登録物件はありません。登録がないだけで、配達しやすいとは限りません。</span></li>`;
      return res;
    }
    $('dc-count').textContent = `${label ? label + ' ' : ''}${res.length}件${!q && state.ward === 'all' ? '（全件）' : ''}`;
    // 一覧カード: ①本人評価（確認済みなら最も目立たせる）②物件名 ③区・町・階数 ④本人メモ1行。Excel の一般目安は控えめ
    $('dc-list').innerHTML = res.map(b => {
      const r = D.ratingInfo(b, DATA);
      const open = state.openId === b.id;
      const memo = b.my && b.my.note;
      return `<li class="dc-item${open ? ' open' : ''}${r.verified ? ' rated r-' + r.code : ''}" data-id="${esc(b.id)}">
        <button type="button" class="dc-row" aria-expanded="${open}">
          <span class="dc-top"><span class="dc-rate r-${r.code || 'none'}">${r.icon} ${esc(r.label)}</span><span class="dc-more">${open ? '閉じる ▴' : '詳細・評価 ▾'}</span></span>
          <span class="dc-name">${esc(b.name)}</span>
          <span class="dc-sub">${esc(b.ward)} ${esc(b.town || '')}${b.chome ? esc(b.chome) + '丁目' : ''}${b.floors != null ? `<b>${esc(b.floors)}階</b>` : ''}</span>
          ${memo ? `<span class="dc-memo-line">「${esc(memo)}」</span>` : ''}
          <span class="dc-tags">${b.excel_level ? `<span class="dc-lvl">一般目安:${esc(b.excel_level)}</span>` : ''}${b.note ? `<span class="dc-note">${esc(b.note)}</span>` : ''}</span>
        </button>
        <div class="dc-detail"${open ? '' : ' hidden'}>${open ? detailHtml(b) : ''}</div>
      </li>`;
    }).join('');
    return res;
  }

  function render() {
    renderWards();
    return renderList();
  }

  /** 評価・メモを保存したら、そのカードの先頭（本人評価・物件名）を検索欄の真下に見せて反映を確認できるようにする */
  function showItemTop(id) {
    const el = document.querySelector(`.dc-item[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const sticky = document.querySelector('.dc-sticky');
    const top = sticky ? sticky.getBoundingClientRect().bottom : 0;
    const r = el.getBoundingClientRect();
    if (r.top < top + 4 || r.top > window.innerHeight * 0.6) window.scrollBy(0, r.top - top - 8);
  }

  function saveMemo(b) {
    const draft = state.drafts[b.id] != null ? state.drafts[b.id] : ((personal.get(b.id) || {}).note || '');
    if (D.noteLength(draft) > D.NOTE_MAX) {
      state.saved = { id: b.id, msg: `メモは${D.NOTE_MAX}文字までです` };
      renderList();
      return;
    }
    let ok = false;
    try { ok = personal.setNote(b, draft); } catch (e) { ok = false; }
    delete state.drafts[b.id];
    const empty = !String(draft).trim();
    state.saved = { id: b.id, msg: ok ? (empty ? 'メモを削除しました' : 'メモを保存しました') : '保存できませんでした（端末の保存領域を確認してください）' };
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // キーボードを閉じる
    renderList();
    showItemTop(b.id);
  }

  function setQuery(text) {
    const input = $('dc-query');
    if (input.value !== text) input.value = text; // 入力中（日本語変換・キーボード音声入力）の欄は書き換えない
    state.query = text;
    state.openId = null;
    $('dc-clear').hidden = !text;
    renderList();
  }

  // ---- 操作 ----
  function bind() {
    const input = $('dc-query');
    input.addEventListener('input', () => setQuery(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } }); // 検索キーでキーボードを閉じて結果を広く見せる
    $('dc-clear').addEventListener('click', () => { setQuery(''); input.focus(); });
    $('dc-wards').addEventListener('click', e => {
      const b = e.target.closest('[data-ward]'); if (!b || b.disabled) return;
      const w = b.dataset.ward;
      state.ward = (state.ward === w && w !== 'all') ? 'all' : w; // 同じ区をもう一度押すと解除
      state.openId = null;
      render();
    });
    $('dc-list').addEventListener('click', e => {
      const item = e.target.closest('.dc-item');
      const b = item && byId(item.dataset.id);
      // 本人評価（タップした時点で保存。初めて付けたら本人確認済み）
      const rate = e.target.closest('[data-rate]');
      if (rate && b) {
        const ok = personal.setRating(b, rate.dataset.rate);
        state.confirmClear = null;
        state.saved = { id: b.id, msg: ok ? `「${DATA.rating_levels[rate.dataset.rate].label}」で保存しました` : '保存できませんでした（端末の保存領域を確認してください）' };
        renderList();
        showItemTop(b.id);
        return;
      }
      // 未検証に戻す（誤操作防止で2回押し）
      if (e.target.closest('[data-unrate]') && b) {
        if (state.confirmClear !== b.id) {
          state.confirmClear = b.id;
          renderList();
          setTimeout(() => { if (state.confirmClear === b.id) { state.confirmClear = null; renderList(); } }, 4000);
          return;
        }
        const ok = personal.clearRating(b);
        state.confirmClear = null;
        state.saved = { id: b.id, msg: ok ? '未検証に戻しました' : '保存できませんでした' };
        renderList();
        showItemTop(b.id);
        return;
      }
      if (e.target.closest('[data-memo-save]') && b) { saveMemo(b); return; }
      const row = e.target.closest('.dc-row'); if (!row) return;
      const id = row.closest('.dc-item').dataset.id;
      state.openId = state.openId === id ? null : id;
      renderList();
      if (state.openId) {
        const el = document.querySelector(`.dc-item[data-id="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
    });
    // 本人メモの入力中: 文字数表示だけ更新（一覧を描き直さない＝入力が途切れない）
    $('dc-list').addEventListener('input', e => {
      const input = e.target.closest('.dc-memo-input'); if (!input) return;
      const id = input.closest('.dc-item').dataset.id;
      state.drafts[id] = input.value;
      const len = D.noteLength(input.value), over = len > D.NOTE_MAX;
      const box = input.closest('.dc-edit');
      const cnt = box.querySelector('[data-count]');
      cnt.textContent = `${len}/${D.NOTE_MAX}文字`;
      cnt.classList.toggle('over', over);
      box.querySelector('[data-memo-save]').disabled = over;
    });
    $('dc-list').addEventListener('keydown', e => {
      const input = e.target.closest('.dc-memo-input');
      if (input && e.key === 'Enter') { e.preventDefault(); const b = byId(input.closest('.dc-item').dataset.id); if (b) saveMemo(b); }
    });
    // 検索欄を固定表示する位置（上部ヘッダーの真下）
    const syncTop = () => {
      const h = document.querySelector('.top-header');
      document.documentElement.style.setProperty('--dc-top', (h ? h.offsetHeight : 0) + 'px');
    };
    syncTop();
    window.addEventListener('resize', syncTop);
  }

  function init() {
    if (!$('drop-check')) return;
    if (!D || !DATA || !Array.isArray(DATA.buildings)) {
      $('dc-list').innerHTML = '<li class="dc-none"><b>物件データを読み込めませんでした</b><span>ページを再読み込みしてください。</span></li>';
      return;
    }
    buildings = DATA.buildings.slice();
    personal = D.createPersonalStore(typeof localStorage !== 'undefined' ? localStorage : null);
    personal.load();
    bind();
    render();
    window.__dropCheck = { state, buildings, setQuery, render, personal }; // 自動テスト用
  }

  document.addEventListener('DOMContentLoaded', init);
})();
