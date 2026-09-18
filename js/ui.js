/**
 * UBER LOG V1.1 - UI Rendering Module
 * 
 * 画面描画、DOMイベントバインド、トースト通知、モーダル制御を担当
 */

class UI {
  constructor() {
    this.currentDate = getTodayDateString();
    this.selectedDelivery = null; // 編集中の配達
    this.timeOptionsInitialized = false;
  }

  // トースト通知を表示
  showToast(message, isUndo = false, duration = 1800) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    container.innerHTML = '';

    const toast = document.createElement('div');
    toast.className = `toast ${isUndo ? 'toast-undo' : ''}`;
    toast.innerHTML = `
      <span class="toast-icon">${isUndo ? '↩' : '✓'}</span>
      <span class="toast-text">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  // 稼働時刻選択肢（30分刻み）を動的生成
  populateSessionTimeOptions() {
    const startSelect = document.getElementById('modal-session-start');
    const endSelect = document.getElementById('modal-session-end');
    if (!startSelect || !endSelect) return;

    const step = typeof WORK_TIME_STEP_MINUTES !== 'undefined' ? WORK_TIME_STEP_MINUTES : 30;
    const options = typeof getTimeOptions === 'function' ? getTimeOptions(step) : [];

    startSelect.innerHTML = options.map(t => `<option value="${t}">${t}</option>`).join('');
    endSelect.innerHTML = `<option value="">未終了（稼働中・未確定）</option>` +
      options.map(t => `<option value="${t}">${t}</option>`).join('');

    this.timeOptionsInitialized = true;
  }

  // 稼働セッション追加・編集モーダルを開く
  openSessionModal(sessionId = null) {
    if (!this.timeOptionsInitialized) {
      this.populateSessionTimeOptions();
    }

    const log = store.getDailyLog(this.currentDate);
    const sessions = log.workSessions || [];
    const session = sessionId ? sessions.find(s => s.id === sessionId) : null;

    const titleEl = document.getElementById('session-modal-title');
    const idInput = document.getElementById('modal-session-id');
    const startSelect = document.getElementById('modal-session-start');
    const endSelect = document.getElementById('modal-session-end');
    const approxCheckbox = document.getElementById('modal-session-approx');
    const noteInput = document.getElementById('modal-session-note');
    const deleteBtn = document.getElementById('btn-session-modal-delete');

    if (session) {
      if (titleEl) titleEl.textContent = '稼働セッションの編集';
      if (idInput) idInput.value = session.id;
      if (startSelect) startSelect.value = session.start ? session.start.slice(0, 5) : '09:00';
      if (endSelect) endSelect.value = session.end ? session.end.slice(0, 5) : '';
      if (approxCheckbox) approxCheckbox.checked = !!session.isApproximate;
      if (noteInput) noteInput.value = session.note || '';
      if (deleteBtn) deleteBtn.style.display = 'inline-block';
    } else {
      if (titleEl) titleEl.textContent = '稼働セッションの追加';
      if (idInput) idInput.value = '';
      const step = typeof WORK_TIME_STEP_MINUTES !== 'undefined' ? WORK_TIME_STEP_MINUTES : 30;
      const defaultStart = typeof roundToTimeStep === 'function' 
        ? roundToTimeStep(getCurrentTimeString(), step) 
        : '09:00';
      if (startSelect) startSelect.value = defaultStart;
      if (endSelect) endSelect.value = '';
      if (approxCheckbox) approxCheckbox.checked = false;
      if (noteInput) noteInput.value = `第${sessions.length + 1}部`;
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    const overlay = document.getElementById('session-modal-overlay');
    if (overlay) overlay.classList.add('active');
  }

  // 稼働セッションモーダルを閉じる
  closeSessionModal() {
    const overlay = document.getElementById('session-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // 公式正本売上 & 明細突合監査バナーの描画（上部黄色バナー撤廃に伴い安全なno-op化）
  renderAuditBanner() {
    const bannerEl = document.getElementById('sot-audit-banner');
    if (!bannerEl) return;
    bannerEl.style.display = 'none';
  }

  // 「今日」画面のレンダリング
  renderTodayView() {
    this.renderAuditBanner();

    const log = store.getDailyLog(this.currentDate);
    const metrics = store.getCalculatedMetrics(log);
    const sessions = log.workSessions || [];
    const ongoingSession = sessions.find(s => !s.end);
    const isWorking = !!ongoingSession || !!(log.workStartedAt && !log.workEndedAt);
    const isPausedOrEnded = sessions.length > 0 && !ongoingSession;

    // ヘッダー日付
    const dateEl = document.getElementById('today-date-text');
    if (dateEl) {
      dateEl.textContent = formatJapaneseDate(this.currentDate);
    }

    // 稼働ステータスバッジ
    const statusBadge = document.getElementById('work-status-badge');
    if (statusBadge) {
      if (isWorking) {
        statusBadge.className = 'work-status-badge working';
        const sessionNum = ongoingSession ? (sessions.indexOf(ongoingSession) + 1) : 1;
        statusBadge.innerHTML = `<span class="status-dot"></span> 稼働中（第${sessionNum}部）`;
      } else if (isPausedOrEnded) {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = `<span class="status-dot"></span> 休憩／終了（全${sessions.length}部）`;
      } else if (log.workStartedAt && log.workEndedAt) {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = '<span class="status-dot"></span> 稼働終了';
      } else {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = '<span class="status-dot"></span> 未稼働';
      }
    }

    // 複数セッション稼働制御ボタンコンテナ
    const controlContainer = document.getElementById('work-control-container');
    if (controlContainer) {
      if (isWorking) {
        controlContainer.innerHTML = `
          <div class="work-actions-group">
            <button id="btn-work-pause" class="btn-work-action pause" type="button">
              <span>⏸ 休憩に入る（第${sessions.length || 1}部終了）</span>
            </button>
            <button id="btn-work-finish" class="btn-work-action finish" type="button">
              <span>⏹ 本日の稼働を完全終了</span>
            </button>
          </div>
        `;
      } else if (sessions.length > 0) {
        controlContainer.innerHTML = `
          <div class="work-actions-group">
            <button id="btn-work-resume" class="btn-work-action resume" type="button">
              <span>▶ 稼働再開（第${sessions.length + 1}部）</span>
            </button>
          </div>
        `;
      } else {
        controlContainer.innerHTML = `
          <button id="btn-work-start" class="btn-work-toggle" type="button">
            <span>▶ 稼働開始（第1部）</span>
          </button>
        `;
      }
    }

    // 本日の配達件数（巨大数字）
    const countEl = document.getElementById('today-delivery-count');
    if (countEl) {
      countEl.textContent = metrics.count;
    }

    // 稼働開始時刻（概算対応）
    const startTimeEl = document.getElementById('today-start-time');
    if (startTimeEl) {
      if (sessions.length > 0 && sessions[0].start) {
        startTimeEl.textContent = sessions[0].start + (sessions[0].isApproximate ? '頃' : '');
      } else if (log.workStartedAt) {
        startTimeEl.textContent = log.workStartedAt;
      } else {
        startTimeEl.textContent = '--:--';
      }
    }

    // 実質稼働時間サマリー（概算対応）
    const lastTimeEl = document.getElementById('today-last-time');
    if (lastTimeEl) {
      if (metrics.workMinutes !== null) {
        lastTimeEl.textContent = `${formatMinutes(metrics.workMinutes)}${metrics.isWorkTimeApproximate ? '（概算）' : ''}${isWorking ? ' (稼働中)' : ''}`;
      } else if (isWorking) {
        lastTimeEl.textContent = '稼働中';
      } else {
        lastTimeEl.textContent = '--';
      }
    }

    // 稼働セッション折りたたみサマリー
    const sessCountEl = document.getElementById('today-sessions-count');
    if (sessCountEl) sessCountEl.textContent = `${sessions.length}部`;

    const sessDurationEl = document.getElementById('today-sessions-duration');
    if (sessDurationEl) {
      sessDurationEl.textContent = metrics.workMinutes !== null
        ? `${formatMinutes(metrics.workMinutes)}${metrics.isWorkTimeApproximate ? '（概算）' : ''}`
        : (isWorking ? '稼働中' : '未記録');
    }

    // 稼働セッション明細リスト
    this.renderTodaySessions(sessions);

    // 直前取消ボタンの状態更新
    const undoBtn = document.getElementById('btn-undo-delivery');
    if (undoBtn) {
      if (log.deliveries && log.deliveries.length > 0) {
        const last = log.deliveries[log.deliveries.length - 1];
        undoBtn.disabled = false;
        undoBtn.style.opacity = '1';
        undoBtn.innerHTML = `<span>↶ 直前の記録（#${last.index} ${last.completedAt}）を取消</span>`;
      } else {
        undoBtn.disabled = true;
        undoBtn.style.opacity = '0.4';
        undoBtn.innerHTML = '<span>↶ 直前の記録を取消</span>';
      }
    }

    // ダッシュボード指標の更新
    const cardCountEl = document.getElementById('stat-delivery-count');
    if (cardCountEl) cardCountEl.textContent = `${metrics.count}件`;

    const totalSalesEl = document.getElementById('stat-total-sales');
    if (totalSalesEl) {
      totalSalesEl.textContent = metrics.totalSales !== null ? `¥${metrics.totalSales.toLocaleString()}` : '--';
    }

    const delivSalesEl = document.getElementById('stat-delivery-sales');
    if (delivSalesEl) {
      delivSalesEl.textContent = metrics.deliverySales !== null ? `¥${metrics.deliverySales.toLocaleString()}` : '--';
    }

    const questSalesEl = document.getElementById('stat-quest-sales');
    if (questSalesEl) {
      questSalesEl.textContent = metrics.questSales !== null ? `¥${metrics.questSales.toLocaleString()}` : '--';
    }

    // 実質稼働時間（休憩除外、複数セッション合算、概算フラグ対応）
    const workDurationEl = document.getElementById('stat-work-duration');
    if (workDurationEl) {
      if (metrics.workMinutes !== null) {
        workDurationEl.textContent = `${formatMinutes(metrics.workMinutes)}${metrics.isWorkTimeApproximate ? '（概算）' : ''}${isWorking ? ' (稼働中)' : ''}`;
      } else if (isWorking) {
        workDurationEl.textContent = '稼働中';
      } else {
        workDurationEl.textContent = '未記録';
      }
    }

    // 実質時給（総売上 ÷ 実質稼働時間、概算フラグ対応）
    const hourlyWageEl = document.getElementById('stat-hourly-wage');
    if (hourlyWageEl) {
      if (metrics.hourlyWage !== null) {
        hourlyWageEl.textContent = `¥${metrics.hourlyWage.toLocaleString()}${metrics.isWorkTimeApproximate ? '（概算）' : ''}`;
      } else {
        hourlyWageEl.textContent = '算出不可';
      }
    }

    // 配達距離（確認済み配達距離 / Uber配達中距離）
    const uberDistLabelEl = document.getElementById('stat-uber-dist-label');
    const uberDistEl = document.getElementById('stat-uber-dist');
    const uberDistCovEl = document.getElementById('stat-uber-dist-coverage');

    if (uberDistLabelEl) {
      uberDistLabelEl.textContent = metrics.isFullDistanceRecorded ? 'Uber配達中距離' : '確認済み配達距離';
    }
    if (uberDistEl) {
      uberDistEl.textContent = metrics.uberDeliveryDistanceKm !== null ? `${metrics.uberDeliveryDistanceKm} km` : '未記録';
    }
    if (uberDistCovEl) {
      if (metrics.count > 0 && metrics.distanceRecordedCount > 0 && !metrics.isFullDistanceRecorded) {
        uberDistCovEl.textContent = `（${metrics.distanceRecordedCount}/${metrics.count}件）`;
      } else {
        uberDistCovEl.textContent = '';
      }
    }

    // 空走距離（実測・確定データなしのため推測せず算出不可）
    const deadheadDistEl = document.getElementById('stat-deadhead-dist');
    if (deadheadDistEl) {
      deadheadDistEl.textContent = metrics.deadheadDistanceKm !== null ? `${metrics.deadheadDistanceKm} km` : '算出不可';
    }

    const avgFeeEl = document.getElementById('stat-avg-fee');
    if (avgFeeEl) {
      avgFeeEl.textContent = metrics.avgFeePerDelivery !== null ? `¥${metrics.avgFeePerDelivery.toLocaleString()}` : '--';
    }

    // 損益・実質時給カードの更新
    const pnlProfitEl = document.getElementById('pnl-net-profit');
    if (pnlProfitEl) {
      pnlProfitEl.textContent = metrics.netProfit !== null ? metrics.netProfit.toLocaleString() : '--';
    }

    const pnlTotalSalesEl = document.getElementById('pnl-total-sales');
    if (pnlTotalSalesEl) {
      pnlTotalSalesEl.textContent = metrics.totalSales !== null ? `¥${metrics.totalSales.toLocaleString()}` : '--';
    }

    const pnlExpensesEl = document.getElementById('pnl-total-expenses');
    if (pnlExpensesEl) {
      pnlExpensesEl.textContent = `¥${(metrics.totalExpenses || 0).toLocaleString()}`;
    }

    const pnlNetHourlyEl = document.getElementById('pnl-net-hourly');
    if (pnlNetHourlyEl) {
      pnlNetHourlyEl.textContent = metrics.netHourlyWage !== null ? `¥${metrics.netHourlyWage.toLocaleString()}/h` : '算出不可';
    }

    const pnlGrossHourlyEl = document.getElementById('pnl-gross-hourly');
    if (pnlGrossHourlyEl) {
      pnlGrossHourlyEl.textContent = metrics.grossHourlyWage !== null ? `¥${metrics.grossHourlyWage.toLocaleString()}/h` : '算出不可';
    }

    const pnlAvgDeliveryEl = document.getElementById('pnl-avg-delivery');
    if (pnlAvgDeliveryEl) {
      pnlAvgDeliveryEl.textContent = metrics.avgSalesPerDelivery !== null ? `¥${metrics.avgSalesPerDelivery.toLocaleString()}/件` : '--';
    }

    const pnlVehicleEl = document.getElementById('pnl-vehicle-badge');
    if (pnlVehicleEl) {
      const v = metrics.vehicleType || 'レンタサイクル';
      pnlVehicleEl.textContent = `🚲 ${v}`;
    }

    const pnlTagsEl = document.getElementById('pnl-breakdown-tags');
    if (pnlTagsEl) {
      const tags = [];
      if (metrics.deliverySales !== null) {
        tags.push(`<span class="pnl-breakdown-pill">配達: ¥${metrics.deliverySales.toLocaleString()}</span>`);
      }
      if (metrics.questSales !== null && metrics.questSales > 0) {
        tags.push(`<span class="pnl-breakdown-pill" style="color:#fbbf24;">クエスト: ¥${metrics.questSales.toLocaleString()}</span>`);
      }
      if (metrics.adjustmentSales > 0) {
        tags.push(`<span class="pnl-breakdown-pill" style="color:#60a5fa;">調整金: ¥${metrics.adjustmentSales.toLocaleString()}</span>`);
      }
      if (metrics.otherSales > 0) {
        tags.push(`<span class="pnl-breakdown-pill">その他: ¥${metrics.otherSales.toLocaleString()}</span>`);
      }
      pnlTagsEl.innerHTML = tags.join('');
    }

    // 折りたたみヘッダーサマリー（クエスト・経費・配達明細）のリアルタイム更新
    const dedupedQuests = deduplicateQuests(log.quests || []);
    const validQuests = dedupedQuests.filter(q => !q.isDuplicateIgnored);
    const questCountEl = document.getElementById('today-quests-summary-count');
    const questAmountEl = document.getElementById('today-quests-summary-amount');
    if (questCountEl) questCountEl.textContent = `${validQuests.length}件`;
    if (questAmountEl) questAmountEl.textContent = `¥${(metrics.questSales || 0).toLocaleString()}`;

    const expCountEl = document.getElementById('today-expenses-summary-count');
    const expAmountEl = document.getElementById('today-expenses-summary-amount');
    if (expCountEl) expCountEl.textContent = `${(metrics.expenses || []).length}件`;
    if (expAmountEl) expAmountEl.textContent = `¥${(metrics.totalExpenses || 0).toLocaleString()}`;

    const delivCountEl = document.getElementById('today-deliveries-summary-count');
    const delivAmountEl = document.getElementById('today-deliveries-summary-amount');
    if (delivCountEl) delivCountEl.textContent = `${metrics.count}件`;
    if (delivAmountEl) {
      delivAmountEl.textContent = metrics.deliverySales !== null ? `¥${metrics.deliverySales.toLocaleString()}` : '¥0';
    }

    // 本日のクエストリスト
    this.renderTodayQuests(log.quests || []);

    // 本日の当日変動経費リスト
    this.renderTodayExpenses(metrics.expenses || []);

    // 本日の配達履歴リスト
    this.renderDeliveryList(log.deliveries || []);
  }

  // 稼働セッション明細リストの描画
  renderTodaySessions(sessions) {
    const listEl = document.getElementById('today-sessions-list');
    if (!listEl) return;

    if (!sessions || sessions.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding:10px; font-size:12px;">
          稼働セッションの記録はありません
        </div>
      `;
      return;
    }

    listEl.innerHTML = sessions.map((s, idx) => {
      let durationText = '稼働中';
      if (s.start && s.end) {
        const dur = calculateMinutesBetween(s.start, s.end);
        durationText = dur !== null ? formatMinutes(dur) : '--';
      }
      const isApprox = s.isApproximate ? '<span class="approx-tag">（概算）</span>' : '';
      const title = s.note || `第${idx + 1}部`;
      const timeRange = `${s.start}${s.isApproximate ? '頃' : ''} 〜 ${s.end ? (s.end + (s.isApproximate ? '頃' : '')) : '<span style="color:var(--color-uber-green); font-weight:700;">稼働中</span>'}`;

      return `
        <div class="session-item" data-id="${s.id}">
          <div class="session-item-left">
            <span class="session-badge">${title}</span>
            <span class="session-time-text">${timeRange}</span>
          </div>
          <div class="session-item-right">
            <span class="session-duration-text">${durationText}${isApprox}</span>
            <button type="button" class="btn-session-edit" data-id="${s.id}" title="編集">✏️</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.btn-session-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        this.openSessionModal(id);
      });
    });

    listEl.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        this.openSessionModal(id);
      });
    });
  }

  // クエスト明細リストの描画
  renderTodayQuests(quests) {
    const listEl = document.getElementById('today-quest-list');
    const sectionEl = document.getElementById('section-today-quests');
    if (!listEl) return;

    if (!quests || quests.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding:10px; font-size:12px;">
          クエスト明細はありません
        </div>
      `;
      return;
    }

    listEl.innerHTML = quests.map(q => {
      return `
        <div class="quest-item ${q.isDuplicateIgnored ? 'duplicate-ignored' : ''}">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; color:var(--text-main); font-size:14px;">🎁 ${q.title}</span>
            <span style="font-size:12px; color:var(--text-muted);">${q.time}</span>
            ${q.isDuplicateIgnored ? `<span class="quest-ignored-badge">重複除外 (二重計上防止)</span>` : ''}
          </div>
          <div style="font-weight:800; font-size:15px; color:${q.isDuplicateIgnored ? 'var(--text-dim)' : 'var(--color-uber-green)'};">
            ${q.isDuplicateIgnored ? `<s>¥${q.amount}</s>` : `+¥${q.amount.toLocaleString()}`}
          </div>
        </div>
      `;
    }).join('');
  }

  // 本日の当日変動経費明細リストの描画
  renderTodayExpenses(expenses) {
    const listEl = document.getElementById('today-expenses-list');
    if (!listEl) return;

    if (!expenses || expenses.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding:10px; font-size:12px;">
          経費明細はありません（レンタサイクル代・駐輪代等）
        </div>
      `;
      return;
    }

    listEl.innerHTML = expenses.map(exp => {
      const categoryIcon = exp.category === 'レンタサイクル' ? '🚲' :
                           exp.category === '駐輪' ? '🅿️' :
                           exp.category === '交通費' ? '🚃' : '🏷️';
      return `
        <div class="session-item" data-id="${exp.id}">
          <div class="session-item-left">
            <span class="session-badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3);">
              ${categoryIcon} ${exp.category}
            </span>
            <span class="session-time-text" style="color: var(--text-muted);">${exp.memo || 'メモなし'}</span>
          </div>
          <div class="session-item-right">
            <span class="session-duration-text" style="color: #f87171; font-weight: 700;">-¥${Number(exp.amount).toLocaleString()}</span>
            <button type="button" class="btn-expense-delete" data-id="${exp.id}" title="削除" style="background:transparent; border:none; color:var(--text-dim); cursor:pointer; font-size:14px; padding:2px 6px;">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.btn-expense-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (confirm('この経費明細を削除しますか？')) {
          store.deleteExpense(this.currentDate, id);
          this.showToast('経費明細を削除しました');
          this.renderTodayView();
        }
      });
    });
  }

  // 配達履歴リストの描画
  renderDeliveryList(deliveries) {
    const listEl = document.getElementById('today-delivery-list');
    if (!listEl) return;

    if (deliveries.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          まだ配達記録がありません<br>
          配達完了後に上の「＋ 配達1件完了」を押してください
        </div>
      `;
      return;
    }

    // 新しい順（降順）で表示
    const sorted = [...deliveries].reverse();

    listEl.innerHTML = sorted.map(del => {
      const hasDetails = del.restaurant || del.area || del.fee !== null || del.distanceKm || del.durationStr || del.memo;
      const detailSnippet = [
        del.restaurant,
        del.area,
        del.fee !== null ? `¥${Number(del.fee).toLocaleString()}` : '',
        del.distanceKm ? `${del.distanceKm}km` : '',
        del.durationStr || '',
        del.memo
      ].filter(Boolean).join(' ・ ');

      return `
        <div class="delivery-item ${del.isAvoidanceCase ? 'avoidance-case-item' : ''}" data-id="${del.id}">
          <div class="delivery-item-left">
            <span class="delivery-item-idx">#${del.index}</span>
            <div>
              <div class="delivery-item-time">${del.completedAt} ${del.fee !== null ? `<span style="color:var(--color-uber-green); font-weight:700; margin-left:6px;">¥${Number(del.fee).toLocaleString()}</span>` : ''}</div>
              ${detailSnippet ? `<div class="delivery-item-meta">${detailSnippet}</div>` : ''}
              ${del.isAvoidanceCase ? `<span class="badge-avoidance-case">⚠️ 原則回避の基準事例</span>` : ''}
            </div>
          </div>
          <div class="delivery-item-right">
            <span>${hasDetails ? '詳細あり' : '詳細を入力'}</span>
            <span>›</span>
          </div>
        </div>
      `;
    }).join('');

    // クリックイベントでモーダル展開
    listEl.querySelectorAll('.delivery-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        this.openDeliveryModal(id);
      });
    });
  }

  // 配達詳細モーダルを開く
  openDeliveryModal(deliveryId) {
    const log = store.getDailyLog(this.currentDate);
    const del = log.deliveries.find(d => d.id === deliveryId);
    if (!del) return;

    this.selectedDelivery = del;

    document.getElementById('modal-title').textContent = `配達 #${del.index} の詳細`;
    document.getElementById('modal-time').value = del.completedAt || '';
    document.getElementById('modal-restaurant').value = del.restaurant || '';
    document.getElementById('modal-area').value = del.area || '';
    document.getElementById('modal-fee').value = del.fee !== null ? del.fee : '';
    document.getElementById('modal-distance').value = del.distanceKm !== null ? del.distanceKm : '';
    document.getElementById('modal-duration').value = del.durationStr || '';
    document.getElementById('modal-memo').value = del.memo || '';

    const overlay = document.getElementById('delivery-modal-overlay');
    if (overlay) overlay.classList.add('active');
  }

  // 配達詳細モーダルを閉じる
  closeDeliveryModal() {
    const overlay = document.getElementById('delivery-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    this.selectedDelivery = null;
  }

  // 「履歴」画面の描画
  renderHistoryView() {
    const container = document.getElementById('history-list-container');
    if (!container) return;

    const allLogs = store.getAllDailyLogs();
    const activeLogs = allLogs.filter(log => {
      return (log.deliveries && log.deliveries.length > 0) || (log.quests && log.quests.length > 0) || log.workStartedAt || log.totalDistanceKm !== null;
    });

    if (activeLogs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          稼働履歴はまだありません
        </div>
      `;
      return;
    }

    container.innerHTML = activeLogs.map(log => {
      const metrics = store.getCalculatedMetrics(log);

      return `
        <div class="history-card" data-date="${log.date}">
          <div class="history-card-header">
            <div class="history-date-title">
              <span>📅 ${formatJapaneseDate(log.date)}</span>
            </div>
            <span class="expand-icon">▼</span>
          </div>
          <div class="history-stats-grid">
            <div class="h-stat-col">
              <span class="h-stat-label">配達</span>
              <span class="h-stat-val">${metrics.count}件</span>
            </div>
            <div class="h-stat-col">
              <span class="h-stat-label">日計</span>
              <span class="h-stat-val" style="color:var(--color-uber-green);">${metrics.totalSales !== null ? `¥${metrics.totalSales.toLocaleString()}` : '--'}</span>
            </div>
            <div class="h-stat-col">
              <span class="h-stat-label">通常報酬</span>
              <span class="h-stat-val">${metrics.deliverySales !== null ? `¥${metrics.deliverySales.toLocaleString()}` : '--'}</span>
            </div>
            <div class="h-stat-col">
              <span class="h-stat-label">クエスト</span>
              <span class="h-stat-val">${metrics.questSales !== null ? `¥${metrics.questSales.toLocaleString()}` : '¥0'}</span>
            </div>
          </div>
          <div class="history-deliveries-detail">
            <div style="font-size: 12px; color:var(--text-muted); margin-bottom:8px; line-height:1.5;">
              走行: ${metrics.totalDistanceKm !== null ? metrics.totalDistanceKm + 'km' : '未記録'} / 
              Uber中距離: ${metrics.uberDeliveryDistanceKm !== null ? metrics.uberDeliveryDistanceKm + 'km' : '未記録'} / 
              実働: ${metrics.workMinutes !== null ? formatMinutes(metrics.workMinutes) : '未記録'} / 
              時給: ${metrics.hourlyWage !== null ? '¥' + metrics.hourlyWage.toLocaleString() : '算出不可'}
            </div>

            <!-- クエスト明細（あれば） -->
            ${(log.quests && log.quests.length > 0) ? `
              <div style="font-size: 12px; font-weight:700; color:var(--text-muted); margin: 6px 0 4px 0;">🎁 クエスト明細（${log.quests.length}件）</div>
              <div class="delivery-list" style="margin-bottom:8px;">
                ${log.quests.map(q => `
                  <div class="quest-item ${q.isDuplicateIgnored ? 'duplicate-ignored' : ''}" style="padding:6px 10px;">
                    <div style="font-size:13px;">${q.time} ${q.title} ${q.isDuplicateIgnored ? '<span class="quest-ignored-badge">重複除外</span>' : ''}</div>
                    <div style="font-weight:700; font-size:13px; color:${q.isDuplicateIgnored ? 'var(--text-dim)' : 'var(--color-uber-green)'};">
                      ${q.isDuplicateIgnored ? `<s>¥${q.amount}</s>` : `+¥${q.amount}`}
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- 配達明細 -->
            <div style="font-size: 12px; font-weight:700; color:var(--text-muted); margin: 6px 0 4px 0;">📋 配達明細（全${metrics.count}件）</div>
            <div class="delivery-list">
              ${(log.deliveries || []).map(d => `
                <div class="delivery-item" style="padding:8px 12px;">
                  <div class="delivery-item-left">
                    <span class="delivery-item-idx" style="font-size:14px;">#${d.index}</span>
                    <div>
                      <span class="delivery-item-time" style="font-size:14px;">${d.completedAt}</span>
                      ${d.fee !== null ? `<span style="font-weight:700; color:var(--color-uber-green); margin-left:6px;">¥${d.fee.toLocaleString()}</span>` : ''}
                      ${(d.restaurant || d.area || d.distanceKm || d.durationStr || d.memo) ? `
                        <div class="delivery-item-meta" style="font-size:12px;">
                          ${[d.restaurant, d.area, d.distanceKm ? `${d.distanceKm}km` : '', d.durationStr || '', d.memo].filter(Boolean).join(' ・ ')}
                        </div>
                      ` : ''}
                      ${d.isAvoidanceCase ? `<span class="badge-avoidance-case" style="font-size:9px;">⚠️ 原則回避の基準事例</span>` : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // アコーディオン展開イベント
    container.querySelectorAll('.history-card-header').forEach(header => {
      header.addEventListener('click', () => {
        const card = header.closest('.history-card');
        card.classList.toggle('expanded');
        const icon = card.querySelector('.expand-icon');
        if (icon) {
          icon.textContent = card.classList.contains('expanded') ? '▲' : '▼';
        }
      });
    });
  }

  // 「分析」画面の描画（今週の売上最重要・目立たない灰色監査フッター）
  renderAnalyticsView() {
    const rev = store.getRevenueSummary();
    const audit = store.getSourceOfTruthAudit();
    const analytics = store.getAnalytics();

    // 今週の売上ヒーロー（最重要）
    const weekPeriodEl = document.getElementById('week-sales-period');
    if (weekPeriodEl) weekPeriodEl.textContent = rev.thisWeek.periodLabel;

    const weekValEl = document.getElementById('week-sales-val');
    if (weekValEl) weekValEl.textContent = rev.thisWeek.officialSales.toLocaleString();

    // 先週比の表示（控えめなバッジ、先週データ不足時は推測せず「比較データ未登録」）
    const prevDiffEl = document.getElementById('week-prev-diff');
    if (prevDiffEl) {
      if (rev.thisWeek.prevWeekComparison) {
        const comp = rev.thisWeek.prevWeekComparison;
        prevDiffEl.textContent = comp.displayText;
        prevDiffEl.className = `week-prev-diff ${comp.status}`;
        prevDiffEl.style.display = 'inline-block';
      } else {
        prevDiffEl.style.display = 'none';
      }
    }

    const weekDelSalesEl = document.getElementById('week-delivery-sales');
    if (weekDelSalesEl) weekDelSalesEl.textContent = `¥${rev.thisWeek.deliverySales.toLocaleString()}`;

    const weekQuestSalesEl = document.getElementById('week-quest-sales');
    if (weekQuestSalesEl) weekQuestSalesEl.textContent = `¥${rev.thisWeek.questSales.toLocaleString()}`;

    const weekCountEl = document.getElementById('week-delivery-count');
    if (weekCountEl) weekCountEl.textContent = `${rev.thisWeek.deliveriesCount}件`;

    // サブ売上カード（今月・登録済み累計）
    const monthPeriodEl = document.getElementById('month-sales-period');
    if (monthPeriodEl) monthPeriodEl.textContent = rev.thisMonth.periodLabel;

    const monthValEl = document.getElementById('month-sales-val');
    if (monthValEl) monthValEl.textContent = `¥${rev.thisMonth.sales.toLocaleString()}`;

    const cumValEl = document.getElementById('cumulative-sales-val');
    if (cumValEl) cumValEl.textContent = `¥${rev.registeredTotal.sales.toLocaleString()}`;

    // パフォーマンス指標
    const totalDelEl = document.getElementById('analytics-total-deliveries');
    if (totalDelEl) totalDelEl.textContent = `${analytics.totalDeliveries}件`;

    const avgDailyEl = document.getElementById('analytics-avg-daily');
    if (avgDailyEl) {
      avgDailyEl.textContent = analytics.avgDailyEarnings !== null ? `¥${analytics.avgDailyEarnings.toLocaleString()}` : '--';
    }

    const avgPerDelEl = document.getElementById('analytics-avg-per-delivery');
    if (avgPerDelEl) {
      avgPerDelEl.textContent = analytics.avgPerDelivery !== null ? `¥${analytics.avgPerDelivery.toLocaleString()}` : '--';
    }

    const totalDistEl = document.getElementById('analytics-total-distance');
    if (totalDistEl) {
      totalDistEl.textContent = '5.58 km (1件)';
    }

    // 4日間テーブル（曜日自動判定・視覚的区別・祝日判定構造）
    const tableBody = document.getElementById('recent-7days-table-body');
    if (tableBody) {
      tableBody.innerHTML = audit.dailyBreakdown.map(row => {
        return `
          <tr>
            <td><strong>${formatDateWithWeekday(row.date, true)}</strong></td>
            <td>${row.count}件</td>
            <td>${row.deliverySales !== null ? `¥${row.deliverySales.toLocaleString()}` : '--'}</td>
            <td>${row.questSales !== null ? `¥${row.questSales.toLocaleString()}` : '¥0'}</td>
            <td style="font-weight:700; color:var(--color-uber-green);">${row.dayTotal !== null ? `¥${row.dayTotal.toLocaleString()}` : '--'}</td>
          </tr>
        `;
      }).join('');
    }

    // 目立たない控えめな灰色監査フッター
    const footerEl = document.getElementById('analytics-audit-footer');
    if (footerEl) {
      footerEl.innerHTML = `
        <div class="audit-discreet-text">${rev.auditFootnote.text}</div>
        <div class="audit-discreet-sub">${rev.auditFootnote.subText}</div>
      `;
    }
  }

  // 「地雷」画面の描画（原則回避DB）
  renderAvoidanceView() {
    const db = store.getAvoidanceDatabase ? store.getAvoidanceDatabase() : (typeof AVOIDANCE_DATABASE !== 'undefined' ? AVOIDANCE_DATABASE : null);
    if (!db) return;

    // 3方面
    const areasList = document.getElementById('avoidance-areas-list');
    if (areasList && db.areas) {
      areasList.innerHTML = db.areas.map(a => `
        <div class="avoidance-card">
          <div class="avoidance-card-header">
            <span class="avoidance-card-title">🚫 ${a.name}</span>
            <span class="avoidance-card-loc">${a.location}</span>
          </div>
          <div class="avoidance-tags-row">
            ${a.tags.map(t => `<span class="reason-tag">${t}</span>`).join('')}
          </div>
          <div class="avoidance-card-reason">${a.reason}</div>
        </div>
      `).join('');
    }

    // 3施設タイプ（分類情報として表示）
    const facilitiesList = document.getElementById('avoidance-facilities-list');
    if (facilitiesList && db.facilities) {
      facilitiesList.innerHTML = db.facilities.map(f => `
        <div class="avoidance-card">
          <div class="avoidance-card-header">
            <span class="avoidance-card-title">🏢 ${f.type}</span>
          </div>
          <div class="avoidance-tags-row">
            ${f.tags.map(t => `<span class="reason-tag">${t}</span>`).join('')}
          </div>
          <div class="avoidance-card-reason">${f.reason}</div>
        </div>
      `).join('');
    }

    // 理由タグ体系
    const tagsList = document.getElementById('avoidance-tags-list');
    if (tagsList && db.reasonCategories) {
      tagsList.innerHTML = db.reasonCategories.map(c => `
        <span class="reason-tag neutral">${c}</span>
      `).join('');
    }

    // 実走事例・配達効率判断（育てるDB: 3段階評価）
    const benchmarksListEl = document.getElementById('avoidance-benchmarks-list');
    if (benchmarksListEl && db.benchmarks) {
      benchmarksListEl.innerHTML = db.benchmarks.map(bm => {
        let badgeClass = 'badge-verify';
        let badgeText = '🔍 要検証';
        if (bm.status === 'AVOID') {
          badgeClass = 'badge-avoid';
          badgeText = '⚠️ 確定地雷';
        } else if (bm.status === 'OK') {
          badgeClass = 'badge-ok';
          badgeText = '✅ 問題なし';
        }

        return `
          <div class="avoidance-card" data-id="${bm.id}" style="padding:14px; margin-bottom:10px;">
            <div class="benchmark-badge-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span class="benchmark-badge" style="font-size:13px; font-weight:800; color:var(--text-main);">${bm.title}</span>
              <span class="benchmark-status-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="benchmark-date" style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">
              📅 ${formatDateWithWeekday(bm.date, true)} ${bm.completedAt || ''} 実走データ
            </div>
            <div class="benchmark-route" style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:8px;">
              📍 ${bm.pickup} ➔ ${bm.drop}
            </div>
            <div class="benchmark-metrics-grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:var(--radius-sm); margin-bottom:8px; text-align:center;">
              <div class="benchmark-metric-item">
                <span class="benchmark-metric-label" style="font-size:10px; color:var(--text-dim); display:block;">配達報酬</span>
                <span class="benchmark-metric-val" style="font-size:13px; font-weight:800; color:var(--color-uber-green);">${bm.fee ? '¥' + Number(bm.fee).toLocaleString() : '--'}</span>
              </div>
              <div class="benchmark-metric-item">
                <span class="benchmark-metric-label" style="font-size:10px; color:var(--text-dim); display:block;">配達距離</span>
                <span class="benchmark-metric-val" style="font-size:13px; font-weight:800; color:var(--text-main);">${bm.distanceKm !== null ? bm.distanceKm + ' km' : '未記録'}</span>
              </div>
              <div class="benchmark-metric-item">
                <span class="benchmark-metric-label" style="font-size:10px; color:var(--text-dim); display:block;">所要時間</span>
                <span class="benchmark-metric-val" style="font-size:13px; font-weight:800; color:var(--text-main);">${bm.durationStr || '未記録'}</span>
              </div>
            </div>
            ${(bm.tags && bm.tags.length > 0) ? `
              <div class="avoidance-tags-row" style="margin-bottom:8px;">
                ${bm.tags.map(t => `<span class="reason-tag">${t}</span>`).join('')}
              </div>
            ` : ''}
            <div class="benchmark-memo" style="font-size:12px; color:var(--text-muted); line-height:1.5;">${bm.memo}</div>
            <div class="benchmark-status-row" style="margin-top:10px; display:flex; align-items:center; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px;">
              <span style="font-size:11px; color:var(--text-dim);">評価ステータス:</span>
              <div style="display:flex; gap:6px;">
                <button type="button" class="btn-benchmark-status ${bm.status === 'AVOID' ? 'active' : ''}" data-id="${bm.id}" data-status="AVOID" style="cursor:pointer; font-size:11px; padding:3px 8px; border-radius:4px; border:1px solid var(--border-color); background:${bm.status === 'AVOID' ? 'var(--color-danger-red)' : 'transparent'}; color:${bm.status === 'AVOID' ? '#fff' : 'var(--text-muted)'}; font-weight:700;">地雷</button>
                <button type="button" class="btn-benchmark-status ${bm.status === 'VERIFY' ? 'active' : ''}" data-id="${bm.id}" data-status="VERIFY" style="cursor:pointer; font-size:11px; padding:3px 8px; border-radius:4px; border:1px solid var(--border-color); background:${bm.status === 'VERIFY' ? 'var(--color-warning-amber)' : 'transparent'}; color:${bm.status === 'VERIFY' ? '#000' : 'var(--text-muted)'}; font-weight:700;">要検証</button>
                <button type="button" class="btn-benchmark-status ${bm.status === 'OK' ? 'active' : ''}" data-id="${bm.id}" data-status="OK" style="cursor:pointer; font-size:11px; padding:3px 8px; border-radius:4px; border:1px solid var(--border-color); background:${bm.status === 'OK' ? 'var(--color-uber-green)' : 'transparent'}; color:${bm.status === 'OK' ? '#000' : 'var(--text-muted)'}; font-weight:700;">OK</button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      benchmarksListEl.querySelectorAll('.btn-benchmark-status').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          const newStatus = btn.getAttribute('data-status');
          store.updateBenchmarkStatus(id, newStatus);
          this.showToast(`評価を更新しました: ${newStatus}`);
          this.renderAvoidanceView();
        });
      });
    }

    // 実走基準事例 #1（旧単体カード要素が存在する場合の後方互換フォールバック）
    const singleBenchmarkEl = document.getElementById('avoidance-benchmark-card');
    if (singleBenchmarkEl && db.benchmarks && db.benchmarks.length > 0) {
      const bm = db.benchmarks[0];
      singleBenchmarkEl.innerHTML = `
        <div class="benchmark-badge-row">
          <span class="benchmark-badge">${bm.title}</span>
          <span class="benchmark-date">${formatDateWithWeekday(bm.date, true)} 実走確定値</span>
        </div>
        <div class="benchmark-route">📍 ${bm.pickup} ➔ ${bm.drop}</div>
        <div class="benchmark-metrics-grid">
          <div class="benchmark-metric-item">
            <span class="benchmark-metric-label">配達報酬</span>
            <span class="benchmark-metric-val" style="color:var(--color-uber-green);">¥${bm.fee}</span>
          </div>
          <div class="benchmark-metric-item">
            <span class="benchmark-metric-label">配達距離</span>
            <span class="benchmark-metric-val">${bm.distanceKm} km</span>
          </div>
          <div class="benchmark-metric-item">
            <span class="benchmark-metric-label">所要時間</span>
            <span class="benchmark-metric-val">${bm.durationStr}</span>
          </div>
        </div>
        <div class="avoidance-tags-row">
          ${bm.tags.map(t => `<span class="reason-tag">${t}</span>`).join('')}
        </div>
        <div class="benchmark-memo">${bm.memo}</div>
      `;
    }
  }

  // 設定モーダルを開く
  openSettingsModal() {
    const overlay = document.getElementById('settings-modal-overlay');
    if (overlay) overlay.classList.add('active');
  }

  // 設定モーダルを閉じる
  closeSettingsModal() {
    const overlay = document.getElementById('settings-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // 売上取込モーダルを開く
  openSalesImportModal() {
    const overlay = document.getElementById('sales-import-modal-overlay');
    const rawTextEl = document.getElementById('import-sales-raw-text');
    const previewArea = document.getElementById('import-sales-preview-area');
    if (rawTextEl) rawTextEl.value = '';
    if (previewArea) previewArea.style.display = 'none';
    this.pendingSalesImport = null;
    if (overlay) overlay.classList.add('active');
  }

  // 売上取込モーダルを閉じる
  closeSalesImportModal() {
    const overlay = document.getElementById('sales-import-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // 売上テキスト解析の実行
  handleParseSalesText() {
    const rawTextEl = document.getElementById('import-sales-raw-text');
    const rawText = rawTextEl ? rawTextEl.value.trim() : '';
    if (!rawText) {
      this.showToast('売上テキストを貼り付けてください');
      return;
    }

    const parsed = parseUberSalesText(rawText);
    
    // 入力フォームに値を反映
    const delivEl = document.getElementById('import-sales-delivery');
    const questEl = document.getElementById('import-sales-quest');
    const adjEl = document.getElementById('import-sales-adjustment');
    const otherEl = document.getElementById('import-sales-other');
    const questNotesEl = document.getElementById('import-sales-quest-notes');
    const totalEl = document.getElementById('import-sales-total-preview');
    const previewArea = document.getElementById('import-sales-preview-area');

    if (delivEl) delivEl.value = parsed.deliverySales;
    if (questEl) questEl.value = parsed.questSales;
    if (adjEl) adjEl.value = parsed.adjustmentSales;
    if (otherEl) otherEl.value = parsed.otherSales;

    if (questNotesEl) {
      if (parsed.detectedQuests && parsed.detectedQuests.length > 0) {
        const ignoredCount = parsed.detectedQuests.filter(q => q.isDuplicateIgnored).length;
        const validCount = parsed.detectedQuests.length - ignoredCount;
        let noteText = `検知: ${parsed.detectedQuests.length}件中 ${validCount}件採用`;
        if (ignoredCount > 0) {
          noteText += `（⚠️重複検知 ${ignoredCount}件を自動除外）`;
        }
        questNotesEl.textContent = noteText;
      } else {
        questNotesEl.textContent = '';
      }
    }

    const updatePreviewTotal = () => {
      const d = Number(delivEl ? delivEl.value : 0) || 0;
      const q = Number(questEl ? questEl.value : 0) || 0;
      const a = Number(adjEl ? adjEl.value : 0) || 0;
      const o = Number(otherEl ? otherEl.value : 0) || 0;
      const tot = d + q + a + o;
      if (totalEl) totalEl.textContent = `¥${tot.toLocaleString()}`;
    };

    updatePreviewTotal();

    // 変更時にリアルタイム合計更新
    [delivEl, questEl, adjEl, otherEl].forEach(el => {
      if (el) {
        el.oninput = updatePreviewTotal;
      }
    });

    if (previewArea) previewArea.style.display = 'block';
  }

  // 売上取込の確定
  confirmImportSales() {
    const delivEl = document.getElementById('import-sales-delivery');
    const questEl = document.getElementById('import-sales-quest');
    const adjEl = document.getElementById('import-sales-adjustment');
    const otherEl = document.getElementById('import-sales-other');
    const rawTextEl = document.getElementById('import-sales-raw-text');

    const delivery = Number(delivEl ? delivEl.value : 0) || 0;
    const quest = Number(questEl ? questEl.value : 0) || 0;
    const adjustment = Number(adjEl ? adjEl.value : 0) || 0;
    const other = Number(otherEl ? otherEl.value : 0) || 0;
    const rawText = rawTextEl ? rawTextEl.value : '';

    store.saveDailySales(this.currentDate, {
      delivery,
      quest,
      adjustment,
      other,
      rawText
    });

    this.closeSalesImportModal();
    this.showToast('売上データを確定・保存しました');
    this.refreshAll();
  }

  // 経費管理モーダルを開く
  openExpensesModal() {
    const overlay = document.getElementById('expenses-modal-overlay');
    const log = store.getDailyLog(this.currentDate);
    
    // 車両種別のセット
    const vehicleEl = document.getElementById('expense-vehicle-type');
    if (vehicleEl) {
      vehicleEl.value = log.vehicleType || 'レンタサイクル';
    }

    this.renderExpensesModalList();
    if (overlay) overlay.classList.add('active');
  }

  // 経費管理モーダルを閉じる
  closeExpensesModal() {
    const overlay = document.getElementById('expenses-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    this.refreshAll();
  }

  // 経費モーダル内の明細一覧と合計プレビューの描画
  renderExpensesModalList() {
    const log = store.getDailyLog(this.currentDate);
    const expenses = log.expenses || [];
    const container = document.getElementById('expense-items-container');
    const totalPreview = document.getElementById('expense-total-preview');

    let total = 0;
    expenses.forEach(e => {
      total += Number(e.amount) || 0;
    });

    if (totalPreview) {
      totalPreview.textContent = `¥${total.toLocaleString()}`;
    }

    if (!container) return;

    if (expenses.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:10px; font-size:12px;">
          まだ登録された経費はありません
        </div>
      `;
      return;
    }

    container.innerHTML = expenses.map(exp => {
      const categoryIcon = exp.category === 'レンタサイクル' ? '🚲' :
                           exp.category === '駐輪' ? '🅿️' :
                           exp.category === '交通費' ? '🚃' : '🏷️';
      return `
        <div class="delivery-item" style="padding:10px 12px; margin-bottom:6px;">
          <div class="delivery-item-left" style="gap:10px;">
            <span style="font-size:16px;">${categoryIcon}</span>
            <div>
              <div style="font-weight:700; font-size:14px; color:var(--text-main);">
                ${exp.category} <span style="color:#f87171; margin-left:6px;">¥${Number(exp.amount).toLocaleString()}</span>
              </div>
              <div style="font-size:12px; color:var(--text-muted);">${exp.memo || 'メモなし'}</div>
            </div>
          </div>
          <button type="button" class="btn-modal-expense-del" data-id="${exp.id}" style="background:transparent; border:none; color:var(--text-dim); cursor:pointer; font-size:16px; padding:4px 8px;">🗑️</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-modal-expense-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        store.deleteExpense(this.currentDate, id);
        this.renderExpensesModalList();
        this.renderTodayView();
      });
    });
  }

  // 経費明細の追加
  handleAddExpenseItem() {
    const catEl = document.getElementById('expense-category');
    const amtEl = document.getElementById('expense-amount');
    const memoEl = document.getElementById('expense-memo');

    const category = catEl ? catEl.value : 'レンタサイクル';
    const amount = amtEl ? amtEl.value : '';
    const memo = memoEl ? memoEl.value.trim() : '';

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      this.showToast('有効な金額を入力してください');
      return;
    }

    store.addExpense(this.currentDate, {
      category,
      amount: Number(amount),
      memo
    });

    if (amtEl) amtEl.value = '';
    if (memoEl) memoEl.value = '';

    this.showToast('経費を追加しました');
    this.renderExpensesModalList();
    this.renderTodayView();
  }

  // すべての画面を最新状態に更新
  refreshAll() {
    this.renderTodayView();
    this.renderHistoryView();
    this.renderAnalyticsView();
    this.renderAvoidanceView();
  }
}

const ui = new UI();

if (typeof window !== 'undefined') {
  window.UI = UI;
  window.ui = ui;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UI, ui };
}

