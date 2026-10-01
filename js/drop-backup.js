/**
 * 地雷タブ: DROP個人データ（本人評価・本人メモ）の JSON バックアップ書き出し
 * - 読み取り専用: localStorage は getItem だけ。書き換え・削除・統合・正規化はしない
 * - Supabase とは通信しない（このファイルは supabase / fetch を一切使わない）
 * - 保存されている文字列をそのまま source_raw に、解釈した内容を source_data に入れる（壊れていても原文は残る）
 * - 復元（インポート）機能は持たない
 */
(function (root) {
  'use strict';

  const SOURCE_KEY = 'uber_drop_personal_v1';
  const BACKUP_SCHEMA = 'uber_drop_backup/1';
  const MEMO_MAX = 30;

  /** 保存領域から読む（読むだけ） */
  function readSource(storage) {
    let raw = null;
    let readError = null;
    try { raw = storage ? storage.getItem(SOURCE_KEY) : null; } catch (e) { readError = String(e && e.message || e); }
    let data = null;
    let parseError = null;
    if (raw != null) {
      try { data = JSON.parse(raw); } catch (e) { parseError = String(e && e.message || e); }
    }
    const items = data && typeof data === 'object' && data.items && typeof data.items === 'object' ? data.items : null;
    return { raw, data, present: raw != null, itemCount: items ? Object.keys(items).length : 0, parseError, readError };
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  /** 端末の現地時刻（+09:00 など時差付き） */
  function localIso(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  /** バックアップ本体（元データは source_data / source_raw に手を加えずに入れる） */
  function buildBackup(storage, opts) {
    const o = opts || {};
    const now = o.now || new Date();
    const src = readSource(storage);
    const memo = String(o.deviceMemo || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MEMO_MAX);
    return {
      backup_schema: BACKUP_SCHEMA,
      exported_at: localIso(now),
      exported_at_utc: now.toISOString(),
      app_version: o.appVersion || null,
      device_memo: memo || null,
      user_agent: o.userAgent || null,
      display_mode: o.displayMode || null,
      page_origin: o.origin || null,
      source_storage_key: SOURCE_KEY,
      source_present: src.present,
      source_item_count: src.itemCount,
      source_parse_error: src.parseError,
      source_read_error: src.readError,
      source_data: src.data,
      source_raw: src.raw
    };
  }

  /** ファイル名: uber_drop_backup[_端末メモ(英数字のみ)]_YYYY-MM-DD_HHMM.json */
  function fileName(date, deviceMemo) {
    const d = date instanceof Date ? date : new Date();
    const safe = String(deviceMemo || '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 20);
    return `uber_drop_backup${safe ? '_' + safe : ''}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  }

  function toJson(backup) { return JSON.stringify(backup, null, 2) + '\n'; }

  const api = { SOURCE_KEY, BACKUP_SCHEMA, MEMO_MAX, readSource, buildBackup, fileName, toJson };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.DropBackup = api;

  // ---- 画面（地雷タブ下部の「データ管理」。開いた時だけ件数を読む） ----
  const $ = id => document.getElementById(id);
  const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };
  const displayMode = () => {
    try {
      if (window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) return 'standalone';
    } catch (e) { /* noop */ }
    return 'browser';
  };

  function refresh() {
    const src = readSource(storage());
    $('dcb-count').textContent = src.present ? `${src.itemCount}件` : '0件（保存データなし）';
    $('dcb-warn').hidden = !(src.parseError || src.readError);
    $('dcb-warn').textContent = src.parseError || src.readError ? '保存データを解釈できませんでした（原文のまま書き出します）' : '';
  }

  function make() {
    const now = new Date();
    const memo = $('dcb-memo').value;
    const backup = buildBackup(storage(), {
      now, deviceMemo: memo, appVersion: window.UBER_LOG_APP_VERSION || null,
      userAgent: navigator.userAgent, displayMode: displayMode(), origin: location.origin
    });
    return { backup, name: fileName(now, memo), text: toJson(backup) };
  }

  function done(msg) { $('dcb-status').textContent = msg; }

  function download() {
    const { backup, name, text } = make();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    window.__dropBackupLast = { name, text }; // 自動テスト用（書き出した内容の確認）
    done(`書き出しました: ${name}（${backup.source_item_count}件）`);
  }

  async function share() {
    const { backup, name, text } = make();
    try {
      const file = new File([text], name, { type: 'application/json' });
      await navigator.share({ files: [file], title: name });
      done(`共有シートを開きました: ${name}（${backup.source_item_count}件）`);
    } catch (e) {
      if (e && e.name === 'AbortError') { done('キャンセルしました'); return; }
      done('共有できませんでした。「JSONを書き出す」を使ってください');
    }
  }

  function init() {
    const box = $('dc-backup');
    if (!box) return;
    box.addEventListener('toggle', () => { if (box.open) refresh(); });
    $('dcb-download').addEventListener('click', download);
    let canShare = false;
    try { canShare = !!(navigator.canShare && typeof File !== 'undefined' && navigator.canShare({ files: [new File(['{}'], 't.json', { type: 'application/json' })] })); } catch (e) { canShare = false; }
    $('dcb-share').hidden = !canShare;
    $('dcb-share').addEventListener('click', share);
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
