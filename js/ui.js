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

  // 「今日」画面のレンダリング（視認性・巨大文字・昨日比較最優先）
  renderTodayView() {
    this.renderAuditBanner();

    const log = store.getDailyLog(this.currentDate);
    const metrics = store.getCalculatedMetrics(log);
    const sessions = log.workSessions || [];
    const ongoingSession = sessions.find(s => !s.end);
    const isWorking = !!ongoingSession || !!(log.workStartedAt && !log.workEndedAt);
    const isPausedOrEnded = sessions.length > 0 && !ongoingSession;

    // 1. ヘッダー日付（簡潔表記: 9月19日（土）など）
    const dateEl = document.getElementById('today-date-text');
    if (dateEl) {
      dateEl.textContent = typeof formatShortJapaneseDate === 'function' 
        ? formatShortJapaneseDate(this.currentDate, false) 
        : formatJapaneseDate(this.currentDate);
    }

    // 2. 稼働ステータスバッジ
    const statusBadge = document.getElementById('work-status-badge');
    if (statusBadge) {
      if (isWorking) {
        statusBadge.className = 'work-status-badge working';
        statusBadge.innerHTML = '<span class="status-dot"></span> 稼働中';
      } else if (isPausedOrEnded) {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = '<span class="status-dot"></span> 休憩中';
      } else if (log.workStartedAt && log.workEndedAt) {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = '<span class="status-dot"></span> 稼働終了';
      } else {
        statusBadge.className = 'work-status-badge';
        statusBadge.innerHTML = '<span class="status-dot"></span> 未稼働';
      }
    }

    // 開始時刻表示
    const startTimeEl = document.getElementById('today-start-time-text');
    if (startTimeEl) {
      if (sessions.length > 0 && sessions[0].start) {
        startTimeEl.textContent = `${sessions[0].start} 開始`;
      } else if (log.workStartedAt) {
        startTimeEl.textContent = `${log.workStartedAt} 開始`;
      } else {
        startTimeEl.textContent = '--:-- 開始';
      }
    }

    // 3. メイン数字：配達件数（巨大）
    const countEl = document.getElementById('today-delivery-count');
    if (countEl) {
      countEl.textContent = metrics.count;
    }

    // メイン数字：本日の実働時間（巨大）
    const durationEl = document.getElementById('today-work-duration-text');
    if (durationEl) {
      if (metrics.workMinutes !== null) {
        durationEl.textContent = formatMinutes(metrics.workMinutes);
      } else if (isWorking) {
        durationEl.textContent = '稼働中';
      } else {
        durationEl.textContent = '--';
      }
    }

    // 4. 直前取消ボタン
    const undoBtn = document.getElementById('btn-undo-delivery');
    if (undoBtn) {
      if (log.deliveries && log.deliveries.length > 0) {
        const last = log.deliveries[log.deliveries.length - 1];
        undoBtn.disabled = false;
        undoBtn.style.opacity = '1';
        undoBtn.innerHTML = `<span>↶ 直前の記録（No.${last.index} ${last.completedAt}）を取消</span>`;
      } else {
        undoBtn.disabled = true;
        undoBtn.style.opacity = '0.35';
        undoBtn.innerHTML = '<span>↶ 直前の記録を取消</span>';
      }
    }

    // 5. 稼働操作ボタングループ
    const controlContainer = document.getElementById('work-control-container');
    if (controlContainer) {
      if (isWorking) {
        controlContainer.innerHTML = `
          <div class="work-actions-group">
            <button id="btn-work-pause" class="btn-work-action pause" type="button">
              <span>⏸ 休憩する</span>
            </button>
            <button id="btn-work-finish" class="btn-work-action finish" type="button">
              <span>⏹ 稼働終了</span>
            </button>
          </div>
        `;
      } else if (sessions.length > 0 && !log.workEndedAt) {
        controlContainer.innerHTML = `
          <div class="work-actions-group" style="grid-template-columns: 1fr;">
            <button id="btn-work-resume" class="btn-work-action resume" type="button">
              <span>▶ 稼働再開</span>
            </button>
          </div>
        `;
      } else {
        controlContainer.innerHTML = `
          <button id="btn-work-start" class="btn-big-delivery" type="button" style="height:48px; font-size:16px; background:rgba(6,193,103,0.15); border:1px solid rgba(6,193,103,0.4); color:var(--color-uber-green); box-shadow:none;">
            <span>▶ 稼働開始</span>
          </button>
        `;
      }
    }

    // 6. 昨日比カード（直感的・シンプル・数字重視）
    const comp = store.getYesterdayComparison(this.currentDate);
    const compCard = document.getElementById('yesterday-compare-card');
    if (comp && compCard) {
      compCard.style.display = 'block';
      const todayCountEl = document.getElementById('compare-today-count');
      const yesterdayCountEl = document.getElementById('compare-yesterday-count');
      const diffBadgeEl = document.getElementById('compare-diff-badge');
      const salesValEl = document.getElementById('compare-yesterday-sales-val');
      const salesRowEl = document.getElementById('compare-yesterday-sales-row');

      if (todayCountEl) todayCountEl.textContent = `${comp.todayCount}件`;
      if (yesterdayCountEl) yesterdayCountEl.textContent = `${comp.yesterdayCount}件`;

      if (diffBadgeEl) {
        if (comp.diffCount > 0) {
          diffBadgeEl.textContent = `＋${comp.diffCount}件`;
          diffBadgeEl.className = 'compare-diff-badge positive';
        } else if (comp.diffCount === 0) {
          diffBadgeEl.textContent = '±0件';
          diffBadgeEl.className = 'compare-diff-badge neutral';
        } else {
          diffBadgeEl.textContent = `${comp.diffCount}件`;
          diffBadgeEl.className = 'compare-diff-badge negative';
        }
      }

      if (salesRowEl && salesValEl) {
        if (comp.yesterdaySales !== null) {
          salesRowEl.style.display = 'flex';
          salesValEl.textContent = `${comp.yesterdaySales.toLocaleString()}円`;
        } else {
          salesRowEl.style.display = 'none';
        }
      }
    } else if (compCard) {
      compCard.style.display = 'none';
    }

    // 7. 本日の確定結果カード（売上確定時のみ表示）
    const settledCard = document.getElementById('today-settled-card');

    if (metrics.totalSales !== null || (metrics.totalSalesWithBonus !== null && metrics.totalSalesWithBonus > 0)) {
      if (settledCard) settledCard.style.display = 'block';

      // マイルストーンバッジ（累計75配達達成等）
      const milestoneBadge = document.getElementById('settled-milestone-badge');
      if (milestoneBadge) {
        if (metrics.milestone) {
          milestoneBadge.textContent = `🎉 ${metrics.milestone}`;
          milestoneBadge.style.display = 'inline-block';
        } else {
          milestoneBadge.style.display = 'none';
        }
      }

      // 新規ドライバー保証・特別収入ボックス
      const guaranteeBox = document.getElementById('settled-guarantee-box');
      if (guaranteeBox) {
        if (metrics.guaranteeBonus > 0) {
          guaranteeBox.style.display = 'block';
          const regSalesEl = document.getElementById('settled-regular-sales');
          const bonusEl = document.getElementById('settled-guarantee-bonus');
          const totWithBonusEl = document.getElementById('settled-total-with-bonus');
          if (regSalesEl) regSalesEl.textContent = `¥${(metrics.totalSales || 0).toLocaleString()}`;
          if (bonusEl) bonusEl.textContent = `+¥${metrics.guaranteeBonus.toLocaleString()}`;
          if (totWithBonusEl) totWithBonusEl.textContent = `¥${(metrics.totalSalesWithBonus || 0).toLocaleString()}`;
        } else {
          guaranteeBox.style.display = 'none';
        }
      }

      const pProfit = document.getElementById('settled-net-profit');
      const pNetHourly = document.getElementById('settled-net-hourly');
      const pSales = document.getElementById('settled-total-sales');
      const pExpenses = document.getElementById('settled-total-expenses');
      const pGrossHourly = document.getElementById('settled-gross-hourly');
      const pAvgDelivery = document.getElementById('settled-avg-delivery');

      if (pProfit) pProfit.textContent = `¥${(metrics.netProfit || 0).toLocaleString()}`;
      if (pNetHourly) pNetHourly.textContent = metrics.netHourlyWage !== null ? `¥${metrics.netHourlyWage.toLocaleString()}/h` : '--';
      if (pSales) pSales.textContent = `¥${(metrics.totalSales || 0).toLocaleString()}`;
      if (pExpenses) pExpenses.textContent = `-¥${(metrics.totalExpenses || 0).toLocaleString()}`;
      if (pGrossHourly) pGrossHourly.textContent = metrics.grossHourlyWage !== null ? `¥${metrics.grossHourlyWage.toLocaleString()}/h` : '--';
      if (pAvgDelivery) pAvgDelivery.textContent = metrics.avgSalesPerDelivery !== null ? `¥${metrics.avgSalesPerDelivery.toLocaleString()}/件` : '--';
    } else if (settledCard) {
      settledCard.style.display = 'none';
    }

    // 8. 配達明細セクション見出し（例: 9月19日（23件 / 18トリップ））
    const deliveriesTitleEl = document.getElementById('today-deliveries-title');
    if (deliveriesTitleEl) {
      const cleanDate = this.currentDate.replace(/\//g, '-');
      const [y, m, d] = cleanDate.split('-').map(Number);
      const trips = metrics.tripsCount || (log.deliveries ? log.deliveries.length : metrics.count);
      if (trips && trips !== metrics.count) {
        deliveriesTitleEl.textContent = `${m}月${d}日（${metrics.count}件 / ${trips}トリップ）`;
      } else {
        deliveriesTitleEl.textContent = `${m}月${d}日（${metrics.count}件）`;
      }
    }
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

  // 配達一覧リストの描画（1公式トリップ＝1明細カード、一目で分かる情報に絞り込み、タップで詳細展開）
  renderDeliveryList(deliveries) {
    const listEl = document.getElementById('today-delivery-list');
    if (!listEl) return;

    if (!deliveries || deliveries.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          まだ配達記録がありません<br>
          配達完了後に上の「＋ 配達1件完了」を押してください
        </div>
      `;
      return;
    }

    // 公式実績（店舗名または確定報酬あり）が存在する場合、手動仮ログ（店舗空かつ報酬null）を除外して重複・空カードを完全排除
    const hasOfficial = deliveries.some(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
    const targetDeliveries = hasOfficial
      ? deliveries.filter(d => d.restaurant || (d.fee !== null && d.fee !== undefined))
      : deliveries;

    // 重複indexを排除（同一indexが存在する場合はより詳細な公式データを優先）
    const seenIndices = new Map();
    targetDeliveries.forEach(d => {
      const idx = d.index || 0;
      if (!seenIndices.has(idx)) {
        seenIndices.set(idx, d);
      } else {
        const existing = seenIndices.get(idx);
        if ((!existing.restaurant && d.restaurant) || (existing.fee === null && d.fee !== null)) {
          seenIndices.set(idx, d);
        }
      }
    });

    // No.1 〜 昇順で並べる
    const sorted = Array.from(seenIndices.values()).sort((a, b) => a.index - b.index);

    listEl.innerHTML = sorted.map(del => this.renderDeliveryCardHtml(del, true, this.currentDate)).join('');

    // カードタップで詳細モーダル展開
    listEl.querySelectorAll('.delivery-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-eval') || e.target.closest('.trip-eval-buttons') || e.target.closest('.btn-trip-map') || e.target.closest('.trip-eval-reason-box')) return;
        const id = item.getAttribute('data-id');
        this.openDeliveryModal(id);
      });
    });

    // ○／×評価ボタンイベント
    listEl.querySelectorAll('.btn-eval').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const evalGroup = btn.closest('.trip-eval-buttons');
        if (!evalGroup) return;
        const delId = evalGroup.getAttribute('data-del-id');
        const val = btn.getAttribute('data-val');
        const isCurrentlyActive = btn.classList.contains('active');
        const newVal = isCurrentlyActive ? null : val;

        store.setTripEvaluation(delId, newVal);

        evalGroup.querySelectorAll('.btn-eval').forEach(b => b.classList.remove('active'));
        const evalBox = listEl.querySelector(`#eval-box-${delId}`);
        const reasonInput = evalBox ? evalBox.querySelector('.input-eval-reason') : null;

        if (newVal) {
          btn.classList.add('active');
          if (evalBox) {
            evalBox.style.display = 'block';
            if (reasonInput) {
              reasonInput.placeholder = newVal === 'OK' ? '○の理由（例: 店も配達先も楽、高単価）' : '×の理由（例: 入館ロス、大迂回、トンネル）';
              if (newVal === 'AVOID') {
                reasonInput.classList.add('avoid-focus');
              } else {
                reasonInput.classList.remove('avoid-focus');
              }
            }
          }
          this.showToast(newVal === 'OK' ? '評価「○」を保存しました' : '評価「×」を保存しました');
        } else {
          if (evalBox) {
            evalBox.style.display = 'none';
          }
          this.showToast('評価を解除しました');
        }
      });
    });

    // 評価理由メモ入力イベント
    listEl.querySelectorAll('.input-eval-reason').forEach(input => {
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('input', (e) => {
        e.stopPropagation();
        const delId = input.getAttribute('data-del-id');
        if (delId && typeof store !== 'undefined' && store.setTripEvaluationReason) {
          store.setTripEvaluationReason(delId, input.value);
        }
      });
    });

    // 地図ボタンイベント
    listEl.querySelectorAll('.btn-trip-map').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const delId = btn.getAttribute('data-del-id');
        this.openTripMapModal(delId);
      });
    });
  }

  // 1トリップ（公式明細）カードHTML生成（引/配の視覚化 & 大阪市省略 & ○/×評価 & 理由メモ & 地図対応）
  renderDeliveryCardHtml(del, isClickable = false, logDate = '') {
    const formattedArea = (typeof formatDisplayAddress === 'function') 
      ? formatDisplayAddress(del.area) 
      : (del.area ? String(del.area).replace(/^大阪市/, '').trim() : '');

    const metaParts = [];
    if (del.distanceKm !== null && del.distanceKm !== undefined && del.distanceKm !== '') {
      const distStr = (typeof del.distanceKm === 'number') ? del.distanceKm.toFixed(2) : String(del.distanceKm);
      metaParts.push(`<span class="trip-meta-num">${distStr}</span><span class="trip-meta-unit">km</span>`);
    }
    if (del.durationStr) {
      const formattedDuration = (typeof formatDurationColon === 'function')
        ? formatDurationColon(del.durationStr)
        : String(del.durationStr);
      metaParts.push(`<span class="trip-meta-duration">${formattedDuration}</span>`);
    }
    const metaLine = metaParts.join('<span class="trip-meta-sep"> / </span>');

    const evalData = (typeof store !== 'undefined' && store.getTripEvaluationData) 
      ? store.getTripEvaluationData(del.id) 
      : { evaluation: del.evaluation || null, reason: del.evaluationReason || '' };
    const evalVal = evalData.evaluation;
    const evalReason = (evalData.reason || del.evaluationReason || '').replace(/"/g, '&quot;');

    const hasMap = Boolean(typeof TRIP_MAP_CATALOG !== 'undefined' && TRIP_MAP_CATALOG[del.id]);

    return `
      <div class="delivery-item" ${isClickable ? `data-id="${del.id || ''}" style="cursor:pointer;"` : ''}>
        <div class="delivery-item-top">
          <div class="delivery-item-no-time">
            <span class="delivery-item-no">No.${del.index}</span>
            <span class="delivery-item-time">${del.completedAt || ''}</span>
          </div>
          ${(del.fee !== null && del.fee !== undefined) ? `
            <div class="delivery-item-fee">¥${Number(del.fee).toLocaleString()}</div>
          ` : ''}
        </div>

        ${(del.restaurant || formattedArea) ? `
          <div class="delivery-route-flow">
            ${del.restaurant ? `
              <div class="route-node route-pickup">
                <span class="route-badge badge-pickup">引</span>
                <span class="route-name">${del.restaurant}</span>
              </div>
            ` : ''}
            ${(del.restaurant && formattedArea) ? `
              <div class="route-arrow-connector">
                <span class="route-arrow">↓</span>
              </div>
            ` : ''}
            ${formattedArea ? `
              <div class="route-node route-drop">
                <span class="route-badge badge-drop">配</span>
                <span class="route-name">${formattedArea}</span>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <div class="trip-footer-row">
          <div class="trip-stats-meta">
            ${metaLine ? `<span class="trip-meta-stat">${metaLine}</span>` : ''}
            ${(del.points && del.points > 1) ? `<span class="trip-points-pill">${del.points}pt（ダブル）</span>` : ''}
            <button type="button" class="btn-trip-map ${hasMap ? '' : 'no-map'}" data-del-id="${del.id || ''}" title="${hasMap ? '公式実績地図を表示' : '公式地図画像は未登録です'}">MAP</button>
          </div>
          <div class="trip-eval-buttons" data-del-id="${del.id || ''}">
            <button type="button" class="btn-eval btn-eval-good ${evalVal === 'OK' ? 'active' : ''}" data-val="OK" title="また受けたい・良かった" aria-label="良かった">○</button>
            <button type="button" class="btn-eval btn-eval-avoid ${evalVal === 'AVOID' ? 'active' : ''}" data-val="AVOID" title="避けたい・地雷だった" aria-label="避けたい">×</button>
          </div>
        </div>

        <!-- ○／×評価理由の一言メモ入力欄（○または×選択時のみ表示、未評価時は非表示） -->
        <div class="trip-eval-reason-box" id="eval-box-${del.id || ''}" style="${evalVal ? '' : 'display:none;'}">
          <input type="text" class="input-eval-reason ${evalVal === 'AVOID' ? 'avoid-focus' : ''}" data-del-id="${del.id || ''}" placeholder="${evalVal === 'OK' ? '○の理由（例: 店も配達先も楽、高単価）' : (evalVal === 'AVOID' ? '×の理由（例: 入館ロス、大迂回、トンネル）' : '評価の理由を入力')}" value="${evalReason}" maxlength="100">
        </div>
      </div>
    `;
  }

  // 公式トリップ地図モーダルを開く
  openTripMapModal(deliveryId) {
    if (!deliveryId) return;
    const modalOverlay = document.getElementById('trip-map-modal-overlay');
    if (!modalOverlay) return;

    const mapInfo = (typeof TRIP_MAP_CATALOG !== 'undefined') ? TRIP_MAP_CATALOG[deliveryId] : null;
    if (!mapInfo) {
      this.showToast('このトリップの公式地図画像は未登録です（架空地図の生成は行いません）');
      return;
    }

    let foundDel = null;
    const allLogs = (typeof store !== 'undefined' && store.state && store.state.dailyLogs) ? Object.values(store.state.dailyLogs) : [];
    for (const log of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          foundDel = d;
          break;
        }
      }
    }

    const titleEl = document.getElementById('trip-map-title');
    const pickupEl = document.getElementById('trip-map-pickup-name');
    const dropEl = document.getElementById('trip-map-drop-name');
    const metaEl = document.getElementById('trip-map-meta-info');
    const imgEl = document.getElementById('trip-map-img');
    const gmapsBtn = document.getElementById('btn-open-google-maps');

    const memoInput = document.getElementById('trip-map-memo-input');

    if (foundDel) {
      if (titleEl) titleEl.textContent = `🗺️ No.${foundDel.index || ''} 公式実績マップ`;
      if (pickupEl) pickupEl.textContent = foundDel.restaurant || '店舗名不明';
      if (dropEl) dropEl.textContent = (typeof formatDisplayAddress === 'function') ? formatDisplayAddress(foundDel.area) : (foundDel.area || '配達先');

      if (memoInput) {
        memoInput.value = (typeof store !== 'undefined' && store.getTripMapMemo)
          ? store.getTripMapMemo(deliveryId)
          : '';
        memoInput.oninput = (e) => {
          if (typeof store !== 'undefined' && store.setTripMapMemo) {
            store.setTripMapMemo(deliveryId, e.target.value);
          }
        };
        memoInput.onclick = (e) => e.stopPropagation();
        memoInput.onkeydown = (e) => e.stopPropagation();
      }

      const metaParts = [];
      if (foundDel.distanceKm !== null && foundDel.distanceKm !== undefined && foundDel.distanceKm !== '') {
        const distStr = (typeof foundDel.distanceKm === 'number') ? foundDel.distanceKm.toFixed(2) : String(foundDel.distanceKm);
        metaParts.push(`<span class="modal-meta-num">${distStr}</span><span class="modal-meta-unit">km</span>`);
      }
      if (foundDel.durationStr) {
        const formattedDur = (typeof formatDurationColon === 'function')
          ? formatDurationColon(foundDel.durationStr)
          : String(foundDel.durationStr);
        metaParts.push(`<span class="modal-meta-duration">${formattedDur}</span>`);
      }
      if (foundDel.fee !== null && foundDel.fee !== undefined) {
        metaParts.push(`<span class="modal-meta-fee">¥${Number(foundDel.fee).toLocaleString()}</span>`);
      }
      if (metaEl) {
        metaEl.innerHTML = metaParts.join('<span class="modal-meta-sep"> / </span>');
      }

      // Google Mapsで開くリンクの安全な共通生成
      if (gmapsBtn) {
        const origin = (foundDel.restaurant || '').trim();
        const destination = (foundDel.area || '').trim();
        if (origin && destination) {
          gmapsBtn.href = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
          gmapsBtn.style.display = 'inline-flex';
          gmapsBtn.title = `${origin} から ${destination} への経路検索を開く`;
        } else {
          gmapsBtn.removeAttribute('href');
          gmapsBtn.style.display = 'none';
        }
      }
    } else {
      if (titleEl) titleEl.textContent = '🗺️ 公式実績マップ';
      if (metaEl) metaEl.innerHTML = '';
      if (memoInput) {
        memoInput.value = '';
        memoInput.oninput = null;
      }
      if (gmapsBtn) {
        gmapsBtn.removeAttribute('href');
        gmapsBtn.style.display = 'none';
      }
    }

    if (imgEl) {
      imgEl.src = mapInfo.map;
      imgEl.alt = `${foundDel ? foundDel.restaurant : ''} 公式地図`;
    }

    modalOverlay.classList.add('active');

    const closeBtn = document.getElementById('btn-close-trip-map-modal');
    const dismissBtn = document.getElementById('btn-dismiss-trip-map');
    const closeModal = () => modalOverlay.classList.remove('active');
    if (closeBtn) closeBtn.onclick = closeModal;
    if (dismissBtn) dismissBtn.onclick = closeModal;
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) closeModal();
    };
  }

  // 配達詳細モーダルを開く
  openDeliveryModal(deliveryId) {
    const log = store.getDailyLog(this.currentDate);
    const del = log.deliveries.find(d => d.id === deliveryId);
    if (!del) return;

    this.selectedDelivery = del;

    document.getElementById('modal-title').textContent = `No.${del.index} 配達詳細`;
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
      const dateHtml = (typeof formatDateWithColoredWeekday === 'function') 
        ? formatDateWithColoredWeekday(log.date, false) 
        : ((typeof formatShortJapaneseDate === 'function') ? formatShortJapaneseDate(log.date, false) : formatJapaneseDate(log.date));

      // 日別属性の取得と「+N」集約ロジック（最大2個まで個別表示、3個以上は先頭2個 + [+N] に集約）
      const dayAttrs = (typeof store !== 'undefined' && store.getDayAttributes)
        ? store.getDayAttributes(log.date)
        : [];

      let visibleAttrs = [];
      let hiddenCount = 0;
      if (dayAttrs.length <= 2) {
        visibleAttrs = dayAttrs;
      } else {
        visibleAttrs = dayAttrs.slice(0, 2);
        hiddenCount = dayAttrs.length - 2;
      }

      let dayAttrsHtml = visibleAttrs.map(attr => `
        <span class="day-attr-badge ${attr.className}" title="${attr.fullName}">${attr.label}</span>
      `).join('');

      if (hiddenCount > 0) {
        const hiddenNames = dayAttrs.slice(2).map(a => a.fullName).join(', ');
        dayAttrsHtml += `
          <span class="day-attr-badge attr-more" title="他${hiddenCount}件: ${hiddenNames}">+${hiddenCount}</span>
        `;
      }

      const tripCount = log.tripsCount || (log.deliveries ? log.deliveries.length : metrics.count);
      const deliverySectionTitle = (tripCount !== metrics.count)
        ? `配達明細（全${tripCount}トリップ / ${metrics.count}件）`
        : `配達明細（全${metrics.count}件）`;

      // 公式トリップが存在する場合は手動空タップ残骸を非表示
      const hasOfficial = (log.deliveries || []).some(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
      const histDeliveries = hasOfficial
        ? (log.deliveries || []).filter(d => d.restaurant || (d.fee !== null && d.fee !== undefined))
        : (log.deliveries || []);

      // 日別詳細上部の距離・配達時間・時給サマリー
      const distVal = metrics.totalDistanceKm !== null ? metrics.totalDistanceKm : metrics.uberDeliveryDistanceKm;
      const distText = distVal !== null ? `${distVal}km` : '未記録';
      const workText = metrics.workMinutes !== null ? formatMinutes(metrics.workMinutes) : '未記録';
      const wageText = metrics.hourlyWage !== null ? `¥${metrics.hourlyWage.toLocaleString()}` : null;

      // 追加収支カード群（プラス収支 -> マイナス収支の順）
      const additionalCards = [];

      // 1. 特別収入カード（プラス）
      if (metrics.guaranteeBonus > 0) {
        additionalCards.push(`
          <div class="balance-card card-bonus">
            <div class="balance-card-left">
              <span class="day-attr-badge attr-bonus">賞</span>
              <div class="balance-card-info">
                <span class="balance-card-title">特別収入（新規保証）</span>
                ${metrics.milestone ? `<span class="balance-card-sub">${metrics.milestone}</span>` : ''}
              </div>
            </div>
            <span class="balance-card-amount">+¥${metrics.guaranteeBonus.toLocaleString()}</span>
          </div>
        `);
      }

      // 2. 売上調整金カード（プラス）
      if (metrics.adjustmentSales > 0) {
        additionalCards.push(`
          <div class="balance-card card-adjustment">
            <div class="balance-card-left">
              <span class="day-attr-badge attr-adjustment">調</span>
              <div class="balance-card-info">
                <span class="balance-card-title">売上調整金</span>
              </div>
            </div>
            <span class="balance-card-amount">+¥${metrics.adjustmentSales.toLocaleString()}</span>
          </div>
        `);
      }

      // 3. バイクシェア利用カード（マイナス）
      if (metrics.totalExpenses > 0) {
        additionalCards.push(`
          <div class="balance-card card-bike">
            <div class="balance-card-left">
              <span class="day-attr-badge attr-bike">B</span>
              <div class="balance-card-info">
                <span class="balance-card-title">バイクシェア利用</span>
              </div>
            </div>
            <span class="balance-card-amount">-¥${metrics.totalExpenses.toLocaleString()}</span>
          </div>
        `);
      }

      return `
        <div class="history-card" data-date="${log.date}">
          <!-- 日付バー（完全1行構成: 日付＋利益 / 属性＋▼） -->
          <div class="history-card-header">
            <div class="history-header-left">
              <div class="history-date-title">
                ${dateHtml}
              </div>
              <div class="history-profit-item">
                利益 <span class="h-sub-val val-profit">${metrics.netProfit !== null ? `¥${metrics.netProfit.toLocaleString()}` : '--'}</span>
              </div>
            </div>
            <div class="history-header-right">
              ${dayAttrsHtml ? `<div class="day-attributes">${dayAttrsHtml}</div>` : ''}
              <span class="expand-icon">▼</span>
            </div>
          </div>

          <!-- 展開内部（タップ時のみ展開表示） -->
          <div class="history-card-body">
            <!-- ① 基本実績（全日統一） -->
            <div class="history-stats-grid">
              <div class="h-stat-col">
                <span class="h-stat-label">配達</span>
                <span class="h-stat-val">${metrics.count}件</span>
              </div>
              <div class="h-stat-col">
                <span class="h-stat-label">売上</span>
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
              <!-- ② 基本メトリクス（走行 / 配達時間 / 時給） -->
              <div class="history-metrics-strip">
                <div class="h-metric-item">
                  <span class="h-metric-lbl">走行</span>
                  <span class="h-metric-num">${distText}</span>
                </div>
                <span class="h-metric-divider">/</span>
                <div class="h-metric-item">
                  <span class="h-metric-lbl">配達時間</span>
                  <span class="h-metric-num">${workText}</span>
                </div>
                ${wageText ? `
                  <span class="h-metric-divider">/</span>
                  <div class="h-metric-item">
                    <span class="h-metric-lbl">時給</span>
                    <span class="h-metric-num">${wageText}</span>
                  </div>
                ` : ''}
              </div>

              <!-- ③ 追加収支カード群（基本メトリクスの下、配達明細の上） -->
              ${additionalCards.length > 0 ? `
                <div class="history-additional-balances">
                  ${additionalCards.join('')}
                </div>
              ` : ''}

              <!-- ④ 配達明細 -->
              <div class="history-deliveries-section-title">${deliverySectionTitle}</div>
              <div class="delivery-list">
                ${histDeliveries.map(d => this.renderDeliveryCardHtml(d, false, log.date)).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // single-open アコーディオン展開イベント（常に最大1日だけ展開）
    container.querySelectorAll('.history-card-header').forEach(header => {
      header.addEventListener('click', () => {
        const card = header.closest('.history-card');
        const isCurrentlyExpanded = card.classList.contains('expanded');

        // 他の展開中カードをすべて閉じる
        container.querySelectorAll('.history-card.expanded').forEach(otherCard => {
          otherCard.classList.remove('expanded');
          const otherIcon = otherCard.querySelector('.expand-icon');
          if (otherIcon) otherIcon.textContent = '▼';
        });

        // 閉じていたカードをタップした場合は展開する（既に開いていた場合は閉じたまま）
        if (!isCurrentlyExpanded) {
          card.classList.add('expanded');
          const icon = card.querySelector('.expand-icon');
          if (icon) icon.textContent = '▲';
        }
      });
    });

    // ○／×評価ボタンイベント
    container.querySelectorAll('.btn-eval').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const evalGroup = btn.closest('.trip-eval-buttons');
        if (!evalGroup) return;
        const delId = evalGroup.getAttribute('data-del-id');
        const val = btn.getAttribute('data-val');
        const isCurrentlyActive = btn.classList.contains('active');
        const newVal = isCurrentlyActive ? null : val;

        store.setTripEvaluation(delId, newVal);

        evalGroup.querySelectorAll('.btn-eval').forEach(b => b.classList.remove('active'));
        const evalBox = container.querySelector(`#eval-box-${delId}`);
        const reasonInput = evalBox ? evalBox.querySelector('.input-eval-reason') : null;

        if (newVal) {
          btn.classList.add('active');
          if (evalBox) {
            evalBox.style.display = 'block';
            if (reasonInput) {
              reasonInput.placeholder = newVal === 'OK' ? '○の理由（例: 店も配達先も楽、高単価）' : '×の理由（例: 入館ロス、大迂回、トンネル）';
              if (newVal === 'AVOID') {
                reasonInput.classList.add('avoid-focus');
              } else {
                reasonInput.classList.remove('avoid-focus');
              }
            }
          }
          this.showToast(newVal === 'OK' ? '評価「○」を保存しました' : '評価「×」を保存しました');
        } else {
          if (evalBox) {
            evalBox.style.display = 'none';
          }
          this.showToast('評価を解除しました');
        }
      });
    });

    // 評価理由メモ入力イベント
    container.querySelectorAll('.input-eval-reason').forEach(input => {
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('input', (e) => {
        e.stopPropagation();
        const delId = input.getAttribute('data-del-id');
        if (delId && typeof store !== 'undefined' && store.setTripEvaluationReason) {
          store.setTripEvaluationReason(delId, input.value);
        }
      });
    });

    // 地図ボタンイベント
    container.querySelectorAll('.btn-trip-map').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const delId = btn.getAttribute('data-del-id');
        this.openTripMapModal(delId);
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

    const monthNoteEl = document.getElementById('month-sales-note');
    if (monthNoteEl) monthNoteEl.textContent = rev.thisMonth.note;

    const cumPeriodEl = document.getElementById('cumulative-sales-period');
    if (cumPeriodEl) cumPeriodEl.textContent = rev.registeredTotal.periodLabel;

    const cumValEl = document.getElementById('cumulative-sales-val');
    if (cumValEl) cumValEl.textContent = `¥${rev.registeredTotal.sales.toLocaleString()}`;

    const cumNoteEl = document.getElementById('cumulative-sales-note');
    if (cumNoteEl) cumNoteEl.textContent = rev.registeredTotal.note;

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
      totalDistEl.textContent = analytics.totalDistanceSum !== null ? `${analytics.totalDistanceSum.toFixed(1)} km` : '--';
    }

    // 日別実績テーブル（常に最新日を一番上にする降順表示：9/18 → 9/17 → 9/16 → 9/15 → 9/14）
    const tableBody = document.getElementById('recent-7days-table-body');
    if (tableBody) {
      const allLogs = store.getAllDailyLogs();
      const activeLogs = allLogs.filter(log => {
        const m = store.getCalculatedMetrics(log);
        return m.count > 0 || m.totalSales !== null;
      });
      tableBody.innerHTML = activeLogs.map(log => {
        const m = store.getCalculatedMetrics(log);
        return `
          <tr>
            <td><strong>${formatDateWithWeekday(log.date, false)}</strong></td>
            <td>${m.count}件</td>
            <td>${m.deliverySales !== null ? `¥${m.deliverySales.toLocaleString()}` : '--'}</td>
            <td>${m.questSales !== null ? `¥${m.questSales.toLocaleString()}` : '¥0'}</td>
            <td style="font-weight:700; color:var(--color-uber-green);">${m.totalSales !== null ? `¥${m.totalSales.toLocaleString()}` : '--'}${m.guaranteeBonus > 0 ? `<div style="font-size:10px; color:#fbbf24; font-weight:normal; margin-top:2px;">*保証込 ¥${m.totalSalesWithBonus.toLocaleString()}</div>` : ''}</td>
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
              ${formatDateWithWeekday(bm.date, true)} ${bm.completedAt || ''} 実走データ
            </div>
            <div class="benchmark-route" style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:8px;">
              📍 ${bm.pickup} ➔ ${(typeof formatDisplayAddress === 'function') ? formatDisplayAddress(bm.drop) : bm.drop}
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

