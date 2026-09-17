/**
 * UBER LOG V1.1 - Data Store Module
 * 
 * 責務:
 * - LocalStorageを用いたデータの永続化
 * - 稼働時間の複数セッション制管理（何部でも追加・休憩可能、実稼働時間と実質時給の厳密算出、概算時刻対応）
 * - 公式正本売上（17,080円）と明細集計（17,084円、要確認差額+4円）の監査管理
 * - クエスト二重計上防止ロジック
 * - 距離指標の整理（Uber表示配達距離と空走距離の分離、手動入力・平均距離の排除）
 * - 地雷（配達効率判断）データベースの3段階評価管理（地雷／要検証／問題なし）と実走事例蓄積
 */

const STORAGE_KEY = 'uber_log_v1_data';

// 稼働時刻選択の刻み間隔（分）。将来15分等への変更もここを変更するだけで対応可能
const WORK_TIME_STEP_MINUTES = 30;

// 30分単位の時刻選択肢リスト生成（例: 06:00, 06:30, ..., 23:30）
function getTimeOptions(stepMinutes = WORK_TIME_STEP_MINUTES) {
  const options = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      options.push(`${hh}:${mm}`);
    }
  }
  return options;
}

// 時刻文字列を最寄りの刻み間隔に丸める（秒はUI/入力から完全排除）
function roundToTimeStep(timeStr, stepMinutes = WORK_TIME_STEP_MINUTES) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return timeStr;
  
  const totalMinutes = h * 60 + m;
  const rounded = Math.round(totalMinutes / stepMinutes) * stepMinutes;
  const rh = Math.floor(rounded / 60) % 24;
  const rm = rounded % 60;
  return `${String(rh).padStart(2, '0')}:${String(rm).padStart(2, '0')}`;
}

// 公式正本売上（2026-09-14 ～ 2026-09-17）
const OFFICIAL_SOURCE_OF_TRUTH = {
  period: '2026-09-14 ～ 2026-09-17',
  startDate: '2026-09-14',
  endDate: '2026-09-17',
  officialTotal: 17080, // 正式な帳簿上の売上（Uber公式画面最終合計）
  statusDescription: '正式売上: ¥17,080 / 分析用明細集計: ¥17,084（要確認差額: +4円 / 原因不明）'
};

// 地雷（配達効率判断）データベース - 育てるDB・3段階評価
const AVOIDANCE_DATABASE = {
  policy: '絶対拒否ではなく「原則回避」。すでにそのエリア内にいて近距離で完結する高効率案件等は例外になり得る。施設タイプは分類情報であり、個別スポット・実走経験を評価対象とする。',
  evaluationStatuses: {
    AVOID: { code: 'AVOID', label: '地雷', icon: '🚫', badgeClass: 'badge-avoid' },
    VERIFY: { code: 'VERIFY', label: '要検証', icon: '⚠️', badgeClass: 'badge-verify' },
    OK: { code: 'OK', label: '問題なし', icon: '✅', badgeClass: 'badge-ok' }
  },
  reasonCategories: [
    '橋',
    '階段',
    '自転車移動困難',
    '駐輪',
    '入口',
    'エレベーター',
    '館内徒歩',
    '退館導線',
    '長距離',
    '帰路の空走',
    'その他メモ'
  ],
  areas: [
    {
      id: 'area_sample_bridge',
      name: '長距離・長大橋方面',
      location: '一般注意エリア',
      status: 'AVOID',
      tags: ['橋', '長距離', '帰路の空走'],
      reason: '長大橋越え、急坂・階段、自転車帰還困難、空走リスク大（一般事例）'
    }
  ],
  facilities: [
    {
      id: 'fac_tower',
      type: '大型タワーマンション',
      role: '分類情報（※一律拒否ではなく個別スポット・実走経験を評価）',
      tags: ['駐輪', '入口', 'エレベーター', '館内徒歩', '退館導線'],
      reason: '駐輪場所、防災センター入館手続き、入口探索、エレベーター待ち、高層階移動ロス'
    },
    {
      id: 'fac_commercial',
      type: '大型商業施設',
      role: '分類情報（※一律拒否ではなく個別スポット・実走経験を評価）',
      tags: ['駐輪', '入口', '館内徒歩', '退館導線'],
      reason: '駐輪場所、入館手続き、入口探索、館内長距離徒歩、退出導線ロス'
    },
    {
      id: 'fac_hotel',
      type: '大型ホテル／観光施設',
      role: '分類情報（※一律拒否ではなく個別スポット・実走経験を評価）',
      tags: ['駐輪', '入口', '館内徒歩', '退館導線'],
      reason: '駐輪困難、フロント/入口探索、入館手続き、館内徒歩・退出導線ロス'
    }
  ],
  benchmarks: [],
  customSpots: []
};

// 既存コードとの後方互換性エイリアス
const AVOIDANCE_RULES = {
  ...AVOIDANCE_DATABASE,
  areaPolicy: AVOIDANCE_DATABASE.policy
};

// 初期シードデータ（個人実績データは内包せず、空の状態で初期化。Supabaseログイン後にRLSで取得）
function getConfirmedSeedData() {
  return {
    version: '1.2',
    dailyLogs: {}
  };
}

// 今日の日付文字列（YYYY-MM-DD）を取得
function getTodayDateString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 現在時刻文字列（HH:mm）を取得
function getCurrentTimeString(d = new Date()) {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// 日本の祝日データ（将来の祝日判定拡張用辞書。データがない日は推測判定しない）
const JAPAN_HOLIDAYS = {
  // 'YYYY-MM-DD': '祝日名'
  // 例: '2026-09-21': '敬老の日', '2026-09-22': '国民の休日', '2026-09-23': '秋分の日'
};

// 曜日・祝日判定ヘルパー
function getDayOfWeekInfo(dateStr) {
  if (!dateStr) return null;
  const cleanStr = dateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayIndex = dateObj.getDay();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekdayChar = weekdays[dayIndex];

  const holidayName = JAPAN_HOLIDAYS[cleanStr] || null;
  const isHoliday = !!holidayName;
  const isSunday = dayIndex === 0;
  const isSaturday = dayIndex === 6;

  let colorType = 'weekday'; // 'weekday' | 'saturday' | 'sunday' | 'holiday'
  if (isHoliday || isSunday) {
    colorType = isHoliday ? 'holiday' : 'sunday';
  } else if (isSaturday) {
    colorType = 'saturday';
  }

  return {
    dayIndex,
    weekdayChar,
    isSaturday,
    isSunday,
    isHoliday,
    holidayName,
    colorType
  };
}

// 日本語日付表記を取得（例: 2026年9月17日（木））
function formatJapaneseDate(dateStr) {
  if (!dateStr) return '';
  const info = getDayOfWeekInfo(dateStr);
  const [y, m, d] = dateStr.replace(/\//g, '-').split('-').map(Number);
  return `${y}年${m}月${d}日（${info ? info.weekdayChar : ''}）`;
}

// 「YYYY/MM/DD（曜日）」形式で曜日文字にクラスを付与
function formatDateWithWeekday(dateStr, includeYear = true) {
  if (!dateStr) return '';
  const cleanStr = dateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const info = getDayOfWeekInfo(cleanStr);
  const mStr = String(m).padStart(2, '0');
  const dStr = String(d).padStart(2, '0');
  const base = includeYear ? `${y}/${mStr}/${dStr}` : `${mStr}/${dStr}`;

  let spanClass = 'weekday-text';
  if (info.colorType === 'saturday') {
    spanClass = 'weekday-text sat';
  } else if (info.colorType === 'sunday' || info.colorType === 'holiday') {
    spanClass = 'weekday-text sun-hol';
  }

  return `${base}<span class="${spanClass}">（${info.weekdayChar}）</span>`;
}

// 週の範囲（月曜日〜日曜日）を取得
function getWeekRange(dateStr) {
  const [y, m, d] = dateStr.replace(/\//g, '-').split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const day = dateObj.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);

  const monday = new Date(dateObj);
  monday.setDate(dateObj.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (dt) => {
    const yr = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  };

  return {
    startStr: fmt(monday),
    endStr: fmt(sunday),
    mondayDate: monday,
    sundayDate: sunday
  };
}

// 先週の範囲（前週月曜日〜前週日曜日）を取得
function getPreviousWeekRange(dateStr) {
  const currentWeek = getWeekRange(dateStr);
  const prevMonday = new Date(currentWeek.mondayDate);
  prevMonday.setDate(prevMonday.getDate() - 7);

  const prevSunday = new Date(prevMonday);
  prevSunday.setDate(prevMonday.getDate() + 6);

  const fmt = (dt) => {
    const yr = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  };

  return {
    startStr: fmt(prevMonday),
    endStr: fmt(prevSunday)
  };
}

// 稼働時間の計算（分）
function calculateMinutesBetween(startHHmm, endHHmm) {
  if (!startHHmm || !endHHmm) return 0;
  const [sh, sm] = startHHmm.split(':').map(Number);
  const [eh, em] = endHHmm.split(':').map(Number);
  if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return 0;
  
  let startTotal = sh * 60 + sm;
  let endTotal = eh * 60 + em;
  
  // 日跨ぎの場合
  if (endTotal < startTotal) {
    endTotal += 24 * 60;
  }
  return Math.max(0, endTotal - startTotal);
}

// 分を「X時間Y分」または「Y分」にフォーマット
function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || isNaN(minutes) || minutes <= 0) return '0分';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}時間${m}分`;
  if (h > 0) return `${h}時間`;
  return `${m}分`;
}

// クエスト二重計上検知・排除ロジック
function deduplicateQuests(questList = []) {
  if (!Array.isArray(questList)) return [];
  
  const processed = [];
  const seenKeys = new Set();

  questList.forEach((q) => {
    const rawTime = (q.time || '').replace(/頃/, '').trim();
    const amount = Number(q.amount) || 0;
    
    // 同額かつ同一（または近接）時刻のキー
    const key = `${rawTime}_${amount}`;

    if (seenKeys.has(key)) {
      // 二重表示と判定して除外フラグを立てる
      processed.push({
        ...q,
        isDuplicateIgnored: true,
        dedupReason: '「クエスト」と「1回乗車クエスト」等の重複表示検知により二重加算除外'
      });
    } else {
      seenKeys.add(key);
      processed.push({
        ...q,
        isDuplicateIgnored: false
      });
    }
  });

  return processed;
}

class Store {
  constructor() {
    this.state = this.loadFromStorage();
  }

  // LocalStorageから読み込み（初回起動時は空シードをロード、既存データは完全保持）
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') {
        return getConfirmedSeedData();
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seed = getConfirmedSeedData();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
        } catch (e) {}
        return seed;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.dailyLogs) {
        const seed = getConfirmedSeedData();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
        } catch (e) {}
        return seed;
      }
      return parsed;
    } catch (e) {
      console.error('UBER_LOG: Failed to load from storage', e);
      return getConfirmedSeedData();
    }
  }

  // LocalStorageへ保存 & クラウド同期フック呼び出し
  saveToStorage(changedDate = null) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
      if (typeof window !== 'undefined' && window.cloudSync && typeof window.cloudSync.onLocalDataSaved === 'function') {
        window.cloudSync.onLocalDataSaved(changedDate);
      }
    } catch (e) {
      console.error('UBER_LOG: Failed to save to storage', e);
    }
  }

  // 指定日のログを取得（存在しなければ初期化して返す）
  getDailyLog(dateStr = getTodayDateString()) {
    if (!this.state.dailyLogs[dateStr]) {
      this.state.dailyLogs[dateStr] = {
        date: dateStr,
        workStartedAt: null,
        workEndedAt: null,
        workMinutes: null,
        totalDistanceKm: null,
        workSessions: [],
        deliveries: [],
        quests: []
      };
    }
    const log = this.state.dailyLogs[dateStr];
    if (!log.deliveries) log.deliveries = [];
    if (!log.quests) log.quests = [];
    if (!log.workSessions) {
      log.workSessions = [];
      // 既存ログの後方互換自動変換
      if (log.workStartedAt) {
        log.workSessions.push({
          id: `sess_${Date.now()}_1`,
          start: log.workStartedAt,
          end: log.workEndedAt || null,
          isApproximate: false,
          note: '第1部'
        });
      }
    }
    return log;
  }

  // すべての日次ログを取得（日付降順）
  getAllDailyLogs() {
    return Object.values(this.state.dailyLogs).sort((a, b) => {
      return b.date.localeCompare(a.date);
    });
  }

  // 複数セッション制: 稼働セッション開始（第1部、第2部...）
  startWorkSession(dateStr = getTodayDateString(), timeStr = null, isApproximate = false, note = '') {
    const log = this.getDailyLog(dateStr);
    if (!log.workSessions) log.workSessions = [];

    // すでに未終了のセッションがあればそれを返す
    const active = log.workSessions.find(s => s.start && !s.end);
    if (active) {
      return { log, session: active, isNew: false };
    }

    const t = timeStr ? roundToTimeStep(timeStr) : roundToTimeStep(getCurrentTimeString());
    const nextPart = log.workSessions.length + 1;
    const session = {
      id: `sess_${Date.now()}_${nextPart}`,
      start: t,
      end: null,
      isApproximate: Boolean(isApproximate),
      note: note || `第${nextPart}部`
    };

    log.workSessions.push(session);
    this.syncLegacyWorkInfo(log);
    this.saveToStorage();
    return { log, session, isNew: true };
  }

  // 複数セッション制: 進行中のセッションを終了（休憩または終了）
  endWorkSession(dateStr = getTodayDateString(), timeStr = null, sessionId = null, isApproximate = false) {
    const log = this.getDailyLog(dateStr);
    if (!log.workSessions) log.workSessions = [];

    let targetSession = null;
    if (sessionId) {
      targetSession = log.workSessions.find(s => s.id === sessionId);
    } else {
      // 最後の未終了セッションを探す
      targetSession = [...log.workSessions].reverse().find(s => s.start && !s.end);
    }

    if (!targetSession) {
      return { log, session: null };
    }

    const t = timeStr ? roundToTimeStep(timeStr) : roundToTimeStep(getCurrentTimeString());
    targetSession.end = t;
    if (isApproximate !== undefined) {
      targetSession.isApproximate = Boolean(isApproximate) || targetSession.isApproximate;
    }

    this.syncLegacyWorkInfo(log);
    this.saveToStorage();
    return { log, session: targetSession };
  }

  // 複数セッション制: セッションの手動追加
  addWorkSession(dateStr, { start, end, isApproximate, note }) {
    const log = this.getDailyLog(dateStr);
    if (!log.workSessions) log.workSessions = [];

    const nextPart = log.workSessions.length + 1;
    const session = {
      id: `sess_${Date.now()}_${nextPart}`,
      start: start ? roundToTimeStep(start) : '09:00',
      end: end ? roundToTimeStep(end) : null,
      isApproximate: Boolean(isApproximate),
      note: note || `第${nextPart}部`
    };

    log.workSessions.push(session);
    this.syncLegacyWorkInfo(log);
    this.saveToStorage();
    return session;
  }

  // 複数セッション制: セッションの修正
  updateWorkSession(dateStr, sessionId, updateFields) {
    const log = this.getDailyLog(dateStr);
    if (!log.workSessions) log.workSessions = [];

    const idx = log.workSessions.findIndex(s => s.id === sessionId);
    if (idx !== -1) {
      const current = log.workSessions[idx];
      log.workSessions[idx] = {
        ...current,
        ...updateFields,
        start: updateFields.start !== undefined ? (updateFields.start ? roundToTimeStep(updateFields.start) : current.start) : current.start,
        end: updateFields.end !== undefined ? (updateFields.end ? roundToTimeStep(updateFields.end) : null) : current.end,
        isApproximate: updateFields.isApproximate !== undefined ? Boolean(updateFields.isApproximate) : current.isApproximate
      };
      this.syncLegacyWorkInfo(log);
      this.saveToStorage();
      return log.workSessions[idx];
    }
    return null;
  }

  // 複数セッション制: セッションの削除
  deleteWorkSession(dateStr, sessionId) {
    const log = this.getDailyLog(dateStr);
    if (!log.workSessions) return null;

    const idx = log.workSessions.findIndex(s => s.id === sessionId);
    if (idx !== -1) {
      const removed = log.workSessions.splice(idx, 1)[0];
      this.syncLegacyWorkInfo(log);
      this.saveToStorage();
      return removed;
    }
    return null;
  }

  // 後方互換性用: workStartedAt / workEndedAt / workMinutes を workSessions と同期
  syncLegacyWorkInfo(log) {
    if (!log.workSessions || log.workSessions.length === 0) {
      log.workStartedAt = null;
      log.workEndedAt = null;
      log.workMinutes = null;
      return;
    }
    const sorted = [...log.workSessions].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    log.workStartedAt = sorted[0].start || null;
    const lastSession = sorted[sorted.length - 1];
    log.workEndedAt = lastSession.end || null;

    let totalMins = 0;
    let hasCompleted = false;
    log.workSessions.forEach(s => {
      if (s.start && s.end) {
        totalMins += calculateMinutesBetween(s.start, s.end);
        hasCompleted = true;
      }
    });
    log.workMinutes = hasCompleted ? totalMins : null;
  }

  // 配達1件完了を即時記録（1タップ記録）
  addDelivery(dateStr = getTodayDateString(), timeStr = getCurrentTimeString()) {
    const log = this.getDailyLog(dateStr);
    const nextIndex = log.deliveries.length + 1;
    const delivery = {
      id: `del_${Date.now()}_${nextIndex}`,
      index: nextIndex,
      completedAt: timeStr,
      restaurant: '',
      area: '',
      fee: null,
      distanceKm: null,
      durationStr: '',
      memo: ''
    };

    log.deliveries.push(delivery);
    this.saveToStorage();
    return { log, delivery };
  }

  // 直前の配達記録を取り消す
  undoLastDelivery(dateStr = getTodayDateString()) {
    const log = this.getDailyLog(dateStr);
    if (!log.deliveries || log.deliveries.length === 0) {
      return null;
    }
    const removed = log.deliveries.pop();
    this.saveToStorage();
    return { log, removed };
  }

  // 単一の配達詳細を更新
  updateDelivery(dateStr, deliveryId, updateFields) {
    const log = this.getDailyLog(dateStr);
    const idx = log.deliveries.findIndex(d => d.id === deliveryId);
    if (idx !== -1) {
      log.deliveries[idx] = {
        ...log.deliveries[idx],
        ...updateFields
      };
      this.saveToStorage();
      return log.deliveries[idx];
    }
    return null;
  }

  // 配達を削除
  deleteDelivery(dateStr, deliveryId) {
    const log = this.getDailyLog(dateStr);
    const idx = log.deliveries.findIndex(d => d.id === deliveryId);
    if (idx !== -1) {
      const removed = log.deliveries.splice(idx, 1)[0];
      log.deliveries.forEach((d, i) => {
        d.index = i + 1;
      });
      this.saveToStorage();
      return removed;
    }
    return null;
  }

  // クエストを追加
  addQuest(dateStr, { time, title, amount }) {
    const log = this.getDailyLog(dateStr);
    const quest = {
      id: `quest_${Date.now()}`,
      time: time || getCurrentTimeString(),
      title: title || 'クエスト',
      amount: Number(amount) || 0,
      isDuplicateIgnored: false
    };
    log.quests.push(quest);
    log.quests = deduplicateQuests(log.quests);
    this.saveToStorage();
    return quest;
  }

  // クエストを削除
  deleteQuest(dateStr, questId) {
    const log = this.getDailyLog(dateStr);
    const idx = log.quests.findIndex(q => q.id === questId);
    if (idx !== -1) {
      const removed = log.quests.splice(idx, 1)[0];
      log.quests = deduplicateQuests(log.quests);
      this.saveToStorage();
      return removed;
    }
    return null;
  }

  // 稼働開始（出発）- 既存互換ラッパー
  startWork(dateStr = getTodayDateString(), timeStr = getCurrentTimeString()) {
    const res = this.startWorkSession(dateStr, timeStr);
    return res.log;
  }

  // 稼働終了（帰宅）- 既存互換ラッパー
  endWork(dateStr = getTodayDateString(), timeStr = getCurrentTimeString()) {
    const res = this.endWorkSession(dateStr, timeStr);
    return res.log;
  }

  // 稼働状態の更新 - 既存互換ラッパー
  updateWorkInfo(dateStr, { workStartedAt, workEndedAt }) {
    const log = this.getDailyLog(dateStr);
    if (workStartedAt !== undefined) log.workStartedAt = workStartedAt || null;
    if (workEndedAt !== undefined) log.workEndedAt = workEndedAt || null;

    if (log.workStartedAt || log.workEndedAt) {
      if (!log.workSessions || log.workSessions.length === 0) {
        log.workSessions = [{
          id: `sess_${Date.now()}_1`,
          start: log.workStartedAt ? roundToTimeStep(log.workStartedAt) : null,
          end: log.workEndedAt ? roundToTimeStep(log.workEndedAt) : null,
          isApproximate: false,
          note: '第1部'
        }];
      } else {
        log.workSessions[0].start = log.workStartedAt ? roundToTimeStep(log.workStartedAt) : log.workSessions[0].start;
        log.workSessions[0].end = log.workEndedAt ? roundToTimeStep(log.workEndedAt) : log.workSessions[0].end;
      }
    }
    this.syncLegacyWorkInfo(log);
    this.saveToStorage();
    return log;
  }

  // ダッシュボード数値（総走行距離、手動売上等）の更新
  updateDailyNumbers(dateStr, { totalDistanceKm, uberSales, quest }) {
    const log = this.getDailyLog(dateStr);
    if (totalDistanceKm !== undefined) {
      log.totalDistanceKm = (totalDistanceKm === '' || totalDistanceKm === null || isNaN(Number(totalDistanceKm)))
        ? null : Number(totalDistanceKm);
    }
    if (uberSales !== undefined) {
      log.manualUberSales = (uberSales === '' || uberSales === null || isNaN(Number(uberSales))) ? null : Number(uberSales);
    }
    if (quest !== undefined) {
      log.manualQuest = (quest === '' || quest === null || isNaN(Number(quest))) ? null : Number(quest);
    }
    this.saveToStorage();
    return log;
  }

  // 日別実運用指標の厳密計算（推測補完を排除、複数セッション実稼働時間・実質時給対応）
  getCalculatedMetrics(log) {
    const count = log.deliveries ? log.deliveries.length : 0;
    
    // 通常配達報酬の計算（明細のfee合算、または手動値）
    let deliverySales = null;
    if (log.deliveries && log.deliveries.length > 0) {
      let sum = 0;
      let hasValidFee = false;
      log.deliveries.forEach(d => {
        if (d.fee !== null && d.fee !== undefined && !isNaN(Number(d.fee))) {
          sum += Number(d.fee);
          hasValidFee = true;
        }
      });
      if (hasValidFee) {
        deliverySales = sum;
      }
    }
    if (deliverySales === null && log.manualUberSales !== undefined && log.manualUberSales !== null) {
      deliverySales = Number(log.manualUberSales);
    }

    // クエスト報酬の計算（二重計上を除外した有効クエスト合算、または手動値）
    let questSales = null;
    const dedupedQuests = deduplicateQuests(log.quests || []);
    const validQuests = dedupedQuests.filter(q => !q.isDuplicateIgnored);
    if (dedupedQuests.length > 0) {
      questSales = validQuests.reduce((acc, q) => acc + (Number(q.amount) || 0), 0);
    } else if (log.manualQuest !== undefined && log.manualQuest !== null) {
      questSales = Number(log.manualQuest);
    }

    // 1日総売上（通常配達報酬 ＋ クエスト報酬）
    let totalSales = null;
    if (deliverySales !== null || questSales !== null) {
      totalSales = (deliverySales || 0) + (questSales || 0);
    }

    // 総走行距離（確定データのみ、主要指標からは整理）
    const totalDistanceKm = (log.totalDistanceKm !== null && log.totalDistanceKm !== undefined && !isNaN(Number(log.totalDistanceKm)))
      ? Number(log.totalDistanceKm) : null;

    // A. Uber表示配達距離（明細のdistanceKm合算：主要指標）
    let uberDeliveryDistanceKm = null;
    let distanceRecordedCount = 0;
    if (log.deliveries && log.deliveries.length > 0) {
      let distSum = 0;
      let hasDist = false;
      log.deliveries.forEach(d => {
        if (d.distanceKm !== null && d.distanceKm !== undefined && !isNaN(Number(d.distanceKm))) {
          distSum += Number(d.distanceKm);
          hasDist = true;
          distanceRecordedCount++;
        }
      });
      if (hasDist) {
        uberDeliveryDistanceKm = Number(distSum.toFixed(2));
      }
    }

    // 全配達分の確定距離が揃っているか
    const isFullDistanceRecorded = (count > 0 && distanceRecordedCount === count);

    // B. 空走距離（現時点では実測・確定データが存在しないため推測補完せず算出不可/null）
    const deadheadDistanceKm = null;

    // 総実移動距離（将来用: Uber表示配達距離 + 空走距離）
    const totalActualDistanceKm = uberDeliveryDistanceKm !== null ? uberDeliveryDistanceKm : null;

    // 実質稼働時間（全workSessionの end - start の合計分。休憩時間は完全除外）
    let workMinutes = null;
    let isDurationApproximate = false;
    let hasActiveSession = false;

    if (log.workSessions && log.workSessions.length > 0) {
      let totalMins = 0;
      let hasCompletedSession = false;

      log.workSessions.forEach(s => {
        if (s.isApproximate) {
          isDurationApproximate = true;
        }
        if (s.start && s.end) {
          const m = calculateMinutesBetween(s.start, s.end);
          totalMins += m;
          hasCompletedSession = true;
        } else if (s.start && !s.end) {
          hasActiveSession = true;
        }
      });

      if (hasCompletedSession) {
        workMinutes = totalMins;
      }
    } else if (log.workMinutes && log.workMinutes > 0) {
      workMinutes = log.workMinutes;
    } else if (log.workStartedAt && log.workEndedAt) {
      workMinutes = calculateMinutesBetween(log.workStartedAt, log.workEndedAt);
    }

    // 売上 ÷ 実質稼働時間による実質時給（両方確定している場合のみ算出）
    let hourlyWage = null;
    if (totalSales !== null && workMinutes !== null && workMinutes > 0) {
      hourlyWage = Math.round(totalSales / (workMinutes / 60));
    }

    // 1件あたり平均報酬
    let avgFeePerDelivery = null;
    if (totalSales !== null && count > 0) {
      avgFeePerDelivery = Math.round(totalSales / count);
    }

    // 1件あたり平均距離（後方互換用）
    let avgDistPerDelivery = null;
    if (uberDeliveryDistanceKm !== null && isFullDistanceRecorded) {
      avgDistPerDelivery = Number((uberDeliveryDistanceKm / count).toFixed(2));
    }

    return {
      date: log.date,
      count,
      deliverySales,
      questSales,
      totalSales,
      totalDistanceKm,
      uberDeliveryDistanceKm,
      deadheadDistanceKm,
      totalActualDistanceKm,
      distanceRecordedCount,
      isFullDistanceRecorded,
      workMinutes,
      hourlyWage,
      isDurationApproximate,
      hasActiveSession,
      workSessions: log.workSessions || [],
      avgFeePerDelivery,
      avgDistPerDelivery,
      quests: dedupedQuests
    };
  }

  // 地雷DBの評価ステータス更新（育てるDB: AVOID | VERIFY | OK）
  updateBenchmarkStatus(benchmarkId, newStatus) {
    const bm = AVOIDANCE_DATABASE.benchmarks.find(b => b.id === benchmarkId);
    if (bm) {
      bm.status = newStatus;
      const statusMeta = AVOIDANCE_DATABASE.evaluationStatuses[newStatus];
      if (statusMeta) {
        bm.statusLabel = statusMeta.label;
      }
      this.saveToStorage();
      return bm;
    }
    return null;
  }

  // 正本（17,080円）と明細集計（17,084円）の監査・突合
  getSourceOfTruthAudit() {
    const targetDates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
    
    const dailyBreakdown = [];
    let sumDeliveries = 0;
    let sumDeliverySales = 0;
    let sumQuestSales = 0;
    let sumTotalSales = 0;

    targetDates.forEach(d => {
      const log = this.getDailyLog(d);
      const metrics = this.getCalculatedMetrics(log);

      sumDeliveries += metrics.count;
      sumDeliverySales += metrics.deliverySales || 0;
      sumQuestSales += metrics.questSales || 0;
      sumTotalSales += metrics.totalSales || 0;

      dailyBreakdown.push({
        date: d,
        count: metrics.count,
        deliverySales: metrics.deliverySales,
        questSales: metrics.questSales,
        dayTotal: metrics.totalSales,
        questsCount: (log.quests || []).length
      });
    });

    const officialTotal = OFFICIAL_SOURCE_OF_TRUTH.officialTotal;
    const calculatedTotal = sumTotalSales;
    const diff = calculatedTotal - officialTotal; // +4

    return {
      period: OFFICIAL_SOURCE_OF_TRUTH.period,
      officialTotal,       // 17,080（帳簿上の正式売上）
      calculatedTotal,     // 17,084（分析用明細集計）
      diff,                // +4（要確認差額）
      diffStatus: sumDeliveries === 0 ? 'PENDING_SYNC' : (diff === 0 ? 'MATCH' : 'UNCONFIRMED_DIFF'),
      diffMessage: sumDeliveries === 0
        ? '登録データ未取得（Supabaseログイン後に自動同期されます）'
        : (diff === 0 
          ? '正本（17,080円）と明細集計が完全一致しています。'
          : `要確認差額: +${diff.toLocaleString()}円（現時点では原因不明。架空補完レコードは作成せず差額として保持）`),
      totalDeliveries: sumDeliveries,
      totalDeliverySales: sumDeliverySales,
      totalQuestSales: sumQuestSales,
      dailyBreakdown
    };
  }

  // 週・月・累計の売上サマリー取得（今週の売上を最重要管理）
  getRevenueSummary(dateStr = getTodayDateString()) {
    const audit = this.getSourceOfTruthAudit();
    
    // 先週の確定売上集計（先週比較用：推測・捏造せずデータ存在時のみ比較）
    const prevWeekRange = getPreviousWeekRange(dateStr);
    const allLogs = this.getAllDailyLogs();
    const prevLogs = allLogs.filter(l => l.date >= prevWeekRange.startStr && l.date <= prevWeekRange.endStr);

    let hasPrevWeekData = false;
    let prevWeekSalesSum = 0;
    let prevWeekDeliveriesCount = 0;

    prevLogs.forEach(l => {
      const m = this.getCalculatedMetrics(l);
      if (m.count > 0 || m.totalSales !== null) {
        hasPrevWeekData = true;
        prevWeekSalesSum += (m.totalSales || 0);
        prevWeekDeliveriesCount += m.count;
      }
    });

    let prevWeekComparison = null;
    if (hasPrevWeekData) {
      const diff = audit.officialTotal - prevWeekSalesSum;
      prevWeekComparison = {
        hasComparison: true,
        diffAmount: diff,
        status: diff >= 0 ? 'positive' : 'negative',
        displayText: diff >= 0 ? `先週比 +¥${diff.toLocaleString()}` : `先週比 -¥${Math.abs(diff).toLocaleString()}`
      };
    } else {
      prevWeekComparison = {
        hasComparison: false,
        diffAmount: null,
        status: 'no-data',
        displayText: '先週比：比較データ未登録'
      };
    }

    // 今週の売上（2026-09-14〜2026-09-20）
    const thisWeek = {
      label: '今週の売上',
      periodLabel: '2026/09/14（月）〜 09/20（日）',
      startDate: '2026-09-14',
      endDate: '2026-09-20',
      officialSales: audit.officialTotal,     // 17,080円
      calculatedSales: audit.calculatedTotal, // 17,084円
      deliverySales: audit.totalDeliverySales, // 15,184円
      questSales: audit.totalQuestSales,       // 1,900円
      deliveriesCount: audit.totalDeliveries, // 30件
      note: '次回振込対象・当週確定売上（公式正本）',
      prevWeekComparison // 先週比較データ
    };

    // 今月の売上（登録済み期間を明記）
    const thisMonth = {
      label: '今月の売上',
      periodLabel: '2026年9月（9/14〜9/17 登録分）',
      sales: audit.officialTotal,
      deliveriesCount: audit.totalDeliveries,
      note: '※9月度 登録済み期間の集計'
    };

    // 登録済み累計売上（開始以来全期間と誤認させない表記）
    const registeredTotal = {
      label: '登録済み累計売上',
      periodLabel: '2026/09/14 ～ 09/17（登録分）',
      sales: audit.officialTotal,
      calculatedSales: audit.calculatedTotal,
      deliveriesCount: audit.totalDeliveries,
      note: '※アプリ内登録データのみの累計（全期間確定値ではありません）'
    };

    const auditFootnote = {
      diff: audit.diff, // +4
      officialTotal: audit.officialTotal,
      calculatedTotal: audit.calculatedTotal,
      text: `明細との差額: +${audit.diff}円（未照合）`,
      subText: `公式正本: ¥${audit.officialTotal.toLocaleString()} / 分析用明細集計: ¥${audit.calculatedTotal.toLocaleString()}`
    };

    return {
      thisWeek,
      thisMonth,
      registeredTotal,
      auditFootnote
    };
  }

  // 全体・累計・直近7日の分析データ取得
  getAnalytics() {
    const allLogs = this.getAllDailyLogs();
    
    let totalDeliveries = 0;
    let totalSalesSum = 0;
    let totalMinutesSum = 0;
    let totalDistanceSum = 0;
    let activeDaysCount = 0;

    allLogs.forEach(log => {
      const metrics = this.getCalculatedMetrics(log);
      const hasActivity = metrics.count > 0 || log.workStartedAt || metrics.totalSales !== null;
      if (hasActivity) {
        activeDaysCount++;
        totalDeliveries += metrics.count;
        if (metrics.totalSales !== null) {
          totalSalesSum += metrics.totalSales;
        }
        if (metrics.workMinutes) {
          totalMinutesSum += metrics.workMinutes;
        }
        if (metrics.totalDistanceKm) {
          totalDistanceSum += metrics.totalDistanceKm;
        }
      }
    });

    const avgDailyEarnings = activeDaysCount > 0 ? Math.round(totalSalesSum / activeDaysCount) : null;
    const avgHourlyWage = totalMinutesSum > 0 ? Math.round(totalSalesSum / (totalMinutesSum / 60)) : null;
    const avgPerDelivery = totalDeliveries > 0 ? Math.round(totalSalesSum / totalDeliveries) : null;

    const recent7Days = allLogs.slice(0, 7).map(log => {
      const metrics = this.getCalculatedMetrics(log);
      return {
        date: log.date,
        formattedDate: log.date.substring(5).replace('-', '/'),
        count: metrics.count,
        totalSales: metrics.totalSales,
        hourlyWage: metrics.hourlyWage,
        distance: metrics.totalDistanceKm
      };
    });

    return {
      totalDeliveries,
      totalSalesSum,
      avgDailyEarnings,
      avgHourlyWage,
      avgPerDelivery,
      totalDistanceSum: totalDistanceSum > 0 ? Number(totalDistanceSum.toFixed(1)) : null,
      recent7Days
    };
  }

  // 地雷（原則回避）データベース取得
  getAvoidanceDatabase() {
    return AVOIDANCE_DATABASE;
  }

  // 確定データ（2026-09-14 ～ 2026-09-17）をSupabaseから再同期
  async reloadConfirmedSeedData() {
    if (typeof window !== 'undefined' && window.cloudSync) {
      await window.cloudSync.pullAndSync();
    }
    return this.state;
  }

  // 全データエクスポート（JSON）
  exportJSON() {
    return JSON.stringify(this.state, null, 2);
  }

  // 全データインポート
  importJSON(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data.dailyLogs) {
        throw new Error('無効なデータ形式です（dailyLogsが見つかりません）');
      }
      this.state = data;
      this.saveToStorage();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // 全データ初期化
  clearAllData() {
    this.state = {
      version: '1.1',
      dailyLogs: {}
    };
    this.saveToStorage();
  }
}

const store = new Store();

// ブラウザ環境（window）およびNode.js環境（module.exports）両方に対応
if (typeof window !== 'undefined') {
  window.WORK_TIME_STEP_MINUTES = WORK_TIME_STEP_MINUTES;
  window.getTimeOptions = getTimeOptions;
  window.roundToTimeStep = roundToTimeStep;
  window.OFFICIAL_SOURCE_OF_TRUTH = OFFICIAL_SOURCE_OF_TRUTH;
  window.AVOIDANCE_DATABASE = AVOIDANCE_DATABASE;
  window.AVOIDANCE_RULES = AVOIDANCE_RULES;
  window.JAPAN_HOLIDAYS = JAPAN_HOLIDAYS;
  window.getDayOfWeekInfo = getDayOfWeekInfo;
  window.formatDateWithWeekday = formatDateWithWeekday;
  window.getWeekRange = getWeekRange;
  window.getPreviousWeekRange = getPreviousWeekRange;
  window.getConfirmedSeedData = getConfirmedSeedData;
  window.getTodayDateString = getTodayDateString;
  window.getCurrentTimeString = getCurrentTimeString;
  window.formatJapaneseDate = formatJapaneseDate;
  window.calculateMinutesBetween = calculateMinutesBetween;
  window.formatMinutes = formatMinutes;
  window.deduplicateQuests = deduplicateQuests;
  window.Store = Store;
  window.store = store;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WORK_TIME_STEP_MINUTES,
    getTimeOptions,
    roundToTimeStep,
    OFFICIAL_SOURCE_OF_TRUTH,
    AVOIDANCE_DATABASE,
    AVOIDANCE_RULES,
    JAPAN_HOLIDAYS,
    getDayOfWeekInfo,
    formatDateWithWeekday,
    getWeekRange,
    getPreviousWeekRange,
    getConfirmedSeedData,
    getTodayDateString,
    getCurrentTimeString,
    formatJapaneseDate,
    calculateMinutesBetween,
    formatMinutes,
    deduplicateQuests,
    Store,
    store
  };
}

