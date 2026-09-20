/**
 * UBER LOG V1.1 - Main Application Controller
 * 
 * イベントリスナーの登録、タブ遷移、各機能の協調動作を統括
 */

// タップ時のハプティックフィードバック
function triggerHaptic() {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      return;
    }
    try {
      navigator.vibrate(12);
    } catch (e) {}
  }
}

// 初期化処理
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initTodayActions();
  initSessionActions();
  initAvoidanceToggle();
  initCollapsibleSections();
  initDashboardInputs();
  initModalActions();
  initSettingsActions();
  initCloudSyncActions();
  initSalesAndExpensesActions();
  initAppUpdateChecker();

  // 初回描画
  ui.refreshAll();

  // 稼働中なら1分ごとに稼働時間・時給を自動更新
  setInterval(() => {
    const log = store.getDailyLog(ui.currentDate);
    const sessions = log.workSessions || [];
    const hasActiveSession = sessions.some(s => !s.end);
    if (hasActiveSession || (log.workStartedAt && !log.workEndedAt)) {
      ui.renderTodayView();
    }
  }, 60000);
});

// 1. タブナビゲーション
function initTabs() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      navBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(`tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      // タブ切り替え時の再描画
      if (targetTab === 'today') ui.renderTodayView();
      if (targetTab === 'history') ui.renderHistoryView();
      if (targetTab === 'analytics') ui.renderAnalyticsView();
      if (targetTab === 'avoidance') ui.renderAvoidanceView();

      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  });

  // ヘッダー設定アイコンボタンで設定モーダルを開く
  const openSettingsBtn = document.getElementById('btn-open-settings');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.openSettingsModal();
    });
  }

  // 設定モーダルの閉じるボタン
  const closeSettingsBtn = document.getElementById('btn-close-settings-modal');
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
      ui.closeSettingsModal();
    });
  }

  // 設定モーダルのオーバーレイ背景タップで閉じる
  const settingsOverlay = document.getElementById('settings-modal-overlay');
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) {
        ui.closeSettingsModal();
      }
    });
  }
}

// 2. 「今日」のメインアクション（1タップ記録、取消、稼働開始/終了）
function initTodayActions() {
  // 超特大「＋ 配達1件完了」ボタン
  const bigDeliveryBtn = document.getElementById('btn-add-delivery');
  if (bigDeliveryBtn) {
    bigDeliveryBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerHaptic();

      const timeNow = getCurrentTimeString();
      const { delivery } = store.addDelivery(ui.currentDate, timeNow);

      ui.showToast(`${delivery.index}件目を記録しました　${delivery.completedAt}`);
      ui.renderTodayView();
    });
  }

  // 「直前の記録を取消」ボタン
  const undoBtn = document.getElementById('btn-undo-delivery');
  if (undoBtn) {
    undoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerHaptic();

      const result = store.undoLastDelivery(ui.currentDate);
      if (result && result.removed) {
        ui.showToast(`直前の配達（#${result.removed.index}）を取り消しました`, true);
        ui.renderTodayView();
      }
    });
  }

  // 稼働制御ボタンコンテナ（イベント委譲：開始・休憩・再開・完全終了）
  const workControlContainer = document.getElementById('work-control-container');
  if (workControlContainer) {
    workControlContainer.addEventListener('click', (e) => {
      const startBtn = e.target.closest('#btn-work-start');
      const pauseBtn = e.target.closest('#btn-work-pause');
      const resumeBtn = e.target.closest('#btn-work-resume');
      const finishBtn = e.target.closest('#btn-work-finish');
      const toggleBtn = e.target.closest('#btn-work-toggle');

      if (startBtn) {
        e.preventDefault();
        triggerHaptic();
        store.startWorkSession(ui.currentDate);
        ui.showToast('稼働を開始しました（第1部）');
        ui.renderTodayView();
      } else if (pauseBtn) {
        e.preventDefault();
        triggerHaptic();
        store.endWorkSession(ui.currentDate);
        ui.showToast('休憩に入りました');
        ui.renderTodayView();
      } else if (resumeBtn) {
        e.preventDefault();
        triggerHaptic();
        store.startWorkSession(ui.currentDate);
        const log = store.getDailyLog(ui.currentDate);
        ui.showToast(`稼働を再開しました（第${(log.workSessions || []).length}部）`);
        ui.renderTodayView();
      } else if (finishBtn) {
        e.preventDefault();
        triggerHaptic();
        store.endWorkSession(ui.currentDate);
        ui.showToast('本日の稼働を終了しました');
        ui.renderTodayView();
      } else if (toggleBtn) {
        e.preventDefault();
        triggerHaptic();
        const log = store.getDailyLog(ui.currentDate);
        const ongoing = (log.workSessions || []).find(s => !s.end);
        if (ongoing || (log.workStartedAt && !log.workEndedAt)) {
          store.endWorkSession(ui.currentDate);
          ui.showToast('稼働を終了しました');
        } else {
          store.startWorkSession(ui.currentDate);
          ui.showToast('稼働を開始しました');
        }
        ui.renderTodayView();
      }
    });
  }
}

// 2b. 稼働セッション管理アクション（一覧折りたたみ、追加・編集・削除モーダル）
function initSessionActions() {
  // セッション一覧折りたたみ
  const toggleBtn = document.getElementById('btn-toggle-today-sessions');
  const bodyEl = document.getElementById('today-sessions-body');
  const iconEl = document.getElementById('today-sessions-expand-icon');

  if (toggleBtn && bodyEl && iconEl) {
    toggleBtn.addEventListener('click', () => {
      triggerHaptic();
      const isHidden = bodyEl.style.display === 'none';
      bodyEl.style.display = isHidden ? 'block' : 'none';
      iconEl.textContent = isHidden ? '▲' : '▼';
    });
  }

  // セッション追加ボタン
  const addBtn = document.getElementById('btn-open-session-modal');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.openSessionModal(null);
    });
  }

  // モーダル閉じるボタン
  const closeBtn = document.getElementById('btn-close-session-modal');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      ui.closeSessionModal();
    });
  }

  // モーダルオーバーレイタップ
  const overlay = document.getElementById('session-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) ui.closeSessionModal();
    });
  }

  // モーダル保存ボタン
  const saveBtn = document.getElementById('btn-session-modal-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerHaptic();

      const id = document.getElementById('modal-session-id').value;
      const start = document.getElementById('modal-session-start').value;
      const end = document.getElementById('modal-session-end').value || null;
      const isApprox = document.getElementById('modal-session-approx').checked;
      const note = document.getElementById('modal-session-note').value.trim();

      if (!start) {
        alert('開始時刻を選択してください');
        return;
      }

      if (id) {
        store.updateWorkSession(ui.currentDate, id, {
          start,
          end,
          isApproximate: isApprox,
          note
        });
        ui.showToast('稼働セッションを更新しました');
      } else {
        store.addWorkSession(ui.currentDate, {
          start,
          end,
          isApproximate: isApprox,
          note
        });
        ui.showToast('稼働セッションを追加しました');
      }

      ui.closeSessionModal();
      ui.renderTodayView();
    });
  }

  // モーダル削除ボタン
  const deleteBtn = document.getElementById('btn-session-modal-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerHaptic();

      const id = document.getElementById('modal-session-id').value;
      if (!id) return;

      if (confirm('この稼働セッションを削除しますか？')) {
        store.deleteWorkSession(ui.currentDate, id);
        ui.closeSessionModal();
        ui.showToast('稼働セッションを削除しました', true);
        ui.renderTodayView();
      }
    });
  }
}

// 3. 原則回避ルールのトグル表示
function initAvoidanceToggle() {
  const toggleBtn = document.getElementById('btn-toggle-avoidance');
  const bodyEl = document.getElementById('avoidance-body');
  const iconEl = document.getElementById('avoidance-expand-icon');

  if (toggleBtn && bodyEl && iconEl) {
    toggleBtn.addEventListener('click', () => {
      const isHidden = bodyEl.style.display === 'none';
      bodyEl.style.display = isHidden ? 'block' : 'none';
      iconEl.textContent = isHidden ? '▲' : '▼';
    });
  }
}

// 3b. クエスト明細・配達明細の折りたたみトグル表示
function initCollapsibleSections() {
  // クエスト明細折りたたみ
  const questToggle = document.getElementById('btn-toggle-today-quests');
  const questBody = document.getElementById('today-quests-body');
  const questIcon = document.getElementById('today-quests-expand-icon');

  if (questToggle && questBody && questIcon) {
    questToggle.addEventListener('click', () => {
      triggerHaptic();
      const isHidden = questBody.style.display === 'none';
      questBody.style.display = isHidden ? 'block' : 'none';
      questIcon.textContent = isHidden ? '▲' : '▼';
    });
  }

  // 配達明細折りたたみ
  const delivToggle = document.getElementById('btn-toggle-today-deliveries');
  const delivBody = document.getElementById('today-deliveries-body');
  const delivIcon = document.getElementById('today-deliveries-expand-icon');

  if (delivToggle && delivBody && delivIcon) {
    delivToggle.addEventListener('click', () => {
      triggerHaptic();
      const isHidden = delivBody.style.display === 'none';
      delivBody.style.display = isHidden ? 'block' : 'none';
      delivIcon.textContent = isHidden ? '▲' : '▼';
    });
  }

  // 当日経費折りたたみ
  const expToggle = document.getElementById('btn-toggle-today-expenses');
  const expBody = document.getElementById('today-expenses-body');
  const expIcon = document.getElementById('today-expenses-expand-icon');

  if (expToggle && expBody && expIcon) {
    expToggle.addEventListener('click', () => {
      triggerHaptic();
      const isHidden = expBody.style.display === 'none';
      expBody.style.display = isHidden ? 'block' : 'none';
      expIcon.textContent = isHidden ? '▲' : '▼';
    });
  }

  // 今日の配達明細ドロワートグル
  const histToggle = document.getElementById('btn-toggle-today-history');
  const histDrawer = document.getElementById('today-history-drawer');
  const histIcon = document.getElementById('today-history-toggle-icon');

  if (histToggle && histDrawer && histIcon) {
    histToggle.addEventListener('click', () => {
      triggerHaptic();
      const isHidden = histDrawer.style.display === 'none';
      histDrawer.style.display = isHidden ? 'block' : 'none';
      histIcon.textContent = isHidden ? '▲' : '▼';
    });
  }
}

// 4. 今日のダッシュボード（総走行距離の手動入力）
function initDashboardInputs() {
  const distInput = document.getElementById('input-total-dist');

  if (distInput) {
    distInput.addEventListener('input', () => {
      store.updateDailyNumbers(ui.currentDate, {
        totalDistanceKm: distInput.value
      });
      ui.renderTodayView();
    });
  }
}

// 5. 配達詳細モーダルのアクション
function initModalActions() {
  const closeBtn = document.getElementById('btn-close-modal');
  const overlay = document.getElementById('delivery-modal-overlay');
  const saveBtn = document.getElementById('btn-modal-save');
  const deleteBtn = document.getElementById('btn-modal-delete');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => ui.closeDeliveryModal());
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) ui.closeDeliveryModal();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!ui.selectedDelivery) return;

      const timeVal = document.getElementById('modal-time').value.trim();
      const restaurantVal = document.getElementById('modal-restaurant').value.trim();
      const areaVal = document.getElementById('modal-area').value.trim();
      const feeVal = document.getElementById('modal-fee').value.trim();
      const distanceVal = document.getElementById('modal-distance').value.trim();
      const durationVal = document.getElementById('modal-duration').value.trim();
      const memoVal = document.getElementById('modal-memo').value.trim();

      store.updateDelivery(ui.currentDate, ui.selectedDelivery.id, {
        completedAt: timeVal || ui.selectedDelivery.completedAt,
        restaurant: restaurantVal,
        area: areaVal,
        fee: feeVal === '' ? null : Number(feeVal),
        distanceKm: distanceVal === '' ? null : Number(distanceVal),
        durationStr: durationVal,
        memo: memoVal
      });

      ui.closeDeliveryModal();
      ui.showToast('配達詳細を保存しました');
      ui.renderTodayView();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!ui.selectedDelivery) return;

      if (confirm(`配達 #${ui.selectedDelivery.index} を削除しますか？`)) {
        store.deleteDelivery(ui.currentDate, ui.selectedDelivery.id);
        ui.closeDeliveryModal();
        ui.showToast('配達を削除しました', true);
        ui.renderTodayView();
      }
    });
  }
}

// 6. 設定画面のアクション
function initSettingsActions() {
  // 確定データ（2026-09-14〜09-17）復元
  const reloadBtn = document.getElementById('btn-reload-confirmed');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      store.reloadConfirmedSeedData();
      ui.showToast('確定データ（9/14〜9/17）を復元しました');
      ui.refreshAll();
    });
  }

  // 予備・復旧用：最新版への強制再読込ボタン（キャッシュ＆SW強制クリア）
  const forceReloadBtn = document.getElementById('btn-force-reload');
  if (forceReloadBtn) {
    forceReloadBtn.addEventListener('click', async () => {
      triggerHaptic();
      ui.showToast('最新版へ更新中...');

      try {
        // 1. Service Workerの強制更新
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.update();
            if (reg.waiting) {
              reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
          }
        }
        // 2. 古いCacheStorageを全削除（※localStorageの本人入力データは一切消しません）
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map(name => caches.delete(name)));
        }
        // 3. セッションストレージ初期化
        sessionStorage.clear();
      } catch (e) {
        console.warn('Cache clear error:', e);
      }

      setTimeout(() => {
        window.location.reload(true);
      }, 300);
    });
  }

  // JSONバックアップ（エクスポート）
  const exportBtn = document.getElementById('btn-export-data');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const json = store.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `uber_log_backup_${getTodayDateString()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      ui.showToast('バックアップファイルを書き出しました');
    });
  }

  // JSONインポート
  const importInput = document.getElementById('input-import-file');
  if (importInput) {
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const result = store.importJSON(event.target.result);
        if (result.success) {
          ui.showToast('バックアップから復元しました');
          ui.refreshAll();
        } else {
          alert('データの復元に失敗しました: ' + result.error);
        }
      };
      reader.readAsText(file);
      importInput.value = '';
    });
  }

  // データ全削除
  const clearAllBtn = document.getElementById('btn-clear-all');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      if (confirm('【警告】すべての配達ログを消去します。本当によろしいですか？')) {
        store.clearAllData();
        ui.showToast('全データを初期化しました', true);
        ui.refreshAll();
      }
    });
  }
}

// 6.5. アプリ更新チェック機能（フォアグラウンド復帰時・定期チェック）
function initAppUpdateChecker() {
  const checkVersion = async () => {
    if (!navigator.onLine || !window.location.protocol.startsWith('http')) return;
    try {
      // タイムスタンプパラメータでCDN・ブラウザキャッシュを確実にバイパス
      const res = await fetch('version.json?_cb=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();
      const currentVer = window.UBER_LOG_APP_VERSION || '20260920_v15';
      if (data && data.version && data.version !== currentVer) {
        console.log(`[PWA] Newer version detected: ${data.version} (current: ${currentVer})`);

        // 同一バージョンでの再読込ループ防止ガード（sessionStorage）
        const reloadKey = 'uber_log_reload_attempt_' + data.version;
        if (sessionStorage.getItem(reloadKey)) {
          return;
        }
        sessionStorage.setItem(reloadKey, '1');

        // Service Workerの強制更新をトリガー
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
        }

        // 自動再読込を実行
        window.location.reload();
      }
    } catch (e) {
      // オフライン・通信エラー時は静かに無視（ユーザー操作を妨げない）
    }
  };

  // 1. 初回起動時のチェック（安定後に実行）
  setTimeout(checkVersion, 1500);

  // 2. iOSでバックグラウンドからフォアグラウンドへ復帰した時にチェック
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkVersion();
    }
  });

  // 3. オンライン復帰時のチェック
  window.addEventListener('online', checkVersion);
}

// 7. クラウド同期（Supabase）アクション
function initCloudSyncActions() {
  const syncBadge = document.getElementById('sync-status-badge');
  const syncIcon = document.getElementById('sync-status-icon');
  const syncText = document.getElementById('sync-status-text');

  function updateSyncBadge(status, message) {
    if (!syncBadge || !syncIcon || !syncText) return;
    syncBadge.className = 'sync-status-badge';

    switch (status) {
      case 'SYNCED':
        syncBadge.classList.add('synced');
        syncIcon.textContent = '☁️';
        syncText.textContent = '同期済';
        syncBadge.title = message || '同期完了';
        break;
      case 'SYNCING':
        syncBadge.classList.add('syncing');
        syncIcon.textContent = '🔄';
        syncText.textContent = '同期中';
        syncBadge.title = message || '同期中...';
        break;
      case 'OFFLINE':
        syncBadge.classList.add('offline');
        syncIcon.textContent = '📡';
        syncText.textContent = '端末保存';
        syncBadge.title = message || 'オフライン（端末内保存）';
        break;
      case 'ERROR':
        syncBadge.classList.add('error');
        syncIcon.textContent = '⚠️';
        syncText.textContent = '同期待機';
        syncBadge.title = message || '通信保留中';
        break;
      case 'NOT_LOGGED_IN':
        syncBadge.classList.add('offline');
        syncIcon.textContent = '☁️';
        syncText.textContent = '未ログイン';
        syncBadge.title = '未ログイン（端末単体稼働中）';
        break;
      default:
        syncIcon.textContent = '☁️';
        syncText.textContent = '未設定';
        syncBadge.title = 'Supabase未設定';
    }

    updateSettingsSyncUI();
  }

  if (window.cloudSync) {
    window.cloudSync.onStatusChange((status, message) => {
      updateSyncBadge(status, message);
    });
  }

  // ヘッダーの同期バッジタップで設定モーダルを開く
  if (syncBadge) {
    syncBadge.addEventListener('click', () => {
      triggerHaptic();
      ui.openSettingsModal();
    });
  }

  // 設定モーダル内のUI表示更新
  function updateSettingsSyncUI() {
    const desc = document.getElementById('settings-sync-status-desc');
    const loginBtn = document.getElementById('btn-open-login-modal');
    const logoutBtn = document.getElementById('btn-logout-cloud');
    const manualSyncRow = document.getElementById('settings-manual-sync-row');
    const migrationRow = document.getElementById('settings-migration-row');
    const configDesc = document.getElementById('settings-supabase-config-desc');

    const sm = window.supabaseManager;
    const isConfigured = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.isConfigured();

    if (configDesc) {
      if (isConfigured) {
        const url = window.SUPABASE_CONFIG.getUrl();
        const host = url.replace(/^https?:\/\//, '').split('.')[0];
        configDesc.textContent = `接続済 (${host})`;
      } else {
        configDesc.textContent = 'URL / Publishable key 未設定';
      }
    }

    if (sm && sm.isLoggedIn()) {
      if (desc) desc.textContent = `ログイン中 (${sm.getUserEmail()})`;
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
      if (manualSyncRow) manualSyncRow.style.display = 'flex';

      const migrationDone = localStorage.getItem('uber_cloud_migration_completed') === 'true';
      if (migrationRow) {
        migrationRow.style.display = migrationDone ? 'none' : 'flex';
      }
    } else {
      if (desc) desc.textContent = isConfigured ? '未ログイン（端末単体稼働中）' : 'Supabase接続情報未設定';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (manualSyncRow) manualSyncRow.style.display = 'none';
      if (migrationRow) migrationRow.style.display = 'none';
    }
  }

  // ログインモーダル開閉
  const openLoginBtn = document.getElementById('btn-open-login-modal');
  const closeLoginBtn = document.getElementById('btn-close-login-modal');
  const cancelLoginBtn = document.getElementById('btn-cancel-login');
  const loginModalOverlay = document.getElementById('login-modal-overlay');
  const loginForm = document.getElementById('login-form');
  const loginErrorMsg = document.getElementById('login-error-msg');

  function openLoginModal() {
    if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.isConfigured()) {
      alert('先に「設定変更」から Project URL と Publishable key を登録してください。');
      openConfigModal();
      return;
    }
    if (loginErrorMsg) loginErrorMsg.style.display = 'none';
    if (loginModalOverlay) loginModalOverlay.classList.add('active');
  }

  function closeLoginModal() {
    if (loginModalOverlay) loginModalOverlay.classList.remove('active');
  }

  if (openLoginBtn) openLoginBtn.addEventListener('click', openLoginModal);
  if (closeLoginBtn) closeLoginBtn.addEventListener('click', closeLoginModal);
  if (cancelLoginBtn) cancelLoginBtn.addEventListener('click', closeLoginModal);
  if (loginModalOverlay) {
    loginModalOverlay.addEventListener('click', (e) => {
      if (e.target === loginModalOverlay) closeLoginModal();
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const submitBtn = document.getElementById('btn-submit-login');

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '認証中...';
      }
      if (loginErrorMsg) loginErrorMsg.style.display = 'none';

      try {
        await window.supabaseManager.login(email, password);
        closeLoginModal();
        ui.showToast('Supabaseにログインしました');
        updateSettingsSyncUI();
        if (window.cloudSync) {
          window.cloudSync.pullAndSync();
        }
      } catch (err) {
        if (loginErrorMsg) {
          loginErrorMsg.textContent = err.message || 'ログインに失敗しました';
          loginErrorMsg.style.display = 'block';
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'ログイン';
        }
      }
    });
  }

  // ログアウト処理（端末データは保持）
  const logoutBtn = document.getElementById('btn-logout-cloud');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (confirm('クラウドからログアウトしますか？\n（端末内の配達履歴データは削除されません）')) {
        await window.supabaseManager.logout();
        ui.showToast('ログアウトしました（端末単体モード）');
        updateSettingsSyncUI();
      }
    });
  }

  // 手動同期ボタン
  const manualSyncBtn = document.getElementById('btn-manual-sync');
  if (manualSyncBtn) {
    manualSyncBtn.addEventListener('click', async () => {
      if (window.cloudSync) {
        ui.showToast('同期を開始します...');
        await window.cloudSync.pullAndSync();
      }
    });
  }

  // 初回移行ボタン
  const migrateBtn = document.getElementById('btn-migrate-initial');
  if (migrateBtn) {
    migrateBtn.addEventListener('click', async () => {
      if (confirm('ローカルの確定データ（9/14〜9/17: 30件配達・12クエスト・正本17,080円）をSupabaseへ初期アップロードしますか？\n\n※事前整合性チェックと事後突合が行われます。')) {
        migrateBtn.disabled = true;
        migrateBtn.textContent = '移行処理中...';
        try {
          const res = await window.cloudSync.migrateLocalToCloud();
          ui.showToast(`確定データ移行完了！(正本¥${res.metrics.officialTotal.toLocaleString()}完全一致)`);
          updateSettingsSyncUI();
        } catch (err) {
          alert(`移行エラー: ${err.message}`);
        } finally {
          migrateBtn.disabled = false;
          migrateBtn.textContent = '移行実行';
        }
      }
    });
  }

  // 接続先設定モーダル開閉
  const openConfigBtn = document.getElementById('btn-open-config-modal');
  const closeConfigBtn = document.getElementById('btn-close-config-modal');
  const cancelConfigBtn = document.getElementById('btn-cancel-config');
  const configModalOverlay = document.getElementById('config-modal-overlay');
  const configForm = document.getElementById('config-form');

  function openConfigModal() {
    const urlInput = document.getElementById('input-supabase-url');
    const keyInput = document.getElementById('input-supabase-key');
    if (urlInput && window.SUPABASE_CONFIG) urlInput.value = window.SUPABASE_CONFIG.getUrl() || '';
    if (keyInput && window.SUPABASE_CONFIG) keyInput.value = window.SUPABASE_CONFIG.getAnonKey() || '';
    if (configModalOverlay) configModalOverlay.classList.add('active');
  }

  function closeConfigModal() {
    if (configModalOverlay) configModalOverlay.classList.remove('active');
  }

  if (openConfigBtn) openConfigBtn.addEventListener('click', openConfigModal);
  if (closeConfigBtn) closeConfigBtn.addEventListener('click', closeConfigModal);
  if (cancelConfigBtn) cancelConfigBtn.addEventListener('click', closeConfigModal);
  if (configModalOverlay) {
    configModalOverlay.addEventListener('click', (e) => {
      if (e.target === configModalOverlay) closeConfigModal();
    });
  }

  if (configForm) {
    configForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = document.getElementById('input-supabase-url').value;
      const key = document.getElementById('input-supabase-key').value;

      if (!url || !key) {
        alert('URLとPublishable keyを入力してください');
        return;
      }

      window.SUPABASE_CONFIG.update(url, key);
      const inited = window.supabaseManager.init();
      closeConfigModal();
      ui.showToast(inited ? 'Supabase接続設定を保存しました' : '接続情報を保存しました');
      updateSettingsSyncUI();
    });
  }

  // 初期ステータス反映
  updateSettingsSyncUI();
}

// 8. 売上取込＆当日変動経費のアクション
function initSalesAndExpensesActions() {
  // 1. 売上取込モーダル関連
  const openSalesBtn = document.getElementById('btn-open-sales-import');
  if (openSalesBtn) {
    openSalesBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.openSalesImportModal();
    });
  }

  const openSalesLink = document.getElementById('btn-open-sales-modal-link');
  if (openSalesLink) {
    openSalesLink.addEventListener('click', () => {
      triggerHaptic();
      ui.openSalesImportModal();
    });
  }

  const openSalesUnsettled = document.getElementById('btn-open-sales-modal-from-unsettled');
  if (openSalesUnsettled) {
    openSalesUnsettled.addEventListener('click', () => {
      triggerHaptic();
      ui.openSalesImportModal();
    });
  }

  const openSalesFromSettings = document.getElementById('btn-open-sales-modal-from-settings');
  if (openSalesFromSettings) {
    openSalesFromSettings.addEventListener('click', () => {
      triggerHaptic();
      ui.closeSettingsModal();
      ui.openSalesImportModal();
    });
  }

  const closeSalesBtn = document.getElementById('btn-close-sales-import-modal');
  if (closeSalesBtn) {
    closeSalesBtn.addEventListener('click', () => ui.closeSalesImportModal());
  }

  const cancelSalesBtn = document.getElementById('btn-cancel-import-sales');
  if (cancelSalesBtn) {
    cancelSalesBtn.addEventListener('click', () => ui.closeSalesImportModal());
  }

  const salesOverlay = document.getElementById('sales-import-modal-overlay');
  if (salesOverlay) {
    salesOverlay.addEventListener('click', (e) => {
      if (e.target === salesOverlay) ui.closeSalesImportModal();
    });
  }

  const parseSalesBtn = document.getElementById('btn-parse-sales-text');
  if (parseSalesBtn) {
    parseSalesBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.handleParseSalesText();
    });
  }

  const confirmSalesBtn = document.getElementById('btn-confirm-import-sales');
  if (confirmSalesBtn) {
    confirmSalesBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.confirmImportSales();
    });
  }

  // 2. 経費管理モーダル関連
  const openExpBtn = document.getElementById('btn-open-expenses-modal');
  if (openExpBtn) {
    openExpBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.openExpensesModal();
    });
  }

  const openExpBtn2 = document.getElementById('btn-open-expense-modal-from-list');
  if (openExpBtn2) {
    openExpBtn2.addEventListener('click', () => {
      triggerHaptic();
      ui.openExpensesModal();
    });
  }

  const closeExpBtn = document.getElementById('btn-close-expenses-modal');
  if (closeExpBtn) {
    closeExpBtn.addEventListener('click', () => ui.closeExpensesModal());
  }

  const closeExpBottomBtn = document.getElementById('btn-close-expenses-bottom');
  if (closeExpBottomBtn) {
    closeExpBottomBtn.addEventListener('click', () => ui.closeExpensesModal());
  }

  const expOverlay = document.getElementById('expenses-modal-overlay');
  if (expOverlay) {
    expOverlay.addEventListener('click', (e) => {
      if (e.target === expOverlay) ui.closeExpensesModal();
    });
  }

  const addExpItemBtn = document.getElementById('btn-add-expense-item');
  if (addExpItemBtn) {
    addExpItemBtn.addEventListener('click', () => {
      triggerHaptic();
      ui.handleAddExpenseItem();
    });
  }

  const vehicleSelect = document.getElementById('expense-vehicle-type');
  if (vehicleSelect) {
    vehicleSelect.addEventListener('change', () => {
      store.updateVehicleType(ui.currentDate, vehicleSelect.value);
      ui.renderTodayView();
      ui.showToast(`移動手段を「${vehicleSelect.value}」に更新しました`);
    });
  }
}


