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

// 今週のクエスト定義（期間・目標件数設定。将来のクエスト差し替えに柔軟対応）
const CURRENT_WEEK_QUEST = {
  id: 'quest_20260921_0925',
  title: '今週のクエスト',
  targetCount: 80,
  startAt: '2026-09-21T04:00:00+09:00',
  endAt: '2026-09-25T04:00:00+09:00',
  deadlineText: '9/25（金）4:00まで'
};

// 公式確定実績の取り込み世代。端末に残る旧クエスト手動オフセットが公式件数と
// 二重計上になるのを防ぐため、この値が一致する保存データのみ手動補正を採用する。
const QUEST_OFFICIAL_BASELINE = '20260922_official';

// 稼働していないことが確認済みの日（履歴カレンダーの「休」表示用）。
// 配達データが無い日を自動で「休」にはしない（未来・未入力・判定できない日と区別するため、確認済みの日だけをここに記録する）。
const CONFIRMED_DAY_OFF_DATES = ['2026-09-12', '2026-09-13', '2026-09-20'];

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
  benchmarks: [
    {
      id: 'bm_0917_mos',
      title: 'モスバーガー 市岡みなと通り店 ➔ 此花区島屋6丁目',
      date: '2026-09-17',
      completedAt: '14:04',
      pickup: 'モスバーガー 市岡みなと通り店',
      drop: '大阪市此花区島屋6丁目',
      fee: 621,
      distanceKm: 5.58,
      durationStr: '34分36秒',
      status: 'AVOID',
      tags: ['橋', '自転車移動困難', '階段', '長距離', '帰路の空走'],
      memo: '巨大な橋を越える必要あり・自転車押し階段・通常エリア外・帰路空走・体力拘束大負担。【原則回避の基準事例】'
    },
    {
      id: 'bm_0919_fukushima_tower',
      title: 'セブン-イレブン 野田阪神駅前店 ➔ 福島タワー（海老江6丁目）',
      date: '2026-09-19',
      completedAt: '15:45',
      pickup: 'セブン-イレブン 野田阪神駅前店',
      drop: '大阪市福島区海老江6丁目',
      fee: 325,
      distanceKm: 1.54,
      durationStr: '10分27秒',
      status: 'AVOID',
      tags: ['入館手続き', 'エレベーター', '館内徒歩', '退館導線'],
      memo: '福島タワー。入館時の手続きが複雑。記入等が必要。上階への導線も面倒。時間ロスが大きく、特に低単価案件では割に合わない。地雷／原則回避候補。'
    },
    {
      id: 'bm_0919_sushiro_shiokusa',
      title: 'スシロー 辰巳橋店 ➔ 浪速区塩草1丁目',
      date: '2026-09-19',
      completedAt: '13:49',
      pickup: 'スシロー 辰巳橋店',
      drop: '大阪市浪速区塩草1丁目',
      fee: 429,
      distanceKm: 6.74,
      durationStr: '31分32秒',
      status: 'VERIFY',
      tags: ['橋', '自転車移動困難', '長距離', '要ルート検証'],
      memo: '43号線付近で自転車ルート判断を誤り、引き返しによる大きな時間ロスが発生した。正しい自転車渡河ルートについては未検証。【要ルート検証】'
    }
  ],
  customSpots: []
};

// 既存コードとの後方互換性エイリアス
const AVOIDANCE_RULES = {
  ...AVOIDANCE_DATABASE,
  areaPolicy: AVOIDANCE_DATABASE.policy
};

// 初期シードデータ（個人実績データは内包せず、空の状態で初期化。Supabaseログイン後にRLSで取得）
// 初期確定シードデータ（2026-09-14〜09-17正本 + 09-18実運用データ）
const CONFIRMED_SEED_DATA = {
  "version": "1.2",
  "dailyLogs": {
    "2026-09-10": {
      "date": "2026-09-10",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 14.31,
      "tripsCount": 2,
      "officialPoints": 3,
      "deliveriesCount": 3,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0910_1",
          "index": 1,
          "completedAt": "10:12",
          "restaurant": "【塩のおにぎり屋】PACKN-TO",
          "area": "大阪市港区弁天1丁目",
          "fee": 402,
          "distanceKm": 6.07,
          "durationStr": "41分7秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0910_2",
          "index": 2,
          "completedAt": "11:04",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市此花区西九条3丁目",
          "fee": 701,
          "distanceKm": 8.24,
          "durationStr": "42分58秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        }
      ],
      "quests": [
        {
          "id": "quest_0910_1",
          "time": "10:15",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0910_2",
          "time": "11:05",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        }
      ]
    },
    "2026-09-11": {
      "date": "2026-09-11",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 17.47,
      "tripsCount": 4,
      "officialPoints": 5,
      "deliveriesCount": 5,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0911_1",
          "index": 1,
          "completedAt": "09:55",
          "restaurant": "ケーラベーカリー Kayra Bakery",
          "area": "大阪市港区南市岡2丁目",
          "fee": 800,
          "distanceKm": 8.01,
          "durationStr": "46分2秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0911_2",
          "index": 2,
          "completedAt": "11:01",
          "restaurant": "セブン-イレブン 大阪川口2丁目店",
          "area": "大阪市西区本田1丁目",
          "fee": 363,
          "distanceKm": 1.98,
          "durationStr": "10分47秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0911_3",
          "index": 3,
          "completedAt": "11:11",
          "restaurant": "マクドナルド JR野田駅前店",
          "area": "大阪市福島区海老江3丁目",
          "fee": 478,
          "distanceKm": 4.47,
          "durationStr": "35分29秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0911_4",
          "index": 4,
          "completedAt": "12:06",
          "restaurant": "マクドナルド JR野田駅前店",
          "area": "大阪市福島区吉野5丁目",
          "fee": 320,
          "distanceKm": 3.01,
          "durationStr": "23分27秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0911_1",
          "time": "10:00",
          "title": "クエスト",
          "amount": 125,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0911_2",
          "time": "11:15",
          "title": "クエスト",
          "amount": 145,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0911_3",
          "time": "12:10",
          "title": "クエスト",
          "amount": 180,
          "isDuplicateIgnored": false
        }
      ]
    },
    "2026-09-14": {
      "date": "2026-09-14",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 18.02,
      "tripsCount": 4,
      "officialPoints": 5,
      "deliveriesCount": 4,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0914_1",
          "index": 1,
          "completedAt": "08:54",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 1.87,
          "durationStr": "11分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0914_2",
          "index": 2,
          "completedAt": "09:08",
          "restaurant": "ガスト 港弁天町店",
          "area": "大阪市港区波除2丁目",
          "fee": 619,
          "distanceKm": 6.90,
          "durationStr": "31分18秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0914_3",
          "index": 3,
          "completedAt": "09:21",
          "restaurant": "スターバックス コーヒー 海遊館店",
          "area": "大阪市此花区桜島3丁目",
          "fee": 1166,
          "distanceKm": 4.86,
          "durationStr": "4時間30分",
          "points": 1,
          "memo": "Uber公式表示値・要確認（所要時間4時間30分表示）。大型施設・移動導線負担大【要検証】",
          "isAvoidanceCase": true
        },
        {
          "id": "del_0914_4",
          "index": 4,
          "completedAt": "09:41",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区田中3丁目",
          "fee": 338,
          "distanceKm": 4.39,
          "durationStr": "21分08秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": []
    },
    "2026-09-15": {
      "date": "2026-09-15",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 44.41,
      "tripsCount": 11,
      "officialPoints": 11,
      "deliveriesCount": 11,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0915_1",
          "index": 1,
          "completedAt": "09:04",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区弁天3丁目",
          "fee": 355,
          "distanceKm": 3.10,
          "durationStr": "25分3秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_2",
          "index": 2,
          "completedAt": "09:34",
          "restaurant": "吉野家 朝潮橋店",
          "area": "大阪市港区弁天3丁目",
          "fee": 396,
          "distanceKm": 3.33,
          "durationStr": "15分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_3",
          "index": 3,
          "completedAt": "10:02",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区三先2丁目",
          "fee": 320,
          "distanceKm": 2.33,
          "durationStr": "16分13秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_4",
          "index": 4,
          "completedAt": "10:28",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区三先1丁目",
          "fee": 320,
          "distanceKm": 2.37,
          "durationStr": "14分22秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_5",
          "index": 5,
          "completedAt": "10:49",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区千代崎1丁目",
          "fee": 416,
          "distanceKm": 4.14,
          "durationStr": "30分22秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_6",
          "index": 6,
          "completedAt": "11:22",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区波除2丁目",
          "fee": 474,
          "distanceKm": 3.43,
          "durationStr": "22分8秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_7",
          "index": 7,
          "completedAt": "11:35",
          "restaurant": "カリーWEST百名店2020 いずみバーグ",
          "area": "大阪市此花区西九条1丁目",
          "fee": 455,
          "distanceKm": 4.31,
          "durationStr": "23分25秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_8",
          "index": 8,
          "completedAt": "12:05",
          "restaurant": "マクドナルド JR野田駅前店",
          "area": "大阪市福島区玉川1丁目",
          "fee": 320,
          "distanceKm": 3.25,
          "durationStr": "20分29秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_9",
          "index": 9,
          "completedAt": "12:22",
          "restaurant": "マクドナルド 高見プラザ店",
          "area": "大阪市此花区梅香2丁目",
          "fee": 560,
          "distanceKm": 6.12,
          "durationStr": "35分38秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_10",
          "index": 10,
          "completedAt": "13:07",
          "restaurant": "マクドナルド 野田阪神店",
          "area": "大阪市福島区吉野2丁目",
          "fee": 393,
          "distanceKm": 3.40,
          "durationStr": "19分21秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0915_11",
          "index": 11,
          "completedAt": "13:19",
          "restaurant": "KFC うめきたグリーンプレイス店",
          "area": "大阪市西区江戸堀1丁目",
          "fee": 723,
          "distanceKm": 8.63,
          "durationStr": "55分44秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0915_1",
          "time": "11:45",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0915_2",
          "time": "12:11",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0915_3",
          "time": "12:27",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0915_4",
          "time": "12:58",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0915_5",
          "time": "13:27",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false
        }
      ]
    },
    "2026-09-16": {
      "date": "2026-09-16",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 37.01,
      "tripsCount": 8,
      "officialPoints": 10,
      "deliveriesCount": 8,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0916_1",
          "index": 1,
          "completedAt": "09:01",
          "restaurant": "コクミンドラッグ 西九条店",
          "area": "大阪市港区波除4丁目",
          "fee": 606,
          "distanceKm": 3.89,
          "durationStr": "25分0秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0916_2",
          "index": 2,
          "completedAt": "09:19",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区海岸通2丁目",
          "fee": 563,
          "distanceKm": 5.91,
          "durationStr": "33分32秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0916_3",
          "index": 3,
          "completedAt": "09:28",
          "restaurant": "セブン-イレブン 大阪築港1丁目店",
          "area": "大阪市港区築港2丁目",
          "fee": 320,
          "distanceKm": 1.29,
          "durationStr": "9分34秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0916_4",
          "index": 4,
          "completedAt": "09:39",
          "restaurant": "吉野家 朝潮橋店",
          "area": "大阪市港区夕凪1丁目",
          "fee": 525,
          "distanceKm": 3.96,
          "durationStr": "24分59秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0916_5",
          "index": 5,
          "completedAt": "10:29",
          "restaurant": "【もっちり玄米と低脂質チキン】とりげん食堂 弁天町店",
          "area": "大阪市西区新町4丁目",
          "fee": 906,
          "distanceKm": 6.78,
          "durationStr": "42分54秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0916_6",
          "index": 6,
          "completedAt": "10:54",
          "restaurant": "マクドナルド 南堀江関西スーパー店",
          "area": "大阪市西区南堀江4丁目",
          "fee": 0,
          "distanceKm": null,
          "durationStr": "0秒",
          "points": 0,
          "memo": "未完了／売上調整された特殊トリップ（見積もり¥481、一部配達未完了のため売上調整¥0）",
          "isUncompletedOrAdjusted": true
        },
        {
          "id": "del_0916_7",
          "index": 7,
          "completedAt": "10:56",
          "restaurant": "マクドナルド 南堀江関西スーパー店",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 432,
          "distanceKm": 3.91,
          "durationStr": "24分26秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0916_8",
          "index": 8,
          "completedAt": "11:58",
          "restaurant": "ガスト",
          "area": "大阪市西区九条2丁目",
          "fee": 1050,
          "distanceKm": 11.27,
          "durationStr": "1時間13分",
          "points": 2,
          "memo": "2ポイント獲得。遠方の一軒家方面。1件か2件セットか未確認、報酬悪くない可能性あり【要検証】"
        }
      ],
      "quests": [
        {
          "id": "quest_0916_1",
          "time": "11:40頃",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0916_2",
          "time": "13:12頃",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0916_3",
          "time": "13:27頃",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        }
      ]
    },
    "2026-09-17": {
      "date": "2026-09-17",
      "workStartedAt": "09:00",
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 28.55,
      "tripsCount": 7,
      "officialPoints": 7,
      "deliveriesCount": 7,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0917_1",
          "index": 1,
          "completedAt": "08:56",
          "restaurant": "魚屋のおむすび丸徳 sakanaya omusubi marutoku",
          "area": "大阪市北区中津1丁目",
          "fee": 704,
          "distanceKm": 6.57,
          "durationStr": "35分31秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_2",
          "index": 2,
          "completedAt": "10:10",
          "restaurant": "7-Eleven 大阪福島西通店",
          "area": "大阪市福島区福島3丁目",
          "fee": 511,
          "distanceKm": 3.14,
          "durationStr": "16分59秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_3",
          "index": 3,
          "completedAt": "10:40",
          "restaurant": "マクドナルド 四ツ橋店",
          "area": "大阪市西区南堀江1丁目",
          "fee": 419,
          "distanceKm": 2.95,
          "durationStr": "17分19秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_4",
          "index": 4,
          "completedAt": "10:57",
          "restaurant": "スシロー スシロー辰巳橋店",
          "area": "大阪市西区北堀江3丁目",
          "fee": 644,
          "distanceKm": 4.86,
          "durationStr": "24分07秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_5",
          "index": 5,
          "completedAt": "11:33",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市港区南市岡1丁目",
          "fee": 388,
          "distanceKm": 3.07,
          "durationStr": "18分59秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_6",
          "index": 6,
          "completedAt": "12:00",
          "restaurant": "ローソン 港区南市岡一丁目",
          "area": "大阪市港区南市岡3丁目",
          "fee": 320,
          "distanceKm": 2.38,
          "durationStr": "09分05秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0917_7",
          "index": 7,
          "completedAt": "14:04",
          "restaurant": "モスバーガー 市岡みなと通り店",
          "area": "大阪市此花区島屋6丁目",
          "fee": 621,
          "distanceKm": 5.58,
          "durationStr": "34分36秒",
          "points": 1,
          "memo": "巨大な橋を越える必要あり・自転車押し階段・通常エリア外・帰路空走・体力拘束大負担。【原則回避の基準事例】",
          "isAvoidanceCase": true
        }
      ],
      "quests": [
        {
          "id": "quest_0917_1",
          "time": "11:29頃",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0917_2",
          "time": "11:53頃",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0917_3",
          "time": "12:10頃",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0917_4",
          "time": "14:42頃",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false
        }
      ],
      "sales": {
        "delivery": 3607,
        "quest": 600,
        "adjustment": 0,
        "other": 0,
        "total": 4207
      }
    },
    "2026-09-18": {
      "date": "2026-09-18",
      "workStartedAt": "09:00",
      "workEndedAt": "14:30",
      "workMinutes": 330,
      "totalDistanceKm": 33.24,
      "tripsCount": 9,
      "officialPoints": 11,
      "deliveriesCount": 11,
      "vehicleType": "レンタサイクル",
      "workSessions": [
        {
          "id": "sess_0918_1",
          "start": "09:00",
          "end": "14:30",
          "isApproximate": false,
          "note": "第1部"
        }
      ],
      "deliveries": [
        {
          "id": "del_0918_1",
          "index": 1,
          "completedAt": "09:06",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田4丁目",
          "fee": 320,
          "distanceKm": 0.66,
          "durationStr": "7分45秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_2",
          "index": 2,
          "completedAt": "09:11",
          "restaurant": "すき家 西九条駅前店",
          "area": "大阪市港区弁天5丁目",
          "fee": 491,
          "distanceKm": 6.50,
          "durationStr": "27分6秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_3",
          "index": 3,
          "completedAt": "09:36",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区三先2丁目",
          "fee": 367,
          "distanceKm": 5.71,
          "durationStr": "22分3秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_4",
          "index": 4,
          "completedAt": "10:22",
          "restaurant": "セブン-イレブン 大阪泉尾4丁目店",
          "area": "大阪市浪速区木川1丁目",
          "fee": 537,
          "distanceKm": 5.07,
          "durationStr": "29分26秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_5",
          "index": 5,
          "completedAt": "11:09",
          "restaurant": "バーガーキング 九条店",
          "area": "大阪市福島区吉野5丁目",
          "fee": 546,
          "distanceKm": 3.65,
          "durationStr": "22分6秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0918_6",
          "index": 6,
          "completedAt": "11:43",
          "restaurant": "たこ家輝 西九条店",
          "area": "大阪市港区市岡元町2丁目",
          "fee": 517,
          "distanceKm": 4.23,
          "durationStr": "22分9秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_7",
          "index": 7,
          "completedAt": "12:32",
          "restaurant": "スシロー 辰巳橋店",
          "area": "大阪市港区南市岡3丁目",
          "fee": 441,
          "distanceKm": 2.90,
          "durationStr": "23分30秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_8",
          "index": 8,
          "completedAt": "13:02",
          "restaurant": "【塩のおにぎり屋】PACKN-TO",
          "area": "大阪市西区九条南",
          "fee": 320,
          "distanceKm": 2.06,
          "durationStr": "12分31秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0918_9",
          "index": 9,
          "completedAt": "13:55",
          "restaurant": "松屋 九条店",
          "area": "大阪市西区本田2丁目",
          "fee": 378,
          "distanceKm": 2.46,
          "durationStr": "20分14秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        }
      ],
      "quests": [
        {
          "id": "quest_0918_1",
          "time": "14:25",
          "title": "クエスト",
          "amount": 950,
          "isDuplicateIgnored": false
        }
      ],
      "vehicleType": "バイクシェア利用",
      "sales": {
        "delivery": 3917,
        "quest": 950,
        "adjustment": 200,
        "other": 0,
        "total": 5067
      },
      "expenses": [
        {
          "id": "exp_0918_1",
          "category": "バイクシェア利用",
          "amount": 1980,
          "memo": "ドコモ・バイクシェア1日パス"
        }
      ]
    },
    "2026-09-19": {
      "date": "2026-09-19",
      "workStartedAt": "08:30",
      "workEndedAt": "17:00",
      "workMinutes": 510,
      "totalDistanceKm": 70.18,
      "vehicleType": "バイクシェア利用",
      "milestone": "累計75配達達成",
      "tripsCount": 19,
      "officialPoints": 23,
      "deliveriesCount": 23,
      "workSessions": [
        {
          "id": "sess_0919_1",
          "start": "08:30",
          "end": "17:00",
          "isApproximate": true,
          "note": "08:30〜17:00頃"
        }
      ],
      "deliveries": [
        {
          "id": "del_0919_1",
          "index": 1,
          "completedAt": "08:09",
          "restaurant": "ローソンストア100 西区京町堀店",
          "area": "大阪市福島区福島6丁目",
          "fee": 473,
          "distanceKm": 4.70,
          "durationStr": "23分26秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_2",
          "index": 2,
          "completedAt": "08:43",
          "restaurant": "マクドナルド 野田阪神店",
          "area": "大阪市福島区海老江8丁目",
          "fee": 610,
          "distanceKm": 5.49,
          "durationStr": "31分33秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0919_3",
          "index": 3,
          "completedAt": "09:02",
          "restaurant": "Uberダイレクト アカカベ薬局 野田阪神",
          "area": "大阪市西区西本町2丁目",
          "fee": 535,
          "distanceKm": 4.99,
          "durationStr": "26分08秒",
          "points": 1,
          "memo": "処方薬配送"
        },
        {
          "id": "del_0919_4",
          "index": 4,
          "completedAt": "09:25",
          "restaurant": "マクドナルド 靱本町店",
          "area": "大阪市西区京町堀2丁目",
          "fee": 347,
          "distanceKm": 2.62,
          "durationStr": "16分42秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_5",
          "index": 5,
          "completedAt": "09:53",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 546,
          "distanceKm": 3.44,
          "durationStr": "17分26秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_6",
          "index": 6,
          "completedAt": "10:15",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ 九条店",
          "area": "大阪市西区南堀江3丁目",
          "fee": 320,
          "distanceKm": 2.33,
          "durationStr": "13分42秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_7",
          "index": 7,
          "completedAt": "10:32",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市港区南市岡3丁目",
          "fee": 592,
          "distanceKm": 5.09,
          "durationStr": "29分04秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0919_8",
          "index": 8,
          "completedAt": "10:58",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区夕凪1丁目",
          "fee": 368,
          "distanceKm": 3.60,
          "durationStr": "20分50秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_9",
          "index": 9,
          "completedAt": "11:34",
          "restaurant": "セブン-イレブン 大阪市岡元町1丁目店",
          "area": "大阪市港区波除2丁目",
          "fee": 322,
          "distanceKm": 1.87,
          "durationStr": "09分18秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_19",
          "index": 10,
          "completedAt": "11:44",
          "restaurant": "スシロー 辰巳橋店",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.98,
          "durationStr": "13分34秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_10",
          "index": 11,
          "completedAt": "12:04",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区弁天5丁目",
          "fee": 591,
          "distanceKm": 4.72,
          "durationStr": "28分57秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0919_11",
          "index": 12,
          "completedAt": "12:43",
          "restaurant": "スターバックス コーヒー JR弁天町駅店",
          "area": "大阪市港区弁天3丁目",
          "fee": 320,
          "distanceKm": 1.17,
          "durationStr": "10分43秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_12",
          "index": 13,
          "completedAt": "12:56",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区市岡元町3丁目",
          "fee": 320,
          "distanceKm": 1.63,
          "durationStr": "11分14秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_13",
          "index": 14,
          "completedAt": "13:05",
          "restaurant": "カレーハウスCoCo壱番屋 港区弁天町店",
          "area": "大阪市港区弁天5丁目",
          "fee": 433,
          "distanceKm": 2.49,
          "durationStr": "18分02秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0919_14",
          "index": 15,
          "completedAt": "13:49",
          "restaurant": "スシロー 辰巳橋店",
          "area": "大阪市浪速区塩草1丁目",
          "fee": 429,
          "distanceKm": 6.74,
          "durationStr": "31分32秒",
          "points": 1,
          "memo": "43号線付近で自転車ルート判断を誤り、引き返しによる大きな時間ロスが発生した。正しい自転車渡河ルートについては未検証。【要ルート検証】",
          "isAvoidanceCase": true
        },
        {
          "id": "del_0919_15",
          "index": 16,
          "completedAt": "14:18",
          "restaurant": "韓国屋台momoチキン 大正店",
          "area": "大阪市福島区大開4丁目",
          "fee": 624,
          "distanceKm": 6.82,
          "durationStr": "30分25秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_16",
          "index": 17,
          "completedAt": "15:03",
          "restaurant": "セブン-イレブン 大阪玉川2丁目店",
          "area": "大阪市福島区福島4丁目",
          "fee": 433,
          "distanceKm": 5.57,
          "durationStr": "30分45秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_17",
          "index": 18,
          "completedAt": "15:37",
          "restaurant": "ミスタードーナツ 福島大開ショップ",
          "area": "大阪市福島区海老江6丁目",
          "fee": 320,
          "distanceKm": 3.43,
          "durationStr": "16分58秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0919_18",
          "index": 19,
          "completedAt": "15:45",
          "restaurant": "セブン-イレブン 野田阪神駅前店",
          "area": "大阪市福島区海老江6丁目",
          "fee": 325,
          "distanceKm": 1.54,
          "durationStr": "10分27秒",
          "points": 1,
          "memo": "福島タワー。入館時の手続きが複雑。記入等が必要。上階への導線も面倒。時間ロスが大きく、特に低単価案件では割に合わない。地雷／原則回避候補。",
          "isAvoidanceCase": true
        }
      ],
      "quests": [
        {
          "id": "quest_0919_1",
          "time": "11:44",
          "title": "クエスト",
          "amount": 125,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0919_2",
          "time": "11:58",
          "title": "クエスト",
          "amount": 145,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0919_3",
          "time": "12:28",
          "title": "クエスト",
          "amount": 180,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0919_4",
          "time": "12:34",
          "title": "クエスト",
          "amount": 210,
          "isDuplicateIgnored": false
        },
        {
          "id": "quest_0919_5",
          "time": "12:54",
          "title": "クエスト",
          "amount": 290,
          "isDuplicateIgnored": false
        }
      ],
      "sales": {
        "delivery": 8228,
        "quest": 950,
        "adjustment": 0,
        "other": 0,
        "regularTotal": 9178,
        "guaranteeBonus": 12132,
        "guaranteeBonusNote": "新規ドライバー保証（累計75配達達成: 保証額42,525円 - 対象売上30,393円）",
        "total": 21310
      },
      "expenses": [
        {
          "id": "exp_0919_1",
          "category": "バイクシェア利用",
          "amount": 1527,
          "memo": "ドコモ・バイクシェア1日パス"
        }
      ]
    },
    "2026-09-21": {
      "date": "2026-09-21",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 27.92,
      "vehicleType": "バイクシェア利用",
      "tripsCount": 7,
      "officialPoints": 10,
      "deliveriesCount": 10,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0921_1",
          "index": 1,
          "completedAt": "07:54",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo〜お持帰り専門店〜",
          "area": "大阪市大正区三軒家東2丁目",
          "fee": 345,
          "distanceKm": 3.30,
          "durationStr": "18分48秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0921_2",
          "index": 2,
          "completedAt": "09:06",
          "restaurant": "【もったりアサイーボウル】YoruAsa/ヨルアサ",
          "area": "大阪市大正区南恩加島2丁目",
          "fee": 643,
          "distanceKm": 5.28,
          "durationStr": "31分21秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0921_3",
          "index": 3,
          "completedAt": "10:41",
          "restaurant": "マクドナルド 大正店",
          "area": "大阪市大正区平尾2丁目",
          "fee": 320,
          "distanceKm": 2.16,
          "durationStr": "14分22秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0921_4",
          "index": 4,
          "completedAt": "11:23",
          "restaurant": "マクドナルド 大正店",
          "area": "大阪市大正区北村1丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "11分34秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0921_5",
          "index": 5,
          "completedAt": "11:41",
          "restaurant": "【カラダが喜ぶオムライスCafe】Egg House〜大正店〜",
          "area": "大阪市西区靱本町3丁目",
          "fee": 890,
          "distanceKm": 7.39,
          "durationStr": "39分00秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0921_6",
          "index": 6,
          "completedAt": "12:16",
          "restaurant": "マクドナルド 南堀江関西スーパー店",
          "area": "大阪市西区新町4丁目",
          "fee": 603,
          "distanceKm": 5.15,
          "durationStr": "32分19秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0921_7",
          "index": 7,
          "completedAt": "12:48",
          "restaurant": "マクドナルド 四ツ橋店",
          "area": "大阪市西区新町3丁目",
          "fee": 369,
          "distanceKm": 3.43,
          "durationStr": "21分23秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0921_1",
          "time": "13:10",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "note": "公式画面は「クエスト ¥800」「6回乗車クエスト ¥800」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 3490,
        "quest": 800,
        "adjustment": 0,
        "other": 0,
        "total": 4290
      },
      "expenses": [
        {
          "id": "exp_0921_1",
          "category": "バイクシェア利用",
          "amount": 1527,
          "memo": "ドコモ・バイクシェア1日パス"
        }
      ]
    },
    "2026-09-22": {
      "date": "2026-09-22",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 67.13,
      "vehicleType": "バイクシェア利用",
      "tripsCount": 18,
      "officialPoints": 25,
      "deliveriesCount": 25,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0922_1",
          "index": 1,
          "completedAt": "08:21",
          "restaurant": "マクドナルド ＪＲ野田駅前店",
          "area": "大阪市西区江之子島2丁目",
          "fee": 466,
          "distanceKm": 4.44,
          "durationStr": "25分56秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_2",
          "index": 2,
          "completedAt": "08:44",
          "restaurant": "珈琲とフレンチトースト MUC COFFEE ROASTERS うつぼ公園店",
          "area": "大阪市 新町1丁目",
          "fee": 514,
          "distanceKm": 4.26,
          "durationStr": "28分21秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／公式配達先表記: 1-chōme Osaka Osaka Shinmachi Japón"
        },
        {
          "id": "del_0922_3",
          "index": 3,
          "completedAt": "09:22",
          "restaurant": "my bowl Kitahorie マイボウル 北堀江店",
          "area": "大阪市浪速区敷津東2丁目",
          "fee": 398,
          "distanceKm": 3.48,
          "durationStr": "18分00秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_4",
          "index": 4,
          "completedAt": "09:58",
          "restaurant": "ローソン 大阪ドームシティ",
          "area": "大阪市大正区三軒家西3丁目",
          "fee": 651,
          "distanceKm": 4.86,
          "durationStr": "29分10秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0922_5",
          "index": 5,
          "completedAt": "10:28",
          "restaurant": "京都北白川ラーメン魁力屋 イオンモール大阪ドームシティ店",
          "area": "大阪市西区九条2丁目",
          "fee": 432,
          "distanceKm": 4.62,
          "durationStr": "24分14秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_6",
          "index": 6,
          "completedAt": "10:50",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 370,
          "baseFee": 320,
          "tip": 50,
          "distanceKm": 1.85,
          "durationStr": "13分14秒",
          "points": 1,
          "memo": "最終売上¥370（基本料金¥320＋チップ¥50）"
        },
        {
          "id": "del_0922_7",
          "index": 7,
          "completedAt": "12:31",
          "restaurant": "松のや 九条店",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 350,
          "distanceKm": 4.14,
          "durationStr": "24分01秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0922_8",
          "index": 8,
          "completedAt": "12:53",
          "restaurant": "松のや 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 607,
          "distanceKm": 6.81,
          "durationStr": "52分31秒",
          "points": 3,
          "memo": "トリプル配達（3件完了/3pt）"
        },
        {
          "id": "del_0922_9",
          "index": 9,
          "completedAt": "14:07",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市此花区春日出南2丁目",
          "fee": 576,
          "distanceKm": 3.86,
          "durationStr": "29分39秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0922_10",
          "index": 10,
          "completedAt": "14:48",
          "restaurant": "スターバックス コーヒー JR弁天町駅店",
          "area": "大阪市西区九条南2丁目",
          "fee": 331,
          "distanceKm": 2.69,
          "durationStr": "17分27秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_11",
          "index": 11,
          "completedAt": "15:02",
          "restaurant": "たこ家 輝 西九条店",
          "area": "大阪市港区市岡1丁目",
          "fee": 835,
          "distanceKm": 7.32,
          "durationStr": "43分58秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0922_12",
          "index": 12,
          "completedAt": "15:42",
          "restaurant": "ローソン 夕凪二丁目",
          "area": "大阪市港区夕凪1丁目",
          "fee": 320,
          "distanceKm": 2.48,
          "durationStr": "17分43秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_13",
          "index": 13,
          "completedAt": "16:21",
          "restaurant": "オリジナルガパオライス アロイ・ガパオ 大阪西店",
          "area": "大阪市此花区伝法6丁目",
          "fee": 489,
          "distanceKm": 3.81,
          "durationStr": "23分23秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_14",
          "index": 14,
          "completedAt": "17:07",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市西区本田1丁目",
          "fee": 399,
          "distanceKm": 2.61,
          "durationStr": "21分25秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_15",
          "index": 15,
          "completedAt": "17:48",
          "restaurant": "ピザハット 大阪ナインモール九条店",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 2.22,
          "durationStr": "13分11秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_16",
          "index": 16,
          "completedAt": "18:21",
          "restaurant": "串カツ田中 大正店",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 389,
          "distanceKm": 2.37,
          "durationStr": "16分13秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_17",
          "index": 17,
          "completedAt": "19:04",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区北堀江4丁目",
          "fee": 320,
          "distanceKm": 2.24,
          "durationStr": "14分49秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0922_18",
          "index": 18,
          "completedAt": "19:48",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区西本町2丁目",
          "fee": 483,
          "distanceKm": 3.07,
          "durationStr": "21分05秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0922_1",
          "time": "14:29",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "note": "公式画面は「クエスト ¥800」「6回乗車クエスト ¥800」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0922_2",
          "time": "20:09",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "note": "公式画面は「クエスト ¥800」「6回乗車クエスト ¥800」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。15:00の「3回乗車クエスト ¥0」は報酬0のため売上非加算"
        }
      ],
      "adjustments": [
        {
          "id": "adj_0922_1",
          "time": "23:46",
          "eventType": "調整",
          "officialTitle": "Support Adjustment",
          "amount": -607,
          "userNote": "配達ミスに伴う調整",
          "note": "Uber側の売上調整（経費ではない）。12:53 del_0922_8（Delivery ¥607）とは別イベントで、tripは変更しない"
        }
      ],
      "sales": {
        "delivery": 8250,
        "quest": 1600,
        "adjustment": -607,
        "other": 0,
        "total": 9243
      },
      "expenses": [
        {
          "id": "exp_0922_1",
          "category": "バイクシェア利用",
          "amount": 1527,
          "memo": "ドコモ・バイクシェア1日パス"
        }
      ]
    },
    "2026-09-23": {
      "date": "2026-09-23",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 65.32,
      "tripsCount": 20,
      "officialPoints": 23,
      "deliveriesCount": 23,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0923_1",
          "index": 1,
          "completedAt": "08:01",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo〜お持帰り専門店〜",
          "area": "大阪市此花区西九条2丁目",
          "fee": 451,
          "distanceKm": 3.46,
          "durationStr": "22分33秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_2",
          "index": 2,
          "completedAt": "08:16",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市此花区春日出南1丁目",
          "fee": 320,
          "distanceKm": 3.3,
          "durationStr": "19分32秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_3",
          "index": 3,
          "completedAt": "08:55",
          "restaurant": "モスバーガー ＪＲ福島駅前店 Mos Burger JR FUKUSHIMA EKIMAE",
          "area": "大阪市西区土佐堀2丁目",
          "fee": 415,
          "distanceKm": 3.69,
          "durationStr": "23分21秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_4",
          "index": 4,
          "completedAt": "09:19",
          "restaurant": "マクドナルド 福島店 McDonald's FUKUSHIMA",
          "area": "大阪市北区中津5丁目",
          "fee": 396,
          "distanceKm": 3.17,
          "durationStr": "17分47秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_5",
          "index": 5,
          "completedAt": "09:38",
          "restaurant": "ブルーボトルコーヒー 梅田茶屋町カフェ Blue Bottle Cofee Umeda Chayamachi Cafe",
          "area": "大阪市北区豊崎2丁目",
          "fee": 552,
          "distanceKm": 4.3,
          "durationStr": "27分30秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0923_6",
          "index": 6,
          "completedAt": "10:04",
          "restaurant": "エッグスンシングス 梅田茶屋町店 Eggs 'n Things Umeda Chayamachi",
          "area": "大阪市中央区安土町2丁目",
          "fee": 862,
          "distanceKm": 7.97,
          "durationStr": "49分36秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0923_7",
          "index": 7,
          "completedAt": "10:54",
          "restaurant": "バーガーキング 御堂筋本町店 Burger King Midosujihonmachi",
          "area": "大阪市中央区平野町1丁目",
          "fee": 320,
          "distanceKm": 2.48,
          "durationStr": "16分49秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_8",
          "index": 8,
          "completedAt": "11:05",
          "restaurant": "スターバックス コーヒー 北浜店 Starbucks Coffee Kitahama",
          "area": "大阪市中央区東高麗橋",
          "fee": 320,
          "distanceKm": 2.09,
          "durationStr": "16分46秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_9",
          "index": 9,
          "completedAt": "11:19",
          "restaurant": "たっぷりたんぱく肉とブロッコリー生活 大阪店",
          "area": "大阪市中央区森ノ宮中央2丁目",
          "fee": 452,
          "distanceKm": 4.39,
          "durationStr": "24分0秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_10",
          "index": 10,
          "completedAt": "11:49",
          "restaurant": "松屋 天満橋店 Matsuya Tenmabashi",
          "area": "大阪市北区天神橋3丁目",
          "fee": 368,
          "distanceKm": 2.75,
          "durationStr": "18分37秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_11",
          "index": 11,
          "completedAt": "12:01",
          "restaurant": "ラホンパンマーラータン 天神橋店",
          "area": "大阪市北区曾根崎",
          "fee": 320,
          "distanceKm": 2.16,
          "durationStr": "21分22秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_12",
          "index": 12,
          "completedAt": "12:20",
          "restaurant": "ル・クロワッサン 北新地店 LE CROISSANT",
          "area": "大阪市中央区瓦町4丁目",
          "fee": 385,
          "distanceKm": 3.4,
          "durationStr": "25分7秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_13",
          "index": 13,
          "completedAt": "12:50",
          "restaurant": "バーガーキング 御堂筋本町店 Burger King Midosujihonmachi",
          "area": "大阪市西区立売堀2丁目",
          "fee": 404,
          "distanceKm": 3.09,
          "durationStr": "23分0秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0923_14",
          "index": 14,
          "completedAt": "13:14",
          "restaurant": "すき家 阿波座 Sukiya Awaza",
          "area": "大阪市西区新町3丁目",
          "fee": 320,
          "distanceKm": 1.05,
          "durationStr": "8分24秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_15",
          "index": 15,
          "completedAt": "13:47",
          "restaurant": "ウエルシア大阪新町店",
          "area": "大阪市福島区福島3丁目",
          "fee": 400,
          "distanceKm": 3.52,
          "durationStr": "17分24秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_16",
          "index": 16,
          "completedAt": "14:40",
          "restaurant": "マクドナルド ＪＲ野田駅前店 McDonald's JR NODA EKI-MAE",
          "area": "大阪市江之子島2丁目",
          "fee": 323,
          "distanceKm": 2.41,
          "durationStr": "14分49秒",
          "points": 1,
          "memo": "公式配達先表記: 2-chōme Osaka Osaka Enokojima 日本"
        },
        {
          "id": "del_0923_17",
          "index": 17,
          "completedAt": "14:53",
          "restaurant": "ローソン 靱本町三丁目",
          "area": "大阪市西区土佐堀3丁目",
          "fee": 538,
          "baseFee": 320,
          "tip": 218,
          "distanceKm": 1.37,
          "durationStr": "10分54秒",
          "points": 1,
          "memo": "最終売上¥538（基本料金¥320＋チップ¥218）"
        },
        {
          "id": "del_0923_18",
          "index": 18,
          "completedAt": "15:28",
          "restaurant": "かっぱ寿司 境川店 Kappa Sushi Sakaigawa",
          "area": "大阪市浪速区大国3丁目",
          "fee": 597,
          "distanceKm": 4.96,
          "durationStr": "29分23秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_19",
          "index": 19,
          "completedAt": "16:27",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市西区千代崎3丁目",
          "fee": 970,
          "distanceKm": 3.75,
          "durationStr": "26分50秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0923_20",
          "index": 20,
          "completedAt": "17:15",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市浪速区桜川2丁目",
          "fee": 320,
          "distanceKm": 2.01,
          "durationStr": "15分49秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0923_1",
          "time": "13:06",
          "title": "クエスト",
          "amount": 900,
          "isDuplicateIgnored": false,
          "note": "公式一覧は「クエスト ¥900」「6 回乗車クエスト ¥900」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0923_2",
          "time": "14:05",
          "title": "クエスト",
          "amount": 750,
          "isDuplicateIgnored": false,
          "note": "公式一覧は「クエスト ¥750」「3 回乗車クエスト ¥750」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。15:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 9033,
        "quest": 1650,
        "adjustment": 0,
        "other": 0,
        "total": 10683
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-23T17:50:20.306Z"
      }
    },
    "2026-09-24": {
      "date": "2026-09-24",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 62.02,
      "tripsCount": 16,
      "officialPoints": 22,
      "deliveriesCount": 22,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0924_1",
          "index": 1,
          "completedAt": "07:42",
          "restaurant": "魚屋のおむすび丸徳 sakanaya omusubi marutoku",
          "area": "大阪市浪速区稲荷2丁目",
          "fee": 861,
          "distanceKm": 6.82,
          "durationStr": "41分27秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0924_2",
          "index": 2,
          "completedAt": "08:33",
          "restaurant": "なか卯 桜川店 Nakau Sakuragawa",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 320,
          "distanceKm": 1.75,
          "durationStr": "12分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_3",
          "index": 3,
          "completedAt": "08:44",
          "restaurant": "マクドナルド 南堀江関西スーパー店 McDonald's MINAMI-HORIE KANSAI S.M.",
          "area": "大阪市浪速区元町3丁目",
          "fee": 380,
          "distanceKm": 4.09,
          "durationStr": "26分49秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_4",
          "index": 4,
          "completedAt": "09:18",
          "restaurant": "【チキンステーキ弁当】Master Of Chicken～大正店～",
          "area": "大阪市西区境川1丁目",
          "fee": 387,
          "distanceKm": 3.49,
          "durationStr": "18分33秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_5",
          "index": 5,
          "completedAt": "10:06",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区千代崎1丁目",
          "fee": 320,
          "distanceKm": 1.11,
          "durationStr": "10分33秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_6",
          "index": 6,
          "completedAt": "10:19",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市市岡元町2丁目",
          "fee": 386,
          "distanceKm": 2.64,
          "durationStr": "16分20秒",
          "points": 1,
          "memo": "公式配達先表記: 2-chōme 27 Osaka Ichioka Motomachi Japan"
        },
        {
          "id": "del_0924_7",
          "index": 7,
          "completedAt": "10:37",
          "restaurant": "マクドナルド 九 条 店 McDonald's KUJO",
          "area": "大阪市西区九条南3丁目",
          "fee": 437,
          "distanceKm": 3.6,
          "durationStr": "26分12秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0924_8",
          "index": 8,
          "completedAt": "11:21",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区九条南4丁目",
          "fee": 320,
          "distanceKm": 1.58,
          "durationStr": "11分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_9",
          "index": 9,
          "completedAt": "11:30",
          "restaurant": "すき家 西九条駅前店 Sukiya Saikujo-Ekimae",
          "area": "大阪市大正区三軒家東",
          "fee": 908,
          "distanceKm": 7.79,
          "durationStr": "41分45秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0924_10",
          "index": 10,
          "completedAt": "13:06",
          "restaurant": "天下一品 西長堀店",
          "area": "大阪市九条1丁目",
          "fee": 320,
          "distanceKm": 2.49,
          "durationStr": "16分10秒",
          "points": 1,
          "memo": "公式配達先表記: 1-chōme 27 Osaka Kujō Japan"
        },
        {
          "id": "del_0924_11",
          "index": 11,
          "completedAt": "15:13",
          "restaurant": "松屋 九条店 Matsuya Kujo",
          "area": "大阪市此花区梅香1丁目",
          "fee": 666,
          "distanceKm": 4.12,
          "durationStr": "29分1秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0924_12",
          "index": 12,
          "completedAt": "15:42",
          "restaurant": "すき家 此花四貫島店 Sukiya Konohana Shikanjima",
          "area": "大阪市此花区春日出北1丁目",
          "fee": 320,
          "distanceKm": 2.98,
          "durationStr": "16分52秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_13",
          "index": 13,
          "completedAt": "16:20",
          "restaurant": "名代 かすうどん ながた 西九条店",
          "area": "大阪市港区弁天4丁目",
          "fee": 757,
          "distanceKm": 8.32,
          "durationStr": "56分11秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0924_14",
          "index": 14,
          "completedAt": "17:39",
          "restaurant": "やよい軒 フォレオ大阪ドームシティ店",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 320,
          "distanceKm": 1.74,
          "durationStr": "13分18秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_15",
          "index": 15,
          "completedAt": "18:09",
          "restaurant": "築地銀だこ イオンモール大阪ドームシティ店 Tsukiji Gindaco Aeon Mall Osaka Dome City",
          "area": "大阪市港区南市岡1丁目",
          "fee": 320,
          "distanceKm": 3.11,
          "durationStr": "23分4秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0924_16",
          "index": 16,
          "completedAt": "18:39",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市此花区梅香1丁目",
          "fee": 677,
          "distanceKm": 6.39,
          "durationStr": "40分55秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        }
      ],
      "quests": [
        {
          "id": "quest_0924_1",
          "time": "19:23",
          "title": "クエスト",
          "amount": 8890,
          "isDuplicateIgnored": false,
          "questName": "80回乗車クエスト",
          "questType": "special",
          "achievedAt": "19:15",
          "note": "公式一覧は 19:15「80 回乗車クエスト ¥8,890」（達成表示）と 19:23「クエスト ¥8,890」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0924_2",
          "time": "19:23",
          "title": "クエスト",
          "amount": 600,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "achievedAt": "19:15",
          "note": "公式一覧は 19:15「6 回乗車クエスト ¥600」（達成表示）と 19:23「クエスト ¥600」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）。15:00の「6 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 7699,
        "quest": 9490,
        "adjustment": 0,
        "other": 0,
        "total": 17189
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-24T12:04:21.039Z"
      }
    }
  }
};

// Bike（バイクシェア等）経費の共通判定。週次・月次のBike集計、履歴の「B」バッジ、経費一覧表示で共用する。
// 「バイクシェア」（稼働画面の経費入力）・「バイクシェア利用」（既存データ）・レンタバイク／レンタサイクル等を含む。
// カテゴリ未設定の経費は従来の集計どおりBike扱い。「必要経費」はBikeではない。
function isBikeExpenseCategory(category) {
  const cat = String(category || '').trim();
  return !cat || cat.includes('バイク') || cat.includes('サイクル') || cat.toLowerCase().includes('bike');
}
function isBikeExpense(expense) {
  const amt = Number(expense && expense.amount);
  return !isNaN(amt) && amt > 0 && isBikeExpenseCategory(expense.category);
}

// ------------------------------------------------------------
// ユーザー入力データ（経費など）のマージ（端末保存・クラウド同期で共用）
// 経費は Uber 公式データとは別のユーザーデータ。日別ログ全体の新旧で丸ごと勝ち負けさせず、必ずID単位で統合する。
//  - 片方にだけある経費は残す（削除済み tombstone に載っているものだけ除く）
//  - 同じIDは updatedAt（無ければ createdAt）が新しい方。同じなら primary 側
//  - deletedExpenseIds は両方の和集合（削除した経費を復活させない）
// ------------------------------------------------------------
function expenseTime(e) {
  const t = Date.parse((e && (e.updatedAt || e.createdAt)) || '');
  return isNaN(t) ? 0 : t;
}
function mergeExpenseLists(primary, other, deletedIds = []) {
  const deleted = new Set(deletedIds);
  const map = new Map();
  const keyOf = e => (e && e.id) ? e.id : `noid:${JSON.stringify(e)}`;
  (Array.isArray(primary) ? primary : []).forEach(e => map.set(keyOf(e), { ...e }));
  (Array.isArray(other) ? other : []).forEach(e => {
    const k = keyOf(e);
    const cur = map.get(k);
    if (!cur || expenseTime(e) > expenseTime(cur)) map.set(k, { ...e });
  });
  return Array.from(map.values()).filter(e => !(e && e.id && deleted.has(e.id)));
}
function mergeById(primary, other) {
  const map = new Map();
  (Array.isArray(other) ? other : []).forEach(x => map.set(x && x.id, { ...x }));
  (Array.isArray(primary) ? primary : []).forEach(x => map.set(x && x.id, { ...(map.get(x && x.id) || {}), ...x }));
  return Array.from(map.values());
}
// 同じ日の2つのコピーを統合（primary の内容を基本に、other にしか無いユーザー入力を失わない）
function mergeDayUserData(primary, other) {
  if (!other) return primary;
  if (!primary) return other;
  const merged = { ...primary };
  const deletedIds = Array.from(new Set([
    ...(Array.isArray(primary.deletedExpenseIds) ? primary.deletedExpenseIds : []),
    ...(Array.isArray(other.deletedExpenseIds) ? other.deletedExpenseIds : [])
  ]));
  if (primary.expenses || other.expenses) merged.expenses = mergeExpenseLists(primary.expenses, other.expenses, deletedIds);
  if (deletedIds.length) merged.deletedExpenseIds = deletedIds;
  if (primary.workSessions || other.workSessions) {
    merged.workSessions = mergeById(primary.workSessions, other.workSessions)
      .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  }
  if (primary.manualTapsArchive || other.manualTapsArchive) merged.manualTapsArchive = mergeById(primary.manualTapsArchive, other.manualTapsArchive);
  if (!merged.vehicleType && other.vehicleType) merged.vehicleType = other.vehicleType;
  return merged;
}

// シードの確定Bike経費（9/18・9/19 等）が端末データに無い場合だけ追加する。既存の経費は置き換えない。
// ユーザーが削除した（deletedExpenseIds にある）シード経費は復活させない。追加したら true
function restoreSeedBikeExpense(target, seedLog) {
  const seedExpenses = Array.isArray(seedLog.expenses) ? seedLog.expenses : [];
  if (!seedExpenses.length) return false;
  const current = Array.isArray(target.expenses) ? target.expenses : [];
  const deleted = Array.isArray(target.deletedExpenseIds) ? target.deletedExpenseIds : [];
  if (current.some(isBikeExpense) || seedExpenses.some(e => deleted.includes(e.id))) return false;
  target.expenses = current.concat(seedExpenses.filter(e => !current.some(c => c.id === e.id)));
  if (!target.vehicleType) target.vehicleType = 'バイクシェア利用';
  return true;
}

function getConfirmedSeedData() {
  return JSON.parse(JSON.stringify(CONFIRMED_SEED_DATA));
}

// 公式取込v1で反映された日（シードに officialImport あり）を端末データへ同期する。
// - 公式側: trip（ID単位）・件数・距離・クエスト・売上調整・売上内訳をシードに合わせる
// - 端末側: 経費・稼働セッション・○×評価・理由メモ等はそのまま保持
// - シードに無い配達記録（手動タップ等）は削除せず manualTapsArchive へ退避
// 変更があれば true を返す
function syncOfficialImportedDay(target, log) {
  let changed = false;
  const current = Array.isArray(target.deliveries) ? target.deliveries : [];
  const seedIds = new Set(log.deliveries.map(d => d.id));

  const leftovers = current.filter(d => !seedIds.has(d.id));
  if (leftovers.length > 0) {
    const archive = Array.isArray(target.manualTapsArchive) ? target.manualTapsArchive : [];
    const archivedIds = new Set(archive.map(d => d.id));
    leftovers.forEach(d => {
      if (!archivedIds.has(d.id)) archive.push(d);
    });
    target.manualTapsArchive = archive;
    changed = true;
  }

  const byId = new Map(current.map(d => [d.id, d]));
  const nextDeliveries = log.deliveries.map(sd => ({ ...(byId.get(sd.id) || {}), ...sd }));
  if (JSON.stringify(nextDeliveries) !== JSON.stringify(current)) {
    target.deliveries = nextDeliveries;
    changed = true;
  }

  ['tripsCount', 'officialPoints', 'deliveriesCount', 'totalDistanceKm'].forEach(k => {
    if (target[k] !== log[k]) {
      target[k] = log[k];
      changed = true;
    }
  });

  if (JSON.stringify(target.quests || []) !== JSON.stringify(log.quests || [])) {
    target.quests = log.quests || [];
    changed = true;
  }

  if (Array.isArray(log.adjustments)) {
    const adjMap = new Map((Array.isArray(target.adjustments) ? target.adjustments : []).map(a => [a.id, a]));
    log.adjustments.forEach(a => adjMap.set(a.id, { ...(adjMap.get(a.id) || {}), ...a }));
    const nextAdj = Array.from(adjMap.values());
    if (JSON.stringify(nextAdj) !== JSON.stringify(target.adjustments || [])) {
      target.adjustments = nextAdj;
      changed = true;
    }
  }

  const salesKeys = ['delivery', 'quest', 'adjustment', 'other', 'total'];
  if (!target.sales || salesKeys.some(k => target.sales[k] !== log.sales[k])) {
    target.sales = { ...(target.sales || {}), ...log.sales };
    changed = true;
  }
  return changed;
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

// 日本の祝日データ（2026年9月周辺の確実な国民の祝日を安全に内包。外部API依存なし）
// 日本の国民の祝日（「国民の祝日に関する法律」の現行規定で年ごとに計算。特定の年月をハードコードしない）
//  - 固定日・ハッピーマンデー（第n月曜）・春分／秋分（1980〜2099年の近似式）
//  - 振替休日: 祝日が日曜なら、その後の最初の祝日でない日
//  - 国民の休日: 前日と翌日がともに祝日の平日（例: 2026-09-22）
const japanHolidayCache = {};
function computeJapanHolidays(year) {
  if (japanHolidayCache[year]) return japanHolidayCache[year];
  const pad = n => String(n).padStart(2, '0');
  const key = (m, d) => `${year}-${pad(m)}-${pad(d)}`;
  const nthMonday = (m, n) => {
    const firstDay = new Date(year, m - 1, 1).getDay();
    return 1 + ((8 - firstDay) % 7) + (n - 1) * 7;
  };
  const base = year - 1980;
  const shunbun = Math.floor(20.8431 + 0.242194 * base - Math.floor(base / 4));
  const shubun = Math.floor(23.2488 + 0.242194 * base - Math.floor(base / 4));
  const h = {};
  h[key(1, 1)] = '元日';
  h[key(1, nthMonday(1, 2))] = '成人の日';
  h[key(2, 11)] = '建国記念の日';
  h[key(2, 23)] = '天皇誕生日';
  h[key(3, shunbun)] = '春分の日';
  h[key(4, 29)] = '昭和の日';
  h[key(5, 3)] = '憲法記念日';
  h[key(5, 4)] = 'みどりの日';
  h[key(5, 5)] = 'こどもの日';
  h[key(7, nthMonday(7, 3))] = '海の日';
  h[key(8, 11)] = '山の日';
  h[key(9, nthMonday(9, 3))] = '敬老の日';
  h[key(9, shubun)] = '秋分の日';
  h[key(10, nthMonday(10, 2))] = 'スポーツの日';
  h[key(11, 3)] = '文化の日';
  h[key(11, 23)] = '勤労感謝の日';
  const toKey = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  // 国民の休日（前日・翌日が祝日の平日）
  for (let m = 1; m <= 12; m++) {
    const days = new Date(year, m, 0).getDate();
    for (let d = 2; d < days; d++) {
      const k = key(m, d);
      const dt = new Date(year, m - 1, d);
      if (!h[k] && dt.getDay() !== 0 && h[toKey(new Date(year, m - 1, d - 1))] && h[toKey(new Date(year, m - 1, d + 1))]) {
        h[k] = '国民の休日';
      }
    }
  }
  // 振替休日
  Object.keys(h).sort().forEach(k => {
    const [yy, mm, dd] = k.split('-').map(Number);
    if (new Date(yy, mm - 1, dd).getDay() !== 0) return;
    const next = new Date(yy, mm - 1, dd + 1);
    while (h[toKey(next)]) next.setDate(next.getDate() + 1);
    if (next.getFullYear() === year) h[toKey(next)] = '振替休日';
  });
  japanHolidayCache[year] = h;
  return h;
}
function getJapanHolidayName(dateStr) {
  if (!dateStr) return null;
  const clean = String(dateStr).replace(/\//g, '-');
  const year = Number(clean.slice(0, 4));
  if (!year) return null;
  return computeJapanHolidays(year)[clean] || null;
}
// 後方互換: 以前の固定表（JAPAN_HOLIDAYS[日付]）と同じ形で参照できるよう、前後の年を計算して展開
const JAPAN_HOLIDAYS = (() => {
  const all = {};
  const y = new Date().getFullYear();
  for (let yy = Math.min(2026, y) - 1; yy <= Math.max(2026, y) + 5; yy++) Object.assign(all, computeJapanHolidays(yy));
  return all;
})();

// 曜日・祝日判定ヘルパー
function getDayOfWeekInfo(dateStr) {
  if (!dateStr) return null;
  const cleanStr = dateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayIndex = dateObj.getDay();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekdayChar = weekdays[dayIndex];

  const holidayName = getJapanHolidayName(cleanStr);
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

// 簡潔な日付表記（例: 年自明時 9月19日（土）、年要時 2026/9/19（土））
function formatShortJapaneseDate(dateStr, includeYear = false) {
  if (!dateStr) return '';
  const cleanStr = dateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const info = getDayOfWeekInfo(cleanStr);
  const weekday = info ? info.weekdayChar : '';
  if (includeYear) {
    return `${y}/${m}/${d}（${weekday}）`;
  }
  return `${m}月${d}日（${weekday}）`;
}

// 日本語日付HTML（曜日表記（土）（日）は維持、文字色は通常の日付色に統一）
function formatDateWithColoredWeekday(dateStr, includeYear = false) {
  if (!dateStr) return '';
  const cleanStr = dateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const info = getDayOfWeekInfo(cleanStr);
  const weekdayChar = info ? info.weekdayChar : '';
  
  // 土日祝の色分けを廃止し、通常の日付色（weekday-normal）へ統一
  const colorClass = 'weekday-normal';

  const weekdayHtml = `<span class="date-weekday ${colorClass}">（${weekdayChar}）</span>`;
  if (includeYear) {
    return `${y}/${m}/${d}${weekdayHtml}`;
  }
  return `${m}月${d}日${weekdayHtml}`;
}

// 次回振込予定日（日曜日締め -> 翌火曜日。銀行営業日でない場合は次の営業日へ順次繰り越し）
function getNextPayoutDate(weekEndDateStr) {
  if (!weekEndDateStr) return '';
  const cleanStr = weekEndDateStr.replace(/\//g, '-');
  const [y, m, d] = cleanStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  // 日曜日締めから火曜日（2日後）へ
  dateObj.setDate(dateObj.getDate() + 2);

  // 銀行休業日（土曜・日曜・祝日）の場合は営業日まで順次繰越
  for (let i = 0; i < 14; i++) {
    const day = dateObj.getDay();
    const curY = dateObj.getFullYear();
    const curM = String(dateObj.getMonth() + 1).padStart(2, '0');
    const curD = String(dateObj.getDate()).padStart(2, '0');
    const isoStr = `${curY}-${curM}-${curD}`;
    const isWeekend = day === 0 || day === 6;
    const isHoliday = !!getJapanHolidayName(isoStr);

    if (!isWeekend && !isHoliday) {
      const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
      return `${dateObj.getMonth() + 1}月${dateObj.getDate()}日（${weekdays[day]}）`;
    }
    dateObj.setDate(dateObj.getDate() + 1);
  }
  return '';
}

// 日別属性の定義辞書（将来の属性拡張に対応するメタデータ設計）
const DAY_ATTRIBUTE_DEFINITIONS = {
  bike_share: {
    key: 'bike_share',
    label: 'B',
    fullName: 'バイクシェア利用',
    className: 'attr-bike',
    description: 'ドコモ・バイクシェア等の電動アシスト自転車を利用して稼働した日'
  },
  adjustment: {
    key: 'adjustment',
    label: '調',
    fullName: '売上調整金',
    className: 'attr-adjustment',
    description: '基本報酬や通常クエストとは別に調整金が付与された日'
  },
  special_bonus: {
    key: 'special_bonus',
    label: '賞',
    fullName: '特別保証・ボーナス',
    className: 'attr-bonus',
    description: '通常報酬や通常クエストとは別の特別保証・ボーナスが発生した日'
  },
  special_quest: {
    key: 'special_quest',
    label: '🏆',
    fullName: '特別クエスト',
    className: 'attr-bonus attr-quest-trophy',
    description: '特別クエスト（questType: special。例: 80回乗車クエスト）の報酬があった日。配色は「賞」と同じ金色系'
  },
  tip: {
    key: 'tip',
    label: '♥',
    fullName: 'チップ',
    className: 'attr-tip',
    description: 'チップを受け取った配達がある日（チップは配達の最終売上に含まれ、別途加算しない）'
  },
  more: {
    key: 'more',
    label: '+N',
    fullName: '追加属性',
    className: 'attr-more',
    description: '横幅制約により集約された追加属性'
  }
};

// 属性表示の固定優先順位（B -> 調 -> 賞 の定義順）
const DAY_ATTRIBUTE_PRIORITY = ['bike_share', 'adjustment', 'special_bonus', 'special_quest', 'tip'];

// 所要時間文字列を秒単位の数値に正確にパース（公式トリップ所要時間の厳密合算用）
function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const s = durationStr.trim();
  if (!s || s === '0秒') return 0;

  let totalSeconds = 0;
  const hourMatch = s.match(/(\d+)\s*時間/);
  const minMatch = s.match(/(\d+)\s*分/);
  const secMatch = s.match(/(\d+)\s*秒/);

  if (hourMatch) totalSeconds += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
  if (secMatch) totalSeconds += parseInt(secMatch[1], 10);

  if (!hourMatch && !minMatch && !secMatch && s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      totalSeconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  return totalSeconds;
}

// UI表示用住所（内部データは変えず、表示時のみ「大阪市」を省略）
function formatDisplayAddress(addr) {
  if (!addr) return '';
  return String(addr).replace(/^大阪市/, '').trim();
}

// UI表示用所要時間フォーマット（内部データは変えず、表示時のみ「分・秒」をコロン形式「MM:SS」へ変換。秒は必ず2桁）
function formatDurationColon(durationStr) {
  if (!durationStr) return '';
  const s = String(durationStr).trim();

  // 例: 1時間13分, 4時間30分, 1時間13分20秒
  const matchH = s.match(/^(\d+)時間(?:(\d+)分)?(?:(\d+)秒)?$/);
  if (matchH) {
    const h = parseInt(matchH[1], 10);
    const m = parseInt(matchH[2] || '0', 10);
    const sec = parseInt(matchH[3] || '0', 10);
    const totalMinutes = h * 60 + m;
    return `${totalMinutes}:${String(sec).padStart(2, '0')}`;
  }

  // 例: 23分26秒, 27分6秒, 25分0秒, 15分
  const matchM = s.match(/^(\d+)分(?:(\d+)秒)?$/);
  if (matchM) {
    const m = parseInt(matchM[1], 10);
    const sec = parseInt(matchM[2] || '0', 10);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // 例: 0秒, 45秒
  const matchS = s.match(/^(\d+)秒$/);
  if (matchS) {
    const sec = parseInt(matchS[1], 10);
    return `0:${String(sec).padStart(2, '0')}`;
  }

  return s;
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

// クエスト二重計上検知・排除ロジック（同一時刻・同額および「クエスト」と「1回乗車クエスト」の重複排除）
function deduplicateQuests(questList = []) {
  if (!Array.isArray(questList)) return [];
  
  const processed = [];
  const seenKeys = new Set();
  const seenAmountPairs = new Map();

  questList.forEach((q) => {
    const rawTime = (q.time || '').replace(/頃/, '').trim();
    const amount = Number(q.amount) || 0;
    const title = (q.title || '').trim();
    
    // 1. 同時刻・同額のキー
    const timeKey = rawTime ? `${rawTime}_${amount}` : null;
    
    // 2. 「クエスト」と「1回乗車クエスト」の重複ペア判定
    const isQuestVariant = /1回乗車クエスト|乗車クエスト/.test(title);
    const isBaseQuest = /^クエスト$|^Quest$/i.test(title);

    let isDuplicate = false;
    let reason = '';

    if (timeKey && seenKeys.has(timeKey)) {
      isDuplicate = true;
      reason = '同一時刻・同額の重複検知により除外';
    } else if (isQuestVariant && seenAmountPairs.has(amount)) {
      isDuplicate = true;
      reason = '「クエスト」と「1回乗車クエスト」の同額重複検知により除外';
    } else if (isBaseQuest && seenAmountPairs.has(amount) && seenAmountPairs.get(amount).isQuestVariant) {
      isDuplicate = true;
      reason = '「クエスト」と「1回乗車クエスト」の同額重複検知により除外';
    }

    if (timeKey) {
      seenKeys.add(timeKey);
    }
    if (!seenAmountPairs.has(amount)) {
      seenAmountPairs.set(amount, { title, isQuestVariant, isBaseQuest, time: rawTime });
    }

    processed.push({
      ...q,
      isDuplicateIgnored: isDuplicate,
      dedupReason: isDuplicate ? reason : undefined
    });
  });

  return processed;
}

// Uber Driver PC版売上テキスト解析関数
function parseUberSalesText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      deliverySales: 0,
      questSales: 0,
      adjustmentSales: 0,
      otherSales: 0,
      totalSales: 0,
      deliveryCount: 0,
      detectedQuests: [],
      detectedAdjustments: [],
      rawLines: []
    };
  }

  // 全角数字・記号を半角に正規化
  const normalized = rawText
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[￥]/g, '¥');

  const lines = normalized
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const extractAmount = (str) => {
    if (!str) return null;
    const clean = str.replace(/,/g, '');
    // 1. ¥1,234 or 1,234円
    const mWithUnit = clean.match(/[+\-]?\s*[¥￥]\s*(\d+(?:\.\d+)?)/) ||
                      clean.match(/[+\-]?\s*(\d+(?:\.\d+)?)\s*円/);
    if (mWithUnit) return Math.round(parseFloat(mWithUnit[1]));

    // 2. 単独数値行（1回、11件等のカウントを誤検知しないよう除外）
    if (/^\s*[+\-]?\d+(?:\.\d+)?\s*$/.test(clean.trim())) {
      const num = parseFloat(clean.trim());
      return isNaN(num) ? null : Math.round(num);
    }
    return null;
  };

  let deliveryTotal = null;
  let detectedQuests = [];
  let detectedAdjustments = [];
  let otherIncome = 0;
  let totalSales = null;
  let deliveryCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1] || '';
    const prevLine = lines[i - 1] || '';

    // 配達件数: "11件" or "11 件の乗車"
    const countMatch = line.match(/(\d+)\s*件/);
    if (countMatch && deliveryCount === 0) {
      deliveryCount = parseInt(countMatch[1], 10);
    }

    // 配達 / Delivery
    if (/^(?:配達|Delivery|乗車|配達報酬)$/i.test(line) || /^(?:配達|Delivery|乗車)[:：]/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && deliveryTotal === null) {
        deliveryTotal = amt;
      }
    }

    // クエスト / 1回乗車クエスト
    if (/クエスト|Quest|インセンティブ/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && amt > 0) {
        let time = '';
        const timeMatch = prevLine.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/) ||
                          line.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/) ||
                          nextLine.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
        if (timeMatch) time = timeMatch[0];

        detectedQuests.push({
          id: `quest_import_${Date.now()}_${detectedQuests.length}`,
          title: line,
          amount: amt,
          time: time
        });
      }
    }

    // 調整金 / Adjustment / 料金の調整
    if (/調整|Adjustment/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && amt > 0) {
        detectedAdjustments.push({
          title: line,
          amount: amt
        });
      }
    }

    // チップ / その他
    if (/チップ|Tip/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && amt > 0) {
        otherIncome += amt;
      }
    }

    // 総売上 / 売上
    if (/^(?:売上|純売上|総売上|合計|Total)$/i.test(line) || /(?:日次|本日)売上/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && totalSales === null) {
        totalSales = amt;
      }
    }
  }

  // クエスト二重計上排除
  const dedupedQuests = deduplicateQuests(detectedQuests);
  const validQuestTotal = dedupedQuests
    .filter(q => !q.isDuplicateIgnored)
    .reduce((sum, q) => sum + (Number(q.amount) || 0), 0);

  const adjustmentTotal = detectedAdjustments.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  // 配達売上の補正: もし配達ラベルが見当たらず総売上がある場合
  if (deliveryTotal === null && totalSales !== null) {
    deliveryTotal = Math.max(0, totalSales - validQuestTotal - adjustmentTotal - otherIncome);
  } else if (deliveryTotal === null) {
    deliveryTotal = 0;
  }

  const calculatedTotal = deliveryTotal + validQuestTotal + adjustmentTotal + otherIncome;
  if (totalSales === null) {
    totalSales = calculatedTotal;
  }

  return {
    deliverySales: deliveryTotal,
    questSales: validQuestTotal,
    adjustmentSales: adjustmentTotal,
    otherSales: otherIncome,
    totalSales: totalSales,
    deliveryCount: deliveryCount,
    detectedQuests: dedupedQuests,
    detectedAdjustments,
    rawLines: lines
  };
}

class Store {
  constructor() {
    this.state = this.loadFromStorage();
    this.watchOtherInstances();
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
      // 9/18実データ・確定データがローカルに未反映または不完全な場合は安全に補完
      const seed = getConfirmedSeedData();
      let hasChange = false;
      for (const [date, log] of Object.entries(seed.dailyLogs)) {
        if (!parsed.dailyLogs[date]) {
          parsed.dailyLogs[date] = log;
          hasChange = true;
        } else if (log.officialImport) {
          // 公式取込v1（tools/official-import）で反映された日: Uber公式データを正とし、端末側データは保持
          if (syncOfficialImportedDay(parsed.dailyLogs[date], log)) hasChange = true;
        } else if (date === '2026-09-10') {
          const target = parsed.dailyLogs[date];
          if (!target.quests || target.quests.length < 2 || !target.quests.some(q => q.amount === 100)) {
            target.quests = log.quests;
            hasChange = true;
          }
        } else if (date === '2026-09-11') {
          const target = parsed.dailyLogs[date];
          if (!target.quests || target.quests.length < 3 || !target.quests.some(q => q.amount === 125)) {
            target.quests = log.quests;
            hasChange = true;
          }
        } else if (date === '2026-09-14') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || !target.deliveries[0] || !target.deliveries[0].restaurant) {
            target.deliveries = log.deliveries;
            target.totalDistanceKm = log.totalDistanceKm;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.tripsCount = log.tripsCount;
            hasChange = true;
          }
        } else if (date === '2026-09-15') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || !target.deliveries[0] || !target.deliveries[0].restaurant) {
            target.deliveries = log.deliveries;
            target.totalDistanceKm = log.totalDistanceKm;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.tripsCount = log.tripsCount;
            hasChange = true;
          }
        } else if (date === '2026-09-16') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || !target.deliveries[0] || !target.deliveries[0].restaurant || !target.deliveries.some(d => d.isUncompletedOrAdjusted) || !target.deliveries[7] || target.deliveries[7].distanceKm === null) {
            target.deliveries = log.deliveries;
            target.totalDistanceKm = log.totalDistanceKm;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.tripsCount = log.tripsCount;
            hasChange = true;
          }
        } else if (date === '2026-09-17') {
          const target = parsed.dailyLogs[date];
          const lacksDetails = !target.deliveries ||
            target.deliveries.length !== 7 ||
            !target.deliveries[0] || !target.deliveries[0].restaurant ||
            !target.deliveries[0].durationStr ||
            target.totalDistanceKm !== 28.55;
          const lacksCounts = !target.tripsCount || !target.deliveriesCount || !target.officialPoints;
          if (lacksDetails || lacksCounts) {
            target.deliveries = log.deliveries;
            target.totalDistanceKm = log.totalDistanceKm;
            target.officialPoints = log.officialPoints || 7;
            target.deliveriesCount = log.deliveriesCount || 7;
            target.tripsCount = log.tripsCount || 7;
            target.sales = log.sales;
            hasChange = true;
          }
        } else if (date === '2026-09-18') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || target.deliveries.length !== 9 || target.deliveries[0].completedAt !== '09:06') {
            target.deliveries = log.deliveries;
            target.totalDistanceKm = log.totalDistanceKm;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.tripsCount = log.tripsCount;
            hasChange = true;
          }
          if (!target.sales) {
            target.sales = log.sales;
            hasChange = true;
          }
          // 確定Bike経費が無い場合だけ補う（ユーザーが登録した経費は置き換えない・削除済み tombstone は復活させない）
          if (restoreSeedBikeExpense(target, log)) hasChange = true;
          if (!target.workSessions || target.workSessions.length === 0) {
            target.workSessions = log.workSessions;
            target.workStartedAt = log.workStartedAt;
            target.workEndedAt = log.workEndedAt;
            target.workMinutes = log.workMinutes;
            hasChange = true;
          }
        } else if (date === '2026-09-19') {
          const target = parsed.dailyLogs[date];
          // 均等配分や仮データ（fee=340等）、手動空タップ残骸（41件混在等）、または19件の公式トリップ未更新・不一致時は公式実績データへ置換
          const hasSynthetic = target.deliveries && target.deliveries.some(d => d.fee === 340 || d.completedAt === '09:15');
          const hasWrongFukushima = target.deliveries && target.deliveries[0] && target.deliveries[0].memo && target.deliveries[0].memo.includes('福島タワー');
          const lacksFukushimaOn18 = target.deliveries && target.deliveries[target.deliveries.length - 1] && (!target.deliveries[target.deliveries.length - 1].memo || !target.deliveries[target.deliveries.length - 1].memo.includes('福島タワー'));
          const hasEmptyManualTaps = target.deliveries && target.deliveries.some(d => !d.restaurant && (d.fee === null || d.fee === undefined));
          const isNot19Trips = !target.deliveries || target.deliveries.length !== 19;
          if (isNot19Trips || hasSynthetic || hasEmptyManualTaps || !target.tripsCount || hasWrongFukushima || lacksFukushimaOn18 || target.deliveriesCount !== 23) {
            target.deliveries = log.deliveries;
            target.tripsCount = log.tripsCount;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.totalDistanceKm = log.totalDistanceKm;
            hasChange = true;
          }
          if (!target.sales || target.sales.guaranteeBonus !== 12132 || target.sales.total !== 21310) {
            target.sales = log.sales;
            hasChange = true;
          }
          // 確定Bike経費が無い場合だけ補う（ユーザーが登録した経費は置き換えない・削除済み tombstone は復活させない）
          if (restoreSeedBikeExpense(target, log)) hasChange = true;
          if (!target.quests || target.quests.length < 5) {
            target.quests = log.quests;
            hasChange = true;
          }
          if (!target.workSessions || target.workSessions.length === 0) {
            target.workSessions = log.workSessions;
            target.workStartedAt = log.workStartedAt;
            target.workEndedAt = log.workEndedAt;
            target.workMinutes = log.workMinutes;
            hasChange = true;
          }
          if (!target.milestone) {
            target.milestone = log.milestone;
            hasChange = true;
          }
        } else if (date === '2026-09-21' || date === '2026-09-22') {
          // 9/21・9/22 公式確定実績（Uber公式スクリーンショット照合済み）の安全な取り込み。
          // 端末に残る手動タップ記録は削除せず manualTapsArchive へ退避してから公式トリップへ置換する。
          const target = parsed.dailyLogs[date];
          const hasOfficialTrips = Array.isArray(target.deliveries) &&
            target.deliveries.some(d => d.restaurant || (d.fee !== null && d.fee !== undefined));
          const isNotOfficialSet = !Array.isArray(target.deliveries) ||
            target.deliveries.length !== log.deliveries.length ||
            !hasOfficialTrips;

          if (isNotOfficialSet) {
            const manualTaps = (target.deliveries || []).filter(d => !d.restaurant && (d.fee === null || d.fee === undefined));
            if (manualTaps.length > 0) {
              const archive = Array.isArray(target.manualTapsArchive) ? target.manualTapsArchive : [];
              const archivedIds = new Set(archive.map(d => d.id));
              manualTaps.forEach(d => {
                if (!archivedIds.has(d.id)) archive.push(d);
              });
              target.manualTapsArchive = archive;
            }
            target.deliveries = log.deliveries;
            target.tripsCount = log.tripsCount;
            target.officialPoints = log.officialPoints;
            target.deliveriesCount = log.deliveriesCount;
            target.totalDistanceKm = log.totalDistanceKm;
            hasChange = true;
          }
          if (!target.sales || !target.sales.delivery) {
            target.sales = log.sales;
            hasChange = true;
          }
          if (!target.quests || target.quests.length === 0) {
            target.quests = log.quests;
            hasChange = true;
          }
          // Uber公式の売上調整イベント（9/22 23:46 Support Adjustment -¥607 等）。
          // 調整イベントはID単位で保持し、sales.adjustment はイベント合計と一致させる（tripは変更しない）
          if (Array.isArray(log.adjustments) && log.adjustments.length > 0) {
            const adjList = Array.isArray(target.adjustments) ? target.adjustments : [];
            const adjIds = new Set(adjList.map(a => a.id));
            log.adjustments.forEach(a => {
              if (!adjIds.has(a.id)) {
                adjList.push(a);
                hasChange = true;
              }
            });
            target.adjustments = adjList;
            if (!target.sales || target.sales.adjustment !== log.sales.adjustment || target.sales.total !== log.sales.total) {
              target.sales = { ...(target.sales || {}), ...log.sales };
              hasChange = true;
            }
          }
          // Bike経費（¥1,527）はユーザー削除済み（tombstone）の場合は復活させない
          const bikeExpenseId = log.expenses[0].id;
          const isDeletedByUser = Array.isArray(target.deletedExpenseIds) && target.deletedExpenseIds.includes(bikeExpenseId);
          const hasBikeExpense = Array.isArray(target.expenses) && target.expenses.some(isBikeExpense);
          if (!isDeletedByUser && !hasBikeExpense) {
            target.expenses = (Array.isArray(target.expenses) ? target.expenses : []).concat(log.expenses);
            target.vehicleType = 'バイクシェア利用';
            hasChange = true;
          }
        } else {
          // 9/18, 9/19 以外の過去日（9/10〜9/17等）から誤ったバイクシェア/レンタサイクル情報を完全排除
          const target = parsed.dailyLogs[date];
          if (target) {
            if (target.vehicleType === 'レンタサイクル' || target.vehicleType === 'レンタバイク' || target.vehicleType === 'バイクシェア利用') {
              delete target.vehicleType;
              hasChange = true;
            }
            if (Array.isArray(target.expenses) && target.expenses.some(e => e.category === 'レンタバイク' || e.category === 'レンタサイクル' || e.category === 'バイクシェア利用')) {
              target.expenses = target.expenses.filter(e => e.category !== 'レンタバイク' && e.category !== 'レンタサイクル' && e.category !== 'バイクシェア利用');
              hasChange = true;
            }
          }
        }
      }
      // ○／×体験評価・理由メモデータの復元（公式実績は不変、別フィールドとして保持）
      try {
        if (typeof localStorage !== 'undefined') {
          const rawEvals = localStorage.getItem('uber_log_trip_evaluations');
          if (rawEvals) {
            const evalsMap = JSON.parse(rawEvals);
            if (evalsMap && typeof evalsMap === 'object') {
              Object.values(parsed.dailyLogs).forEach(plog => {
                if (plog.deliveries) {
                  plog.deliveries.forEach(pd => {
                    const entry = evalsMap[pd.id];
                    if (entry) {
                      if (typeof entry === 'string') {
                        pd.evaluation = entry;
                        pd.evaluationReason = '';
                      } else if (typeof entry === 'object') {
                        pd.evaluation = entry.evaluation || null;
                        pd.evaluationReason = entry.reason || '';
                      }
                    }
                  });
                }
              });
            }
          }
        }
      } catch (e) {}

      // MAP一口メモデータの復元（公式実績とは完全分離。個人情報自動転記厳禁）
      try {
        if (typeof localStorage !== 'undefined') {
          const rawMemos = localStorage.getItem('uber_log_trip_map_memos');
          if (rawMemos) {
            const memosMap = JSON.parse(rawMemos);
            if (memosMap && typeof memosMap === 'object') {
              Object.values(parsed.dailyLogs).forEach(plog => {
                if (plog.deliveries) {
                  plog.deliveries.forEach(pd => {
                    if (memosMap[pd.id] !== undefined) {
                      pd.mapMemo = String(memosMap[pd.id]);
                    }
                  });
                }
              });
            }
          }
        }
      } catch (e) {}

      if (hasChange && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        } catch (e) {}
      }

      return parsed;
    } catch (e) {
      console.error('UBER_LOG: Failed to load from storage', e);
      return getConfirmedSeedData();
    }
  }

  // 端末保存（LocalStorage）への書込。
  // 同じ端末で別の画面（タブ・ホーム画面アプリ・古いインスタンス）が先に保存した内容を、この画面の古いメモリ内容で
  // 上書きしないよう、保存済みデータを読み直して日ごとに統合してから書く（経費等のユーザー入力は ID 単位で和集合）。
  // replace: true は全データの復元・初期化のときだけ（統合せずにそのまま書く）。
  persistState({ replace = false } = {}) {
    if (typeof localStorage === 'undefined') return;
    let toWrite = this.state;
    if (!replace) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const stored = raw ? JSON.parse(raw) : null;
        if (stored && stored.dailyLogs && this.state && this.state.dailyLogs) {
          const logs = { ...stored.dailyLogs };
          Object.entries(this.state.dailyLogs).forEach(([d, day]) => {
            logs[d] = stored.dailyLogs[d] ? mergeDayUserData(day, stored.dailyLogs[d]) : day;
          });
          this.state.dailyLogs = logs;
          toWrite = { ...stored, ...this.state, dailyLogs: logs };
        }
      } catch (e) {
        // 保存済みデータが読めない場合はメモリ内容をそのまま書く
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
  }

  // 別の画面が端末保存を更新したら、この画面のメモリ内容も最新に読み直す
  watchOtherInstances() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('storage', (e) => {
      if (e && e.key && e.key !== STORAGE_KEY) return;
      try {
        this.state = this.loadFromStorage();
        if (typeof ui !== 'undefined' && ui && typeof ui.refreshAll === 'function') ui.refreshAll();
      } catch (err) {
        console.warn('UBER_LOG: failed to reload after storage change', err);
      }
    });
  }

  // LocalStorageへ保存 & クラウド同期フック呼び出し
  saveToStorage(changedDate = null, { replace = false } = {}) {
    try {
      if (typeof localStorage !== 'undefined') {
        this.persistState({ replace });
      }
      if (typeof window !== 'undefined' && window.cloudSync && typeof window.cloudSync.onLocalDataSaved === 'function') {
        window.cloudSync.onLocalDataSaved(changedDate);
      }
    } catch (e) {
      console.error('UBER_LOG: Failed to save to storage', e);
    }
  }

  // ○／×体験評価の登録・変更・解除（公式実績本体は不変、解除時も理由は保持して誤操作復元を可能にする）
  setTripEvaluation(deliveryId, evaluation) {
    if (!deliveryId) return null;
    const cleanEval = (evaluation === 'OK' || evaluation === 'AVOID') ? evaluation : null;

    let prevReason = '';
    try {
      if (typeof localStorage !== 'undefined') {
        let evalsMap = {};
        const raw = localStorage.getItem('uber_log_trip_evaluations');
        if (raw) {
          try { evalsMap = JSON.parse(raw) || {}; } catch (e) {}
        }
        const existing = evalsMap[deliveryId];
        if (typeof existing === 'string') {
          prevReason = '';
        } else if (existing && typeof existing === 'object') {
          prevReason = existing.reason || '';
        }

        // 保存用オブジェクトの構築（解除時も誤操作保護のためreasonは保持）
        evalsMap[deliveryId] = {
          evaluation: cleanEval,
          reason: prevReason,
          updatedAt: new Date().toISOString()
        };
        localStorage.setItem('uber_log_trip_evaluations', JSON.stringify(evalsMap));
      }
    } catch (e) {}

    // 現在のstate内のdelivery.evaluationを更新（既存のevaluationReasonは保持）
    let changedDate = null;
    const allLogs = this.state && this.state.dailyLogs ? Object.entries(this.state.dailyLogs) : [];
    for (const [date, log] of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          d.evaluation = cleanEval;
          if (prevReason && !d.evaluationReason) {
            d.evaluationReason = prevReason;
          }
          changedDate = date;
          break;
        }
      }
    }

    this.saveToStorage(changedDate);
    return cleanEval;
  }

  // ○／×評価理由の一言メモ保存（利用者が明示的に編集した時のみ更新、既存詳細メモとは完全分離）
  setTripEvaluationReason(deliveryId, reasonText) {
    if (!deliveryId) return '';
    const cleanReason = typeof reasonText === 'string' ? reasonText : '';

    try {
      if (typeof localStorage !== 'undefined') {
        let evalsMap = {};
        const raw = localStorage.getItem('uber_log_trip_evaluations');
        if (raw) {
          try { evalsMap = JSON.parse(raw) || {}; } catch (e) {}
        }
        const existing = evalsMap[deliveryId];
        const curEval = typeof existing === 'string' ? existing : (existing && existing.evaluation ? existing.evaluation : null);

        evalsMap[deliveryId] = {
          evaluation: curEval,
          reason: cleanReason,
          updatedAt: new Date().toISOString()
        };
        localStorage.setItem('uber_log_trip_evaluations', JSON.stringify(evalsMap));
      }
    } catch (e) {}

    // 現在のstate内のdelivery.evaluationReasonを更新
    let changedDate = null;
    const allLogs = this.state && this.state.dailyLogs ? Object.entries(this.state.dailyLogs) : [];
    for (const [date, log] of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          d.evaluationReason = cleanReason;
          changedDate = date;
          break;
        }
      }
    }

    this.saveToStorage(changedDate);
    return cleanReason;
  }

  // ○／×体験評価および理由メモの取得
  getTripEvaluationData(deliveryId) {
    if (!deliveryId) return { evaluation: null, reason: '' };
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('uber_log_trip_evaluations');
        if (raw) {
          const evalsMap = JSON.parse(raw);
          if (evalsMap && evalsMap[deliveryId]) {
            const item = evalsMap[deliveryId];
            if (typeof item === 'string') {
              return { evaluation: item, reason: '' };
            } else if (typeof item === 'object') {
              return { evaluation: item.evaluation || null, reason: item.reason || '' };
            }
          }
        }
      }
    } catch (e) {}

    const allLogs = this.state && this.state.dailyLogs ? Object.values(this.state.dailyLogs) : [];
    for (const log of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          return { evaluation: d.evaluation || null, reason: d.evaluationReason || '' };
        }
      }
    }
    return { evaluation: null, reason: '' };
  }

  // ○／×体験評価の取得（従来の互換性維持）
  getTripEvaluation(deliveryId) {
    const data = this.getTripEvaluationData(deliveryId);
    return data ? data.evaluation : null;
  }

  // MAP一口メモの保存（地図・ルート・建物名・入口等の本人経験記録。公式データ・○×評価とは完全分離。個人情報自動転記厳禁）
  setTripMapMemo(deliveryId, memoText) {
    if (!deliveryId) return '';
    const cleanMemo = typeof memoText === 'string' ? memoText : '';

    try {
      if (typeof localStorage !== 'undefined') {
        let memosMap = {};
        const raw = localStorage.getItem('uber_log_trip_map_memos');
        if (raw) {
          try { memosMap = JSON.parse(raw) || {}; } catch (e) {}
        }
        if (cleanMemo.trim()) {
          memosMap[deliveryId] = cleanMemo;
        } else {
          delete memosMap[deliveryId];
        }
        localStorage.setItem('uber_log_trip_map_memos', JSON.stringify(memosMap));
      }
    } catch (e) {
      console.warn('UBER_LOG: Failed to save map memo to localStorage', e);
    }

    const allLogs = this.state && this.state.dailyLogs ? Object.values(this.state.dailyLogs) : [];
    for (const log of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          d.mapMemo = cleanMemo;
          break;
        }
      }
    }

    return cleanMemo;
  }

  // MAP一口メモの取得
  getTripMapMemo(deliveryId) {
    if (!deliveryId) return '';
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('uber_log_trip_map_memos');
        if (raw) {
          const memosMap = JSON.parse(raw);
          if (memosMap && memosMap[deliveryId] !== undefined) {
            return String(memosMap[deliveryId]);
          }
        }
      }
    } catch (e) {}

    const allLogs = this.state && this.state.dailyLogs ? Object.values(this.state.dailyLogs) : [];
    for (const log of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d && d.mapMemo) {
          return String(d.mapMemo);
        }
      }
    }
    return '';
  }

  // 履歴画面: 配達明細の表示順ソート順序を取得（'newest' | 'oldest'）
  // 初期値: 'newest'（直近の配達を先頭に表示）
  getHistorySortOrder() {
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem('uber_log_history_sort_order');
        if (val === 'oldest') return 'oldest';
      }
    } catch (e) {}
    return 'newest';
  }

  // 履歴画面: 配達明細の表示順ソート順序を端末内に保存
  setHistorySortOrder(order) {
    const val = (order === 'oldest') ? 'oldest' : 'newest';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('uber_log_history_sort_order', val);
      }
    } catch (e) {}
    return val;
  }

  // 今週のクエスト設定オブジェクトを取得
  getCurrentWeekQuest() {
    return CURRENT_WEEK_QUEST;
  }

  // 指定日時がクエスト期間内（2026-09-21 04:00 〜 2026-09-25 04:00）か判定
  isDateTimeInQuestPeriod(dateStr, timeStr, quest = CURRENT_WEEK_QUEST) {
    if (!dateStr) return false;
    const cleanDate = String(dateStr).replace(/\//g, '-');
    const cleanTime = (timeStr && timeStr.length >= 5) ? timeStr.slice(0, 5) : '12:00';
    const isoStr = `${cleanDate}T${cleanTime}:00+09:00`;
    const t = new Date(isoStr).getTime();
    const start = new Date(quest.startAt).getTime();
    const end = new Date(quest.endAt).getTime();
    return t >= start && t < end;
  }

  // クエスト期間内の実配達件数を集計（公式トリップはポイント数＝配達件数、手動タップは1件）
  countQuestDeliveries(quest = CURRENT_WEEK_QUEST) {
    let logDeliveriesCount = 0;
    const startMs = new Date(quest.startAt).getTime();
    const endMs = new Date(quest.endAt).getTime();

    if (this.state && this.state.dailyLogs) {
      Object.values(this.state.dailyLogs).forEach(log => {
        if (log.deliveries && Array.isArray(log.deliveries)) {
          log.deliveries.forEach(del => {
            const dStr = (del.date || log.date || '').replace(/\//g, '-');
            const tStr = (del.completedAt && del.completedAt.length >= 5) ? del.completedAt.slice(0, 5) : '12:00';
            const tMs = new Date(`${dStr}T${tStr}:00+09:00`).getTime();
            if (tMs >= startMs && tMs < endMs) {
              // 公式トリップはダブル・トリプル配達を含むためポイント数を配達件数として加算
              const pts = Number(del.points);
              logDeliveriesCount += (!isNaN(pts) && pts > 0) ? pts : 1;
            }
          });
        }
      });
    }

    return logDeliveriesCount;
  }

  // 今週のクエスト進捗データを取得（累積進捗・残り件数・達成率）
  getQuestProgress(quest = CURRENT_WEEK_QUEST) {
    const logDeliveriesCount = this.countQuestDeliveries(quest);
    const startMs = new Date(quest.startAt).getTime();
    const endMs = new Date(quest.endAt).getTime();

    // 端末保存の累積カウンター確認
    // 公式確定実績を取り込んだ時点（QUEST_OFFICIAL_BASELINE）より前に保存された
    // 手動オフセットは、公式件数と二重になるため無効として扱う
    let manualAdjust = 0;
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(`uber_log_quest_${quest.id}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed.manualAdjust === 'number' && parsed.officialBaseline === QUEST_OFFICIAL_BASELINE) {
            manualAdjust = parsed.manualAdjust;
          }
        }
      }
    } catch (e) {}

    const currentCount = Math.max(0, logDeliveriesCount + manualAdjust);
    const nowMs = Date.now();
    const isStarted = nowMs >= startMs;
    const isEnded = nowMs >= endMs;
    const isAchieved = currentCount >= quest.targetCount;
    const remainingCount = Math.max(0, quest.targetCount - currentCount);
    const percentage = Math.min(100, Math.round((currentCount / quest.targetCount) * 100));

    return {
      questId: quest.id,
      title: quest.title,
      targetCount: quest.targetCount,
      currentCount,
      remainingCount,
      percentage,
      deadlineText: quest.deadlineText,
      startAt: quest.startAt,
      endAt: quest.endAt,
      isStarted,
      isEnded,
      isAchieved
    };
  }

  // クエスト手動調整オフセットを保存
  saveQuestProgress(questId, manualAdjust) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`uber_log_quest_${questId}`, JSON.stringify({
          questId,
          manualAdjust,
          officialBaseline: QUEST_OFFICIAL_BASELINE,
          updatedAt: new Date().toISOString()
        }));
      }
    } catch (e) {}
  }

  // クエスト進捗手動設定
  setQuestProgressCount(count, quest = CURRENT_WEEK_QUEST) {
    const targetCount = Math.max(0, Number(count) || 0);
    const logDeliveriesCount = this.countQuestDeliveries(quest);
    const manualAdjust = targetCount - logDeliveriesCount;
    this.saveQuestProgress(quest.id, manualAdjust);
    return targetCount;
  }

  // クエスト進捗をインクリメント（＋1）
  incrementQuestProgress(quest = CURRENT_WEEK_QUEST) {
    const progress = this.getQuestProgress(quest);
    return this.setQuestProgressCount(progress.currentCount + 1, quest);
  }

  // クエスト進捗をデクリメント（－1、0未満にはしない）
  decrementQuestProgress(quest = CURRENT_WEEK_QUEST) {
    const progress = this.getQuestProgress(quest);
    return this.setQuestProgressCount(Math.max(0, progress.currentCount - 1), quest);
  }

  // 日別属性の判定（将来の属性拡張に対応する構造化メタデータ）
  getDayAttributes(dateStr) {
    if (!dateStr) return [];
    const attrs = [];
    const log = this.state && this.state.dailyLogs ? this.state.dailyLogs[dateStr] : null;

    // 1. バイクシェア属性 (B)
    // 正式定義: 「その日にバイクシェアを実際に利用したことが確認済み」
    // 自転車配達・推測・過去日パターン・単なるvehicleTypeフラグ等での付与は厳禁。
    // 判定基準: その日の log.expenses[] にBike経費（amount > 0）が1件以上あること。
    // 判定は週次・月次のBike集計と同じ isBikeExpense() を使う（稼働画面で登録する「バイクシェア」も対象）。
    // 経費を全件削除すればBも消える。9/18・9/19 も確定済みのBike経費データで判定される。
    const hasBikeExpense = log && Array.isArray(log.expenses) && log.expenses.some(isBikeExpense);

    if (hasBikeExpense) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.bike_share);
    }

    // 2. 調整金属性 (調)
    // 対象日: 調整金（adjustmentSales）が存在する日（プラス例: 2026-09-18 +¥200 / マイナス例: 2026-09-22 -¥607）
    const metrics = log ? this.getCalculatedMetrics(log) : null;
    if (metrics && metrics.adjustmentSales !== 0) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.adjustment);
    }

    // 3. 特別保証・ボーナス属性 (賞)
    // 対象日: guaranteeBonus > 0 の日（例: 2026-09-19）
    if ((metrics && metrics.guaranteeBonus > 0) || (log && log.sales && log.sales.guaranteeBonus > 0) || dateStr === '2026-09-19') {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.special_bonus);
    }

    // 定義された優先順位に従って固定ソート（B -> 調 -> 賞）
    // 3-2. 特別クエスト属性 (🏆): questType が special のクエストが1件以上ある日（複数あっても1個）
    if (metrics && metrics.specialQuestSales > 0) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.special_quest);
    }

    // 4. チップ属性 (♥): その日の配達にチップ（tip > 0）がある日
    if (metrics && metrics.tipSales > 0) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.tip);
    }

    const priority = (typeof DAY_ATTRIBUTE_PRIORITY !== 'undefined') ? DAY_ATTRIBUTE_PRIORITY : ['bike_share', 'adjustment', 'special_bonus', 'special_quest', 'tip'];
    attrs.sort((a, b) => {
      const idxA = priority.indexOf(a.key);
      const idxB = priority.indexOf(b.key);
      return (idxA !== -1 ? idxA : 999) - (idxB !== -1 ? idxB : 999);
    });

    return attrs;
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


  // 昨日との比較データを取得（細かな表ではなく、直感的なペースと昨日実績）
  getYesterdayComparison(dateStr = getTodayDateString()) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const currentDate = new Date(y, m - 1, d);
    currentDate.setDate(currentDate.getDate() - 1);
    const yYear = currentDate.getFullYear();
    const yMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
    const yDay = String(currentDate.getDate()).padStart(2, '0');
    const yesterdayStr = `${yYear}-${yMonth}-${yDay}`;

    const todayLog = this.getDailyLog(dateStr);
    const todayMetrics = this.getCalculatedMetrics(todayLog);

    const yesterdayLog = this.state.dailyLogs[yesterdayStr];
    if (!yesterdayLog) {
      return null;
    }

    const yesterdayMetrics = this.getCalculatedMetrics(yesterdayLog);
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    const yWeekday = weekdays[currentDate.getDay()];
    const yesterdayLabel = `${parseInt(yMonth, 10)}/${parseInt(yDay, 10)}（${yWeekday}）`;

    const diffCount = todayMetrics.count - yesterdayMetrics.count;

    return {
      yesterdayDate: yesterdayStr,
      yesterdayLabel,
      todayCount: todayMetrics.count,
      yesterdayCount: yesterdayMetrics.count,
      diffCount,
      todayWorkMinutes: todayMetrics.workMinutes,
      yesterdayWorkMinutes: yesterdayMetrics.workMinutes,
      yesterdaySales: yesterdayMetrics.totalSales,
      yesterdayProfit: yesterdayMetrics.netProfit,
      yesterdayHourly: yesterdayMetrics.hourlyWage
    };
  }

  // 日別実運用指標の厳密計算（推測補完を排除、複数セッション実稼働時間・実質時給・当日経費対応）
  getCalculatedMetrics(log) {
    const count = (log.deliveriesCount !== undefined && log.deliveriesCount !== null)
      ? log.deliveriesCount
      : (log.deliveries ? log.deliveries.length : 0);
    const tripsCount = (log.tripsCount !== undefined && log.tripsCount !== null)
      ? log.tripsCount
      : (log.deliveries ? log.deliveries.length : 0);
    
    // 通常配達報酬・クエスト・調整金・その他Uber収入の計算
    let deliverySales = null;
    let questSales = null;
    let adjustmentSales = 0;
    let otherSales = 0;
    let hasExplicitSales = false;

    if (log.sales) {
      if (log.sales.delivery !== undefined && log.sales.delivery !== null) {
        deliverySales = Number(log.sales.delivery) || 0;
        hasExplicitSales = true;
      }
      if (log.sales.quest !== undefined && log.sales.quest !== null) {
        questSales = Number(log.sales.quest) || 0;
        hasExplicitSales = true;
      }
      if (log.sales.adjustment !== undefined && log.sales.adjustment !== null) {
        adjustmentSales = Number(log.sales.adjustment) || 0;
      }
      if (log.sales.other !== undefined && log.sales.other !== null) {
        otherSales = Number(log.sales.other) || 0;
      }
    }

    // 明細または手動入力からのフォールバック（過去互換）
    if (!hasExplicitSales) {
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

      const dedupedQuests = deduplicateQuests(log.quests || []);
      const validQuests = dedupedQuests.filter(q => !q.isDuplicateIgnored);
      if (dedupedQuests.length > 0) {
        questSales = validQuests.reduce((acc, q) => acc + (Number(q.amount) || 0), 0);
      } else if (log.manualQuest !== undefined && log.manualQuest !== null) {
        questSales = Number(log.manualQuest);
      }
    }

    // チップ（各配達の tip の合計）。Uber公式の最終売上（fee）にすでに含まれているため、総売上には別途加算しない。
    // 表示・分析用に「配達報酬（チップを除く）」と「チップ」に分けて見せるための内訳。
    let tipSales = 0;
    let tipCount = 0;
    (log.deliveries || []).forEach(d => {
      const t = Number(d && d.tip);
      if (Number.isFinite(t) && t > 0) {
        tipSales += t;
        tipCount++;
      }
    });
    const baseDeliverySales = deliverySales !== null ? deliverySales - tipSales : null;

    // 特別クエスト（questType: 'special'。例: 80回乗車クエスト）。クエスト報酬（questSales）の内訳で、別途加算はしない
    const specialQuests = deduplicateQuests(log.quests || [])
      .filter(q => !q.isDuplicateIgnored && q.questType === 'special' && Number(q.amount) > 0)
      .map(q => ({ name: q.questName || q.title, amount: Number(q.amount), time: q.time }));
    const specialQuestSales = specialQuests.reduce((s, q) => s + q.amount, 0);

    // 新規ドライバー保証・特別収入
    const guaranteeBonus =(log.sales && log.sales.guaranteeBonus) ? Number(log.sales.guaranteeBonus) : (Number(log.guaranteeBonus) || 0);
    const guaranteeBonusNote = (log.sales && log.sales.guaranteeBonusNote) ? log.sales.guaranteeBonusNote : (log.guaranteeBonusNote || '');

    // 1日総売上（通常稼働分 ＋ 特別保証ボーナス等すべての確認済みUber総収入）
    let totalSales = null;
    if (deliverySales !== null || questSales !== null || adjustmentSales !== 0 || otherSales !== 0 || guaranteeBonus > 0) {
      totalSales = (deliverySales || 0) + (questSales || 0) + (adjustmentSales || 0) + (otherSales || 0) + (guaranteeBonus || 0);
    }

    const totalSalesWithBonus = totalSales;
    const milestone = log.milestone || (guaranteeBonus > 0 ? '累計75配達達成' : null);

    // 当日経費（直接経費: レンタバイク代等）の計算
    const expenses = Array.isArray(log.expenses) ? log.expenses : [];
    let totalExpenses = 0;
    expenses.forEach(e => {
      const amt = Number(e.amount);
      if (!isNaN(amt) && amt > 0) {
        totalExpenses += amt;
      }
    });

    // 当日利益（売上 − 確認済み直接経費）
    const netProfit = totalSales !== null ? (totalSales - totalExpenses) : null;
    const netProfitWithBonus = netProfit;

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

    // 全配達分の確定距離が揃っているか（トリップ数または配達数に一致）
    const isFullDistanceRecorded = (count > 0 && (distanceRecordedCount === count || distanceRecordedCount === (log.tripsCount || (log.deliveries ? log.deliveries.length : 0))));

    // B. 空走距離（現時点では実測・確定データが存在しないため推測補完せず算出不可/null）
    const deadheadDistanceKm = null;

    // 総実移動距離（将来用: Uber表示配達距離 + 空走距離）
    const totalActualDistanceKm = uberDeliveryDistanceKm !== null ? uberDeliveryDistanceKm : null;

    // 配達時間（その日の全Uber公式トリップの所要時間を秒単位で厳密合算。手動セッション由来は完全排除）
    let workSeconds = null;
    let workMinutes = null;
    let isFullTripDurationRecorded = false;

    if (log.deliveries && log.deliveries.length > 0) {
      let totalSec = 0;
      let validCount = 0;

      log.deliveries.forEach(d => {
        if (d.durationStr && d.durationStr.trim() !== '') {
          totalSec += parseDurationToSeconds(d.durationStr);
          validCount++;
        } else if (d.durationMinutes !== null && d.durationMinutes !== undefined && !isNaN(Number(d.durationMinutes))) {
          totalSec += Math.round(Number(d.durationMinutes) * 60);
          validCount++;
        }
      });

      // 全公式トリップの所要時間が揃っている場合のみ確定
      if (validCount === log.deliveries.length && validCount > 0) {
        workSeconds = totalSec;
        // 表示用は秒を省略（例: 2時間36分36秒 -> 2時間36分）
        workMinutes = Math.floor(totalSec / 60);
        isFullTripDurationRecorded = true;
      }
    }

    // 時給計算対象売上＝通常分析売上（通常報酬 ＋ 通常クエスト ＋ 売上調整金。新規保証等の特別収入と特別クエスト（questType: special）は除外。経費も引かない）
    // 総売上・利益・特別ボーナス集計には特別クエストを含めたまま（効率指標だけから除外）
    let hourlyBaseSales = null;
    if (deliverySales !== null || questSales !== null || adjustmentSales !== 0) {
      hourlyBaseSales = (deliverySales || 0) + (questSales || 0) - specialQuestSales + (adjustmentSales || 0);
    }

    // 基本時給（通常稼働売上 ÷ 配達時間。秒単位の正確な時間を使用）
    let grossHourlyWage = null;
    if (hourlyBaseSales !== null && workSeconds !== null && workSeconds > 0) {
      const exactHours = workSeconds / 3600;
      grossHourlyWage = Math.round(hourlyBaseSales / exactHours);
    }

    // 経費後時給（利益 ÷ 配達時間。秒単位の正確な時間を使用。参考値）
    let netHourlyWage = null;
    if (netProfit !== null && workSeconds !== null && workSeconds > 0) {
      const exactHours = workSeconds / 3600;
      netHourlyWage = Math.round(netProfit / exactHours);
    }

    // 基本表示の「時給」は通常稼働時給（grossHourlyWage）に統一
    const hourlyWage = grossHourlyWage;

    // 1件あたり平均売上
    let avgSalesPerDelivery = null;
    if (totalSales !== null && count > 0) {
      avgSalesPerDelivery = Math.round(totalSales / count);
    }

    // 1件あたり平均距離（後方互換用）
    let avgDistPerDelivery = null;
    if (uberDeliveryDistanceKm !== null && isFullDistanceRecorded) {
      avgDistPerDelivery = Number((uberDeliveryDistanceKm / count).toFixed(2));
    }

    return {
      date: log.date,
      count,
      tripsCount,
      deliverySales,
      baseDeliverySales,
      tipSales,
      tipCount,
      specialQuests,
      specialQuestSales,
      questSales,
      adjustmentSales,
      otherSales,
      regularSales: hourlyBaseSales,
      hourlyBaseSales,
      totalSales,
      totalExpenses,
      netProfit,
      expenses,
      vehicleType: log.vehicleType || null,
      totalDistanceKm,
      uberDeliveryDistanceKm,
      deadheadDistanceKm,
      totalActualDistanceKm,
      distanceRecordedCount,
      isFullDistanceRecorded,
      workMinutes,
      workSeconds,
      grossHourlyWage,
      netHourlyWage,
      hourlyWage,
      guaranteeBonus,
      guaranteeBonusNote,
      totalSalesWithBonus,
      netProfitWithBonus,
      milestone,
      isDurationApproximate: Boolean(log.workSessions && log.workSessions.some(s => s.isApproximate)),
      hasActiveSession: Boolean(log.workSessions && log.workSessions.some(s => s.start && !s.end)),
      workSessions: log.workSessions || [],
      avgSalesPerDelivery,
      avgFeePerDelivery: avgSalesPerDelivery,
      avgDistPerDelivery,
      quests: deduplicateQuests(log.quests || [])
    };
  }

  // 日別売上データ（Delivery, Quest, Adjustment, Other, Total）の確定保存
  saveDailySales(dateStr, { delivery, quest, adjustment, other, rawText, guaranteeBonus, guaranteeBonusNote }) {
    const log = this.getDailyLog(dateStr);
    const d = Number(delivery) || 0;
    const q = Number(quest) || 0;
    const a = Number(adjustment) || 0;
    const o = Number(other) || 0;
    const existingBonus = log.sales ? (log.sales.guaranteeBonus || 0) : (log.guaranteeBonus || 0);
    const existingBonusNote = log.sales ? (log.sales.guaranteeBonusNote || '') : (log.guaranteeBonusNote || '');
    const finalBonus = guaranteeBonus !== undefined ? Number(guaranteeBonus) : existingBonus;
    const finalBonusNote = guaranteeBonusNote !== undefined ? guaranteeBonusNote : existingBonusNote;
    const tot = d + q + a + o + finalBonus;

    log.sales = {
      delivery: d,
      quest: q,
      adjustment: a,
      other: o,
      total: tot,
      guaranteeBonus: finalBonus,
      guaranteeBonusNote: finalBonusNote,
      rawTextSummary: rawText ? (rawText.length > 50 ? rawText.substring(0, 50) + '...' : rawText) : '',
      updatedAt: new Date().toISOString()
    };

    this.saveToStorage(dateStr);
    return log.sales;
  }

  // 当日経費の追加（idを指定すると既存IDを保持したまま別日付へ移動できる）
  addExpense(dateStr, { category, amount, memo, id }) {
    const log = this.getDailyLog(dateStr);
    if (!log.expenses) log.expenses = [];

    const amt = Number(amount) || 0;
    const now = new Date().toISOString();
    // 同一IDで戻す場合は、その日付の削除済みマーク（tombstone）を解除する
    if (id && Array.isArray(log.deletedExpenseIds)) {
      log.deletedExpenseIds = log.deletedExpenseIds.filter(x => x !== id);
    }
    const expense = {
      id: id || `exp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      category: category || 'バイクシェア',
      amount: amt,
      memo: memo || '',
      createdAt: now,
      updatedAt: now
    };

    log.expenses.push(expense);
    this.saveToStorage(dateStr);
    return expense;
  }

  // 当日経費の更新
  updateExpense(dateStr, expenseId, { category, amount, memo }) {
    const log = this.getDailyLog(dateStr);
    if (!log.expenses) return null;

    const idx = log.expenses.findIndex(e => e.id === expenseId);
    if (idx !== -1) {
      log.expenses[idx] = {
        ...log.expenses[idx],
        category: category !== undefined ? category : log.expenses[idx].category,
        amount: amount !== undefined ? (Number(amount) || 0) : log.expenses[idx].amount,
        memo: memo !== undefined ? memo : log.expenses[idx].memo,
        updatedAt: new Date().toISOString()
      };
      this.saveToStorage(dateStr);
      return log.expenses[idx];
    }
    return null;
  }

  // 当日経費の削除
  deleteExpense(dateStr, expenseId) {
    const log = this.getDailyLog(dateStr);
    if (!log.expenses) return null;

    const idx = log.expenses.findIndex(e => e.id === expenseId);
    if (idx !== -1) {
      const removed = log.expenses.splice(idx, 1)[0];
      // 削除済みマーク（tombstone）を残し、クラウド同期や公式シード補完での復活を防ぐ
      if (!Array.isArray(log.deletedExpenseIds)) log.deletedExpenseIds = [];
      if (!log.deletedExpenseIds.includes(expenseId)) log.deletedExpenseIds.push(expenseId);
      this.saveToStorage(dateStr);
      return removed;
    }
    return null;
  }

  // 直近N日分の全経費を日付降順で取得（経費一覧表示用）
  getRecentExpenses(days = 14) {
    const allLogs = this.getAllDailyLogs();
    const today = getTodayDateString();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = getTodayDateString(cutoff);

    const result = [];
    allLogs.forEach(log => {
      if (log.date < cutoffStr || log.date > today) return;
      if (!Array.isArray(log.expenses) || log.expenses.length === 0) return;
      log.expenses.forEach(exp => {
        result.push({
          ...exp,
          dateStr: log.date
        });
      });
    });

    // 日付降順、同日内はcreatedAt降順
    result.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return b.dateStr.localeCompare(a.dateStr);
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    return result;
  }

  // 移動手段/車両種別の更新
  updateVehicleType(dateStr, vehicleType) {
    const log = this.getDailyLog(dateStr);
    log.vehicleType = vehicleType || null;
    this.saveToStorage(dateStr);
    return log.vehicleType;
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

    // 常に最新日を上にする降順ソート
    dailyBreakdown.sort((a, b) => b.date.localeCompare(a.date));

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
    
    // 先週の確定売上利益集計（先週比較用：推測・捏造せずデータ存在時のみ比較）
    const prevWeekRange = getPreviousWeekRange(dateStr);
    const allLogs = this.getAllDailyLogs();
    const prevLogs = allLogs.filter(l => l.date >= prevWeekRange.startStr && l.date <= prevWeekRange.endStr);

    let hasPrevWeekData = false;
    let prevWeekDeliverySales = 0;
    let prevWeekQuestSales = 0;
    let prevWeekGuaranteeBonus = 0;
    let prevWeekOtherSales = 0;
    let prevWeekBikeExpenses = 0;
    let prevWeekDeliveriesCount = 0;

    prevLogs.forEach(l => {
      const m = this.getCalculatedMetrics(l);
      if (m.count > 0 || m.totalSales !== null || m.totalExpenses > 0) {
        hasPrevWeekData = true;
        prevWeekDeliverySales += (m.deliverySales || 0);
        prevWeekQuestSales += (m.questSales || 0);
        prevWeekGuaranteeBonus += (m.guaranteeBonus || 0);
        prevWeekOtherSales += ((m.adjustmentSales || 0) + (m.otherSales || 0));

        let logBike = 0;
        if (Array.isArray(l.expenses)) {
          l.expenses.forEach(e => {
            const cat = (e.category || '').trim();
            const amt = Number(e.amount);
            if (!isNaN(amt) && amt > 0) {
              if (isBikeExpenseCategory(cat)) {
                logBike += amt;
              }
            }
          });
        }
        prevWeekBikeExpenses += logBike;
        prevWeekDeliveriesCount += m.count;
      }
    });

    const prevWeekSalesProfit = prevWeekDeliverySales + prevWeekQuestSales + prevWeekGuaranteeBonus + prevWeekOtherSales - prevWeekBikeExpenses;

    let prevWeekComparison = null;
    // 今週の確定売上利益集計（当週の全登録日を動的に集計）
    const weekRange = getWeekRange(dateStr);
    const weekLogs = allLogs.filter(l => l.date >= weekRange.startStr && l.date <= weekRange.endStr);

    let weekCalculatedSales = 0;
    let weekDeliverySales = 0;
    let weekQuestSales = 0;
    let weekAdjustmentSales = 0;
    let weekOtherSales = 0;
    let weekTipSales = 0;       // チップ（配達報酬に含まれる内訳。総売上へは別途加算しない）
    let weekOtherOnlySales = 0; // 調整以外のその他
    let weekGuaranteeBonus = 0;      // 特別ボーナス（特別収入・保証 ＋ 特別クエスト）
    let weekGuaranteeOnly = 0;       // うち特別収入・保証
    let weekSpecialQuestSales = 0;   // うち特別クエスト
    let weekBikeExpenses = 0;
    let weekDeliveriesCount = 0;
    let weekTripsCount = 0;

    weekLogs.forEach(l => {
      const m = this.getCalculatedMetrics(l);
      if (m.count > 0 || m.totalSales !== null || m.totalExpenses > 0) {
        weekDeliverySales += (m.deliverySales || 0);
        // 分析の分類: 通常クエスト → クエスト / 特別クエスト（questType: special）→ 特別ボーナス（二重計上しない）
        weekQuestSales += (m.questSales || 0) - (m.specialQuestSales || 0);
        weekSpecialQuestSales += (m.specialQuestSales || 0);
        weekAdjustmentSales += (m.adjustmentSales || 0);
        weekOtherSales += ((m.adjustmentSales || 0) + (m.otherSales || 0));
        weekTipSales += (m.tipSales || 0);
        weekOtherOnlySales += (m.otherSales || 0);
        weekCalculatedSales += (m.totalSales || 0);
        weekDeliveriesCount += m.count;
        weekTripsCount += (l.tripsCount || (l.deliveries ? l.deliveries.length : 0));
        weekGuaranteeBonus += (m.guaranteeBonus || 0) + (m.specialQuestSales || 0);
        weekGuaranteeOnly += (m.guaranteeBonus || 0);

        let logBike = 0;
        if (Array.isArray(l.expenses)) {
          l.expenses.forEach(e => {
            const cat = (e.category || '').trim();
            const amt = Number(e.amount);
            if (!isNaN(amt) && amt > 0) {
              if (isBikeExpenseCategory(cat)) {
                logBike += amt;
              }
            }
          });
        }
        weekBikeExpenses += logBike;
      }
    });

    // 内訳の数学的合計（¥43,461）と完全一致させる公式売上
    const weekOfficialSales = weekCalculatedSales;

    // 「今週の売上利益」＝ 配達報酬 ＋ クエスト ＋ 特別ボーナス ＋ その他 － Bike経費
    const weekSalesProfit = weekDeliverySales + weekQuestSales + weekGuaranteeBonus + weekOtherSales - weekBikeExpenses;

    if (hasPrevWeekData) {
      const diff = weekSalesProfit - prevWeekSalesProfit;
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

    // 今週の売上利益（26/9/14～9/20）
    const [wsY, wsM, wsD] = weekRange.startStr.split('-').map(Number);
    const [weY, weM, weD] = weekRange.endStr.split('-').map(Number);
    const cleanWeekPeriod = `${String(wsY).slice(2)}/${wsM}/${wsD}～${weM}/${weD}`;

    const thisWeek = {
      label: '今週の売上利益',
      periodLabel: cleanWeekPeriod,
      startDate: weekRange.startStr,
      endDate: weekRange.endStr,
      salesProfit: weekSalesProfit,
      officialSales: weekOfficialSales,
      calculatedSales: weekCalculatedSales,
      deliverySales: weekDeliverySales,
      questSales: weekQuestSales,
      adjustmentSales: weekOtherSales,
      otherSales: weekOtherSales,
      // 内訳表示用（合計すると officialSales と一致: 配達報酬(チップ除く) + チップ + クエスト + 特別ボーナス + 調整 + その他）
      baseDeliverySales: weekDeliverySales - weekTipSales,
      tipSales: weekTipSales,
      adjustmentOnlySales: weekAdjustmentSales,
      otherOnlySales: weekOtherOnlySales,
      bikeExpenses: weekBikeExpenses,
      deliveriesCount: weekDeliveriesCount,
      deliveryCount: weekDeliveriesCount,
      tripsCount: weekTripsCount,
      guaranteeBonus: weekGuaranteeBonus,
      bonusSales: weekGuaranteeBonus,
      guaranteeOnlySales: weekGuaranteeOnly,
      specialQuestSales: weekSpecialQuestSales,
      payoutDateText: getNextPayoutDate(weekRange.endStr),
      note: '次回振込対象・当週確定売上利益',
      prevWeekComparison
    };

    // 今月の実績（当月の全登録日を動的に集計）
    const currentMonthPrefix = dateStr.substring(0, 7);
    const monthLogs = allLogs.filter(l => l.date.startsWith(currentMonthPrefix));
    let monthSales = 0;
    let monthDeliveriesCount = 0;
    let monthBikeExpenses = 0;
    let monthOtherExpenses = 0;
    monthLogs.forEach(l => {
      const m = this.getCalculatedMetrics(l);
      if (m.count > 0 || m.totalSales !== null) {
        monthSales += (m.totalSales || 0);
        monthDeliveriesCount += m.count;
      }
      if (Array.isArray(l.expenses)) {
        l.expenses.forEach(e => {
          const cat = (e.category || '').trim();
          const amt = Number(e.amount);
          if (!isNaN(amt) && amt > 0) {
            if (isBikeExpenseCategory(cat)) {
              monthBikeExpenses += amt;
            } else if (cat === '必要経費') {
              monthOtherExpenses += amt;
            }
          }
        });
      }
    });

    // 月次利益 = 売上 - Bike経費 - 必要経費
    const monthSalesProfit = monthSales - monthBikeExpenses - monthOtherExpenses;
    const [mY, mM] = currentMonthPrefix.split('-').map(Number);
    const cleanMonthPeriod = `${mY}年${mM}月`;

    const thisMonth = {
      label: '今月の実績',
      periodLabel: cleanMonthPeriod,
      sales: monthSales,
      salesProfit: monthSalesProfit,
      calculatedSales: monthSales,
      bikeExpenses: monthBikeExpenses,
      otherExpenses: monthOtherExpenses,
      deliveriesCount: monthDeliveriesCount,
      note: `※${mM}月度 登録分（全${monthDeliveriesCount}件）`
    };

    // 登録済み累計売上（全登録日を動的に集計）
    let cumSales = 0;
    let cumDeliveriesCount = 0;
    let earliestDate = dateStr;
    let latestDate = dateStr;

    allLogs.forEach(l => {
      const m = this.getCalculatedMetrics(l);
      if (m.count > 0 || m.totalSales !== null) {
        cumSales += (m.totalSales || 0);
        cumDeliveriesCount += m.count;
        if (l.date < earliestDate) earliestDate = l.date;
        if (l.date > latestDate) latestDate = l.date;
      }
    });

    const [eY, eM, eD] = earliestDate.split('-').map(Number);
    const [lY, lM, lD] = latestDate.split('-').map(Number);
    const cleanCumPeriod = `${String(eY).slice(2)}/${eM}/${eD}～${lM}/${lD}`;

    const registeredTotal = {
      label: '登録済み累計売上',
      periodLabel: cleanCumPeriod,
      sales: cumSales,
      calculatedSales: cumSales,
      deliveriesCount: cumDeliveriesCount,
      note: `※${cleanCumPeriod} 登録データ累計（全${cumDeliveriesCount}件）`
    };

    // 公式週明細（¥43,461）とUBER_LOG正式データ集計（¥43,461）は完全一致（差額解消済み）
    const officialWeekStatement = 43461;
    const unresolvedDiff = officialWeekStatement - weekOfficialSales;
    const auditFootnote = {
      diff: unresolvedDiff,
      officialTotal: officialWeekStatement,
      calculatedTotal: weekOfficialSales,
      text: unresolvedDiff === 0 ? '公式週明細と完全一致（差額解消済み）' : `公式週明細との未解決差額: ¥${unresolvedDiff}（推測補正なし）`,
      subText: `公式週明細: ¥${officialWeekStatement.toLocaleString()} / 日別集計: ¥${weekOfficialSales.toLocaleString()}`
    };

    return {
      thisWeek,
      thisMonth,
      registeredTotal,
      auditFootnote
    };
  }

  // 日別の稼働状況（履歴カレンダー用。一覧と同じ日別データ・同じ計算を使う）
  //  worked : 配達実績（件数）または売上がある日
  //  off    : 稼働していないことが確認済みの日（CONFIRMED_DAY_OFF_DATES、または日別データの dayOff: true）
  //  unknown: それ以外（未来・未入力・判定できない日）。「休」にはしない
  getDayStatus(dateStr) {
    const log = this.state && this.state.dailyLogs ? this.state.dailyLogs[dateStr] : null;
    const metrics = log ? this.getCalculatedMetrics(log) : null;
    if (metrics && (metrics.count > 0 || (metrics.totalSales !== null && metrics.totalSales !== 0))) {
      return { status: 'worked', count: metrics.count, totalSales: metrics.totalSales, netProfit: metrics.netProfit };
    }
    if (CONFIRMED_DAY_OFF_DATES.includes(dateStr) || (log && log.dayOff === true)) {
      return { status: 'off' };
    }
    return { status: 'unknown' };
  }

  // 期間指定の売上内訳（開始日〜終了日、両端含む）。
  // 配達報酬はチップを除いた額、チップは配達の最終売上に含まれる内訳（総売上へは二重に加算しない）。
  // 合計: 配達報酬 + チップ + クエスト + 特別ボーナス + 調整 + その他 = 総売上
  getSalesBreakdown(startDate, endDate) {
    const out = {
      startDate, endDate, days: 0, deliveriesCount: 0,
      deliverySales: 0, baseDeliverySales: 0, tipSales: 0, tipCount: 0,
      questSales: 0, guaranteeBonus: 0, guaranteeOnlySales: 0, specialQuestSales: 0, adjustmentSales: 0, otherSales: 0, totalSales: 0, bikeExpenses: 0
    };
    this.getAllDailyLogs()
      .filter(l => (!startDate || l.date >= startDate) && (!endDate || l.date <= endDate))
      .forEach(l => {
        const m = this.getCalculatedMetrics(l);
        if (!(m.count > 0 || m.totalSales !== null || m.totalExpenses > 0)) return;
        out.days++;
        out.deliveriesCount += m.count;
        out.deliverySales += (m.deliverySales || 0);
        out.baseDeliverySales += (m.baseDeliverySales || 0);
        out.tipSales += (m.tipSales || 0);
        out.tipCount += (m.tipCount || 0);
        // 分析の分類: 通常クエスト → クエスト / 特別クエスト → 特別ボーナス（二重計上しない）
        out.questSales += (m.questSales || 0) - (m.specialQuestSales || 0);
        out.specialQuestSales += (m.specialQuestSales || 0);
        out.guaranteeOnlySales += (m.guaranteeBonus || 0);
        out.guaranteeBonus += (m.guaranteeBonus || 0) + (m.specialQuestSales || 0);
        out.adjustmentSales += (m.adjustmentSales || 0);
        out.otherSales += (m.otherSales || 0);
        out.totalSales += (m.totalSales || 0);
        (l.expenses || []).forEach(e => { if (isBikeExpense(e)) out.bikeExpenses += Number(e.amount); });
      });
    return out;
  }

  // 全体・累計・直近7日の分析データ取得
  getAnalytics() {
    const allLogs = this.getAllDailyLogs();
    
    let totalDeliveries = 0;
    let totalSalesSum = 0;
    let totalRegularSalesSum = 0; // 通常稼働売上（大型特別ボーナス除外）
    let totalMinutesSum = 0;
    let totalSecondsSum = 0; // 全公式トリップ所要時間秒数合計
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
        // 通常稼働売上（通常報酬 ＋ 通常クエスト ＋ 通常の売上調整金等。新規保証等の大型特別ボーナスと特別クエストは除外）
        const reg = metrics.regularSales !== null && metrics.regularSales !== undefined ? metrics.regularSales : 0;
        totalRegularSalesSum += reg;

        if (metrics.workMinutes) {
          totalMinutesSum += metrics.workMinutes;
        }
        if (metrics.workSeconds) {
          totalSecondsSum += metrics.workSeconds;
        }
        if (metrics.totalDistanceKm) {
          totalDistanceSum += metrics.totalDistanceKm;
        }
      }
    });

    // 平均日給: 通常稼働売上 ÷ 稼働日数（特別ボーナス除外）
    const avgDailyEarnings = activeDaysCount > 0 ? Math.round(totalRegularSalesSum / activeDaysCount) : null;
    const avgHourlyWage = totalMinutesSum > 0 ? Math.round(totalRegularSalesSum / (totalMinutesSum / 60)) : null;
    // 平均1件単価: 通常稼働売上 ÷ 配達件数（特別ボーナス除外）
    const avgPerDelivery = totalDeliveries > 0 ? Math.round(totalRegularSalesSum / totalDeliveries) : null;

    // 配達時間テキスト（全期間の公式トリップ所要時間合計、秒省略「xx時間xx分」）
    const totalDurationText = totalSecondsSum > 0
      ? `${Math.floor(totalSecondsSum / 3600)}時間${Math.floor((totalSecondsSum % 3600) / 60)}分`
      : '0時間0分';

    // 日別比較用データ（全稼働日、降順、10円単位四捨五入時給）
    const dailyComparison = allLogs.filter(log => {
      const m = this.getCalculatedMetrics(log);
      return m.count > 0 || log.workStartedAt || m.totalSales !== null;
    }).map(log => {
      const metrics = this.getCalculatedMetrics(log);
      const regSales = metrics.regularSales !== undefined ? metrics.regularSales : ((metrics.deliverySales || 0) + (metrics.questSales || 0) - (metrics.specialQuestSales || 0) + (metrics.adjustmentSales || 0));
      
      // 時給: 通常売上 ÷ 配達時間（秒単位高精度計算）。一覧表示では10円単位に四捨五入
      let roundedHourly = null;
      if (metrics.hourlyWage !== null) {
        roundedHourly = Math.round(metrics.hourlyWage / 10) * 10;
      }

      // 配達時間（秒省略「○時間○分」）
      let durationText = '未記録';
      if (metrics.workSeconds !== null && metrics.workSeconds > 0) {
        const h = Math.floor(metrics.workSeconds / 3600);
        const m = Math.floor((metrics.workSeconds % 3600) / 60);
        durationText = `${h}時間${m}分`;
      } else if (metrics.workMinutes !== null && metrics.workMinutes > 0) {
        durationText = formatMinutes(metrics.workMinutes);
      }

      // 日付フォーマット
      const [y, mon, d] = log.date.split('-');
      const shortDate = `${Number(mon)}/${Number(d)}`;

      return {
        date: log.date,
        shortDate,
        count: metrics.count,
        regularSales: regSales,
        workSeconds: metrics.workSeconds,
        durationText,
        hourlyWage: roundedHourly,
        exactHourlyWage: metrics.hourlyWage,
        totalSales: metrics.totalSales,
        deliverySales: metrics.deliverySales,
        questSales: metrics.questSales,
        distance: metrics.totalDistanceKm
      };
    });

    return {
      totalDeliveries,
      totalSalesSum,
      totalRegularSalesSum,
      activeDaysCount,
      avgDailyEarnings,
      avgHourlyWage,
      avgPerDelivery,
      totalDistanceSum: totalDistanceSum > 0 ? Number(totalDistanceSum.toFixed(1)) : null,
      totalSecondsSum,
      totalDurationText,
      dailyComparison,
      recent7Days: dailyComparison.slice(0, 7)
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
      this.saveToStorage(null, { replace: true });
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
    this.saveToStorage(null, { replace: true });
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
  window.getJapanHolidayName = getJapanHolidayName;
  window.getDayOfWeekInfo = getDayOfWeekInfo;
  window.formatDateWithWeekday = formatDateWithWeekday;
  window.getWeekRange = getWeekRange;
  window.getPreviousWeekRange = getPreviousWeekRange;
  window.getConfirmedSeedData = getConfirmedSeedData;
  window.isBikeExpenseCategory = isBikeExpenseCategory;
  window.isBikeExpense = isBikeExpense;
  window.mergeExpenseLists = mergeExpenseLists;
  window.mergeDayUserData = mergeDayUserData;
  window.getTodayDateString = getTodayDateString;
  window.getCurrentTimeString = getCurrentTimeString;
  window.formatJapaneseDate = formatJapaneseDate;
  window.formatShortJapaneseDate = formatShortJapaneseDate;
  window.formatDateWithColoredWeekday = formatDateWithColoredWeekday;
  window.DAY_ATTRIBUTE_DEFINITIONS = DAY_ATTRIBUTE_DEFINITIONS;
  window.DAY_ATTRIBUTE_PRIORITY = DAY_ATTRIBUTE_PRIORITY;
  window.formatDisplayAddress = formatDisplayAddress;
  window.formatDurationColon = formatDurationColon;
  window.parseDurationToSeconds = parseDurationToSeconds;
  window.calculateMinutesBetween = calculateMinutesBetween;
  window.formatMinutes = formatMinutes;
  window.deduplicateQuests = deduplicateQuests;
  window.parseUberSalesText = parseUberSalesText;
  window.getNextPayoutDate = getNextPayoutDate;
  window.CURRENT_WEEK_QUEST = CURRENT_WEEK_QUEST;
  window.CONFIRMED_DAY_OFF_DATES = CONFIRMED_DAY_OFF_DATES;
  window.Store = Store;
  window.store = store;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WORK_TIME_STEP_MINUTES,
    getTimeOptions,
    roundToTimeStep,
    CURRENT_WEEK_QUEST,
    CONFIRMED_DAY_OFF_DATES,
    OFFICIAL_SOURCE_OF_TRUTH,
    AVOIDANCE_DATABASE,
    AVOIDANCE_RULES,
    JAPAN_HOLIDAYS,
    getJapanHolidayName,
    getDayOfWeekInfo,
    formatDateWithWeekday,
    getWeekRange,
    getPreviousWeekRange,
    getConfirmedSeedData,
    isBikeExpenseCategory,
    isBikeExpense,
    mergeExpenseLists,
    mergeDayUserData,
    getTodayDateString,
    getCurrentTimeString,
    formatJapaneseDate,
    formatShortJapaneseDate,
    formatDateWithColoredWeekday,
    getNextPayoutDate,
    DAY_ATTRIBUTE_DEFINITIONS,
    DAY_ATTRIBUTE_PRIORITY,
    formatDisplayAddress,
    formatDurationColon,
    parseDurationToSeconds,
    calculateMinutesBetween,
    formatMinutes,
    deduplicateQuests,
    parseUberSalesText,
    Store,
    store
  };
}

