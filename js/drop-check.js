/**
 * 地雷タブ: DROP先照合ツール
 * Uber Driver の案件表示中に、DROP先のマンション名・町名・住所を数秒で照合する。
 * データ: window.UBER_DROP_BUILDINGS（data/uber_drop_buildings.js） 検索: window.DropCheck（js/drop-check-core.js）
 * 音声: Web Speech API（使える端末だけ）。使えなければ検索欄にフォーカスしてキーボードの音声入力🎤を案内する。
 */
(function () {
  'use strict';

  const D = window.DropCheck;
  const DATA = window.UBER_DROP_BUILDINGS;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { ward: 'all', query: '', openId: null };
  let buildings = [];

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

  function detailHtml(b) {
    const rows = [
      ['正式名称', esc(b.name)],
      ['所在地', esc(b.address)],
      ['階数', b.floors != null ? esc(b.floors) + '階' : '—'],
      ['Uber目安', b.excel_level ? esc(b.excel_level) + '<small>（一覧作成時の一般的な目安）</small>' : '—'],
      ['備考', esc(b.note || '—')],
      ['本人評価', `${D.ratingInfo(b, DATA.rating_levels).icon} ${esc(D.ratingInfo(b, DATA.rating_levels).label)}<small>（実体験の記録なし）</small>`],
      ['情報源', b.source_url ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(decodeURI(b.source_url).replace(/^https?:\/\//, '').slice(0, 48))}…</a>` : '—']
    ];
    const rel = relatedBenchmarks(b);
    const relHtml = rel.length ? `<div class="dc-rel"><b>参考：同じ町（${esc(b.town)}${b.chome ? esc(b.chome) + '丁目' : ''}）への実走記録</b>${rel.map(bm => {
      const st = ((window.AVOIDANCE_DATABASE || {}).evaluationStatuses || {})[bm.status] || {};
      return `<div>${esc(bm.date)} ${esc(bm.title)} ${esc(st.icon || '')}${esc(st.label || bm.status)}<small>${esc(bm.memo || '')}</small></div>`;
    }).join('')}</div>` : '';
    return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${relHtml}`;
  }

  function renderList() {
    const res = D.search(buildings, { query: state.query, ward: state.ward });
    const wardLabel = state.ward === 'all' ? '' : (state.ward === 'other' ? 'その他' : state.ward);
    const q = state.query.trim();
    const label = [wardLabel, q ? `「${q}」` : ''].filter(Boolean).join(' ');
    if (!res.length) {
      $('dc-count').innerHTML = '';
      $('dc-list').innerHTML = `<li class="dc-none"><b>登録物件なし</b><span>${esc(label)}に一致する登録物件はありません。登録がないだけで、配達しやすいとは限りません。</span></li>`;
      return res;
    }
    $('dc-count').textContent = `${label ? label + ' ' : ''}${res.length}件${!q && state.ward === 'all' ? '（全件）' : ''}`;
    $('dc-list').innerHTML = res.map(b => {
      const r = D.ratingInfo(b, DATA.rating_levels);
      const open = state.openId === b.id;
      return `<li class="dc-item${open ? ' open' : ''}" data-id="${esc(b.id)}">
        <button type="button" class="dc-row" aria-expanded="${open}">
          <span class="dc-name">${esc(b.name)}</span>
          <span class="dc-sub">${esc(b.ward)} ${esc(b.town || '')}${b.chome ? esc(b.chome) + '丁目' : ''}${b.floors != null ? `<b>${esc(b.floors)}階</b>` : ''}</span>
          <span class="dc-tags"><span class="dc-rate r-${r.code || 'none'}">${r.icon} ${esc(r.label)}</span>${b.excel_level ? `<span class="dc-lvl">目安:${esc(b.excel_level)}</span>` : ''}${b.note ? `<span class="dc-note">${esc(b.note)}</span>` : ''}<span class="dc-more">${open ? '閉じる ▴' : '詳細 ▾'}</span></span>
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

  function setQuery(text) {
    const input = $('dc-query');
    input.value = text;
    state.query = text;
    state.openId = null;
    $('dc-clear').hidden = !text;
    renderList();
  }

  // ---- 音声検索 ----
  let recog = null;
  let listening = false;
  let voiceBroken = false; // 権限拒否など → 以後はキーボード音声入力へ案内

  function voiceStatus(msg, ms) {
    const el = $('dc-voice');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(voiceStatus.t);
    if (ms) voiceStatus.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function keyboardDictationHint(reason) {
    const input = $('dc-query');
    input.focus();
    voiceStatus((reason ? reason + ' ' : '') + 'キーボードのマイク🎤ボタンで音声入力できます', 6000);
  }

  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // iPhone のホーム画面アプリでは SpeechRecognition が「存在するが動かない」ことが報告されているので、
  // 最初からキーボードの音声入力へ案内する（タップ操作の中で検索欄にフォーカス → キーボードが開く）
  function isIosStandalone() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    return ios && standalone;
  }

  function startVoice() {
    const SR = speechCtor();
    if (!SR || voiceBroken) { keyboardDictationHint(); return; }
    if (isIosStandalone()) { keyboardDictationHint('ホーム画面アプリでは音声検索を使えないため、'); return; }
    if (listening && recog) { try { recog.stop(); } catch (e) { /* noop */ } return; }
    try {
      recog = new SR();
      recog.lang = 'ja-JP';
      recog.interimResults = true;
      recog.continuous = false;
      recog.maxAlternatives = 1;
    } catch (e) { voiceBroken = true; keyboardDictationHint('この端末では音声検索を使えません。'); return; }
    let started = false; // この回の聞き取りが始まったか（終わった後の listening=false と区別する）
    recog.onstart = () => { started = true; listening = true; $('dc-mic').classList.add('on'); voiceStatus('🎙️ 聞き取り中…「ライズ」「西区 ライズ」のように話してください'); };
    recog.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      text = text.replace(/[。、．.]+$/g, '').trim();
      if (text) setQuery(text);
    };
    recog.onerror = e => {
      const code = e && e.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') { voiceBroken = true; keyboardDictationHint('マイク・音声認識が許可されていません。'); }
      else if (code === 'no-speech') voiceStatus('聞き取れませんでした。もう一度🎙️を押してください', 4000);
      else if (code === 'aborted') voiceStatus('', 0);
      else keyboardDictationHint('音声検索を開始できませんでした。');
    };
    recog.onend = () => {
      listening = false;
      $('dc-mic').classList.remove('on');
      if (!$('dc-voice').textContent.startsWith('聞き取れ') && !$('dc-voice').textContent.includes('キーボード')) voiceStatus('', 0);
    };
    try { recog.start(); } catch (e) { voiceBroken = true; keyboardDictationHint('音声検索を開始できませんでした。'); return; }
    // 反応しない環境（API はあるが何も起きない）で待たせない: 2秒以内に聞き取りが始まらなければ止めて案内
    const r = recog;
    setTimeout(() => {
      if (recog === r && !started) {
        try { r.abort(); } catch (e) { /* noop */ }
        voiceBroken = true;
        voiceStatus('音声検索が反応しませんでした。検索欄をタップしてキーボードのマイク🎤で入力してください', 7000);
      }
    }, 2000);
  }

  // ---- 操作 ----
  function bind() {
    const input = $('dc-query');
    input.addEventListener('input', () => setQuery(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } }); // 検索キーでキーボードを閉じて結果を広く見せる
    $('dc-clear').addEventListener('click', () => { setQuery(''); input.focus(); });
    $('dc-mic').addEventListener('click', startVoice);
    $('dc-wards').addEventListener('click', e => {
      const b = e.target.closest('[data-ward]'); if (!b || b.disabled) return;
      const w = b.dataset.ward;
      state.ward = (state.ward === w && w !== 'all') ? 'all' : w; // 同じ区をもう一度押すと解除
      state.openId = null;
      render();
    });
    $('dc-list').addEventListener('click', e => {
      const row = e.target.closest('.dc-row'); if (!row) return;
      const id = row.closest('.dc-item').dataset.id;
      state.openId = state.openId === id ? null : id;
      renderList();
      if (state.openId) {
        const el = document.querySelector(`.dc-item[data-id="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
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
    if (!speechCtor()) $('dc-mic').setAttribute('aria-label', '音声入力（キーボードのマイクを使う）');
    bind();
    render();
    window.__dropCheck = { state, buildings, setQuery, render }; // 自動テスト用
  }

  document.addEventListener('DOMContentLoaded', init);
})();
