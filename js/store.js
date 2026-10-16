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

// 過去互換専用（LEGACY COMPATIBILITY ONLY）:
// 2026/09/21〜09/25 の旧固定80回クエスト定義。
// ※注意: アプリ本体の表示・集計・同期におけるフォールバックとしての使用は禁止。
// 過去の外部スクリプト・テストコードの後方互換参照のためにのみ保持する。
const CURRENT_WEEK_QUEST = {
  id: 'quest_20260921_0925',
  title: '今週のクエスト',
  targetCount: 80,
  startAt: '2026-09-21T04:00:00+09:00',
  endAt: '2026-09-25T04:00:00+09:00',
  deadlineText: '9/25（金）4:00まで'
};


// 過去の確定済み80回乗車クエスト（2026/09/21〜2026/09/25 達成済み特別クエスト¥8,890）
const LEGACY_80_QUEST = {
  id: 'quest_20260921_0925',
  name: '80回乗車クエスト',
  startAt: '2026-09-21T04:00:00+09:00',
  endAt: '2026-09-25T04:00:00+09:00',
  targetCount: 80,
  expectedReward: 8890,
  memo: '9/21〜9/25 達成済み特別クエスト',
  manualAdjust: 0,
  createdAt: '2026-09-21T04:00:00+09:00',
  updatedAt: '2026-09-25T04:00:00+09:00'
};

// 公式確定実績の取り込み世代。端末に残る旧クエスト手動オフセットが公式件数と
// 二重計上になるのを防ぐため、この値が一致する保存データのみ手動補正を採用する。
const QUEST_OFFICIAL_BASELINE = '20260922_official';

// 手動指定の休み（履歴カレンダーの「休み」表示用。statusSource: manual）。
// それ以外の過去の非稼働日は store.getDayStatus が公式データの取り込み範囲から自動判定する（statusSource: auto）。
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
    },
    "2026-09-26": {
      "date": "2026-09-26",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 90.44,
      "tripsCount": 25,
      "officialPoints": 34,
      "deliveriesCount": 34,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0926_1",
          "index": 1,
          "completedAt": "08:13",
          "restaurant": "ローソンストア100 西区新町店",
          "area": "大阪市福島区吉野2丁目",
          "fee": 702,
          "baseFee": 605,
          "tip": 97,
          "distanceKm": 5.1,
          "durationStr": "35分49秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／最終売上¥702（基本料金¥605＋チップ¥97）"
        },
        {
          "id": "del_0926_2",
          "index": 2,
          "completedAt": "08:57",
          "restaurant": "マクドナルド 野田阪神店 McDonald's NODA HANSHIN",
          "area": "大阪市福島区鷺洲1丁目",
          "fee": 320,
          "distanceKm": 1.05,
          "durationStr": "8分28秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_3",
          "index": 3,
          "completedAt": "08:58",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市此花区春日出中1丁目",
          "fee": 517,
          "distanceKm": 4.15,
          "durationStr": "35分18秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_4",
          "index": 4,
          "completedAt": "09:47",
          "restaurant": "コクミンドラッグ西九条店",
          "area": "大阪市港区弁天5丁目",
          "fee": 393,
          "distanceKm": 3.4,
          "durationStr": "23分50秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_5",
          "index": 5,
          "completedAt": "10:04",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市九条南4丁目",
          "fee": 444,
          "distanceKm": 4.55,
          "durationStr": "31分17秒",
          "points": 1,
          "memo": "公式配達先表記: 4-chōme Osaka Osaka Kujōminami 日本"
        },
        {
          "id": "del_0926_6",
          "index": 6,
          "completedAt": "10:45",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区本田",
          "fee": 887,
          "distanceKm": 6.6,
          "durationStr": "44分12秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0926_7",
          "index": 7,
          "completedAt": "11:25",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区千代崎1丁目",
          "fee": 320,
          "distanceKm": 1.74,
          "durationStr": "16分22秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_8",
          "index": 8,
          "completedAt": "11:47",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.09,
          "durationStr": "11分21秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_9",
          "index": 9,
          "completedAt": "11:49",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市浪速区桜川2丁目",
          "fee": 320,
          "distanceKm": 3.32,
          "durationStr": "21分5秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_10",
          "index": 10,
          "completedAt": "12:07",
          "restaurant": "らーめん亀王 道頓堀店 Ramen kiou",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 564,
          "distanceKm": 4.8,
          "durationStr": "38分7秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0926_11",
          "index": 11,
          "completedAt": "13:31",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持ち帰り専門店～",
          "area": "大阪市西区九条南4丁目",
          "fee": 320,
          "distanceKm": 2.62,
          "durationStr": "14分17秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_12",
          "index": 12,
          "completedAt": "14:03",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市西区北堀江4丁目",
          "fee": 320,
          "distanceKm": 1.13,
          "durationStr": "8分48秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_13",
          "index": 13,
          "completedAt": "14:16",
          "restaurant": "花満円弁当 大阪ドームシティ店 Hanamanmarubento osakadoomten",
          "area": "大阪市西区南堀江3丁目",
          "fee": 466,
          "distanceKm": 4.94,
          "durationStr": "33分1秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0926_14",
          "index": 14,
          "completedAt": "14:43",
          "restaurant": "横浜家系ラーメン 一新家（よこはまいえけいらーめん いっしんや）",
          "area": "大阪市南市岡2丁目",
          "fee": 518,
          "distanceKm": 3.27,
          "durationStr": "21分5秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／公式配達先表記: 2-chōme 27 Osaka Minamiichioka Japan"
        },
        {
          "id": "del_0926_15",
          "index": 15,
          "completedAt": "14:55",
          "restaurant": "オリジナルタコライス【Taco feliz】大阪西店",
          "area": "大阪市西区南堀江4丁目",
          "fee": 634,
          "distanceKm": 5.26,
          "durationStr": "34分45秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0926_16",
          "index": 16,
          "completedAt": "15:11",
          "restaurant": "ウエルシア大阪新町店",
          "area": "大阪市浪速区戎本町1丁目",
          "fee": 597,
          "distanceKm": 5.49,
          "durationStr": "29分5秒",
          "points": 1,
          "memo": "公式配達先表記: 27大阪市浪速区戎本町浪速区戎本町1丁目（区・町名が重複表示）"
        },
        {
          "id": "del_0926_17",
          "index": 17,
          "completedAt": "16:01",
          "restaurant": "かつ丼 吉兵衛 なんば道具屋筋店 Katsudon Yoshibei Namba",
          "area": "大阪市西区京町堀3丁目",
          "fee": 1128,
          "distanceKm": 9,
          "durationStr": "1時間4分",
          "points": 3,
          "memo": "トリプル配達（3件完了/3pt）"
        },
        {
          "id": "del_0926_18",
          "index": 18,
          "completedAt": "17:09",
          "restaurant": "ピザハット 阿波座店 Pizza Hut Awaza",
          "area": "大阪市中之島5丁目",
          "fee": 347,
          "distanceKm": 4.46,
          "durationStr": "29分22秒",
          "points": 1,
          "memo": "公式配達先表記: 5-chōme 27 Osaka Nakanoshima Japan"
        },
        {
          "id": "del_0926_19",
          "index": 19,
          "completedAt": "18:23",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 1.48,
          "durationStr": "11分14秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_20",
          "index": 20,
          "completedAt": "18:32",
          "restaurant": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
          "area": "大阪市西区九条南3丁目",
          "fee": 320,
          "distanceKm": 1.61,
          "durationStr": "13分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_21",
          "index": 21,
          "completedAt": "18:47",
          "restaurant": "かっぱ寿司 境川店 Kappa Sushi Sakaigawa",
          "area": "大阪市此花区島屋2丁目",
          "fee": 589,
          "distanceKm": 6.18,
          "durationStr": "33分42秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_22",
          "index": 22,
          "completedAt": "18:54",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市港区市岡1丁目",
          "fee": 320,
          "distanceKm": 2.57,
          "durationStr": "19分54秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_23",
          "index": 23,
          "completedAt": "20:08",
          "restaurant": "餃子の王将 西九条",
          "area": "大阪市此花区伝法6丁目",
          "fee": 498,
          "distanceKm": 3.19,
          "durationStr": "29分4秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0926_24",
          "index": 24,
          "completedAt": "20:54",
          "restaurant": "宇奈とと 大阪九条店 Unatoto Osaka Kujo",
          "area": "大阪市西区南堀江2丁目",
          "fee": 361,
          "distanceKm": 2.54,
          "durationStr": "16分8秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0926_25",
          "index": 25,
          "completedAt": "21:20",
          "restaurant": "マクドナルド 九条店 McDonald's KUJO",
          "area": "大阪市西区本田3丁目",
          "fee": 320,
          "distanceKm": 0.9,
          "durationStr": "7分39秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0926_1",
          "time": "11:15",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "11:14",
          "note": "公式一覧は 11:14「1 回乗車クエスト ¥300」（達成表示）と 11:15「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_2",
          "time": "11:31",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_3",
          "time": "11:44",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "11:43",
          "note": "公式一覧は 11:43「1 回乗車クエスト ¥200」（達成表示）と 11:44「クエスト ¥200」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_4",
          "time": "11:59",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_5",
          "time": "12:15",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_6",
          "time": "12:45",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_7",
          "time": "12:53",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_8",
          "time": "13:48",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_9",
          "time": "13:48",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥800」「6 回乗車クエスト ¥800」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_10",
          "time": "14:12",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_11",
          "time": "14:39",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_12",
          "time": "14:50",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "14:49",
          "note": "公式一覧は 14:49「1 回乗車クエスト ¥200」（達成表示）と 14:50「クエスト ¥200」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_13",
          "time": "14:50",
          "title": "クエスト",
          "amount": 700,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "14:49",
          "note": "公式一覧は 14:49「3 回乗車クエスト ¥700」（達成表示）と 14:50「クエスト ¥700」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_14",
          "time": "15:01",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_15",
          "time": "17:39",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_16",
          "time": "18:34",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_17",
          "time": "18:46",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_18",
          "time": "18:46",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥800」「6 回乗車クエスト ¥800」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_19",
          "time": "19:14",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_20",
          "time": "19:53",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_21",
          "time": "20:28",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_22",
          "time": "20:28",
          "title": "クエスト",
          "amount": 700,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥700」「3 回乗車クエスト ¥700」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_23",
          "time": "20:38",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_24",
          "time": "21:12",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "21:11",
          "note": "公式一覧は 21:11「1 回乗車クエスト ¥200」（達成表示）と 21:12「クエスト ¥200」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_25",
          "time": "21:28",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥200」「1 回乗車クエスト ¥200」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0926_26",
          "time": "21:28",
          "title": "クエスト",
          "amount": 500,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥500」「3 回乗車クエスト ¥500」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。15:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 11845,
        "quest": 7700,
        "adjustment": 0,
        "other": 0,
        "total": 19545
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-26T21:55:08.649Z"
      }
    },
    "2026-09-27": {
      "date": "2026-09-27",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 38.36,
      "tripsCount": 13,
      "officialPoints": 17,
      "deliveriesCount": 17,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0927_1",
          "index": 1,
          "completedAt": "08:55",
          "restaurant": "ローソン 大阪ドームシティ",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 2.08,
          "durationStr": "12分39秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_2",
          "index": 2,
          "completedAt": "09:10",
          "restaurant": "CoDeLi 大阪九条駅前店",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 1.67,
          "durationStr": "10分4秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_3",
          "index": 3,
          "completedAt": "09:15",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市池島2丁目",
          "fee": 537,
          "distanceKm": 4.51,
          "durationStr": "27分25秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／公式配達先表記: 2-chōme 27 Osaka 池島 Japan"
        },
        {
          "id": "del_0927_4",
          "index": 4,
          "completedAt": "09:53",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区弁天4丁目",
          "fee": 320,
          "distanceKm": 1.82,
          "durationStr": "12分37秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_5",
          "index": 5,
          "completedAt": "10:02",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区弁天6丁目",
          "fee": 320,
          "distanceKm": 2.32,
          "durationStr": "15分34秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_6",
          "index": 6,
          "completedAt": "10:12",
          "restaurant": "吉野家 JR西九条駅店 Yoshinoya JR NISHIKUJO-EKI",
          "area": "大阪市西区川口3丁目",
          "fee": 639,
          "distanceKm": 5.78,
          "durationStr": "34分6秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0927_7",
          "index": 7,
          "completedAt": "11:21",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市泉尾1丁目",
          "fee": 320,
          "distanceKm": 2.46,
          "durationStr": "14分57秒",
          "points": 1,
          "memo": "公式配達先表記: 1-chōme 27 Osaka Izuo Japan"
        },
        {
          "id": "del_0927_8",
          "index": 8,
          "completedAt": "11:46",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市西区千代崎1丁目",
          "fee": 320,
          "distanceKm": 1.95,
          "durationStr": "10分28秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_9",
          "index": 9,
          "completedAt": "11:57",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 414,
          "distanceKm": 2.49,
          "durationStr": "20分20秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0927_10",
          "index": 10,
          "completedAt": "12:34",
          "restaurant": "キッチンオリジン 九条",
          "area": "大阪市此花区梅香3丁目",
          "fee": 725,
          "distanceKm": 5.92,
          "durationStr": "33分5秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0927_11",
          "index": 11,
          "completedAt": "13:07",
          "restaurant": "コクミンドラッグ西九条店",
          "area": "大阪市西区本田3丁目",
          "fee": 389,
          "distanceKm": 3.01,
          "durationStr": "17分3秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_12",
          "index": 12,
          "completedAt": "13:32",
          "restaurant": "スシロースシロー辰巳橋店",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 418,
          "distanceKm": 2.32,
          "durationStr": "15分43秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0927_13",
          "index": 13,
          "completedAt": "13:43",
          "restaurant": "横浜家系ラーメン 天来家 大正駅前店",
          "area": "大阪市浪速区幸町2丁目",
          "fee": 320,
          "distanceKm": 2.03,
          "durationStr": "21分21秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0927_1",
          "time": "11:37",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_2",
          "time": "11:56",
          "title": "クエスト",
          "amount": 50,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥50」「1 回乗車クエスト ¥50」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_3",
          "time": "12:12",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_4",
          "time": "12:17",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_5",
          "time": "12:59",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_6",
          "time": "13:12",
          "title": "クエスト",
          "amount": 800,
          "isDuplicateIgnored": false,
          "questType": "normal"
        },
        {
          "id": "quest_0927_7",
          "time": "13:12",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_8",
          "time": "13:30",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_9",
          "time": "13:49",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_10",
          "time": "13:49",
          "title": "クエスト",
          "amount": 4450,
          "isDuplicateIgnored": false,
          "questName": "50回乗車クエスト",
          "questType": "special",
          "note": "公式一覧は「クエスト ¥4,450」「50 回乗車クエスト ¥4,450」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_11",
          "time": "14:07",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0927_12",
          "time": "14:07",
          "title": "クエスト",
          "amount": 700,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥700」「3 回乗車クエスト ¥700」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 5362,
        "quest": 6850,
        "adjustment": 0,
        "other": 0,
        "total": 12212
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-27T10:23:14.143Z"
      }
    },
    "2026-09-28": {
      "date": "2026-09-28",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 39.88,
      "tripsCount": 9,
      "officialPoints": 13,
      "deliveriesCount": 13,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0928_1",
          "index": 1,
          "completedAt": "08:06",
          "restaurant": "松のや 九条店 Matsunoya Kujo",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 320,
          "distanceKm": 1.88,
          "durationStr": "15分38秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0928_2",
          "index": 2,
          "completedAt": "08:50",
          "restaurant": "マクドナルド ＪＲ野田駅前店 McDonald's JR NODA EKI-MAE",
          "area": "大阪市北区中之島6丁目",
          "fee": 796,
          "distanceKm": 5.68,
          "durationStr": "35分44秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0928_3",
          "index": 3,
          "completedAt": "09:08",
          "restaurant": "やよい軒 野田阪神店",
          "area": "大阪市西淀川区姫島2丁目",
          "fee": 1296,
          "distanceKm": 10.15,
          "durationStr": "55分29秒",
          "points": 3,
          "memo": "トリプル配達（3件完了/3pt）"
        },
        {
          "id": "del_0928_4",
          "index": 4,
          "completedAt": "09:11",
          "restaurant": "スターバックス コーヒー 肥後橋南店 Starbucks Coffee Higobashi Minami",
          "area": "大阪市北区中之島4丁目",
          "fee": 422,
          "distanceKm": 4.22,
          "durationStr": "26分15秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0928_5",
          "index": 5,
          "completedAt": "10:35",
          "restaurant": "マクドナルド 高見プラザ店 McDonald's TAKAMI PLAZA",
          "area": "大阪市福島区海老江8丁目",
          "fee": 704,
          "distanceKm": 5.42,
          "durationStr": "31分47秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0928_6",
          "index": 6,
          "completedAt": "11:17",
          "restaurant": "ローソン 此花千鳥橋",
          "area": "大阪市港区波除5丁目",
          "fee": 586,
          "distanceKm": 4.65,
          "durationStr": "26分24秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0928_7",
          "index": 7,
          "completedAt": "12:14",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区川口3丁目",
          "fee": 424,
          "baseFee": 320,
          "tip": 104,
          "distanceKm": 1.59,
          "durationStr": "11分29秒",
          "points": 1,
          "memo": "最終売上¥424（基本料金¥320＋チップ¥104）"
        },
        {
          "id": "del_0928_8",
          "index": 8,
          "completedAt": "12:49",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市大正区泉尾3丁目",
          "fee": 383,
          "distanceKm": 3.94,
          "durationStr": "23分4秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0928_9",
          "index": 9,
          "completedAt": "14:03",
          "restaurant": "京都北白川 ラーメン魁力屋 イオンモール大阪ドームシティ店",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 415,
          "distanceKm": 2.35,
          "durationStr": "14分32秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0928_1",
          "time": "11:44",
          "title": "クエスト",
          "amount": 75,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥75」「1 回乗車クエスト ¥75」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0928_2",
          "time": "11:44",
          "title": "クエスト",
          "amount": 225,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥225」「1 回乗車クエスト ¥225」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0928_3",
          "time": "12:26",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "12:25",
          "note": "公式一覧は 12:25「1 回乗車クエスト ¥150」（達成表示）と 12:26「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0928_4",
          "time": "13:13",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0928_5",
          "time": "14:18",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0928_6",
          "time": "14:18",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥650」「6 回乗車クエスト ¥650」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 5346,
        "quest": 1400,
        "adjustment": 0,
        "other": 0,
        "total": 6746
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-28T07:50:54.577Z"
      }
    },
    "2026-09-29": {
      "date": "2026-09-29",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 52.09,
      "tripsCount": 17,
      "officialPoints": 23,
      "deliveriesCount": 23,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0929_1",
          "index": 1,
          "completedAt": "07:29",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市梅香1丁目",
          "fee": 611,
          "distanceKm": 3.15,
          "durationStr": "18分8秒",
          "points": 1,
          "memo": "公式配達先表記: 1-chōme 27 Osaka Baika Japan"
        },
        {
          "id": "del_0929_2",
          "index": 2,
          "completedAt": "08:26",
          "restaurant": "モスバーガー ＪＲ野田店 Mos Burger JR NODA",
          "area": "大阪市此花区春日出中2丁目",
          "fee": 2032,
          "distanceKm": 12.65,
          "durationStr": "1時間10分",
          "points": 4,
          "memo": "4件完了/4pt"
        },
        {
          "id": "del_0929_3",
          "index": 3,
          "completedAt": "09:43",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市福島区吉野5丁目",
          "fee": 566,
          "distanceKm": 3.27,
          "durationStr": "14分58秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_4",
          "index": 4,
          "completedAt": "09:46",
          "restaurant": "吉野家 JR西九条駅店 Yoshinoya JR NISHIKUJO-EKI",
          "area": "大阪市福島区野田5丁目",
          "fee": 398,
          "distanceKm": 2.22,
          "durationStr": "14分18秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_5",
          "index": 5,
          "completedAt": "11:12",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区境川1丁目",
          "fee": 479,
          "distanceKm": 1.69,
          "durationStr": "18分33秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0929_6",
          "index": 6,
          "completedAt": "11:25",
          "restaurant": "カレーハウス CoCo壱番屋 フォレオ大阪ドームシティ店 Curry House CoCo Ichibanya Foleo-Oskadomecity",
          "area": "大阪市西区九条1丁目",
          "fee": 406,
          "distanceKm": 3.28,
          "durationStr": "21分40秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0929_7",
          "index": 7,
          "completedAt": "11:50",
          "restaurant": "ウエルシア大阪九条店",
          "area": "大阪市西区千代崎1丁目",
          "fee": 320,
          "distanceKm": 2.06,
          "durationStr": "13分39秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_8",
          "index": 8,
          "completedAt": "11:57",
          "restaurant": "ほっかほっか亭 南堀江4丁目店 Hokkahokka-tei minamihorie4chome",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 2.25,
          "durationStr": "17分34秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_9",
          "index": 9,
          "completedAt": "12:25",
          "restaurant": "マクドナルド 九 条 店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.27,
          "durationStr": "9分48秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_10",
          "index": 10,
          "completedAt": "13:51",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市港区市岡3丁目",
          "fee": 320,
          "distanceKm": 2.88,
          "durationStr": "18分57秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_11",
          "index": 11,
          "completedAt": "14:21",
          "restaurant": "マクドナルド 九 条 店 McDonald's KUJO",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 1.51,
          "durationStr": "11分14秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_12",
          "index": 12,
          "completedAt": "14:59",
          "restaurant": "マクドナルド 九 条 店 McDonald's KUJO",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 0.69,
          "durationStr": "7分31秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_13",
          "index": 13,
          "completedAt": "15:15",
          "restaurant": "マクドナルド 九 条 店 McDonald's KUJO",
          "area": "大阪市西区川口1丁目",
          "fee": 320,
          "distanceKm": 1.51,
          "durationStr": "12分5秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_14",
          "index": 14,
          "completedAt": "15:23",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区千代崎",
          "fee": 320,
          "distanceKm": 2.41,
          "durationStr": "14分1秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_15",
          "index": 15,
          "completedAt": "15:33",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区九条3丁目",
          "fee": 755,
          "distanceKm": 4.18,
          "durationStr": "29分52秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_0929_16",
          "index": 16,
          "completedAt": "15:56",
          "restaurant": "びっくりドンキー フォレオ大阪ドームシティ店 Bikkuri donkey Foleo Oska Dome City",
          "area": "大阪市西区九条1丁目",
          "fee": 379,
          "distanceKm": 3.48,
          "durationStr": "20分50秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_0929_17",
          "index": 17,
          "completedAt": "16:00",
          "restaurant": "グルメシティ 九条店",
          "area": "大阪市西区川口2丁目",
          "fee": 395,
          "distanceKm": 3.59,
          "durationStr": "25分28秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [
        {
          "id": "quest_0929_1",
          "time": "11:24",
          "title": "クエスト",
          "amount": 450,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "11:23",
          "note": "公式一覧は 11:23「1 回乗車クエスト ¥450」（達成表示）と 11:24「クエスト ¥450」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_2",
          "time": "11:31",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "11:30",
          "note": "公式一覧は 11:30「1 回乗車クエスト ¥150」（達成表示）と 11:31「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_3",
          "time": "11:45",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_4",
          "time": "11:52",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_5",
          "time": "12:04",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_6",
          "time": "12:16",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥650」「6 回乗車クエスト ¥650」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_7",
          "time": "12:16",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_8",
          "time": "12:36",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "12:35",
          "note": "公式一覧は 12:35「1 回乗車クエスト ¥300」（達成表示）と 12:36「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_9",
          "time": "14:10",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_10",
          "time": "14:33",
          "title": "クエスト",
          "amount": 450,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "14:32",
          "note": "公式一覧は 14:32「3 回乗車クエスト ¥450」（達成表示）と 14:33「クエスト ¥450」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_11",
          "time": "14:33",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "14:32",
          "note": "公式一覧は 14:32「1 回乗車クエスト ¥300」（達成表示）と 14:33「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_12",
          "time": "15:07",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_13",
          "time": "15:28",
          "title": "クエスト",
          "amount": 50,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥50」「1 回乗車クエスト ¥50」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_14",
          "time": "15:42",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_15",
          "time": "16:07",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_16",
          "time": "16:12",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_17",
          "time": "16:27",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_0929_18",
          "time": "16:51",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:50",
          "note": "公式一覧は 16:50「1 回乗車クエスト ¥100」（達成表示）と 16:51「クエスト ¥100」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 8581,
        "quest": 4500,
        "adjustment": 0,
        "other": 0,
        "total": 13081
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-09-29T09:10:51.418Z"
      }
    },
    "2026-10-01": {
      "date": "2026-10-01",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 14.14,
      "tripsCount": 5,
      "officialPoints": 7,
      "deliveriesCount": 7,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1001_1",
          "index": 1,
          "completedAt": "09:29",
          "restaurant": "マクドナルド 九条店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 2.14,
          "durationStr": "16分7秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1001_2",
          "index": 2,
          "completedAt": "09:50",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市西区境川2丁目",
          "fee": 469,
          "distanceKm": 3.32,
          "durationStr": "23分2秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1001_3",
          "index": 3,
          "completedAt": "11:11",
          "restaurant": "マクドナルド 九条店 McDonald's KUJO",
          "area": "大阪市西区立売堀6丁目",
          "fee": 320,
          "distanceKm": 1.38,
          "durationStr": "10分59秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1001_4",
          "index": 4,
          "completedAt": "11:35",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区南堀江4丁目",
          "fee": 394,
          "distanceKm": 1.54,
          "durationStr": "13分27秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）"
        },
        {
          "id": "del_1001_5",
          "index": 5,
          "completedAt": "13:00",
          "restaurant": "京都北白川 ラーメン魁力屋 イオンモール大阪ドームシティ店",
          "area": "大阪市浪速区敷津西",
          "fee": 805,
          "distanceKm": 5.76,
          "durationStr": "34分7秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／配達先に丁目表記なし（表示どおり）"
        }
      ],
      "quests": [],
      "sales": {
        "delivery": 2308,
        "quest": 0,
        "adjustment": 0,
        "other": 0,
        "total": 2308
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-01T07:48:25.217Z"
      }
    },
    "2026-10-02": {
      "date": "2026-10-02",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 24.88,
      "tripsCount": 5,
      "officialPoints": 5,
      "deliveriesCount": 5,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1002_1",
          "index": 1,
          "completedAt": "07:34",
          "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
          "area": "大阪市此花区西九条1丁目",
          "fee": 495,
          "distanceKm": 5.07,
          "durationStr": "25分55秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1002_2",
          "index": 2,
          "completedAt": "08:32",
          "restaurant": "マクドナルド 高見プラザ店",
          "area": "大阪市此花区伝法5丁目",
          "fee": 490,
          "distanceKm": 5.91,
          "durationStr": "32分10秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1002_3",
          "index": 3,
          "completedAt": "08:42",
          "restaurant": "マクドナルド 高見プラザ店 McDonald's TAKAMI PLAZA",
          "area": "大阪市此花区酉島3丁目",
          "fee": 536,
          "distanceKm": 8.56,
          "durationStr": "40分7秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1002_4",
          "index": 4,
          "completedAt": "09:52",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市此花区梅香3丁目",
          "fee": 320,
          "distanceKm": 1.51,
          "durationStr": "12分4秒",
          "points": 1,
          "memo": ""
        },
        {
          "id": "del_1002_5",
          "index": 5,
          "completedAt": "10:26",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市西区本田1丁目",
          "fee": 372,
          "distanceKm": 3.83,
          "durationStr": "19分21秒",
          "points": 1,
          "memo": ""
        }
      ],
      "quests": [],
      "sales": {
        "delivery": 2213,
        "quest": 0,
        "adjustment": 0,
        "other": 0,
        "total": 2213
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-02T06:25:26.775Z"
      }
    },
    "2026-10-03": {
      "date": "2026-10-03",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 37.48,
      "tripsCount": 13,
      "officialPoints": 16,
      "deliveriesCount": 16,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1003_1",
          "index": 1,
          "completedAt": "06:08",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区立売堀6丁目",
          "fee": 320,
          "distanceKm": 3.07,
          "durationStr": "26分13秒",
          "points": 1,
          "memo": "",
          "tripUuid": "9cc894ec-059d-493c-a996-666d1519c7d4",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9cc894ec-059d-493c-a996-666d1519c7d4",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区立売堀６丁目",
              "area": "大阪市西区立売堀6丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_2",
          "index": 2,
          "completedAt": "06:36",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
          "area": "大阪市港区池島1丁目",
          "fee": 479,
          "distanceKm": 4.15,
          "durationStr": "20分21秒",
          "points": 1,
          "memo": "",
          "tripUuid": "9adf529d-0220-4273-8a4d-40126ec7b864",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9adf529d-0220-4273-8a4d-40126ec7b864",
              "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "pickupAddress": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "dropoffAddress": "27大阪市港区池島１丁目",
              "area": "大阪市港区池島1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_3",
          "index": 3,
          "completedAt": "07:07",
          "restaurant": "マクドナルド 弁天町駅前店",
          "area": "大阪市港区弁天4丁目",
          "fee": 344,
          "distanceKm": 2.24,
          "durationStr": "13分12秒",
          "points": 1,
          "memo": "",
          "tripUuid": "ab758b70-8e4d-4277-ac4a-19ac0b598058",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "ab758b70-8e4d-4277-ac4a-19ac0b598058",
              "restaurant": "マクドナルド 弁天町駅前店",
              "pickupAddress": "マクドナルド 弁天町駅前店",
              "dropoffAddress": "27大阪市港区弁天４丁目",
              "area": "大阪市港区弁天4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_4",
          "index": 4,
          "completedAt": "07:19",
          "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 3.35,
          "durationStr": "14分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0d720735-abf0-474d-be83-c4d83df3dd87",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0d720735-abf0-474d-be83-c4d83df3dd87",
              "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
              "pickupAddress": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_5",
          "index": 5,
          "completedAt": "07:42",
          "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
          "area": "大阪市西区九条2丁目",
          "fee": 341,
          "distanceKm": 2.95,
          "durationStr": "15分59秒",
          "points": 1,
          "memo": "",
          "tripUuid": "511db962-4644-45b6-b741-5a8073646d56",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "511db962-4644-45b6-b741-5a8073646d56",
              "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
              "pickupAddress": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
              "dropoffAddress": "27大阪市西区九条２丁目",
              "area": "大阪市西区九条2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_6",
          "index": 6,
          "completedAt": "08:28",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 1.14,
          "durationStr": "8分45秒",
          "points": 1,
          "memo": "",
          "tripUuid": "cada7aea-7908-4218-8088-90b9a95f1357",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "cada7aea-7908-4218-8088-90b9a95f1357",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条３丁目",
              "area": "大阪市西区九条3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_7",
          "index": 7,
          "completedAt": "08:36",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区江之子島2丁目",
          "fee": 324,
          "distanceKm": 2.37,
          "durationStr": "16分14秒",
          "points": 1,
          "memo": "",
          "tripUuid": "94ead0f7-ad0d-4c02-ac36-6df525f0155e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "94ead0f7-ad0d-4c02-ac36-6df525f0155e",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区江之子島２丁目",
              "area": "大阪市西区江之子島2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_8",
          "index": 8,
          "completedAt": "09:28",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市此花区梅香1丁目",
          "fee": 320,
          "distanceKm": 2,
          "durationStr": "15分7秒",
          "points": 1,
          "memo": "",
          "tripUuid": "4eee68ff-ae4b-423e-82a4-2488f52e6c29",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "4eee68ff-ae4b-423e-82a4-2488f52e6c29",
              "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
              "pickupAddress": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
              "dropoffAddress": "27大阪市此花区梅香１丁目",
              "area": "大阪市此花区梅香1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_9",
          "index": 9,
          "completedAt": "09:53",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市此花区西九条2丁目",
          "fee": 465,
          "distanceKm": 2.86,
          "durationStr": "18分58秒",
          "points": 1,
          "memo": "",
          "tripUuid": "8ad87313-e0c7-4f80-9ff0-1d284686045e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "8ad87313-e0c7-4f80-9ff0-1d284686045e",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市此花区西九条２丁目",
              "area": "大阪市此花区西九条2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_10",
          "index": 10,
          "completedAt": "10:26",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市西区千代崎1丁目/大阪市西区九条1丁目",
          "fee": 489,
          "distanceKm": 3.28,
          "durationStr": "27分21秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "606c2fb7-85e3-4291-bc93-47e2a5fc1d8b",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "1c2bfa71-383a-43d5-926b-b430f4619496",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区千代崎１丁目",
              "area": "大阪市西区千代崎1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6698%2C135.47846&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67505%2C135.48005&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgmrrEks%7ByXc%40yB%7BTqFyAdDqE%7DCMd%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=5UNyXo69Ch7aQD5O_YXA3noMT9w="
            },
            {
              "legIndex": 1,
              "legUuid": "8c7e341b-8f63-4a9e-ad42-cc919e7110b0",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6698%2C135.47845&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67558%2C135.47668&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgmrrEis%7ByXIkBmKoCcIqBiB%7CCaEwCg%40t%40ZgA%7B%40GoCrHc%40tFb%40Ai%40ZNkBb%40HpAbG&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=mCzmCWkNiBvpqlluKhaI50uUjio="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_11",
          "index": 11,
          "completedAt": "10:59",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市西区九条南2丁目/大阪市西区九条南1丁目",
          "fee": 449,
          "distanceKm": 3.62,
          "durationStr": "22分26秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "cac2f9d5-7a32-49e3-bcc8-b48559143d8d",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2cc37617-f538-4dfd-885d-f38c55695f79",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条南２丁目",
              "area": "大阪市西区九条南2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67%2C135.48&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67%2C135.47&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AonrrE%7D%7C%7ByX%3Fl%7D%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=eILmdhJ3kj20hYEOr2lsYAsSOSg="
            },
            {
              "legIndex": 1,
              "legUuid": "730831bf-8437-435f-af59-084c617ab9e5",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条南１丁目",
              "area": "大阪市西区九条南1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67%2C135.48&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67%2C135.48&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=clNPjfBUSaeIseWXAHe6hTXaSqs="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_12",
          "index": 12,
          "completedAt": "11:24",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市港区波除2丁目/大阪市西区九条1丁目",
          "fee": 491,
          "distanceKm": 4.18,
          "durationStr": "27分37秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "25a808ef-2ad7-4fd4-8e32-89f3ffbef2eb",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "cb07e11a-f637-4726-af08-220d2704736d",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市港区波除２丁目",
              "area": "大阪市港区波除2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67547%2C135.47408&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67076%2C135.46486&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AupsrE%7DwzyXjF%5CzAwDx%40t%40%5E%5Dh%40uDS%7CBx%40qBq%40AuArJu%5B%7Cd%40%7EBrIvIlEt%40o%40hIrJdRyIZ%60%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=fSGX7J7Xu3i_VFg5vmfKVs2yn3U="
            },
            {
              "legIndex": 1,
              "legUuid": "8435185e-a350-4f0e-9d17-ca6f427d57fe",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67547%2C135.47407&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67305%2C135.4755&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AupsrE%7DwzyXtFTtA%7DDrAp%40fAeFo%40%60Dj%40cB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=gDqvJg5xrP_H1_pP9t0cggZRlPc="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1003_13",
          "index": 13,
          "completedAt": "12:36",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 320,
          "distanceKm": 2.27,
          "durationStr": "14分49秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b8bc34f2-03ef-4254-93c5-ae92032e7038",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b8bc34f2-03ef-4254-93c5-ae92032e7038",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区三軒家東１丁目",
              "area": "大阪市大正区三軒家東1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1003_1",
          "time": "12:51",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥1,000」「6 回乗車クエスト ¥1,000」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 4982,
        "quest": 1000,
        "adjustment": 0,
        "other": 0,
        "total": 5982
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-04T06:57:50.845Z"
      }
    },
    "2026-10-04": {
      "date": "2026-10-04",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 63.89,
      "tripsCount": 15,
      "officialPoints": 25,
      "deliveriesCount": 25,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1004_1",
          "index": 1,
          "completedAt": "08:10",
          "restaurant": "スターバックス コーヒー JR弁天町駅店 Starbucks Coffee JR Bentencho Eki",
          "area": "大阪市西区九条南3丁目/大阪市此花区西九条2丁目",
          "fee": 620,
          "distanceKm": 5.41,
          "durationStr": "26分5秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "f6aa2b2d-3523-4072-beb2-fc0bb9cd5ae7",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "150c6898-717d-4f11-b324-2abca0bff81c",
              "restaurant": "",
              "pickupAddress": "27大阪市港区波除３丁目",
              "dropoffAddress": "27大阪市西区九条南３丁目",
              "area": "大阪市西区九条南3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66945%2C135.46209&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67414%2C135.4705&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_krrE_mxyXXc%40mJi%5EyHaJsFsBaBsCHk%40Fn%40d%40%5D&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=HSOXrhMA_qZH943cK0Rh1yO0HmM="
            },
            {
              "legIndex": 1,
              "legUuid": "972e084b-12be-4df1-a87f-b6b4470c1c46",
              "restaurant": "",
              "pickupAddress": "27大阪市港区波除３丁目",
              "dropoffAddress": "27大阪市此花区西九条２丁目",
              "area": "大阪市此花区西九条2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66945%2C135.46209&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67874%2C135.46192&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_krrE_mxyXXc%40mJi%5EyHaJcG_CqAgCHk%40j%40z%40Ni%40cAQSlBgGaCuEdH_CBuBvG_D%7E%40cFxQPmN%7C%40BpHr%5BuBpA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=iYlK3npIQBAOS0XD2QCL0TcFfcM="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_2",
          "index": 2,
          "completedAt": "08:28",
          "restaurant": "すき家 此花四貫島店 Sukiya Konohana Shikanjima",
          "area": "3-chōmeOsakaOsakaMinamiichiokaJepang/大阪市港区磯路2丁目",
          "fee": 844,
          "distanceKm": 6.65,
          "durationStr": "38分3秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "54acf809-163f-49f7-bdb7-a34bfd9c3e8b",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "1a271376-4c69-469e-81e4-7d7b8b2b3727",
              "restaurant": "",
              "pickupAddress": "2-chōme Osaka Osaka Shikanjima Jepang",
              "dropoffAddress": "3-chōme Osaka Osaka Minamiichioka Jepang",
              "area": "3-chōmeOsakaOsakaMinamiichiokaJepang",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68323%2C135.45411&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66389%2C135.46562&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AeaurEc%7BvyX%7CA%3FbNqHZg%40e%40kHpAHjCdEr%5DqPlAvDzPqIfBhEv%40M%7CLiGa%40qCgABdBm%40_%40%60%40b%40lC%7EFoBxGjH%60A_BeAl%40KiAfA%60%40pCqDgGeUbKiEScA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=ouS43FEoBFkJgAZRNQIevWRfhZ0="
            },
            {
              "legIndex": 1,
              "legUuid": "8d50397c-d9a5-466a-8824-728977dd0752",
              "restaurant": "",
              "pickupAddress": "27大阪市港区磯路１丁目",
              "dropoffAddress": "27大阪市港区磯路２丁目",
              "area": "大阪市港区磯路2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67%2C135.46&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67%2C135.46&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=dkJiaiSYjAhbgmVDpoKKbJYQNEs="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_3",
          "index": 3,
          "completedAt": "09:15",
          "restaurant": "マクドナルド みなと通夕凪店",
          "area": "大阪市港区市岡1丁目/大阪市港区弁天3丁目",
          "fee": 718,
          "distanceKm": 3.8,
          "durationStr": "23分23秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "7b279c81-6632-4a7e-b623-a2060b566463",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "de2a4618-846d-4ed7-997b-ec7a7814d946",
              "restaurant": "",
              "pickupAddress": "27大阪市港区磯路３丁目",
              "dropoffAddress": "27大阪市港区市岡１丁目",
              "area": "大阪市港区市岡1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66%2C135.46&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66%2C135.46&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=63otoeA26fY8Dm7tALfuLdLguNo="
            },
            {
              "legIndex": 1,
              "legUuid": "54f8c692-f125-42eb-a55b-7aab3c4ebbf4",
              "restaurant": "",
              "pickupAddress": "27大阪市港区三先１丁目",
              "dropoffAddress": "27大阪市港区弁天３丁目",
              "area": "大阪市港区弁天3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66223%2C135.45603&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66651%2C135.45586&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7B%7DprEegwyX_%40l%40Wi%40pBqAlD%7DFeCcL%60D_G%7BD%7DCZmAWj%40oBoAwK%7ED%7DAhB%60CdKkLzPZPo%40D%3FjB_Aq%40%7E%40%5B&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=4gQuAaCBgKve6E6BvMKbxYKTkMQ="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_4",
          "index": 4,
          "completedAt": "09:35",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市此花区西九条1丁目/大阪市此花区梅香2丁目",
          "fee": 714,
          "distanceKm": 6.39,
          "durationStr": "34分45秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "ce1038bc-b8fb-4cad-ac6c-3b2d9cc6475a",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "c3be101e-e59d-49cb-a639-41da1a4f8295",
              "restaurant": "",
              "pickupAddress": "27大阪市此花区西九条１丁目",
              "dropoffAddress": "27大阪市此花区西九条１丁目",
              "area": "大阪市此花区西九条1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68189%2C135.46619&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68149%2C135.46815&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AwxtrEufyyXXl%40vEmDcBaG_DlE_%40QFlAkBGhGwFc%40O&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=l6hvJjW-1j91mv76i-noO9DSMAA="
            },
            {
              "legIndex": 1,
              "legUuid": "6d7dd1da-56c2-4beb-a4c1-862c97dcb088",
              "restaurant": "",
              "pickupAddress": "27大阪市此花区西九条１丁目",
              "dropoffAddress": "27大阪市此花区梅香２丁目",
              "area": "大阪市此花区梅香2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68189%2C135.46619&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68085%2C135.4589&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AwxtrEufyyX%5Ej%40tEuDgBsFiDrEg%40MLpAoBOrG%7BF%7D%40o%40xBX_%40BxGnVgH%7CCfDvCmBdGeAJXn%40%7D%40%7CAjAzAQl%40aBOv%40rAk%40bBdCbCVeA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=JZ8h5BwtI2hg5pVdoGr_dNggSTs="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_5",
          "index": 5,
          "completedAt": "10:14",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市此花区四貫島1丁目",
          "fee": 1106,
          "distanceKm": 2.86,
          "durationStr": "27分33秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a1fb030c-c3ff-4788-85fc-63e52682b0df",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a1fb030c-c3ff-4788-85fc-63e52682b0df",
              "restaurant": "マクドナルド 阪神西九条駅前店",
              "pickupAddress": "マクドナルド 阪神西九条駅前店",
              "dropoffAddress": "27大阪市此花区四貫島１丁目",
              "area": "大阪市此花区四貫島1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_6",
          "index": 6,
          "completedAt": "10:39",
          "restaurant": "ローソン 西九条二丁目",
          "area": "大阪市西区九条南3丁目/大阪市西区本田3丁目",
          "fee": 1958,
          "distanceKm": 6.24,
          "durationStr": "33分17秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "b9aa5af7-a8c6-4ae7-a604-6c636d9e4e6a",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6fc134b9-4cec-4625-8fbf-b60c40526f97",
              "restaurant": "",
              "pickupAddress": "27大阪市此花区西九条２丁目",
              "dropoffAddress": "27大阪市西区九条南３丁目",
              "area": "大阪市西区九条南3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67982%2C135.46684&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.6744%2C135.4682&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7BktrEujyyXFs%40jIoBrEgI%7EEzCj%40c%40zHxCs%40w%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=wEyWv6EijYkx2s_k6aLEqeIQmhA="
            },
            {
              "legIndex": 1,
              "legUuid": "892fdf7c-3ff5-4749-9286-fd3661d2155c",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区吉野４丁目",
              "dropoffAddress": "27大阪市西区本田３丁目",
              "area": "大阪市西区本田3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69025%2C135.47037&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67746%2C135.47554&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AamvrEy%60zyXnKxSnUjE%60GjFrPyK%60Bo%40%7E%40PQd%40Fo%40jIoBrEgI%7EEzCj%40c%40zHxCc%40%7D%40s%40Rh%40b%40lDuMqVa%60%40oB%60%40hAW&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=0t3EyIzFLyrpsVCOmWBXPNbw4ro="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_7",
          "index": 7,
          "completedAt": "11:25",
          "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
          "area": "大阪市港区波除5丁目",
          "fee": 390,
          "distanceKm": 3.41,
          "durationStr": "17分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a48f45a7-1775-4ad5-8873-a660d4625cac",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a48f45a7-1775-4ad5-8873-a660d4625cac",
              "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "pickupAddress": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "dropoffAddress": "27大阪市港区波除５丁目",
              "area": "大阪市港区波除5丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_8",
          "index": 8,
          "completedAt": "11:57",
          "restaurant": "CoDeLi 大阪九条駅前店",
          "area": "大阪市西区本田2丁目/大阪市西区川口2丁目",
          "fee": 388,
          "distanceKm": 2.77,
          "durationStr": "26分9秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "074569fa-71e7-4dc9-8b7c-7cd09bb9e73b",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "8fe16748-3936-4ee9-9ab3-016f4bad294b",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67405%2C135.47353&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67836%2C135.47809&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AygsrEqtzyXw%40r%40mE%7DCuAwBZiF%7BCwBgIcLsCzAf%40EUfAIaBp%40nA%5Es%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=JbHnkYm9HkvE_lxhyyrDHnO1V0Q="
            },
            {
              "legIndex": 1,
              "legUuid": "d6e74f62-4e69-4cd7-add3-1b64a8bc276f",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口２丁目",
              "area": "大阪市西区川口2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67534%2C135.47408&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68105%2C135.48001&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7BosrE%7DwzyXwAmCj%40sDuNyPi%40%60AeAQQlBPqBT%7EAy%40oDn%40hC_%40i%40bA%3FkAbDwDqGuHwFz%40Xg%40oCPvB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=eqXEPT2M1R93bz4f8NLhHoxypUI="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_9",
          "index": 9,
          "completedAt": "13:14",
          "restaurant": "いきなり！ステーキ 大阪福島",
          "area": "大阪市西区京町堀3丁目/大阪市西区川口2丁目/大阪市西区江之子島1丁目",
          "fee": 773,
          "distanceKm": 5.58,
          "durationStr": "37分27秒",
          "points": 3,
          "memo": "トリプル配達（3件完了/3pt）／3件完了/3pt",
          "tripUuid": "ec03cb8f-1265-491d-9c74-25584da75f9e",
          "tripLegCount": 3,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "585268c7-2202-4cc7-ab8b-839ea2d7ed96",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区福島５丁目",
              "dropoffAddress": "27大阪市西区京町堀３丁目",
              "area": "大阪市西区京町堀3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69538%2C135.48612&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68469%2C135.48837&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AcmwrEgc%7DyXrA%7CAtNqArM%7CJbLiRvDaCl%40Vf%40mAbGaDpAnC_AuBf%40%7D%40jAzC&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=9T0zSLhhmhhI6leme5EWmL1jVKI="
            },
            {
              "legIndex": 1,
              "legUuid": "d0de75d6-9203-4ad9-8f11-30e02021c802",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区福島５丁目",
              "dropoffAddress": "27大阪市西区川口２丁目",
              "area": "大阪市西区川口2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69538%2C135.48612&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68311%2C135.48154&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AcmwrEgc%7DyXrA%7CAtNqArM%7CJbLiRvDaCl%40Vf%40mAbGaDpAnC_AuBf%40%7D%40zE%60OgAxBbAzDTm%40%7D%40D%7CA%40gBOd%40Aj%40%7CCgBt%40Lr%40kAx%40bDnFDlAvB%3FYvC%5EBFyBDnA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=cCjL2j0J9i1DAAnodOCny_Y0C6M="
            },
            {
              "legIndex": 2,
              "legUuid": "0b9dc996-32c4-49ba-8c45-14f49c0e4987",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区福島５丁目",
              "dropoffAddress": "27大阪市西区江之子島１丁目",
              "area": "大阪市西区江之子島1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69538%2C135.48612&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68403%2C135.48524&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AcmwrEgc%7DyXrA%7CAtNqArM%7CJbLiRvDaCl%40Vf%40mAbGaDpAnC_AuBf%40%7D%40zE%60OgA%7CAbAvETm%40%7D%40D%60%40A&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=0vJQF4lHYJosNDzA17OZuMF6dLQ="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_10",
          "index": 10,
          "completedAt": "16:04",
          "restaurant": "手作りタピオカ専門店Boba.t　南船場店　Handmaid Tapioca Boba.t Minamisenba",
          "area": "大阪市西区土佐堀/大阪市西区江戸堀2丁目",
          "fee": 924,
          "distanceKm": 4.25,
          "durationStr": "29分9秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "7799553f-079d-4533-a8fe-385c4e8f1a49",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "48e6f697-b797-47b2-8da1-ae98ff4c25f6",
              "restaurant": "",
              "pickupAddress": "27大阪市西区新町２丁目",
              "dropoffAddress": "27大阪市西区土佐堀",
              "area": "大阪市西区土佐堀",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67603%2C135.49068&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68781%2C135.48885&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AetsrEw_%7EyX%7DYTqMzAk%40mCoBp%40%60AnFYp%40oHa%40kCgEoJbF%5Bm%40iB%7EB%7D%40gAv%40%7CCbA%7DD%5BpA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=TnfrRbyr5HZ1294A7kwOLYtBnLI="
            },
            {
              "legIndex": 1,
              "legUuid": "b14361f3-6f30-472a-bd00-54b6942aa641",
              "restaurant": "",
              "pickupAddress": "27大阪市西区立売堀３丁目",
              "dropoffAddress": "27大阪市西区江戸堀２丁目",
              "area": "大阪市西区江戸堀2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67929%2C135.49058&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68723%2C135.48927&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AohtrEc_%7EyXyO%60%40kCz%40k%40mCoBp%40%60AnFYp%40oHa%40cBgEeKjE&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=oannySkCZqYRv-2S24zWgE8i2YQ="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_11",
          "index": 11,
          "completedAt": "16:26",
          "restaurant": "らーめん砦 京町堀店 ra-men toride kyoumachibori",
          "area": "大阪市西区江之子島1丁目",
          "fee": 479,
          "distanceKm": 3.78,
          "durationStr": "25分41秒",
          "points": 1,
          "memo": "",
          "tripUuid": "6aa5be76-3e6d-460d-a85c-af3148adda5d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6aa5be76-3e6d-460d-a85c-af3148adda5d",
              "restaurant": "らーめん砦 京町堀店 ra-men toride kyoumachibori",
              "pickupAddress": "らーめん砦 京町堀店 ra-men toride kyoumachibori",
              "dropoffAddress": "27大阪市西区江之子島１丁目",
              "area": "大阪市西区江之子島1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_12",
          "index": 12,
          "completedAt": "16:55",
          "restaurant": "【唐揚げ弁当・からあげ】鶏よし 土佐堀店",
          "area": "大阪市西区京町堀1丁目",
          "fee": 417,
          "distanceKm": 2.95,
          "durationStr": "21分21秒",
          "points": 1,
          "memo": "",
          "tripUuid": "af9a5fc0-4ef6-4d0f-9b8a-ee38a6cf96a4",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "af9a5fc0-4ef6-4d0f-9b8a-ee38a6cf96a4",
              "restaurant": "【唐揚げ弁当・からあげ】鶏よし 土佐堀店",
              "pickupAddress": "【唐揚げ弁当・からあげ】鶏よし 土佐堀店",
              "dropoffAddress": "27大阪市西区京町堀１丁目",
              "area": "大阪市西区京町堀1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_13",
          "index": 13,
          "completedAt": "17:03",
          "restaurant": "Ton Tonカンナム",
          "area": "大阪市西区靱本町2丁目/大阪市西区北堀江1丁目",
          "fee": 860,
          "distanceKm": 5.87,
          "durationStr": "33分50秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "49c7e6d3-eb10-4582-8d32-492c03f91b93",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "23a8fc3f-b987-4c92-b82b-ec677c72a381",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区福島２丁目",
              "dropoffAddress": "27大阪市西区靱本町２丁目",
              "area": "大阪市西区靱本町2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69422%2C135.48714&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68355%2C135.4917&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7BewrEsi%7DyXZ%60BiEXTzCgA%7B%40DcA_%40%7C%40c%40mDbAu%40jGiBpi%40a%5ChQyAn%40lCnBgDoBjEP%60Dq%40oAxB_%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Z2juZbGkUYzfr3rbXJlviqL7Pn8="
            },
            {
              "legIndex": 1,
              "legUuid": "201c7071-1b81-4891-a0a8-6831e44471d8",
              "restaurant": "",
              "pickupAddress": "27大阪市福島区福島５丁目",
              "dropoffAddress": "27大阪市西区北堀江１丁目",
              "area": "大阪市西区北堀江1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.69539%2C135.48608&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67494%2C135.49538&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AcmwrE%7Db%7DyXL%7D%40_%40%7C%40c%40mDbAu%40jGiBpi%40a%5ChQyAn%40lCnBgDoBjEP%60Dq%40oAtAUQ%5Ey%40%7DBt%40o%40k%40LKkAbWu%40P%7BF%7CZs%40b%40iEzBPIlCCs%40%7E%40H%7B%40cB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Egf8-EemE2XCTrz_644X1V9H87s="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_14",
          "index": 14,
          "completedAt": "18:10",
          "restaurant": "カリーWEST百名店2020 いずみバーグ Izumi Burg",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 1.69,
          "durationStr": "8分57秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a024d21c-ce55-469d-830c-7781b13958bf",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a024d21c-ce55-469d-830c-7781b13958bf",
              "restaurant": "カリーWEST百名店2020 いずみバーグ Izumi Burg",
              "pickupAddress": "カリーWEST百名店2020 いずみバーグ Izumi Burg",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1004_15",
          "index": 15,
          "completedAt": "18:15",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区九条南4丁目",
          "fee": 320,
          "distanceKm": 2.24,
          "durationStr": "14分56秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d55ea913-bfc0-4599-bac4-1f0a00b2b534",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d55ea913-bfc0-4599-bac4-1f0a00b2b534",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "27大阪市西区九条南４丁目",
              "area": "大阪市西区九条南4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1004_1",
          "time": "11:08",
          "title": "クエスト",
          "amount": 225,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥225」「1 回乗車クエスト ¥225」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_2",
          "time": "11:16",
          "title": "クエスト",
          "amount": 75,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥75」「1 回乗車クエスト ¥75」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_3",
          "time": "11:51",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_4",
          "time": "12:21",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "12:20",
          "note": "公式一覧は 12:20「1 回乗車クエスト ¥150」（達成表示）と 12:21「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_5",
          "time": "12:26",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_6",
          "time": "13:49",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥1,000」「6 回乗車クエスト ¥1,000」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_7",
          "time": "13:49",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_8",
          "time": "13:55",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_9",
          "time": "14:02",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_10",
          "time": "16:35",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:34",
          "note": "公式一覧は 16:34「1 回乗車クエスト ¥150」（達成表示）と 16:35「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_11",
          "time": "16:40",
          "title": "クエスト",
          "amount": 50,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:39",
          "note": "公式一覧は 16:39「1 回乗車クエスト ¥50」（達成表示）と 16:40「クエスト ¥50」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_12",
          "time": "17:02",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "17:01",
          "note": "公式一覧は 17:01「1 回乗車クエスト ¥100」（達成表示）と 17:02「クエスト ¥100」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_13",
          "time": "17:16",
          "title": "クエスト",
          "amount": 100,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥100」「1 回乗車クエスト ¥100」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_14",
          "time": "17:39",
          "title": "クエスト",
          "amount": 225,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥225」「1 回乗車クエスト ¥225」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_15",
          "time": "17:50",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥1,000」「6 回乗車クエスト ¥1,000」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_16",
          "time": "17:50",
          "title": "クエスト",
          "amount": 75,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥75」「1 回乗車クエスト ¥75」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_17",
          "time": "18:19",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "decision": "count_all",
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_18",
          "time": "18:19",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "decision": "count_all",
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_19",
          "time": "18:30",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1004_20",
          "time": "18:30",
          "title": "クエスト",
          "amount": 50,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥50」「1 回乗車クエスト ¥50」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 10831,
        "quest": 4400,
        "adjustment": 0,
        "other": 0,
        "total": 15231
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-04T11:49:24.959Z"
      }
    },
    "2026-10-05": {
      "date": "2026-10-05",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 34.22,
      "tripsCount": 13,
      "officialPoints": 17,
      "deliveriesCount": 17,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1005_1",
          "index": 1,
          "completedAt": "15:42",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区川口3丁目",
          "fee": 320,
          "distanceKm": 1.75,
          "durationStr": "12分11秒",
          "points": 1,
          "memo": "",
          "tripUuid": "51f7d961-ad3a-456c-83a9-4f9a6019913f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "51f7d961-ad3a-456c-83a9-4f9a6019913f",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区川口３丁目",
              "area": "大阪市西区川口3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_2",
          "index": 2,
          "completedAt": "15:55",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区九条南3丁目/1-chōmeOsakaOsakaIchiokaMotomachi",
          "fee": 655,
          "distanceKm": 5.18,
          "durationStr": "31分2秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d93dc360-fc6b-4af1-8529-bfa4dbbad6dd",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d8447762-68db-4a32-8cd4-a95d5a4dbdb0",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条南３丁目",
              "area": "大阪市西区九条南3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66973%2C135.47763&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67445%2C135.47095&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AylrrEen%7ByXu%40kCt%40%3FXoCtBdLdChALpHbE%7CHgGhJ%60BtBtAdIgA_DPf%40kAHbA%5BcAcDmGqHkQ%7ETo%40IuF%7DK%5B%60ALi%40c%40j%40Qk%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=LgRldFgHR2nn7z5wVf62lzyH-I8="
            },
            {
              "legIndex": 1,
              "legUuid": "8bb37bfc-ebba-46d2-94c0-591688a83bef",
              "restaurant": "",
              "pickupAddress": "3-chōme Osaka Osaka Chiyozaki 日本",
              "dropoffAddress": "1-chōme Osaka Osaka Ichioka Motomachi 日本",
              "area": "1-chōmeOsakaOsakaIchiokaMotomachi",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66972%2C135.47836&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66829%2C135.47&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AulrrEwr%7ByX_%40_%40x%40iBpBdLdChAPxHbE%60IeGpIzA%60CtAdIkAoDXz%40cA%3F&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=_YRs07ynpR_y9Yfnw6Bpa8k_30M="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_3",
          "index": 3,
          "completedAt": "16:23",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区北堀江3丁目/大阪市西区本田4丁目",
          "fee": 509,
          "distanceKm": 4.26,
          "durationStr": "22分42秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "a4971098-6a39-4e46-aff5-3d445896bbb8",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a6922b12-edc5-4397-b68e-c0111dcc95fa",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区北堀江３丁目",
              "area": "大阪市西区北堀江3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67492%2C135.47582&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67491%2C135.4878&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AemsrE%7Bb%7ByXP_BkGoDo%40vBo%40U%5C%7C%40q%40%60H%7B%40xBoDnIaBc%40p%40FTmAkBRxAI_A%7CArBe%40%60E%7BJ%40qDtB%7BGd%40sIrD%7BLyDwDt%40%7BIHoV%7EDL%3F_A%40%60Bm%40cBb%40%5D&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=IEcPmjzhgC0X0IvVWaOoKJhUNFY="
            },
            {
              "legIndex": 1,
              "legUuid": "69546b55-c10f-4042-856c-b17e7859aa91",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田４丁目",
              "area": "大阪市西区本田4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67492%2C135.47582&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67827%2C135.473&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AemsrE%7Bb%7ByXXyAyGwDg%40nBy%40Wf%40bAkBzKsDtIaBc%40fAc%40kBMjBSk%40%60%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=y8KP5QVteJedEEiL-habocoTnJE="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_4",
          "index": 4,
          "completedAt": "16:52",
          "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
          "area": "大阪市西区本田2丁目",
          "fee": 469,
          "distanceKm": 3.62,
          "durationStr": "18分13秒",
          "points": 1,
          "memo": "",
          "tripUuid": "192b2950-087f-44d9-af71-335ce45e866a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "192b2950-087f-44d9-af71-335ce45e866a",
              "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "pickupAddress": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_5",
          "index": 5,
          "completedAt": "17:16",
          "restaurant": "インド.ネパール料理ククリKhukuri",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 1.27,
          "durationStr": "15分38秒",
          "points": 1,
          "memo": "",
          "tripUuid": "ed5cbed7-0777-4188-9e83-476bf8b192fe",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "ed5cbed7-0777-4188-9e83-476bf8b192fe",
              "restaurant": "インド.ネパール料理ククリKhukuri",
              "pickupAddress": "インド.ネパール料理ククリKhukuri",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_6",
          "index": 6,
          "completedAt": "17:43",
          "restaurant": "ピザハット 大阪ナインモール九条店 Pizza Hut Osaka Ninemall Kujoh",
          "area": "大阪市西区川口3丁目/大阪市西区川口4丁目",
          "fee": 338,
          "distanceKm": 2.01,
          "durationStr": "19分27秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "5f3c3f64-c108-49dc-adcd-926daf97df9d",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "c9c03e68-e7ec-4d81-b36b-c121ee723cbe",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口３丁目",
              "area": "大阪市西区川口3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67523%2C135.47484&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67919%2C135.47784&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AeosrEw%7CzyXyAlFaP_TaBnFyAP%7D%40gCn%40KLkBPlCMuAU%5DUjAUcA%7EDsA_BsB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Qs5gHkOi0du4sUd3yQvSRsgaYpE="
            },
            {
              "legIndex": 1,
              "legUuid": "ff9085d5-606c-497b-a1cf-cdd95cff2cbd",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68%2C135.47&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68%2C135.48&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mtrEo%7EyyX%3Fm%7D%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=FZvdHfn4zfuPjZ1fr21ppBqPvO8="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_7",
          "index": 7,
          "completedAt": "18:13",
          "restaurant": "宇奈とと 大阪九条店 Unatoto Osaka Kujo",
          "area": "大阪市港区南市岡3丁目",
          "fee": 320,
          "distanceKm": 2.3,
          "durationStr": "13分4秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f33cdf7d-1b51-4bb6-a1c5-8b224b684b09",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f33cdf7d-1b51-4bb6-a1c5-8b224b684b09",
              "restaurant": "宇奈とと 大阪九条店 Unatoto Osaka Kujo",
              "pickupAddress": "宇奈とと 大阪九条店 Unatoto Osaka Kujo",
              "dropoffAddress": "27大阪市港区南市岡３丁目",
              "area": "大阪市港区南市岡3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_8",
          "index": 8,
          "completedAt": "18:36",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 2.06,
          "durationStr": "11分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "934e1f56-6e95-4bfc-95de-e64e8a28cef5",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "934e1f56-6e95-4bfc-95de-e64e8a28cef5",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条南２丁目",
              "area": "大阪市西区九条南2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_9",
          "index": 9,
          "completedAt": "18:52",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田1丁目/大阪市西区川口4丁目",
          "fee": 402,
          "distanceKm": 2.12,
          "durationStr": "21分28秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "09c229fa-1d7b-48fa-ae69-aa144a232da2",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "231f867a-c8f1-4b3d-aead-4efa51dbc7e2",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67538%2C135.47413&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67769%2C135.48096&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AapsrEixzyXwGyIKfEu%40%5EiIwCk%40eAeCp%40m%40_%40L%7BAU%5Ee%40mBzG%7DCxEqSS%7D%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=XX2RsbUvSIaC6B-xGLik0zWS7qc="
            },
            {
              "legIndex": 1,
              "legUuid": "de58d2da-977f-4208-8a49-cbf3674d491e",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67538%2C135.47413&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67979%2C135.47623&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AapsrEixzyXsGuIUpEo%40PuI%7DCc%40aAoCt%40q%40yAb%40k%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=BdIPfkL0ZUXs6U38tDEQonFjwkY="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_10",
          "index": 10,
          "completedAt": "19:17",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区境川1丁目",
          "fee": 320,
          "distanceKm": 1.34,
          "durationStr": "9分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d4c001d0-8e15-40fc-9c3e-aab9772e39a6",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d4c001d0-8e15-40fc-9c3e-aab9772e39a6",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市西区境川１丁目",
              "area": "大阪市西区境川1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_11",
          "index": 11,
          "completedAt": "19:22",
          "restaurant": "麺屋ここいち フォレオ大阪ドームシティ店",
          "area": "大阪市港区南市岡1丁目",
          "fee": 320,
          "distanceKm": 2.11,
          "durationStr": "16分3秒",
          "points": 1,
          "memo": "",
          "tripUuid": "88b39181-5745-41db-9f40-63af2f14dbd7",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "88b39181-5745-41db-9f40-63af2f14dbd7",
              "restaurant": "麺屋ここいち フォレオ大阪ドームシティ店",
              "pickupAddress": "麺屋ここいち フォレオ大阪ドームシティ店",
              "dropoffAddress": "27大阪市港区南市岡１丁目",
              "area": "大阪市港区南市岡1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_12",
          "index": 12,
          "completedAt": "19:32",
          "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 1.71,
          "durationStr": "9分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "abed7718-da8d-4925-9caf-b128aef5e693",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "abed7718-da8d-4925-9caf-b128aef5e693",
              "restaurant": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "pickupAddress": "かっぱ寿司 境川店　Kappa Sushi Sakaigawa",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1005_13",
          "index": 13,
          "completedAt": "19:47",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市港区波除3丁目",
          "fee": 403,
          "distanceKm": 4.49,
          "durationStr": "26分39秒",
          "points": 1,
          "memo": "",
          "tripUuid": "8434d28d-d66c-4202-986e-ce9a0ecc02ff",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "8434d28d-d66c-4202-986e-ce9a0ecc02ff",
              "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "pickupAddress": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市港区波除３丁目",
              "area": "大阪市港区波除3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1005_1",
          "time": "15:54",
          "title": "クエスト",
          "amount": 225,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥225」「1 回乗車クエスト ¥225」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_2",
          "time": "16:19",
          "title": "クエスト",
          "amount": 75,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥75」「1 回乗車クエスト ¥75」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_3",
          "time": "16:27",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:19",
          "note": "公式一覧は 16:19「3 回乗車クエスト ¥300」（達成表示）と 16:27「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_4",
          "time": "16:27",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_5",
          "time": "16:38",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:37",
          "note": "公式一覧は 16:37「1 回乗車クエスト ¥150」（達成表示）と 16:38「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_6",
          "time": "16:50",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "16:49",
          "note": "公式一覧は 16:49「1 回乗車クエスト ¥150」（達成表示）と 16:50「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_7",
          "time": "17:14",
          "title": "クエスト",
          "amount": 350,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥350」「3 回乗車クエスト ¥350」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_8",
          "time": "17:14",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥150」「1 回乗車クエスト ¥150」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_9",
          "time": "17:32",
          "title": "クエスト",
          "amount": 450,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥450」「1 回乗車クエスト ¥450」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_10",
          "time": "17:58",
          "title": "クエスト",
          "amount": 150,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "17:57",
          "note": "公式一覧は 17:57「1 回乗車クエスト ¥150」（達成表示）と 17:58「クエスト ¥150」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_11",
          "time": "18:02",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_12",
          "time": "18:02",
          "title": "クエスト",
          "amount": 450,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥450」「3 回乗車クエスト ¥450」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_13",
          "time": "18:31",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "18:30",
          "note": "公式一覧は 18:30「1 回乗車クエスト ¥300」（達成表示）と 18:31「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_14",
          "time": "18:48",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_15",
          "time": "19:07",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥650」「3 回乗車クエスト ¥650」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_16",
          "time": "19:14",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "achievedAt": "19:07",
          "note": "公式一覧は 19:07「1 回乗車クエスト ¥300」（達成表示）と 19:14「クエスト ¥300」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）。公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_17",
          "time": "19:28",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_18",
          "time": "19:39",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_19",
          "time": "19:52",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1005_20",
          "time": "20:15",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "1回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「1 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 5016,
        "quest": 5650,
        "adjustment": 0,
        "other": 0,
        "total": 10666
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-05T16:51:51.740Z"
      }
    },
    "2026-10-06": {
      "date": "2026-10-06",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 29.7,
      "tripsCount": 13,
      "officialPoints": 14,
      "deliveriesCount": 14,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1006_1",
          "index": 1,
          "completedAt": "09:10",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条南3丁目",
          "fee": 320,
          "distanceKm": 1.58,
          "durationStr": "11分23秒",
          "points": 1,
          "memo": "",
          "tripUuid": "408b3dd9-5988-432b-bb02-da46e09122d3",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "408b3dd9-5988-432b-bb02-da46e09122d3",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条南３丁目",
              "area": "大阪市西区九条南3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_2",
          "index": 2,
          "completedAt": "09:26",
          "restaurant": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
          "area": "大阪市港区波除2丁目",
          "fee": 341,
          "distanceKm": 2.24,
          "durationStr": "14分18秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e61afeb6-169d-464f-8380-0094ac74f091",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e61afeb6-169d-464f-8380-0094ac74f091",
              "restaurant": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
              "pickupAddress": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
              "dropoffAddress": "27大阪市港区波除２丁目",
              "area": "大阪市港区波除2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_3",
          "index": 3,
          "completedAt": "09:41",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市大正区三軒家西",
          "fee": 366,
          "distanceKm": 3.25,
          "durationStr": "18分21秒",
          "points": 1,
          "memo": "",
          "tripUuid": "90911bb4-dcb9-4e1c-945e-33e3e64bdc96",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "90911bb4-dcb9-4e1c-945e-33e3e64bdc96",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市大正区三軒家西",
              "area": "大阪市大正区三軒家西",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_4",
          "index": 4,
          "completedAt": "10:19",
          "restaurant": "ローソン 港区南市岡一丁目",
          "area": "3-chōme27OsakaSangenyanishi",
          "fee": 320,
          "distanceKm": 2.16,
          "durationStr": "13分38秒",
          "points": 1,
          "memo": "",
          "tripUuid": "00b8bbb6-117c-4630-a107-4cd657bd8f87",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "00b8bbb6-117c-4630-a107-4cd657bd8f87",
              "restaurant": "ローソン 港区南市岡一丁目",
              "pickupAddress": "ローソン 港区南市岡一丁目",
              "dropoffAddress": "3-chōme 27 Osaka Sangenyanishi Japan",
              "area": "3-chōme27OsakaSangenyanishi",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_5",
          "index": 5,
          "completedAt": "10:59",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 1,
          "durationStr": "9分46秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e62aa06b-aebd-4b34-a855-41cfe74cb219",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e62aa06b-aebd-4b34-a855-41cfe74cb219",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条３丁目",
              "area": "大阪市西区九条3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_6",
          "index": 6,
          "completedAt": "11:12",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 338,
          "distanceKm": 2.4,
          "durationStr": "16分19秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a7b77fb8-eaea-4a7d-b81b-4cf1a896d09e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a7b77fb8-eaea-4a7d-b81b-4cf1a896d09e",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_7",
          "index": 7,
          "completedAt": "11:41",
          "restaurant": "京都北白川 ラーメン魁力屋 イオンモール大阪ドームシティ店",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 374,
          "distanceKm": 2.19,
          "durationStr": "14分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a62abfb5-4731-45d4-9929-e1b705824ff1",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a62abfb5-4731-45d4-9929-e1b705824ff1",
              "restaurant": "京都北白川 ラーメン魁力屋 イオンモール大阪ドームシティ店",
              "pickupAddress": "京都北白川 ラーメン魁力屋 イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市港区市岡元町１丁目",
              "area": "大阪市港区市岡元町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_8",
          "index": 8,
          "completedAt": "11:51",
          "restaurant": "松のや 九条店 Matsunoya Kujo",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 1.14,
          "durationStr": "8分41秒",
          "points": 1,
          "memo": "",
          "tripUuid": "8cee72bc-2539-40f3-9ba7-a344998a15f5",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "8cee72bc-2539-40f3-9ba7-a344998a15f5",
              "restaurant": "松のや 九条店 Matsunoya Kujo",
              "pickupAddress": "松のや 九条店 Matsunoya Kujo",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_9",
          "index": 9,
          "completedAt": "12:49",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区新町3丁目/大阪市西区千代崎1丁目",
          "fee": 551,
          "distanceKm": 3.62,
          "durationStr": "29分17秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "783fe87d-d773-4aed-9e22-8c08c5023cbc",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2e740939-9afe-458f-803b-97c8e8ec40fc",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区新町３丁目",
              "area": "大阪市西区新町3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67014%2C135.47806&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67735%2C135.48903&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkorrE%7Bp%7ByXo%40QXs%40l%40bAr%40g%40HwBk%40%5D%7BU%7BGoAp%40xAkA%60AcFPiI%7BKwDSkGmCq%40%40uEaGa%40MiIg%40u%40f%40%3F&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=hEhpoVwYm8THvg0QOVsVr8TBk8U="
            },
            {
              "legIndex": 1,
              "legUuid": "4a229dcb-5698-4114-92da-8c53b467b0a4",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区千代崎１丁目",
              "area": "大阪市西区千代崎1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67002%2C135.47807&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67397%2C135.4802&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AsnrrE%7Dp%7ByXx%40eAByAk%40%5D%7BU%7BGkAn%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=btWbJUlCRpTZKKlzVftQiNmtRp0="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_10",
          "index": 10,
          "completedAt": "15:38",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市港区夕凪2丁目",
          "fee": 454,
          "distanceKm": 3.83,
          "durationStr": "18分56秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f02431f1-1538-4dd3-8334-eddfd7d8005d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f02431f1-1538-4dd3-8334-eddfd7d8005d",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市港区夕凪２丁目",
              "area": "大阪市港区夕凪2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_11",
          "index": 11,
          "completedAt": "16:23",
          "restaurant": "ウエルシア大阪九条店",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.19,
          "durationStr": "8分7秒",
          "points": 1,
          "memo": "",
          "tripUuid": "45736858-6307-4de4-b34c-119cf275f981",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "45736858-6307-4de4-b34c-119cf275f981",
              "restaurant": "ウエルシア大阪九条店",
              "pickupAddress": "ウエルシア大阪九条店",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_12",
          "index": 12,
          "completedAt": "16:34",
          "restaurant": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
          "area": "大阪市大正区北村1丁目",
          "fee": 523,
          "distanceKm": 3.91,
          "durationStr": "22分19秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b2d67565-be15-4380-8a3c-3923a56c163e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b2d67565-be15-4380-8a3c-3923a56c163e",
              "restaurant": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
              "pickupAddress": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
              "dropoffAddress": "27大阪市大正区北村１丁目",
              "area": "大阪市大正区北村1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1006_13",
          "index": 13,
          "completedAt": "17:31",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 1.19,
          "durationStr": "9分24秒",
          "points": 1,
          "memo": "",
          "tripUuid": "08811999-e8fb-48f7-bbe3-adc2d8b0d8e9",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "08811999-e8fb-48f7-bbe3-adc2d8b0d8e9",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "27大阪市西区九条南２丁目",
              "area": "大阪市西区九条南2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1006_1",
          "time": "13:19",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥650」「6 回乗車クエスト ¥650」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1006_2",
          "time": "16:57",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「3 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 4867,
        "quest": 950,
        "adjustment": 0,
        "other": 0,
        "total": 5817
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-06T10:14:27.207Z"
      }
    },
    "2026-10-08": {
      "date": "2026-10-08",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 27.35,
      "tripsCount": 16,
      "officialPoints": 19,
      "deliveriesCount": 19,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1008_1",
          "index": 1,
          "completedAt": "08:49",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "3-chōmeOsakaOsakaKujō/大阪市西区本田1丁目",
          "fee": 599,
          "baseFee": 416,
          "tip": 183,
          "distanceKm": 2.17,
          "durationStr": "22分50秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／最終売上¥599（基本料金¥416＋チップ¥183）／2件完了/2pt",
          "tripUuid": "bf31e548-4264-4162-8315-ac087ac2f0e8",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "16d7273e-7a9b-4204-95dd-c6d967881808",
              "restaurant": "",
              "pickupAddress": "1-chōme Osaka Osaka Kujō 日本",
              "dropoffAddress": "3-chōme Osaka Osaka Kujō 日本",
              "area": "3-chōmeOsakaOsakaKujō",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67538%2C135.47409&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67693%2C135.47099&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AapsrE_xzyXwHhR&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Ri4PVvvMRbu9L0xgxZnis_Ali34="
            },
            {
              "legIndex": 1,
              "legUuid": "90a1d268-104b-4a37-9b18-c9df52c62ce3",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67538%2C135.47409&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67883%2C135.47992&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AapsrE_xzyXmH%7ERtE%7DMeQoXdCkK%5BiAaCc%40Gq%40p%40Ee%40n%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=IC15OX5-xTgboaqU2n_KX-5k0JE="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_2",
          "index": 2,
          "completedAt": "09:40",
          "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
          "area": "大阪市大正区三軒家東2丁目",
          "fee": 320,
          "distanceKm": 2.2,
          "durationStr": "14分43秒",
          "points": 1,
          "memo": "",
          "tripUuid": "6b4628bd-49ab-485a-bbdf-3827f453ecf1",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6b4628bd-49ab-485a-bbdf-3827f453ecf1",
              "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "pickupAddress": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "dropoffAddress": "27大阪市大正区三軒家東２丁目",
              "area": "大阪市大正区三軒家東2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_3",
          "index": 3,
          "completedAt": "09:54",
          "restaurant": "マクドナルド 大正店",
          "area": "大阪市大正区千島3丁目",
          "fee": 320,
          "distanceKm": 1.88,
          "durationStr": "14分49秒",
          "points": 1,
          "memo": "",
          "tripUuid": "6908c96d-94d6-44b8-813e-ce564678ab16",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6908c96d-94d6-44b8-813e-ce564678ab16",
              "restaurant": "マクドナルド 大正店",
              "pickupAddress": "マクドナルド 大正店",
              "dropoffAddress": "27大阪市大正区千島３丁目",
              "area": "大阪市大正区千島3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_4",
          "index": 4,
          "completedAt": "10:51",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市西区千代崎3丁目",
          "fee": 320,
          "distanceKm": 1.5,
          "durationStr": "16分3秒",
          "points": 1,
          "memo": "",
          "tripUuid": "bd5baa1a-d1ca-4b3e-9898-cf5e69188808",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "bd5baa1a-d1ca-4b3e-9898-cf5e69188808",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市西区千代崎３丁目",
              "area": "大阪市西区千代崎3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_5",
          "index": 5,
          "completedAt": "11:09",
          "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 320,
          "distanceKm": 1.53,
          "durationStr": "15分7秒",
          "points": 1,
          "memo": "",
          "tripUuid": "61e44961-18a6-4528-8613-7bfbd3fbea7b",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "61e44961-18a6-4528-8613-7bfbd3fbea7b",
              "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "pickupAddress": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "dropoffAddress": "27大阪市大正区三軒家東１丁目",
              "area": "大阪市大正区三軒家東1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_6",
          "index": 6,
          "completedAt": "11:27",
          "restaurant": "横浜家系ラーメン 天来家 大正駅前店",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 320,
          "distanceKm": 0.93,
          "durationStr": "8分55秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b8127e0e-3493-4032-9ed3-22036f99966d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b8127e0e-3493-4032-9ed3-22036f99966d",
              "restaurant": "横浜家系ラーメン 天来家 大正駅前店",
              "pickupAddress": "横浜家系ラーメン 天来家 大正駅前店",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_7",
          "index": 7,
          "completedAt": "11:44",
          "restaurant": "花満円弁当 大阪ドームシティ店 Hanamanmarubento osakadoomten",
          "area": "大阪市西区九条1丁目/大阪市浪速区幸町3丁目",
          "fee": 553,
          "distanceKm": 2.83,
          "durationStr": "26分42秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d0d41a01-b4ae-4222-951b-605917644958",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "79ec4418-82f8-4318-9ac5-26dc1a2dfe55",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67013%2C135.4786&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67418%2C135.47475&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgorrEgt%7ByXKkAiC_%40aB%7EIaDSeGzP%7BCy%40P%5E&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=jMOCzBwC5AYKUDvtUuaeUwH9Xlc="
            },
            {
              "legIndex": 1,
              "legUuid": "70d5a830-86cf-4acd-bb29-7cd35ce319b1",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市浪速区幸町３丁目",
              "area": "大阪市浪速区幸町3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67013%2C135.4786&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66825%2C135.48131&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgorrEgt%7ByXKkAiC_%40aB%7EIaDSeGzP%7BCy%40zCz%40rFmR%7EDf%40fBwIbE%5ClLsCu%40uHkBi%40h%40v%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=9-_g72II94_rTJcE2WwKXT7u5K8="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_8",
          "index": 8,
          "completedAt": "12:17",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "2-chōmeOsakaOsakaKujō/大阪市西区九条南1丁目",
          "fee": 450,
          "distanceKm": 2.3,
          "durationStr": "21分9秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "b7d4c8dc-73db-47d7-bffc-e148160ee27e",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "543dd7d4-e551-4020-b49e-0e42f55bb5cf",
              "restaurant": "",
              "pickupAddress": "3-chōme Osaka Osaka Chiyozaki 日本",
              "dropoffAddress": "2-chōme Osaka Osaka Kujō 日本",
              "area": "2-chōmeOsakaOsakaKujō",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66981%2C135.47851&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67627%2C135.47383&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgmrrEus%7ByXkBmAeCbAuBlHZZoDMeAlDk%40%5DkDhNgFtGiFeIqPlDpOaC&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=V4HVCDo39BfBox_dKpxC00vrJLA="
            },
            {
              "legIndex": 1,
              "legUuid": "726e7f07-e359-4ede-a292-4adfdc9ed1f7",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条南１丁目",
              "area": "大阪市西区九条南1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66981%2C135.47851&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67155%2C135.47704&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgmrrEus%7ByXkBmAeCbAkBpH&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=-4U9UZs-B-08DC29duVcwQCP0LY="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_9",
          "index": 9,
          "completedAt": "12:34",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区立売堀6丁目",
          "fee": 320,
          "distanceKm": 2.91,
          "durationStr": "19分32秒",
          "points": 1,
          "memo": "",
          "tripUuid": "98cdf37c-b60a-4c83-9a27-6eb3ea3aea39",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "98cdf37c-b60a-4c83-9a27-6eb3ea3aea39",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区立売堀６丁目",
              "area": "大阪市西区立売堀6丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_10",
          "index": 10,
          "completedAt": "12:49",
          "restaurant": "情熱のぶた",
          "area": "大阪市西区立売堀5丁目",
          "fee": 320,
          "distanceKm": 0.71,
          "durationStr": "11分1秒",
          "points": 1,
          "memo": "",
          "tripUuid": "99dd7f64-879a-44af-99ba-a3313c991a00",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "99dd7f64-879a-44af-99ba-a3313c991a00",
              "restaurant": "情熱のぶた",
              "pickupAddress": "情熱のぶた",
              "dropoffAddress": "27大阪市西区立売堀５丁目",
              "area": "大阪市西区立売堀5丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_11",
          "index": 11,
          "completedAt": "13:10",
          "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 0.69,
          "durationStr": "10分0秒",
          "points": 1,
          "memo": "",
          "tripUuid": "19fe3b93-0da5-4a66-a06f-99f424c9f29f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "19fe3b93-0da5-4a66-a06f-99f424c9f29f",
              "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "pickupAddress": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_12",
          "index": 12,
          "completedAt": "13:40",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "4-chōmeOsakaOsakaKawaguchi일본",
          "fee": 320,
          "distanceKm": 1.19,
          "durationStr": "10分10秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e14fa023-27eb-4972-bc33-49bb67e0f78c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e14fa023-27eb-4972-bc33-49bb67e0f78c",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "4-chōme Osaka Osaka Kawaguchi 일본",
              "area": "4-chōmeOsakaOsakaKawaguchi일본",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_13",
          "index": 13,
          "completedAt": "14:06",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "1丁目大阪府大阪市三軒家東",
          "fee": 458,
          "baseFee": 320,
          "tip": 138,
          "distanceKm": 1.05,
          "durationStr": "14分59秒",
          "points": 1,
          "memo": "最終売上¥458（基本料金¥320＋チップ¥138）",
          "tripUuid": "9ce426e0-96f4-44b0-bf12-1c7380c29927",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9ce426e0-96f4-44b0-bf12-1c7380c29927",
              "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "pickupAddress": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "dropoffAddress": "１丁目 大阪府 大阪市 三軒家東 Nhật Bản",
              "area": "1丁目大阪府大阪市三軒家東",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_14",
          "index": 14,
          "completedAt": "17:33",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区川口1丁目",
          "fee": 325,
          "distanceKm": 1.34,
          "durationStr": "14分25秒",
          "points": 1,
          "memo": "",
          "tripUuid": "7948d1d0-d916-4a87-aa47-37ec32c1b11c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7948d1d0-d916-4a87-aa47-37ec32c1b11c",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区川口１丁目",
              "area": "大阪市西区川口1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_15",
          "index": 15,
          "completedAt": "18:06",
          "restaurant": "【雑穀×発酵×ねばとろ丼】ねばとろみのり 大正店",
          "area": "大阪市西区南堀江3丁目",
          "fee": 352,
          "distanceKm": 2.32,
          "durationStr": "24分47秒",
          "points": 1,
          "memo": "",
          "tripUuid": "142f5fb1-a791-4934-a7d0-7c80864d7c61",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "142f5fb1-a791-4934-a7d0-7c80864d7c61",
              "restaurant": "【雑穀×発酵×ねばとろ丼】ねばとろみのり 大正店",
              "pickupAddress": "【雑穀×発酵×ねばとろ丼】ねばとろみのり 大正店",
              "dropoffAddress": "27大阪市西区南堀江３丁目",
              "area": "大阪市西区南堀江3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1008_16",
          "index": 16,
          "completedAt": "18:52",
          "restaurant": "築地銀だこ イオンモール大阪ドームシティ店 Tsukiji Gindaco Aeon Mall Osaka Dome City",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 320,
          "distanceKm": 1.8,
          "durationStr": "19分26秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0b1353b1-937a-4fdc-a989-2e69dfc61f7f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0b1353b1-937a-4fdc-a989-2e69dfc61f7f",
              "restaurant": "築地銀だこ イオンモール大阪ドームシティ店 Tsukiji Gindaco Aeon Mall Osaka Dome City",
              "pickupAddress": "築地銀だこ イオンモール大阪ドームシティ店 Tsukiji Gindaco Aeon Mall Osaka Dome City",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1008_1",
          "time": "12:30",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥650」「6 回乗車クエスト ¥650」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1008_2",
          "time": "13:07",
          "title": "クエスト",
          "amount": 450,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥450」「3 回乗車クエスト ¥450」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1008_3",
          "time": "14:22",
          "title": "クエスト",
          "amount": 650,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "14:21",
          "note": "公式一覧は 14:21「3 回乗車クエスト ¥650」（達成表示）と 14:22「クエスト ¥650」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1008_4",
          "time": "19:12",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「3 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 5937,
        "quest": 2050,
        "adjustment": 0,
        "other": 0,
        "total": 7987
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-08T12:05:22.110Z"
      }
    },
    "2026-10-09": {
      "date": "2026-10-09",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 33.62,
      "tripsCount": 15,
      "officialPoints": 18,
      "deliveriesCount": 18,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1009_1",
          "index": 1,
          "completedAt": "08:26",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.34,
          "durationStr": "7分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "9da9c479-84a5-47df-9e15-0442b5e5eb8a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9da9c479-84a5-47df-9e15-0442b5e5eb8a",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_2",
          "index": 2,
          "completedAt": "09:33",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 320,
          "distanceKm": 1.77,
          "durationStr": "11分14秒",
          "points": 1,
          "memo": "",
          "tripUuid": "1585e1cf-56c9-4f9b-887a-85b11aeaaec2",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "1585e1cf-56c9-4f9b-887a-85b11aeaaec2",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市港区市岡元町１丁目",
              "area": "大阪市港区市岡元町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_3",
          "index": 3,
          "completedAt": "10:05",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市浪速区幸町3丁目",
          "fee": 320,
          "distanceKm": 1.59,
          "durationStr": "9分39秒",
          "points": 1,
          "memo": "",
          "tripUuid": "209ad81d-869c-4eab-904f-591264ce157f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "209ad81d-869c-4eab-904f-591264ce157f",
              "restaurant": "やよい軒 九条店",
              "pickupAddress": "やよい軒 九条店",
              "dropoffAddress": "27大阪市浪速区幸町３丁目",
              "area": "大阪市浪速区幸町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_4",
          "index": 4,
          "completedAt": "10:23",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
          "area": "大阪市西区西本町2丁目",
          "fee": 366,
          "distanceKm": 2.37,
          "durationStr": "16分39秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e4ccfb29-4897-411a-81f2-6508e64f286c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e4ccfb29-4897-411a-81f2-6508e64f286c",
              "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "pickupAddress": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "dropoffAddress": "27大阪市西区西本町２丁目",
              "area": "大阪市西区西本町2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_5",
          "index": 5,
          "completedAt": "10:54",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区川口3丁目/大阪市福島区野田3丁目",
          "fee": 528,
          "distanceKm": 4.31,
          "durationStr": "27分53秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d8d74876-8872-4ce6-94dc-4d7e1786c220",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "06865763-2309-4630-9d1e-7e254bcf9607",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口３丁目",
              "area": "大阪市西区川口3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67542%2C135.47412&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68125%2C135.47842&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkpsrEgxzyXZmCs%40rDyCkBuKmOc%40X_EiHaEtCeCRkAgCr%40Y&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=j0QIeTJXsXGwCdXmjdvQRv_XQSM="
            },
            {
              "legIndex": 1,
              "legUuid": "d7a57478-8847-4af5-991e-a3dece71c152",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市福島区野田３丁目",
              "area": "大阪市福島区野田3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67526%2C135.4749&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68855%2C135.47477&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkosrEc%7DzyXw%40%60EyCkBuKmOc%40X_EiHaEtCeCR_BmFnDmDkPaJgJaPmEfF%7ECjCmAtEiN%7EXyEfEtDdG&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=iWlPT6-3S9eKfPQps-X591JCsy0="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_6",
          "index": 6,
          "completedAt": "11:48",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市福島区吉野5丁目",
          "fee": 320,
          "distanceKm": 1.37,
          "durationStr": "17分29秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0b86bd0f-964f-4ca8-9044-cd26106301da",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0b86bd0f-964f-4ca8-9044-cd26106301da",
              "restaurant": "マクドナルド 阪神西九条駅前店",
              "pickupAddress": "マクドナルド 阪神西九条駅前店",
              "dropoffAddress": "27大阪市福島区吉野５丁目",
              "area": "大阪市福島区吉野5丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_7",
          "index": 7,
          "completedAt": "12:33",
          "restaurant": "ローソン 大阪ドームシティ",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 320,
          "distanceKm": 1.59,
          "durationStr": "16分36秒",
          "points": 1,
          "memo": "",
          "tripUuid": "74e15d65-050e-4e8c-a8c3-ce70d4d6fc9d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "74e15d65-050e-4e8c-a8c3-ce70d4d6fc9d",
              "restaurant": "ローソン 大阪ドームシティ",
              "pickupAddress": "ローソン 大阪ドームシティ",
              "dropoffAddress": "27大阪市大正区三軒家東１丁目",
              "area": "大阪市大正区三軒家東1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_8",
          "index": 8,
          "completedAt": "16:19",
          "restaurant": "リンガーハット イオンモール大阪ドームシティ店",
          "area": "大阪市西区南堀江1丁目",
          "fee": 449,
          "distanceKm": 2.91,
          "durationStr": "20分10秒",
          "points": 1,
          "memo": "",
          "tripUuid": "3f66a5d8-ba9e-4384-b536-e70dbfb98b05",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "3f66a5d8-ba9e-4384-b536-e70dbfb98b05",
              "restaurant": "リンガーハット イオンモール大阪ドームシティ店",
              "pickupAddress": "リンガーハット イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市西区南堀江１丁目",
              "area": "大阪市西区南堀江1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_9",
          "index": 9,
          "completedAt": "16:51",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区靱本町2丁目",
          "fee": 449,
          "distanceKm": 3.78,
          "durationStr": "21分3秒",
          "points": 1,
          "memo": "",
          "tripUuid": "4e72b82e-bf36-4e56-94b4-05feb5757a6e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "4e72b82e-bf36-4e56-94b4-05feb5757a6e",
              "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "pickupAddress": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市西区靱本町２丁目",
              "area": "大阪市西区靱本町2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_10",
          "index": 10,
          "completedAt": "17:57",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区新町4丁目",
          "fee": 320,
          "distanceKm": 1.87,
          "durationStr": "11分35秒",
          "points": 1,
          "memo": "",
          "tripUuid": "88bfec77-ff9f-4e14-a0d8-c1175a22c51c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "88bfec77-ff9f-4e14-a0d8-c1175a22c51c",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_11",
          "index": 11,
          "completedAt": "18:14",
          "restaurant": "や台ずし 九条町",
          "area": "大阪市大正区三軒家西1丁目",
          "fee": 320,
          "distanceKm": 1.74,
          "durationStr": "15分11秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e385119a-85ef-4835-90bf-4f8d34ba2223",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e385119a-85ef-4835-90bf-4f8d34ba2223",
              "restaurant": "や台ずし 九条町",
              "pickupAddress": "や台ずし 九条町",
              "dropoffAddress": "27大阪市大正区三軒家西１丁目",
              "area": "大阪市大正区三軒家西1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_12",
          "index": 12,
          "completedAt": "18:25",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家東4丁目",
          "fee": 341,
          "distanceKm": 1.66,
          "durationStr": "14分0秒",
          "points": 1,
          "memo": "",
          "tripUuid": "5cf3a9d5-2ba7-410b-b1c7-ad1fd80d21aa",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5cf3a9d5-2ba7-410b-b1c7-ad1fd80d21aa",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区三軒家東４丁目",
              "area": "大阪市大正区三軒家東4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_13",
          "index": 13,
          "completedAt": "18:33",
          "restaurant": "【チキンステーキ弁当】Master Of Chicken～大正店～",
          "area": "大阪市西区靱本町3丁目/大阪市西区靱本町2丁目",
          "fee": 549,
          "distanceKm": 3.81,
          "durationStr": "36分57秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "5b6a345d-ee74-456f-8eba-23bf590fa6fa",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7672e46b-b9be-46dc-a965-662016656481",
              "restaurant": "",
              "pickupAddress": "27大阪市大正区三軒家東１丁目",
              "dropoffAddress": "27大阪市西区靱本町３丁目",
              "area": "大阪市西区靱本町3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66545%2C135.47987&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68287%2C135.48852&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AarqrEe%7C%7ByXuA%60DyGuE%7DA%7BNoA_%40cCmV%40sFeKeBuPQg%40vEeQeA%7DXjDeFhBeAoJ_BLG%7DA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=iki1olrLMAqhJOMK2HoUsCmxBZk="
            },
            {
              "legIndex": 1,
              "legUuid": "e32962bf-71ee-4638-ac3f-97b76ad5f0e9",
              "restaurant": "",
              "pickupAddress": "27大阪市西区南堀江３丁目",
              "dropoffAddress": "27大阪市西区靱本町２丁目",
              "area": "大阪市西区靱本町2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67254%2C135.4884&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68341%2C135.49112&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3Ak%7ErrEoq%7DyXqE%3F_A%7CEmPkA%7DXjDeFhBeAoJ_BLGoAVnA%5DLh%40o%40_%40sC%5EYoCuK&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=hxcBRDhHi9bhr6xBevb5RWM1jBk="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_14",
          "index": 14,
          "completedAt": "19:47",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条南2丁目",
          "fee": 320,
          "distanceKm": 1.24,
          "durationStr": "12分2秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a51cf457-9e83-478a-957d-c5e37cb8ef1a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a51cf457-9e83-478a-957d-c5e37cb8ef1a",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条南２丁目",
              "area": "大阪市西区九条南2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1009_15",
          "index": 15,
          "completedAt": "20:28",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市西区九条南1丁目/大阪市大正区三軒家西1丁目",
          "fee": 449,
          "distanceKm": 2.27,
          "durationStr": "25分52秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "8a2c8eea-4b43-46d7-9d63-7c1698a7e42c",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2c205a97-dd3b-49f9-8abf-f62279fb5d02",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区九条南１丁目",
              "area": "大阪市西区九条南1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66983%2C135.47834&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67146%2C135.47581&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkmrrEsr%7ByXPg%40%7C%40rGeCnAoCm%40qAhF%60%40Yr%40v%40oAq%40GpBm%40%7BA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=pRbYBVLekwR1DTrmA4tUBS1ILrM="
            },
            {
              "legIndex": 1,
              "legUuid": "f3f58aff-3621-4d66-b06a-a7f57265cf44",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市大正区三軒家西１丁目",
              "area": "大阪市大正区三軒家西1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67094%2C135.47924&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66651%2C135.47879&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AktrrEgx%7ByXzCj%40jAvDDsA%60AnGeCnAoCm%40qAhF%60%40Yr%40v%40oAq%40GpBe%40uAQvBbCmJ%60CbA%7CBuAu%40eJpLuBtAX%5ClCtB%5D&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=ICI-Cy21ZQ_Kg2d2pbHb7j_fd0w="
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1009_1",
          "time": "12:06",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「3 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        },
        {
          "id": "quest_1009_2",
          "time": "18:10",
          "title": "クエスト",
          "amount": 300,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥300」「3 回乗車クエスト ¥300」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1009_3",
          "time": "19:23",
          "title": "クエスト",
          "amount": 400,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥400」「3 回乗車クエスト ¥400」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1009_4",
          "time": "20:45",
          "title": "クエスト",
          "amount": 550,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "20:44",
          "note": "公式一覧は 20:44「3 回乗車クエスト ¥550」（達成表示）と 20:45「クエスト ¥550」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算。21:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 5691,
        "quest": 1550,
        "adjustment": 0,
        "other": 0,
        "total": 7241
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-09T12:39:45.923Z"
      }
    },
    "2026-10-10": {
      "date": "2026-10-10",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 35.43,
      "tripsCount": 20,
      "officialPoints": 22,
      "deliveriesCount": 22,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1010_1",
          "index": 1,
          "completedAt": "08:23",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 0.95,
          "durationStr": "8分12秒",
          "points": 1,
          "memo": "",
          "tripUuid": "5a095fcf-aa1a-4517-95e2-0e54d84088e0",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5a095fcf-aa1a-4517-95e2-0e54d84088e0",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_2",
          "index": 2,
          "completedAt": "08:33",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市大正区三軒家西2丁目",
          "fee": 328,
          "distanceKm": 2.46,
          "durationStr": "13分56秒",
          "points": 1,
          "memo": "",
          "tripUuid": "5037dd8a-2f67-4701-ba31-c0899496ef06",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5037dd8a-2f67-4701-ba31-c0899496ef06",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市大正区三軒家西２丁目",
              "area": "大阪市大正区三軒家西2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_3",
          "index": 3,
          "completedAt": "08:46",
          "restaurant": "マクドナルド 大　正　店 McDonald's TAISHO",
          "area": "大阪市大正区北恩加島1丁目/大阪市大正区千島1丁目",
          "fee": 497,
          "distanceKm": 3.28,
          "durationStr": "25分12秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "6cc2d9a2-2a80-41a9-b65f-5c52899eaaf7",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "71619929-93a1-4d2b-85ff-d2b872605e19",
              "restaurant": "",
              "pickupAddress": "27大阪市大正区千島１丁目",
              "dropoffAddress": "27大阪市大正区北恩加島１丁目",
              "area": "大阪市大正区北恩加島1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.65385%2C135.47287&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.65338%2C135.46475&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AoiorEmpzyXLcD_GqBQ%5C%7CD%60%40_%40rDrIfDqGda%40lGhDeC%7CBGbB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=sVwiLJc0VNCWBwO1h7rHfJyYorU="
            },
            {
              "legIndex": 1,
              "legUuid": "1dcd423f-3ba7-447c-8c5e-b39a907568e7",
              "restaurant": "",
              "pickupAddress": "27大阪市大正区千島１丁目",
              "dropoffAddress": "27大阪市大正区千島１丁目",
              "area": "大阪市大正区千島1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.65385%2C135.47287&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.65492%2C135.47414&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AoiorEmpzyXLcDkFuBe%40%60%40l%40E&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=S6Ssaci9gQgNeLmoUJaismBVbOY="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_4",
          "index": 4,
          "completedAt": "09:31",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
          "area": "大阪市西区新町3丁目",
          "fee": 320,
          "distanceKm": 1.77,
          "durationStr": "16分12秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e5494eed-1863-4cab-86bf-4be0421f4276",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e5494eed-1863-4cab-86bf-4be0421f4276",
              "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "pickupAddress": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "dropoffAddress": "27大阪市西区新町３丁目",
              "area": "大阪市西区新町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_5",
          "index": 5,
          "completedAt": "09:43",
          "restaurant": "ローソンストア100 西区新町店",
          "area": "大阪市西区靱本町2丁目",
          "fee": 320,
          "distanceKm": 2.22,
          "durationStr": "21分17秒",
          "points": 1,
          "memo": "",
          "tripUuid": "55e3fd1e-554a-48e4-b86b-601543ac409b",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "55e3fd1e-554a-48e4-b86b-601543ac409b",
              "restaurant": "ローソンストア100 西区新町店",
              "pickupAddress": "ローソンストア100 西区新町店",
              "dropoffAddress": "27大阪市西区靱本町２丁目",
              "area": "大阪市西区靱本町2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_6",
          "index": 6,
          "completedAt": "09:54",
          "restaurant": "ジューシーズ ラボラトリー 靱公園店 juicy's laboratory Utsubo Park",
          "area": "大阪市福島区鷺洲1丁目",
          "fee": 387,
          "distanceKm": 3.2,
          "durationStr": "25分7秒",
          "points": 1,
          "memo": "",
          "tripUuid": "7da8b8d9-1c64-4cae-85ee-e87c6cae3753",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7da8b8d9-1c64-4cae-85ee-e87c6cae3753",
              "restaurant": "ジューシーズ ラボラトリー 靱公園店 juicy's laboratory Utsubo Park",
              "pickupAddress": "ジューシーズ ラボラトリー 靱公園店 juicy's laboratory Utsubo Park",
              "dropoffAddress": "27大阪市福島区鷺洲１丁目",
              "area": "大阪市福島区鷺洲1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_7",
          "index": 7,
          "completedAt": "10:34",
          "restaurant": "マクドナルド 阪神西九条駅前店",
          "area": "大阪市此花区梅香3丁目",
          "fee": 328,
          "distanceKm": 1.66,
          "durationStr": "16分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "7c68c718-a9c8-46b8-83ab-85c421dae2bc",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7c68c718-a9c8-46b8-83ab-85c421dae2bc",
              "restaurant": "マクドナルド 阪神西九条駅前店",
              "pickupAddress": "マクドナルド 阪神西九条駅前店",
              "dropoffAddress": "27大阪市此花区梅香３丁目",
              "area": "大阪市此花区梅香3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_8",
          "index": 8,
          "completedAt": "10:50",
          "restaurant": "マクドナルド 高見プラザ店",
          "area": "大阪市此花区梅香3丁目",
          "fee": 435,
          "distanceKm": 2.86,
          "durationStr": "15分20秒",
          "points": 1,
          "memo": "",
          "tripUuid": "9e9d8b65-87cc-426f-b724-22617398013a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9e9d8b65-87cc-426f-b724-22617398013a",
              "restaurant": "マクドナルド 高見プラザ店",
              "pickupAddress": "マクドナルド 高見プラザ店",
              "dropoffAddress": "27大阪市此花区梅香３丁目",
              "area": "大阪市此花区梅香3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_9",
          "index": 9,
          "completedAt": "11:37",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区新町4丁目",
          "fee": 320,
          "distanceKm": 1.37,
          "durationStr": "11分37秒",
          "points": 1,
          "memo": "",
          "tripUuid": "833c7e35-6d95-4f3c-8960-6226406b92a3",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "833c7e35-6d95-4f3c-8960-6226406b92a3",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_10",
          "index": 10,
          "completedAt": "12:12",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 0.9,
          "durationStr": "8分20秒",
          "points": 1,
          "memo": "",
          "tripUuid": "533f7a7e-79ed-4078-8191-44081eddd9fb",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "533f7a7e-79ed-4078-8191-44081eddd9fb",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_11",
          "index": 11,
          "completedAt": "12:20",
          "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 1.19,
          "durationStr": "9分20秒",
          "points": 1,
          "memo": "",
          "tripUuid": "fbb110a5-5035-4920-8cf0-31e357cb71ce",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "fbb110a5-5035-4920-8cf0-31e357cb71ce",
              "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "pickupAddress": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_12",
          "index": 12,
          "completedAt": "12:32",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区京町堀3丁目/大阪市西区本田2丁目",
          "fee": 460,
          "distanceKm": 2.46,
          "durationStr": "20分20秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d32f284c-4afe-4a2e-ae0a-cd7cde9be520",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "82bab6c4-e90b-412b-8131-d0c6d9b6c60f",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区京町堀３丁目",
              "area": "大阪市西区京町堀3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67502%2C135.47554&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68402%2C135.48604&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7BmsrEca%7ByXj%40%7BBcA%7BA%5CaHoWaJJ%60A%5B%7DB%7DWcJNsQc%40yB%7BAQcAoCYv%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=-S8UbT0fVdTLpmKoON3l9lE12dY="
            },
            {
              "legIndex": 1,
              "legUuid": "dd60fb72-a5e7-4e59-9ec6-85397b6241aa",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6755%2C135.47409&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67888%2C135.47945&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7BpsrE_xzyXjC_LcA%7BAl%40mG_XuJDlA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=s9_2kRGME_HBDe-_B7wUjuD7wcs="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_13",
          "index": 13,
          "completedAt": "13:28",
          "restaurant": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
          "area": "大阪市西区新町3丁目",
          "fee": 320,
          "distanceKm": 1.88,
          "durationStr": "17分26秒",
          "points": 1,
          "memo": "",
          "tripUuid": "cd7e2495-1786-42f3-b9de-b044d688602f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "cd7e2495-1786-42f3-b9de-b044d688602f",
              "restaurant": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
              "pickupAddress": "サーティワン アイスクリーム 九条ナインモール店 31 Ice Cream Kujoh Ninemall",
              "dropoffAddress": "27大阪市西区新町３丁目",
              "area": "大阪市西区新町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_14",
          "index": 14,
          "completedAt": "13:49",
          "restaurant": "ローソン 新町四丁目",
          "area": "大阪市西区新町3丁目",
          "fee": 320,
          "distanceKm": 0.56,
          "durationStr": "6分52秒",
          "points": 1,
          "memo": "",
          "tripUuid": "66f0a667-b868-4ce7-913f-daf409c22ad7",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "66f0a667-b868-4ce7-913f-daf409c22ad7",
              "restaurant": "ローソン 新町四丁目",
              "pickupAddress": "ローソン 新町四丁目",
              "dropoffAddress": "27大阪市西区新町３丁目",
              "area": "大阪市西区新町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_15",
          "index": 15,
          "completedAt": "17:25",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市大正区三軒家東2丁目",
          "fee": 320,
          "distanceKm": 1.54,
          "durationStr": "13分32秒",
          "points": 1,
          "memo": "",
          "tripUuid": "3dc30c28-3e0d-4d61-b1a5-8825bd260211",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "3dc30c28-3e0d-4d61-b1a5-8825bd260211",
              "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "pickupAddress": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "dropoffAddress": "27大阪市大正区三軒家東２丁目",
              "area": "大阪市大正区三軒家東2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_16",
          "index": 16,
          "completedAt": "17:45",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家西3丁目",
          "fee": 341,
          "distanceKm": 1.67,
          "durationStr": "21分27秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f7ef56e8-1cb0-4249-978e-53dc7d1d8023",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f7ef56e8-1cb0-4249-978e-53dc7d1d8023",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区三軒家西３丁目",
              "area": "大阪市大正区三軒家西3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_17",
          "index": 17,
          "completedAt": "18:14",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区新町4丁目",
          "fee": 381,
          "distanceKm": 1.85,
          "durationStr": "17分21秒",
          "points": 1,
          "memo": "",
          "tripUuid": "afd84300-5176-4e4b-a5a6-059dfa4b7940",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "afd84300-5176-4e4b-a5a6-059dfa4b7940",
              "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "pickupAddress": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_18",
          "index": 18,
          "completedAt": "18:39",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市西区川口4丁目",
          "fee": 320,
          "distanceKm": 1.19,
          "durationStr": "9分37秒",
          "points": 1,
          "memo": "",
          "tripUuid": "1a55c65e-08df-426d-9602-17bff2b1ce05",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "1a55c65e-08df-426d-9602-17bff2b1ce05",
              "restaurant": "やよい軒 九条店",
              "pickupAddress": "やよい軒 九条店",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_19",
          "index": 19,
          "completedAt": "19:09",
          "restaurant": "金のとりから/待茶 イオンモール大阪ドームシティ店",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "13分26秒",
          "points": 1,
          "memo": "",
          "tripUuid": "db144b69-a769-42ae-957e-050acb125c75",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "db144b69-a769-42ae-957e-050acb125c75",
              "restaurant": "金のとりから/待茶 イオンモール大阪ドームシティ店",
              "pickupAddress": "金のとりから/待茶 イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1010_20",
          "index": 20,
          "completedAt": "19:41",
          "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
          "area": "大阪市浪速区幸町2丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "11分57秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b63887b8-56d9-4871-b5c2-b46cef22c59d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b63887b8-56d9-4871-b5c2-b46cef22c59d",
              "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "pickupAddress": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "dropoffAddress": "27大阪市浪速区幸町２丁目",
              "area": "大阪市浪速区幸町2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1010_1",
          "time": "13:47",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥1,000」「6 回乗車クエスト ¥1,000」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1010_2",
          "time": "19:53",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥1,000」「6 回乗車クエスト ¥1,000」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。15:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 6997,
        "quest": 2000,
        "adjustment": 0,
        "other": 0,
        "total": 8997
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-10T12:06:05.330Z"
      }
    },
    "2026-10-11": {
      "date": "2026-10-11",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 44.32,
      "tripsCount": 27,
      "officialPoints": 30,
      "deliveriesCount": 30,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1011_1",
          "index": 1,
          "completedAt": "06:44",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
          "area": "大阪市西区千代崎2丁目",
          "fee": 320,
          "distanceKm": 0.74,
          "durationStr": "8分46秒",
          "points": 1,
          "memo": "",
          "tripUuid": "99b32ce0-3b67-4810-a5a8-76b5505e346f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "99b32ce0-3b67-4810-a5a8-76b5505e346f",
              "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "pickupAddress": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "dropoffAddress": "27大阪市西区千代崎２丁目",
              "area": "大阪市西区千代崎2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_2",
          "index": 2,
          "completedAt": "06:49",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市大正区三軒家西",
          "fee": 320,
          "distanceKm": 2.75,
          "durationStr": "15分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "47963b80-06d8-4fbb-b91b-c01874ec42f3",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "47963b80-06d8-4fbb-b91b-c01874ec42f3",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市大正区三軒家西",
              "area": "大阪市大正区三軒家西",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_3",
          "index": 3,
          "completedAt": "07:11",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 320,
          "distanceKm": 1.38,
          "durationStr": "9分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "434e2e16-88f1-4b65-9222-098749cf7d6a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "434e2e16-88f1-4b65-9222-098749cf7d6a",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市港区市岡元町１丁目",
              "area": "大阪市港区市岡元町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_4",
          "index": 4,
          "completedAt": "07:36",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 2.03,
          "durationStr": "17分51秒",
          "points": 1,
          "memo": "",
          "tripUuid": "da9cc561-ca17-422a-9748-90443e0d3c8f",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "da9cc561-ca17-422a-9748-90443e0d3c8f",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区九条３丁目",
              "area": "大阪市西区九条3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_5",
          "index": 5,
          "completedAt": "07:47",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区川口4丁目",
          "fee": 320,
          "distanceKm": 2.22,
          "durationStr": "17分22秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0b1e3519-3091-4a53-8365-9b91c87bad46",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0b1e3519-3091-4a53-8365-9b91c87bad46",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_6",
          "index": 6,
          "completedAt": "08:09",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市浪速区桜川4丁目",
          "fee": 320,
          "distanceKm": 2.37,
          "durationStr": "12分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d730a1fc-3eb6-4877-ad51-71349137aeb4",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d730a1fc-3eb6-4877-ad51-71349137aeb4",
              "restaurant": "やよい軒 九条店",
              "pickupAddress": "やよい軒 九条店",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_7",
          "index": 7,
          "completedAt": "08:30",
          "restaurant": "松屋 九条店 Matsuya Kujo",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 0.89,
          "durationStr": "8分45秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e336e4e6-a566-4859-9fc8-8160791aa38c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e336e4e6-a566-4859-9fc8-8160791aa38c",
              "restaurant": "松屋 九条店 Matsuya Kujo",
              "pickupAddress": "松屋 九条店 Matsuya Kujo",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_8",
          "index": 8,
          "completedAt": "08:41",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.5,
          "durationStr": "11分27秒",
          "points": 1,
          "memo": "",
          "tripUuid": "bbbdd031-983e-4bac-a0af-2edc3f416bc6",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "bbbdd031-983e-4bac-a0af-2edc3f416bc6",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_9",
          "index": 9,
          "completedAt": "08:57",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区川口3丁目",
          "fee": 320,
          "distanceKm": 1.48,
          "durationStr": "18分53秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f4fb7452-a55f-449f-b0c2-3e5bf0fab4fb",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f4fb7452-a55f-449f-b0c2-3e5bf0fab4fb",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区川口３丁目",
              "area": "大阪市西区川口3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_10",
          "index": 10,
          "completedAt": "09:30",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区川口4丁目",
          "fee": 320,
          "distanceKm": 1.22,
          "durationStr": "8分10秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a088c0b2-7cb3-41e2-8b02-5349148c923c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a088c0b2-7cb3-41e2-8b02-5349148c923c",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_11",
          "index": 11,
          "completedAt": "09:48",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "12分51秒",
          "points": 1,
          "memo": "",
          "tripUuid": "5b7a06e0-fa86-41f7-9baa-e8b737ba1a86",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5b7a06e0-fa86-41f7-9baa-e8b737ba1a86",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_12",
          "index": 12,
          "completedAt": "10:10",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区千代崎1丁目",
          "fee": 320,
          "distanceKm": 1.03,
          "durationStr": "14分18秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d1c377fe-5812-411d-87d9-d8fd38bd119e",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d1c377fe-5812-411d-87d9-d8fd38bd119e",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区千代崎１丁目",
              "area": "大阪市西区千代崎1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_13",
          "index": 13,
          "completedAt": "10:34",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.26,
          "durationStr": "10分1秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b26c63bd-35ed-4835-9bfc-92c11deed151",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b26c63bd-35ed-4835-9bfc-92c11deed151",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_14",
          "index": 14,
          "completedAt": "10:45",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目/大阪市西区九条南1丁目",
          "fee": 440,
          "distanceKm": 2.27,
          "durationStr": "20分19秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "17652f44-03e0-4eb4-b207-edcb3d16b7f7",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a455283e-0222-4a32-a1f9-9049807b9900",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67542%2C135.47398&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67691%2C135.47798&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkpsrEkwzyXvB%7CBbB%7DDzCYhCiGx%40h%40Uq%40xAPeAp%40cJaL_EoCeGkBy%40dD&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=_ToIY671UtPn4w2v2bODts6gde8="
            },
            {
              "legIndex": 1,
              "legUuid": "9d49e304-2e95-4dc6-a998-41d42c15b8e9",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区九条南１丁目",
              "area": "大阪市西区九条南1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67542%2C135.47398&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67222%2C135.4756&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AkpsrEkwzyXvB%7CBbB%7DDzCYhCiG%7CB%60%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=cOm-QPb0KcT_OKvuVQ4USu5eYhs="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_15",
          "index": 15,
          "completedAt": "11:17",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区川口4丁目/大阪市西区本田2丁目",
          "fee": 380,
          "distanceKm": 1.51,
          "durationStr": "14分51秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "f3bfbd0d-ea95-4832-a64b-ec8b14326425",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a75cdca5-6471-44d9-89bb-9878f296ad2e",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6754%2C135.47475&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67918%2C135.47601&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgpsrEe%7CzyXPjBmAv%40qDeE%7DA%60%40mJcDyAcA%60%40S&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=tppOTOeyVbjjTbWIYRkOZVOLj8g="
            },
            {
              "legIndex": 1,
              "legUuid": "baa31122-96ab-4471-a08b-fef522b7e223",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67537%2C135.47406&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67867%2C135.47984&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_psrE%7BwzyXoAPeD%7DD%7DA%60%40mJcDyAcA%5EQs%40Ry%40gD%7EDuAnB%7BHLoCgB%7D%40HdBIqB&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=YWfDDOO0zKR8iD-kc59XF48kItk="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_16",
          "index": 16,
          "completedAt": "11:55",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "4-chōmeOsakaOsakaKujōminami일본",
          "fee": 320,
          "distanceKm": 1.14,
          "durationStr": "9分34秒",
          "points": 1,
          "memo": "",
          "tripUuid": "8d91b77d-42b4-4e05-aadf-4319b5e4921c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "8d91b77d-42b4-4e05-aadf-4319b5e4921c",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "4-chōme Osaka Osaka Kujōminami 일본",
              "area": "4-chōmeOsakaOsakaKujōminami일본",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_17",
          "index": 17,
          "completedAt": "12:13",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区江之子島2丁目",
          "fee": 328,
          "distanceKm": 1.74,
          "durationStr": "22分29秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a4c2a498-7187-436d-9f55-9e815cf757ef",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a4c2a498-7187-436d-9f55-9e815cf757ef",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区江之子島２丁目",
              "area": "大阪市西区江之子島2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_18",
          "index": 18,
          "completedAt": "13:00",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市港区波除2丁目/大阪市西区九条南2丁目",
          "fee": 447,
          "distanceKm": 2.37,
          "durationStr": "21分10秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d728ee22-33b4-4013-86f5-9038b4e4c3ba",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7b1bb441-d253-4b9e-a125-cc6be604b8ae",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市港区波除２丁目",
              "area": "大阪市港区波除2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67527%2C135.47464&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67027%2C135.4654&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AmosrEo%7BzyXxAmBxOtGvAiCfIpJoAd%40%7CA_AuLrTjApAcAhChEhFjCvJ%5Cm%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Sv-_wHBzGU0U5BPgnC2nYccuArY="
            },
            {
              "legIndex": 1,
              "legUuid": "c3c947fc-72d2-4a22-821f-ebadec894f7f",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区九条南２丁目",
              "area": "大阪市西区九条南2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67527%2C135.47464&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67017%2C135.47269&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AmosrEo%7BzyXxAmBxOtGvAiCfIpJoAd%40x%40o%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=q89-gh1BtUgU6Fi3KJKCOUk8ons="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_19",
          "index": 19,
          "completedAt": "13:33",
          "restaurant": "ウエルシア大阪九条店",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 1.54,
          "durationStr": "11分43秒",
          "points": 1,
          "memo": "",
          "tripUuid": "a06d07db-0c30-4ce5-9d29-6581edab55d8",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "a06d07db-0c30-4ce5-9d29-6581edab55d8",
              "restaurant": "ウエルシア大阪九条店",
              "pickupAddress": "ウエルシア大阪九条店",
              "dropoffAddress": "27大阪市西区九条３丁目",
              "area": "大阪市西区九条3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_20",
          "index": 20,
          "completedAt": "13:48",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田3丁目",
          "fee": 320,
          "distanceKm": 0.55,
          "durationStr": "6分52秒",
          "points": 1,
          "memo": "",
          "tripUuid": "4e43552b-1b52-4bd0-a922-12a9039db111",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "4e43552b-1b52-4bd0-a922-12a9039db111",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田３丁目",
              "area": "大阪市西区本田3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_21",
          "index": 21,
          "completedAt": "13:59",
          "restaurant": "松のや 九条店 Matsunoya Kujo",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "11分4秒",
          "points": 1,
          "memo": "",
          "tripUuid": "33f11b9f-cca0-4b0a-8f9f-2d599b609b28",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "33f11b9f-cca0-4b0a-8f9f-2d599b609b28",
              "restaurant": "松のや 九条店 Matsunoya Kujo",
              "pickupAddress": "松のや 九条店 Matsunoya Kujo",
              "dropoffAddress": "27大阪市港区市岡元町１丁目",
              "area": "大阪市港区市岡元町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_22",
          "index": 22,
          "completedAt": "14:19",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市港区南市岡1丁目",
          "fee": 386,
          "distanceKm": 2.96,
          "durationStr": "22分50秒",
          "points": 1,
          "memo": "",
          "tripUuid": "11d732d1-c6db-40a5-b63d-8c1b2e81434a",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "11d732d1-c6db-40a5-b63d-8c1b2e81434a",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市港区南市岡１丁目",
              "area": "大阪市港区南市岡1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_23",
          "index": 23,
          "completedAt": "14:53",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条南4丁目",
          "fee": 320,
          "distanceKm": 0.9,
          "durationStr": "9分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "046d2491-13c0-410b-9451-c85c4fd9ed12",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "046d2491-13c0-410b-9451-c85c4fd9ed12",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条南４丁目",
              "area": "大阪市西区九条南4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_24",
          "index": 24,
          "completedAt": "15:24",
          "restaurant": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
          "area": "大阪市西区本田2丁目",
          "fee": 349,
          "distanceKm": 2.4,
          "durationStr": "16分22秒",
          "points": 1,
          "memo": "",
          "tripUuid": "7ac49464-4d6c-443b-b04b-12268d725045",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7ac49464-4d6c-443b-b04b-12268d725045",
              "restaurant": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
              "pickupAddress": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_25",
          "index": 25,
          "completedAt": "15:44",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市大正区三軒家東4丁目",
          "fee": 385,
          "distanceKm": 2.27,
          "durationStr": "15分50秒",
          "points": 1,
          "memo": "",
          "tripUuid": "2f044cd5-dd52-4dfe-80c8-259d50a80156",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2f044cd5-dd52-4dfe-80c8-259d50a80156",
              "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "pickupAddress": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "dropoffAddress": "27大阪市大正区三軒家東４丁目",
              "area": "大阪市大正区三軒家東4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_26",
          "index": 26,
          "completedAt": "16:01",
          "restaurant": "バーミヤン 大正千島店 Bamiyan Taisho Chishima",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 397,
          "distanceKm": 2.75,
          "durationStr": "19分49秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0d3a9209-53f8-480d-bab6-b66eaa29dc63",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0d3a9209-53f8-480d-bab6-b66eaa29dc63",
              "restaurant": "バーミヤン 大正千島店 Bamiyan Taisho Chishima",
              "pickupAddress": "バーミヤン 大正千島店 Bamiyan Taisho Chishima",
              "dropoffAddress": "27大阪市大正区泉尾１丁目",
              "area": "大阪市大正区泉尾1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1011_27",
          "index": 27,
          "completedAt": "16:38",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 0.63,
          "durationStr": "11分36秒",
          "points": 1,
          "memo": "",
          "tripUuid": "349ca8df-4914-4d70-aff5-1cc8fe5a4d3d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "349ca8df-4914-4d70-aff5-1cc8fe5a4d3d",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1011_1",
          "time": "12:06",
          "title": "クエスト",
          "amount": 1000,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "achievedAt": "12:05",
          "note": "公式一覧は 12:05「6 回乗車クエスト ¥1,000」（達成表示）と 12:06「クエスト ¥1,000」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1011_2",
          "time": "13:22",
          "title": "クエスト",
          "amount": 700,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "13:15",
          "note": "公式一覧は 13:15「3 回乗車クエスト ¥700」（達成表示）と 13:22「クエスト ¥700」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1011_3",
          "time": "14:14",
          "title": "クエスト",
          "amount": 700,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥700」「3 回乗車クエスト ¥700」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1011_4",
          "time": "16:50",
          "title": "クエスト",
          "amount": 8840,
          "isDuplicateIgnored": false,
          "questName": "70回乗車クエスト",
          "questType": "special",
          "note": "公式一覧は「クエスト ¥8,840」「70 回乗車クエスト ¥8,840」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1011_5",
          "time": "16:50",
          "title": "クエスト",
          "amount": 500,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥500」「3 回乗車クエスト ¥500」の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        }
      ],
      "sales": {
        "delivery": 9192,
        "quest": 11740,
        "adjustment": 0,
        "other": 0,
        "total": 20932
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-11T08:58:48.144Z"
      }
    },
    "2026-10-12": {
      "date": "2026-10-12",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 47.77,
      "tripsCount": 21,
      "officialPoints": 24,
      "deliveriesCount": 24,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1012_1",
          "index": 1,
          "completedAt": "07:13",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区千代崎2丁目",
          "fee": 320,
          "distanceKm": 1.24,
          "durationStr": "9分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b2d6f025-3f7e-4502-8dde-e648416229b5",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b2d6f025-3f7e-4502-8dde-e648416229b5",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区千代崎２丁目",
              "area": "大阪市西区千代崎2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_2",
          "index": 2,
          "completedAt": "07:25",
          "restaurant": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
          "area": "大阪市港区南市岡2丁目",
          "fee": 367,
          "distanceKm": 2.59,
          "durationStr": "15分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b56f8c67-e0b3-484c-836a-40e84c09e74d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b56f8c67-e0b3-484c-836a-40e84c09e74d",
              "restaurant": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
              "pickupAddress": "マクドナルド 弁天町駅前店 McDonald's BENTENCHO EKIMAE",
              "dropoffAddress": "27大阪市港区南市岡２丁目",
              "area": "大阪市港区南市岡2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_3",
          "index": 3,
          "completedAt": "07:45",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "3-chōmeOsakaOsakaKujō",
          "fee": 320,
          "distanceKm": 2.06,
          "durationStr": "11分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "c5eb00af-06b2-48a2-8c97-5865b44cf0ec",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "c5eb00af-06b2-48a2-8c97-5865b44cf0ec",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "3-chōme Osaka Osaka Kujō 日本",
              "area": "3-chōmeOsakaOsakaKujō",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_4",
          "index": 4,
          "completedAt": "08:10",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区千代崎2丁目/大阪市港区南市岡1丁目",
          "fee": 508,
          "distanceKm": 2.35,
          "durationStr": "18分44秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "ab3c0243-9057-49b8-b502-0ec11da9668e",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6e88af25-130c-4912-8144-411d2612e4e4",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区千代崎２丁目",
              "area": "大阪市西区千代崎2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67551%2C135.47427&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67342%2C135.47699&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A%7DpsrEcyzyX%7CDgQ%7E%40i%40dDtCf%40Wg%40m%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=QD_T_V_xn2NojmQjl2-ODa4sutY="
            },
            {
              "legIndex": 1,
              "legUuid": "bd169cf6-a675-4101-ad48-813bdab698fb",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市港区南市岡１丁目",
              "area": "大阪市港区南市岡1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68%2C135.47&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67%2C135.47&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mtrEo%7EyyX%3Fm%7D%40n%7D%40%3F%3Fl%7D%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=ukGexbL9JblkO129cb1B33Xjvv4="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_5",
          "index": 5,
          "completedAt": "08:44",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市港区市岡元町1丁目",
          "fee": 320,
          "distanceKm": 1.4,
          "durationStr": "10分40秒",
          "points": 1,
          "memo": "",
          "tripUuid": "735602fa-5b78-4c56-a6cc-aa99b6e1f442",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "735602fa-5b78-4c56-a6cc-aa99b6e1f442",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市港区市岡元町１丁目",
              "area": "大阪市港区市岡元町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_6",
          "index": 6,
          "completedAt": "09:01",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区川口4丁目/大阪市西区本田1丁目",
          "fee": 515,
          "distanceKm": 1.83,
          "durationStr": "18分6秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "e608848a-7e58-4354-b334-030d51079386",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5b75565e-96c2-47f4-8022-c58b8c13f4a2",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区川口４丁目",
              "area": "大阪市西区川口4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67537%2C135.47404&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67975%2C135.47363&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_psrEwwzyXs%40v%40iAYuN_RuC%60QcBpA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=K3KZONuoUNG8DFMTdz--eonwfqA="
            },
            {
              "legIndex": 1,
              "legUuid": "85de54fd-9591-4c8b-ba1d-5386bb58d850",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67537%2C135.47404&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67906%2C135.48003&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_psrEwwzyXs%40v%40iAYuN_RuC%60Q_BjAjIwa%40QeAkC%7BAf%40_EBfBsAvA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=YA1LtGxm579FX56elHEbHevD3ak="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_7",
          "index": 7,
          "completedAt": "09:21",
          "restaurant": "ローソン 大阪ドームシティ",
          "area": "大阪市浪速区幸町3丁目",
          "fee": 320,
          "distanceKm": 1.72,
          "durationStr": "9分58秒",
          "points": 1,
          "memo": "",
          "tripUuid": "698fe477-a77e-4e1f-8abd-089f6dbbe696",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "698fe477-a77e-4e1f-8abd-089f6dbbe696",
              "restaurant": "ローソン 大阪ドームシティ",
              "pickupAddress": "ローソン 大阪ドームシティ",
              "dropoffAddress": "27大阪市浪速区幸町３丁目",
              "area": "大阪市浪速区幸町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_8",
          "index": 8,
          "completedAt": "09:30",
          "restaurant": "松のや 桜川店 Matsunoya Sakuragawa",
          "area": "大阪市西区新町1丁目",
          "fee": 331,
          "distanceKm": 2.69,
          "durationStr": "19分36秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b3c9cd59-6d2f-4f91-a533-92b377304316",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b3c9cd59-6d2f-4f91-a533-92b377304316",
              "restaurant": "松のや 桜川店 Matsunoya Sakuragawa",
              "pickupAddress": "松のや 桜川店 Matsunoya Sakuragawa",
              "dropoffAddress": "27大阪市西区新町１丁目",
              "area": "大阪市西区新町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_9",
          "index": 9,
          "completedAt": "09:42",
          "restaurant": "ローソンストア100 西区新町店",
          "area": "大阪市西区南堀江3丁目/大阪市浪速区幸町3丁目",
          "fee": 587,
          "distanceKm": 3.4,
          "durationStr": "25分39秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "c39ffb08-6f82-4ec3-b1e5-e0982b4e7956",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "68d88a3d-9ec4-4697-a6a2-f66bd42a830d",
              "restaurant": "",
              "pickupAddress": "27大阪市西区新町２丁目",
              "dropoffAddress": "27大阪市西区南堀江３丁目",
              "area": "大阪市西区南堀江3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67706%2C135.49304&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67236%2C135.48784&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AszsrEon%7EyXXsAg%40_Cy%40%5BSkI%7D%40CWiEr%40aAb%40%5C%3FgJxH%3FBbCnBj%40Q%7EC%60Bf%40c%40rSbNhBb%40zAjBp%40a%40r%5C_AJZ%5D&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=t1M7UYLnU_G2E8k8WG2n37wTm98="
            },
            {
              "legIndex": 1,
              "legUuid": "f4afedad-4cb9-430b-a6a2-86bcee36c157",
              "restaurant": "",
              "pickupAddress": "27大阪市西区新町１丁目",
              "dropoffAddress": "27大阪市浪速区幸町３丁目",
              "area": "大阪市浪速区幸町3丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67765%2C135.49721&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66862%2C135.48517&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3Ai%7EsrEqh_zXZR%3FgJxH%3FBbCnBj%40Q%7EC%60Bf%40c%40rSbNhBb%40zAjBp%40a%40r%5C_AJLm%40%60A%60ACjBfNn%40VnAfADf%40dFx%40QnBvDc%40iCy%40O&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=st9Pue5yHmsEfpjGEANVi_ZbCKk="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_10",
          "index": 10,
          "completedAt": "10:15",
          "restaurant": "マクドナルド 南堀江関西スーパー店 McDonald's MINAMI-HORIE KANSAI S.M.",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 320,
          "distanceKm": 2.12,
          "durationStr": "14分44秒",
          "points": 1,
          "memo": "",
          "tripUuid": "7f78ee18-6663-478d-ac92-3da45b82d6fc",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "7f78ee18-6663-478d-ac92-3da45b82d6fc",
              "restaurant": "マクドナルド 南堀江関西スーパー店 McDonald's MINAMI-HORIE KANSAI S.M.",
              "pickupAddress": "マクドナルド 南堀江関西スーパー店 McDonald's MINAMI-HORIE KANSAI S.M.",
              "dropoffAddress": "27大阪市大正区三軒家東１丁目",
              "area": "大阪市大正区三軒家東1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_11",
          "index": 11,
          "completedAt": "10:22",
          "restaurant": "【出汁の親子丼】鶏ヶ屋(TORIGAYA)～大正店～",
          "area": "大阪市西区新町4丁目",
          "fee": 370,
          "distanceKm": 2.29,
          "durationStr": "19分3秒",
          "points": 1,
          "memo": "",
          "tripUuid": "cc97e3e5-d320-4814-adc7-bb604aba4f55",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "cc97e3e5-d320-4814-adc7-bb604aba4f55",
              "restaurant": "【出汁の親子丼】鶏ヶ屋(TORIGAYA)～大正店～",
              "pickupAddress": "【出汁の親子丼】鶏ヶ屋(TORIGAYA)～大正店～",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_12",
          "index": 12,
          "completedAt": "10:48",
          "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
          "area": "大阪市西区新町1丁目",
          "fee": 389,
          "distanceKm": 1.87,
          "durationStr": "17分9秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f7ff7f06-a12b-4744-9dbe-190d0a8d0328",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f7ff7f06-a12b-4744-9dbe-190d0a8d0328",
              "restaurant": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "pickupAddress": "バーガーキングフレスポ阿波座店 Burger King Frespo Awaza",
              "dropoffAddress": "27大阪市西区新町１丁目",
              "area": "大阪市西区新町1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_13",
          "index": 13,
          "completedAt": "11:07",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市大正区泉尾7丁目",
          "fee": 494,
          "distanceKm": 3.96,
          "durationStr": "20分18秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b63fcf86-fd1a-461a-9b37-fdd956de3bcc",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b63fcf86-fd1a-461a-9b37-fdd956de3bcc",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "27大阪市大正区泉尾７丁目",
              "area": "大阪市大正区泉尾7丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_14",
          "index": 14,
          "completedAt": "11:33",
          "restaurant": "マクドナルド 大　正　店 McDonald's TAISHO",
          "area": "大阪市大正区千島2丁目",
          "fee": 320,
          "distanceKm": 1.69,
          "durationStr": "18分2秒",
          "points": 1,
          "memo": "",
          "tripUuid": "665badb1-a2dd-44c1-8f0c-c3c50ca3b63b",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "665badb1-a2dd-44c1-8f0c-c3c50ca3b63b",
              "restaurant": "マクドナルド 大　正　店 McDonald's TAISHO",
              "pickupAddress": "マクドナルド 大　正　店 McDonald's TAISHO",
              "dropoffAddress": "27大阪市大正区千島２丁目",
              "area": "大阪市大正区千島2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_15",
          "index": 15,
          "completedAt": "11:56",
          "restaurant": "マクドナルド 大　正　店 McDonald's TAISHO",
          "area": "大阪市大正区三軒家東4丁目",
          "fee": 320,
          "distanceKm": 1.67,
          "durationStr": "13分56秒",
          "points": 1,
          "memo": "",
          "tripUuid": "48ec0303-9de2-4d46-b096-fb96d132946c",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "48ec0303-9de2-4d46-b096-fb96d132946c",
              "restaurant": "マクドナルド 大　正　店 McDonald's TAISHO",
              "pickupAddress": "マクドナルド 大　正　店 McDonald's TAISHO",
              "dropoffAddress": "27大阪市大正区三軒家東４丁目",
              "area": "大阪市大正区三軒家東4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_16",
          "index": 16,
          "completedAt": "13:06",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区泉尾1丁目",
          "fee": 351,
          "distanceKm": 2.14,
          "durationStr": "17分33秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b14ed330-da41-4bab-9b60-086d6970affe",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b14ed330-da41-4bab-9b60-086d6970affe",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区泉尾１丁目",
              "area": "大阪市大正区泉尾1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_17",
          "index": 17,
          "completedAt": "13:27",
          "restaurant": "ドリアとパスタとピザ　カルボリア",
          "area": "大阪市西区新町4丁目",
          "fee": 320,
          "distanceKm": 2.43,
          "durationStr": "16分26秒",
          "points": 1,
          "memo": "",
          "tripUuid": "9a471e3a-33b1-45f9-ad8d-d7b3f4107770",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "9a471e3a-33b1-45f9-ad8d-d7b3f4107770",
              "restaurant": "ドリアとパスタとピザ　カルボリア",
              "pickupAddress": "ドリアとパスタとピザ　カルボリア",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_18",
          "index": 18,
          "completedAt": "16:10",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市浪速区桜川2丁目",
          "fee": 352,
          "distanceKm": 3.54,
          "durationStr": "28分17秒",
          "points": 1,
          "memo": "",
          "tripUuid": "2b0d873d-2d26-46d2-8cba-90a530ae57e8",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2b0d873d-2d26-46d2-8cba-90a530ae57e8",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市浪速区桜川２丁目",
              "area": "大阪市浪速区桜川2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_19",
          "index": 19,
          "completedAt": "16:47",
          "restaurant": "ウエルシア大阪九条店",
          "area": "大阪市大正区千島1丁目",
          "fee": 475,
          "distanceKm": 3.81,
          "durationStr": "19分6秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e7fd60ec-8a1d-40fe-9889-1d63814a31b5",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e7fd60ec-8a1d-40fe-9889-1d63814a31b5",
              "restaurant": "ウエルシア大阪九条店",
              "pickupAddress": "ウエルシア大阪九条店",
              "dropoffAddress": "27大阪市大正区千島１丁目",
              "area": "大阪市大正区千島1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_20",
          "index": 20,
          "completedAt": "17:27",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 0.64,
          "durationStr": "12分47秒",
          "points": 1,
          "memo": "",
          "tripUuid": "2e0a1d44-bdf2-4fcf-be0d-555f06bacbcf",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "2e0a1d44-bdf2-4fcf-be0d-555f06bacbcf",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1012_21",
          "index": 21,
          "completedAt": "17:37",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区南堀江3丁目",
          "fee": 320,
          "distanceKm": 2.33,
          "durationStr": "19分50秒",
          "points": 1,
          "memo": "",
          "tripUuid": "c172624b-a575-4b0a-bf69-78197dadafa0",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "c172624b-a575-4b0a-bf69-78197dadafa0",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市西区南堀江３丁目",
              "area": "大阪市西区南堀江3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1012_1",
          "time": "13:24",
          "title": "クエスト",
          "amount": 600,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥600」「6 回乗車クエスト ¥600」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        },
        {
          "id": "quest_1012_2",
          "time": "17:40",
          "title": "クエスト",
          "amount": 260,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "17:39",
          "note": "公式一覧は 17:39「3 回乗車クエスト ¥260」（達成表示）と 17:40「クエスト ¥260」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算。21:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 7939,
        "quest": 860,
        "adjustment": 0,
        "other": 0,
        "total": 8799
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-13T22:35:13.248Z"
      }
    },
    "2026-10-14": {
      "date": "2026-10-14",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 22.48,
      "tripsCount": 11,
      "officialPoints": 14,
      "deliveriesCount": 14,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1014_1",
          "index": 1,
          "completedAt": "08:53",
          "restaurant": "マクドナルド 阪神西九条駅前店 McDonald's HANSHIN NISHIKUJO EKI-MAE",
          "area": "大阪市此花区梅香1丁目/大阪市此花区西九条2丁目",
          "fee": 522,
          "distanceKm": 3.25,
          "durationStr": "21分53秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "5b078f16-ed47-4446-8f28-82778e4f1f1f",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "64691540-6824-434b-8c51-99a84a47d208",
              "restaurant": "",
              "pickupAddress": "27大阪市此花区西九条１丁目",
              "dropoffAddress": "27大阪市此花区梅香１丁目",
              "area": "大阪市此花区梅香1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68185%2C135.46609&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68289%2C135.46097&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AoxtrEafyyXn%40CjC%60DrEJaBG%5B%7D%40uBVeB_B%7DH%60EsDtJu%40dGhErAb%40hBp%40W&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=OrNKOJF0xokJioZPGPBwcQUH73g="
            },
            {
              "legIndex": 1,
              "legUuid": "72614710-8b4f-49b0-83bd-1ac5badd1492",
              "restaurant": "",
              "pickupAddress": "27大阪市此花区西九条１丁目",
              "dropoffAddress": "27大阪市此花区西九条２丁目",
              "area": "大阪市此花区西九条2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68185%2C135.46609&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.68065%2C135.46555&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AoxtrEafyyXn%40CjC%60DrEJaD%7D%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Ps4iMd0ObUxyQq8786Cev1uVbYQ="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_2",
          "index": 2,
          "completedAt": "09:58",
          "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
          "area": "大阪市西区新町4丁目",
          "fee": 320,
          "distanceKm": 1.74,
          "durationStr": "11分1秒",
          "points": 1,
          "memo": "",
          "tripUuid": "061b1cc9-3286-4971-8158-ff9ebf401ecd",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "061b1cc9-3286-4971-8158-ff9ebf401ecd",
              "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "pickupAddress": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "dropoffAddress": "27大阪市西区新町４丁目",
              "area": "大阪市西区新町4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_3",
          "index": 3,
          "completedAt": "10:06",
          "restaurant": "ウエルシア大阪新町店",
          "area": "大阪市大正区三軒家東2丁目",
          "fee": 320,
          "distanceKm": 2.37,
          "durationStr": "18分30秒",
          "points": 1,
          "memo": "",
          "tripUuid": "5fa6dbdd-fe2a-45f3-9ddb-07070f5e38a6",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5fa6dbdd-fe2a-45f3-9ddb-07070f5e38a6",
              "restaurant": "ウエルシア大阪新町店",
              "pickupAddress": "ウエルシア大阪新町店",
              "dropoffAddress": "27大阪市大正区三軒家東２丁目",
              "area": "大阪市大正区三軒家東2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_4",
          "index": 4,
          "completedAt": "10:30",
          "restaurant": "金のとりから/待茶 イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家西1丁目/大阪市浪速区桜川4丁目",
          "fee": 599,
          "distanceKm": 2.95,
          "durationStr": "27分15秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "d82f66c2-7eae-4691-844b-efbb7c592225",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "5cffcd8d-0a40-4494-aec1-406aed72549b",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市大正区三軒家西１丁目",
              "area": "大阪市大正区三軒家西1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66986%2C135.4785&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.6655%2C135.47781&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AqmrrEss%7ByXDr%40m%40_CbB_BvIgAtAgAoAkStEoA%5ETyA%40_%40tBTzEmBtAvAxHpNxHoAh%40qAm%40PjAiB%7E%40vAY&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=h9vLb8FISt5iH57ZNl8x-zDrK10="
            },
            {
              "legIndex": 1,
              "legUuid": "9894d9eb-0418-4f7c-aa21-08602f89f88e",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市浪速区桜川４丁目",
              "area": "大阪市浪速区桜川4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67002%2C135.4785&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66661%2C135.48369&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AsnrrEss%7ByXEkAbB_BvIgAtAgAoAkSlFeA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=SkyIVn5cgMbGZdq6D3x9QFeaWaw="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_5",
          "index": 5,
          "completedAt": "11:00",
          "restaurant": "ローソン 大阪ドームシティ",
          "area": "大阪市西区南堀江4丁目",
          "fee": 320,
          "distanceKm": 1.51,
          "durationStr": "9分36秒",
          "points": 1,
          "memo": "",
          "tripUuid": "63bec805-f94c-480f-96ff-344ce3be40b6",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "63bec805-f94c-480f-96ff-344ce3be40b6",
              "restaurant": "ローソン 大阪ドームシティ",
              "pickupAddress": "ローソン 大阪ドームシティ",
              "dropoffAddress": "27大阪市西区南堀江４丁目",
              "area": "大阪市西区南堀江4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_6",
          "index": 6,
          "completedAt": "11:26",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区九条3丁目",
          "fee": 320,
          "distanceKm": 0.87,
          "durationStr": "13分57秒",
          "points": 1,
          "memo": "",
          "tripUuid": "36298346-2f64-49b0-93f8-f92487424f31",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "36298346-2f64-49b0-93f8-f92487424f31",
              "restaurant": "マクドナルド 九条店",
              "pickupAddress": "マクドナルド 九条店",
              "dropoffAddress": "27大阪市西区九条３丁目",
              "area": "大阪市西区九条3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_7",
          "index": 7,
          "completedAt": "12:06",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区本田3丁目",
          "fee": 328,
          "distanceKm": 2.2,
          "durationStr": "14分59秒",
          "points": 1,
          "memo": "",
          "tripUuid": "55cc540d-cd28-4445-8483-a434be7d99b5",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "55cc540d-cd28-4445-8483-a434be7d99b5",
              "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "pickupAddress": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市西区本田３丁目",
              "area": "大阪市西区本田3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_8",
          "index": 8,
          "completedAt": "13:37",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 1.82,
          "durationStr": "13分22秒",
          "points": 1,
          "memo": "",
          "tripUuid": "3ec055e1-4305-4fbd-8d80-2e73cbdccd95",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "3ec055e1-4305-4fbd-8d80-2e73cbdccd95",
              "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "pickupAddress": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_9",
          "index": 9,
          "completedAt": "14:13",
          "restaurant": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
          "area": "2-chōme27OsakaKujōminami",
          "fee": 320,
          "distanceKm": 1.26,
          "durationStr": "12分52秒",
          "points": 1,
          "memo": "",
          "tripUuid": "72e1fa69-1e83-4349-b46a-12e8594e7665",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "72e1fa69-1e83-4349-b46a-12e8594e7665",
              "restaurant": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
              "pickupAddress": "スシロー 辰巳橋店 Sushiro TATSUMIBASHI",
              "dropoffAddress": "2-chōme 27 Osaka Kujōminami Japan",
              "area": "2-chōme27OsakaKujōminami",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_10",
          "index": 10,
          "completedAt": "14:36",
          "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
          "area": "大阪市浪速区桜川",
          "fee": 320,
          "distanceKm": 2.16,
          "durationStr": "13分58秒",
          "points": 1,
          "memo": "",
          "tripUuid": "6bf0fa42-1c79-4995-a034-de17da5d11b3",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "6bf0fa42-1c79-4995-a034-de17da5d11b3",
              "restaurant": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "pickupAddress": "スターバックス コーヒー イオンモール大阪ドームシティ店 Starbucks Coffee AEON MALL Osaka Dome City",
              "dropoffAddress": "27大阪市浪速区桜川",
              "area": "大阪市浪速区桜川",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1014_11",
          "index": 11,
          "completedAt": "15:24",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市西区千代崎2丁目/大阪市西区南堀江4丁目",
          "fee": 522,
          "distanceKm": 2.35,
          "durationStr": "27分32秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "233dd45b-12ae-4e23-9877-c224d4ccb4ba",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b928f9a0-faee-49b6-9815-62feaecd08e2",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区千代崎２丁目",
              "area": "大阪市西区千代崎2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66989%2C135.47823&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67372%2C135.4789&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AymrrE%7Dq%7ByXk%40r%40jAqA_%40kCaJcBqArGcDDeFoC%7E%40A&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=no19CguIECGp62MWW3ub1p27tgo="
            },
            {
              "legIndex": 1,
              "legUuid": "aad56dcd-fc68-475c-b766-7b53c8302b50",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区南堀江４丁目",
              "area": "大阪市西区南堀江4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66977%2C135.47844&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67261%2C135.4829&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mrrEgs%7ByXY_CaJcBqArGcDDwEwBj%40Uo%40FzCaOjCTXiHm%40U&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=T-5Wz_q-cLALRxot6zSF5YkSU0E="
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1014_1",
          "time": "13:51",
          "title": "クエスト",
          "amount": 420,
          "isDuplicateIgnored": false,
          "questName": "6回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥420」「6 回乗車クエスト ¥420」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。14:30の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 4211,
        "quest": 420,
        "adjustment": 0,
        "other": 0,
        "total": 4631
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-14T10:14:22.860Z"
      }
    },
    "2026-10-16": {
      "date": "2026-10-16",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": 34.2,
      "tripsCount": 17,
      "officialPoints": 22,
      "deliveriesCount": 22,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_1016_1",
          "index": 1,
          "completedAt": "08:52",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "2-chōme27OsakaSangenyanishi/1-chōmeOsakaOsakaKujōminami",
          "fee": 458,
          "distanceKm": 2.49,
          "durationStr": "21分12秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "cfd03e9c-1b49-4ec7-843c-1a50e5e3dfa5",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0c5283b8-b349-44c9-bc18-eecdb8f36eb8",
              "restaurant": "",
              "pickupAddress": "2-chōme 27 Osaka Kujō Japan",
              "dropoffAddress": "2-chōme 27 Osaka Sangenyanishi Japan",
              "area": "2-chōme27OsakaSangenyanishi",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67545%2C135.47401&markers=%7Canchor%3Aleft%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66535%2C135.47534&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AqpsrEqwzyXPq%40dCrD%7EK%7ED%7EFiPiAWd%40x%40Hw%40UjAx%40tAjIvH%7CIuKhEcJf%40%60FpGa%40ItA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=zVZOE8wMbE1nJCmBVY-o2UG9MSs="
            },
            {
              "legIndex": 1,
              "legUuid": "5df78455-2341-4a1c-983e-e36de60d924b",
              "restaurant": "",
              "pickupAddress": "2-chōme Osaka Osaka Kujō 日本",
              "dropoffAddress": "1-chōme Osaka Osaka Kujōminami 日本",
              "area": "1-chōmeOsakaOsakaKujōminami",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67545%2C135.47401&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67151%2C135.475&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AqpsrEqwzyXPq%40dCrD%7EK%7ED%7EFiPiAWd%40x%40&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=LNO7s0gTSOIixfkPCbPp5H4Hzew="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_2",
          "index": 2,
          "completedAt": "09:21",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市大正区三軒家西2丁目",
          "fee": 320,
          "distanceKm": 1.98,
          "durationStr": "13分20秒",
          "points": 1,
          "memo": "",
          "tripUuid": "e486d67e-6953-44c8-a700-c3c79ac777e7",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "e486d67e-6953-44c8-a700-c3c79ac777e7",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市大正区三軒家西２丁目",
              "area": "大阪市大正区三軒家西2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_3",
          "index": 3,
          "completedAt": "09:50",
          "restaurant": "マクドナルド 九条店",
          "area": "大阪市西区千代崎1丁目/大阪市西区千代崎1丁目",
          "fee": 420,
          "distanceKm": 1.19,
          "durationStr": "18分43秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "8698c521-f68f-43e2-bb96-85c2e6580c31",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "15e7a168-c869-48c0-bda5-faf1192d7c82",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条２丁目",
              "dropoffAddress": "27大阪市西区千代崎１丁目",
              "area": "大阪市西区千代崎1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.68%2C135.47&markers=%7Canchor%3Aright%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67%2C135.48&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mtrEo%7EyyX%3Fm%7D%40n%7D%40%3F&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Tc1vIVh3ZZuDF6hLnQfxHWJ2Eo4="
            },
            {
              "legIndex": 1,
              "legUuid": "d29cf04f-6c34-480a-b994-514a7062f5cc",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区千代崎１丁目",
              "area": "大阪市西区千代崎1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6754%2C135.47414&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67363%2C135.48061&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AgpsrEkxzyXhJud%40c%40aAVdCe%40aAh%40yA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=Ul6Xrqu6yLWOIingKhyEtInw5KE="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_4",
          "index": 4,
          "completedAt": "10:17",
          "restaurant": "バーガーキング 九条店 Burger King Kujo",
          "area": "大阪市西区九条1丁目",
          "fee": 320,
          "distanceKm": 0.5,
          "durationStr": "6分26秒",
          "points": 1,
          "memo": "",
          "tripUuid": "f5c5b6ad-39fb-4346-a749-46e49e055c55",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "f5c5b6ad-39fb-4346-a749-46e49e055c55",
              "restaurant": "バーガーキング 九条店 Burger King Kujo",
              "pickupAddress": "バーガーキング 九条店 Burger King Kujo",
              "dropoffAddress": "27大阪市西区九条１丁目",
              "area": "大阪市西区九条1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_5",
          "index": 5,
          "completedAt": "10:40",
          "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
          "area": "大阪市西区西区南堀江4丁目",
          "fee": 320,
          "distanceKm": 1.4,
          "durationStr": "9分58秒",
          "points": 1,
          "memo": "",
          "tripUuid": "b47fb2fa-ffb0-45d0-a4b8-ad9e0ed78673",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "b47fb2fa-ffb0-45d0-a4b8-ad9e0ed78673",
              "restaurant": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "pickupAddress": "【伝説のクロックムッシュ】サンドイッチ九条店 Sandwich kujyo～お持帰り専門店～",
              "dropoffAddress": "27大阪市西区西区南堀江４丁目",
              "area": "大阪市西区西区南堀江4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_6",
          "index": 6,
          "completedAt": "10:57",
          "restaurant": "マクドナルドイオンモール大阪ドームシティ店 McDonald's AEON MALL OSAKA DOME CITY",
          "area": "大阪市大正区三軒家東4丁目/大阪市大正区三軒家西1丁目",
          "fee": 484,
          "distanceKm": 2.77,
          "durationStr": "26分20秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "a60c2691-4f39-4f54-b38c-71bb037bcb5e",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "25fa2d97-a04a-44e0-a095-3f84d5855bba",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市大正区三軒家東４丁目",
              "area": "大阪市大正区三軒家東4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66977%2C135.47847&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66097%2C135.47614&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mrrEks%7ByXp%40u%40g%40_AfMmAVfHg%40_Hx%40Up%5CxR%7CAe%40%7CEzB%60%40gAm%40Z&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=n8zp9rFQ2qCyDJPYwzJbxQ7XzVE="
            },
            {
              "legIndex": 1,
              "legUuid": "b6f79e26-fdf2-4e02-9268-caefd0d9a9b1",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市大正区三軒家西１丁目",
              "area": "大阪市大正区三軒家西1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66977%2C135.47847&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.66731%2C135.478&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3A_mrrEks%7ByXp%40u%40g%40_AfMmAV%7EG&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=6HAP4exaFiFjOUYXc73MToY9KV4="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_7",
          "index": 7,
          "completedAt": "11:31",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市大正区三軒家西3丁目",
          "fee": 334,
          "distanceKm": 2.77,
          "durationStr": "17分55秒",
          "points": 1,
          "memo": "",
          "tripUuid": "fee067f8-93ce-493a-8ab5-5875d09c778d",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "fee067f8-93ce-493a-8ab5-5875d09c778d",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市大正区三軒家西３丁目",
              "area": "大阪市大正区三軒家西3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_8",
          "index": 8,
          "completedAt": "11:46",
          "restaurant": "ケンタッキーフライドチキン イオンモール大阪ドームシティ店",
          "area": "大阪市西区本田4丁目/大阪市西区九条2丁目",
          "fee": 456,
          "distanceKm": 2.82,
          "durationStr": "22分43秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "9116c3ab-7440-4dbd-961a-ded89f7fe8f4",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "c5308712-2aba-4602-aa42-0b27e2cf2de0",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市西区本田４丁目",
              "area": "大阪市西区本田4丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67017%2C135.478&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.6792%2C135.4714&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AoorrEop%7ByXtAkAq%40_CmEvBcAdEqCUcDzGyEqEuB%60KwAQaBbHcB%5ELrEI%7DDb%40g%40eCyBsDjCwErMaCcAg%40lAv%40L_%40%5B&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=ntMHYcDCKY3vcxFjDh2bdgGqQ4Y="
            },
            {
              "legIndex": 1,
              "legUuid": "b5ffffd7-e788-4cad-9ccd-999a14c8cc69",
              "restaurant": "",
              "pickupAddress": "27大阪市西区九条１丁目",
              "dropoffAddress": "27大阪市西区九条２丁目",
              "area": "大阪市西区九条2丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.67524%2C135.4749&markers=%7Canchor%3Atop%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.67595%2C135.47351&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AeosrEc%7DzyXw%40lEcB%5ET%7CBGuA&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=rZcjKD8g8PxCWY8aIcJUC-_tO7Y="
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_9",
          "index": 9,
          "completedAt": "12:43",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田2丁目",
          "fee": 320,
          "distanceKm": 1.03,
          "durationStr": "9分22秒",
          "points": 1,
          "memo": "",
          "tripUuid": "0e9a5758-6c70-4a8e-a4b3-1123249f6ac9",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "0e9a5758-6c70-4a8e-a4b3-1123249f6ac9",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田２丁目",
              "area": "大阪市西区本田2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_10",
          "index": 10,
          "completedAt": "13:07",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区新町3丁目",
          "fee": 320,
          "distanceKm": 1.98,
          "durationStr": "12分38秒",
          "points": 1,
          "memo": "",
          "tripUuid": "67382d7a-108d-4f24-a113-d77e9b5919bf",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "67382d7a-108d-4f24-a113-d77e9b5919bf",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市西区新町３丁目",
              "area": "大阪市西区新町3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_11",
          "index": 11,
          "completedAt": "13:13",
          "restaurant": "キッチンオリジン 阿波座",
          "area": "大阪市西区靱本町2丁目",
          "fee": 320,
          "distanceKm": 2.24,
          "durationStr": "20分20秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d8a481bc-a003-4674-a470-a4f3399fa3e2",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d8a481bc-a003-4674-a470-a4f3399fa3e2",
              "restaurant": "キッチンオリジン 阿波座",
              "pickupAddress": "キッチンオリジン 阿波座",
              "dropoffAddress": "27大阪市西区靱本町２丁目",
              "area": "大阪市西区靱本町2丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_12",
          "index": 12,
          "completedAt": "17:29",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家東1丁目",
          "fee": 322,
          "distanceKm": 2.67,
          "durationStr": "19分21秒",
          "points": 1,
          "memo": "",
          "tripUuid": "3a196ca8-bcb6-44a3-b668-9ba6aa3020f7",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "3a196ca8-bcb6-44a3-b668-9ba6aa3020f7",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区三軒家東１丁目",
              "area": "大阪市大正区三軒家東1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_13",
          "index": 13,
          "completedAt": "17:58",
          "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
          "area": "大阪市大正区三軒家東4丁目",
          "fee": 323,
          "distanceKm": 1.98,
          "durationStr": "19分1秒",
          "points": 1,
          "memo": "",
          "tripUuid": "032df2aa-34cd-438b-9dcf-d562e9b615b8",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "032df2aa-34cd-438b-9dcf-d562e9b615b8",
              "restaurant": "マクドナルド イオンモール大阪ドームシティ店",
              "pickupAddress": "マクドナルド イオンモール大阪ドームシティ店",
              "dropoffAddress": "27大阪市大正区三軒家東４丁目",
              "area": "大阪市大正区三軒家東4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_14",
          "index": 14,
          "completedAt": "18:31",
          "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
          "area": "大阪市西区本田4丁目",
          "fee": 320,
          "distanceKm": 1.21,
          "durationStr": "18分9秒",
          "points": 1,
          "memo": "",
          "tripUuid": "d84171b8-2e53-4877-a472-a74bc910a0af",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "d84171b8-2e53-4877-a472-a74bc910a0af",
              "restaurant": "マクドナルド 九　条　店 McDonald's KUJO",
              "pickupAddress": "マクドナルド 九　条　店 McDonald's KUJO",
              "dropoffAddress": "27大阪市西区本田４丁目",
              "area": "大阪市西区本田4丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_15",
          "index": 15,
          "completedAt": "19:01",
          "restaurant": "餃子の王将 大阪九条",
          "area": "大阪市西区北堀江3丁目",
          "fee": 320,
          "distanceKm": 1.87,
          "durationStr": "12分28秒",
          "points": 1,
          "memo": "",
          "tripUuid": "1f20af01-e445-4640-b459-d64b1c284651",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "1f20af01-e445-4640-b459-d64b1c284651",
              "restaurant": "餃子の王将 大阪九条",
              "pickupAddress": "餃子の王将 大阪九条",
              "dropoffAddress": "27大阪市西区北堀江３丁目",
              "area": "大阪市西区北堀江3丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_16",
          "index": 16,
          "completedAt": "19:25",
          "restaurant": "やよい軒 九条店",
          "area": "大阪市西区本田1丁目",
          "fee": 320,
          "distanceKm": 0.71,
          "durationStr": "7分31秒",
          "points": 1,
          "memo": "",
          "tripUuid": "850df9eb-6d20-44f5-bf58-e13d755a37ea",
          "tripLegCount": 1,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "850df9eb-6d20-44f5-bf58-e13d755a37ea",
              "restaurant": "やよい軒 九条店",
              "pickupAddress": "やよい軒 九条店",
              "dropoffAddress": "27大阪市西区本田１丁目",
              "area": "大阪市西区本田1丁目",
              "customRouteMap": null
            }
          ],
          "sequence": null
        },
        {
          "id": "del_1016_17",
          "index": 17,
          "completedAt": "19:42",
          "restaurant": "松のや 桜川店 Matsunoya Sakuragawa",
          "area": "大阪市浪速区塩草/大阪市浪速区大国1丁目",
          "fee": 695,
          "distanceKm": 4.59,
          "durationStr": "32分22秒",
          "points": 2,
          "memo": "ダブル配達（2件完了/2pt）／2件完了/2pt",
          "tripUuid": "9219f312-9e71-4828-8e3a-d598328a6cb8",
          "tripLegCount": 2,
          "legs": [
            {
              "legIndex": 0,
              "legUuid": "689359f7-6ebb-41be-b2f6-ef7ae09506df",
              "restaurant": "",
              "pickupAddress": "27大阪市浪速区桜川３丁目",
              "dropoffAddress": "27大阪市浪速区塩草",
              "area": "大阪市浪速区塩草",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.6685%2C135.48747&markers=%7Canchor%3Acenter%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.65954%2C135.49134&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AcerrEuk%7DyXf%40_Cx%5BXb%40mMhPjAf%40mEtFQPmA%7D%40N&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=5Tuiw0OuTnib-8HRQRpOAulpUmg="
            },
            {
              "legIndex": 1,
              "legUuid": "791d8cf5-3e23-4f2e-acd0-2c0aebcc0e6b",
              "restaurant": "",
              "pickupAddress": "27大阪市西区千代崎３丁目",
              "dropoffAddress": "27大阪市浪速区大国１丁目",
              "area": "大阪市浪速区大国1丁目",
              "customRouteMap": "https://maps.googleapis.com/maps/api/staticmap?size=360x200&scale=2&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-pickup-pin.png%7Cscale%3A2%7C34.66985%2C135.47824&markers=%7Canchor%3Abottom%7Cicon%3Ahttps%3A%2F%2Fd1a3f4spazzrp4.cloudfront.net%2Fmaps%2Fhelix%2Fcar-dropoff-pin.png%7Cscale%3A2%7C34.65486%2C135.4974&path=color%3A0x2DBAE4FF%7Cweight%3A4%7Cenc%3AomrrE_r%7ByX%7C%40eFxI_An%40gA_Ei%5CfAsAq%40oPn%5C%3Fb%40mMhPjAf%40mEtFQPmAu%40%5CpA_BjBL%7EBsIfJqJdDkJnBc%40F%7D%40e%40Z&style=feature%3Aadministrative.locality%7Celement%3Alabels.text%7Ccolor%3A0x556275&style=feature%3Aadministrative.locality%7Celement%3Alabels.text.stroke%7Ccolor%3A0xe9edf3&style=feature%3Aadministrative.neighborhood%7Celement%3Alabels.text.fill%7Ccolor%3A0x90a8dd&style=feature%3Alandscape%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.man_made%7Celement%3Ageometry.stroke%7Ccolor%3A0xe6e9ec&style=feature%3Alandscape.natural.terrain%7Ccolor%3A0xe6e9ec%7Cvisibility%3Aoff&style=feature%3Apoi%7Celement%3Ageometry.fill%7Ccolor%3A0xe6e9ec&style=feature%3Apoi%7Celement%3Alabels.icon%7Csaturation%3A-100.0&style=feature%3Apoi%7Celement%3Alabels.text.fill%7Ccolor%3A0x6890df%7Csaturation%3A-65.0%7Clightness%3A-20.0&style=feature%3Apoi.park%7Celement%3Ageometry.fill%7Ccolor%3A0xa7dfb6&style=feature%3Apoi.park%7Celement%3Alabels.text.fill%7Ccolor%3A0x5ea678%7Csaturation%3A-25.0&style=feature%3Aroad%7Celement%3Alabels.icon%7Csaturation%3A-30.0%7Clightness%3A10.0&style=feature%3Aroad%7Celement%3Alabels.text.fill%7Ccolor%3A0x40484d&style=feature%3Aroad.arterial%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.arterial%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Aroad.highway%7Celement%3Ageometry.fill%7Ccolor%3A0xa6b5db&style=feature%3Aroad.highway%7Celement%3Ageometry.stroke%7Ccolor%3A0x96acd0&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.fill%7Ccolor%3A0x8b9fd4&style=feature%3Aroad.highway.controlled_access%7Celement%3Ageometry.stroke%7Ccolor%3A0x7996c9&style=feature%3Aroad.local%7Celement%3Ageometry.fill%7Ccolor%3A0xffffff&style=feature%3Aroad.local%7Celement%3Ageometry.stroke%7Ccolor%3A0xffffff&style=feature%3Atransit%7Celement%3Alabels.icon%7Csaturation%3A-65.0&style=feature%3Atransit.line%7Celement%3Ageometry.fill%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.line%7Celement%3Ageometry.stroke%7Ccolor%3A0x29b4e3%7Csaturation%3A-60.0%7Clightness%3A60.0&style=feature%3Atransit.station.airport%7Celement%3Ageometry.fill%7Ccolor%3A0xc9d4e3&style=feature%3Atransit.station.rail%7Celement%3Alabels.text%7Csaturation%3A-40.0%7Clightness%3A5.0&style=feature%3Awater%7Celement%3Ageometry.fill%7Ccolor%3A0xacd5f5&key=AIzaSyDU50VAD4HVefGeUpMlFxuCbsCvMrPzwZA&signature=TXg-hpjcJ33vW9ZSJV-zaOpK8MQ="
            }
          ],
          "sequence": null
        }
      ],
      "quests": [
        {
          "id": "quest_1016_1",
          "time": "11:24",
          "title": "クエスト",
          "amount": 140,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "11:12",
          "note": "公式一覧は 11:12「3 回乗車クエスト ¥140」（達成表示）と 11:24「クエスト ¥140」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1016_2",
          "time": "12:24",
          "title": "クエスト",
          "amount": 280,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "12:18",
          "note": "公式一覧は 12:18「3 回乗車クエスト ¥280」（達成表示）と 12:24「クエスト ¥280」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1016_3",
          "time": "13:34",
          "title": "クエスト",
          "amount": 490,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "13:33",
          "note": "公式一覧は 13:33「3 回乗車クエスト ¥490」（達成表示）と 13:34「クエスト ¥490」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1016_4",
          "time": "18:50",
          "title": "クエスト",
          "amount": 200,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "achievedAt": "18:49",
          "note": "公式一覧は 18:49「3 回乗車クエスト ¥200」（達成表示）と 18:50「クエスト ¥200」（売上計上）の2表示だが同一報酬のため1件のみ計上（二重計上防止）"
        },
        {
          "id": "quest_1016_5",
          "time": "20:08",
          "title": "クエスト",
          "amount": 340,
          "isDuplicateIgnored": false,
          "questName": "3回乗車クエスト",
          "questType": "normal",
          "note": "公式一覧は「クエスト ¥340」「3 回乗車クエスト ¥340」の2表示だが同一報酬のため1件のみ計上（二重計上防止）。21:00の「3 回乗車クエスト」¥0は報酬0のため売上非加算"
        }
      ],
      "sales": {
        "delivery": 6372,
        "quest": 1450,
        "adjustment": 0,
        "other": 0,
        "total": 7822
      },
      "expenses": [],
      "officialImport": {
        "source": "official-import-v1",
        "importedAt": "2026-10-16T12:11:12.467Z"
      }
    }
  },
  "targetQuests": [
    {
      "id": "quest_20260921_0925",
      "name": "80回乗車クエスト",
      "startAt": "2026-09-21T04:00:00+09:00",
      "endAt": "2026-09-25T04:00:00+09:00",
      "targetCount": 80,
      "expectedReward": 8890,
      "memo": "9/21〜9/25 達成済み特別クエスト",
      "manualAdjust": 0,
      "createdAt": "2026-09-21T04:00:00+09:00",
      "updatedAt": "2026-09-25T04:00:00+09:00"
    }
  ],
  "deletedTargetQuestIds": []
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
  // どの公式取込の値かを残す（同期で新旧を比べるため）
  if (log.officialImport && JSON.stringify(target.officialImport || null) !== JSON.stringify(log.officialImport)) {
    target.officialImport = { ...log.officialImport };
    changed = true;
  }
  return changed;
}

// UBER_LOG の基準タイムゾーン（大阪での配達運用）。端末のタイムゾーン設定に関係なく「今日」「現在時刻」は日本時間で決める
const APP_TIME_ZONE = 'Asia/Tokyo';
function jstParts(d) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
  } catch (e) {
    // Intl のタイムゾーンが使えない環境: UTC+9 を直接計算（日本は夏時間なし）
    const j = new Date(d.getTime() + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return { year: String(j.getUTCFullYear()), month: p(j.getUTCMonth() + 1), day: p(j.getUTCDate()), hour: p(j.getUTCHours()), minute: p(j.getUTCMinutes()) };
  }
}

// 今日の日付文字列（YYYY-MM-DD・日本時間）を取得。d を渡すとその時刻の日本時間の日付
function getTodayDateString(d = new Date()) {
  const p = jstParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// 現在時刻文字列（HH:mm）を取得
function getCurrentTimeString(d = new Date()) {
  const p = jstParts(d);
  return `${p.hour}:${p.minute}`;
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
  // 🏆 特別ボーナス系（v38〜 旧「賞」を廃止して統一）。新規保証・特別収入（guaranteeBonus）と
  // 特別クエスト（questType: special）のどちらか／両方がある日に1個だけ付く。内部データの分類は別のまま
  special_bonus: {
    key: 'special_bonus',
    label: '🏆',
    fullName: '特別ボーナス（新規保証・特別収入／特別クエスト）',
    className: 'attr-bonus attr-quest-trophy',
    description: '新規保証・特別収入、または特別クエスト（例: 80回乗車クエスト）の報酬があった日。金色系'
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

// 属性表示の固定優先順位（B -> 調 -> 🏆 -> ♥ の定義順）
const DAY_ATTRIBUTE_PRIORITY = ['bike_share', 'adjustment', 'special_bonus', 'tip'];

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

// 気象庁の天気データ（data/uber_weather.js が window.UBER_WEATHER に入れる。Node では data/uber_weather.json を読む）
function getWeatherBundle() {
  if (typeof window !== 'undefined' && window.UBER_WEATHER) return window.UBER_WEATHER;
  if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    try { return require('../data/uber_weather.json'); } catch (e) { return null; }
  }
  return null;
}

// 分を HH:MM（2桁ゼロ埋め）に整形。例: 303 → "05:03"、725 → "12:05"
function formatMinutesHHMM(minutes) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// クエスト二重計上検知・排除ロジック（同一時刻・同額および「クエスト」と「1回乗車クエスト」の重複排除）
function deduplicateQuests(questList = []) {
  if (!Array.isArray(questList)) return [];
  
  const processed = [];
  const seenKeys = new Set();
  const seenAmountPairs = new Map();

  questList.forEach((q) => {
    // ユーザー確認済み等で明示的に両方計上（count_all）または重複除外対象外とされている場合は除外しない
    if (q.decision === 'count_all' || q.allowDuplicate || q.keepSeparate) {
      processed.push({
        ...q,
        isDuplicateIgnored: false
      });
      return;
    }

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
      tipSales: 0,
      detectedTipSales: 0,
      tipStatus: 'none',
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
    .replace(/[￥]/g, '¥')
    .replace(/[−－]/g, '-'); // マイナス記号（U+2212・全角）を半角に

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
    // ¥-607 の形（記号の後ろにマイナス）
    const mSignAfterYen = clean.match(/[¥￥]\s*[-−－]\s*(\d+(?:\.\d+)?)/);
    if (mSignAfterYen) return Math.round(parseFloat(mSignAfterYen[1]));

    // 2. 単独数値行（1回、11件等のカウントを誤検知しないよう除外）
    if (/^\s*[+\-]?\d+(?:\.\d+)?\s*$/.test(clean.trim())) {
      const num = parseFloat(clean.trim());
      return isNaN(num) ? null : Math.round(num);
    }
    return null;
  };
  // 符号付きの金額（調整用）。「-¥607」「−¥607」「－607円」「¥-607」はマイナス
  const extractSignedAmount = (str) => {
    const amt = extractAmount(str);
    if (amt === null) return null;
    // マイナス記号は金額の直前だけを見る（日付「2026-09-22」等の「-」に反応しない）
    const s = String(str).replace(/,/g, '').trim();
    const negative = /[-−－]\s*[¥￥]\s*\d/.test(s) || /[¥￥]\s*[-−－]\s*\d/.test(s) ||
      /(^|[^\d])[-−－]\s*\d+(?:\.\d+)?\s*円/.test(s) || /^[-−－]\s*\d+(?:\.\d+)?$/.test(s);
    return negative ? -Math.abs(amt) : amt;
  };

  let deliveryTotal = null;
  let detectedQuests = [];
  let detectedAdjustments = [];
  let otherIncome = 0;
  let detectedTipTotal = 0;
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

    // 調整金 / Adjustment / 料金の調整（符号付き。-¥607 のようなマイナス調整を絶対値にしない）
    if (/調整|Adjustment/i.test(line)) {
      const amt = extractSignedAmount(line) || extractSignedAmount(nextLine);
      if (amt !== null && amt !== 0) {
        detectedAdjustments.push({
          title: line,
          amount: amt
        });
      }
    }

    // チップ（「その他」には入れない。配達報酬に含まれるかは下で総売上の行から判定する）
    // 「Multiple」等の単語の一部に反応しないよう、英語は単語の Tip / Tips だけ
    if (/チップ|\bTips?\b/i.test(line)) {
      const amt = extractAmount(line) || extractAmount(nextLine);
      if (amt !== null && amt > 0) {
        detectedTipTotal += amt;
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

  // チップの扱い（UBER_LOG では配達報酬 = チップを含む最終売上。チップはその内訳 tipSales）。
  // 元テキストの総売上の行で、配達の行がチップを含むかを判定する（推測で足し引きしない）:
  //  included: 総売上 = 配達 + クエスト + 調整 → 配達の行はチップ込み（配達報酬はそのまま・うちチップ = チップ）
  //  separate: 総売上 = 配達 + クエスト + 調整 + チップ → 配達の行はチップ別（配達報酬 = 配達 + チップ・うちチップ = チップ）
  //  unknown : 総売上の行が無い／どちらとも一致しない → 自動では配達報酬・その他のどちらにも入れない（画面で確認してもらう）
  let tipStatus = 'none';
  let tipSales = 0;
  if (detectedTipTotal > 0) {
    if (deliveryTotal === null && totalSales !== null) {
      // 配達の行が無い場合は 総売上 − クエスト − 調整 を配達報酬にする（チップは総売上に含まれる）
      const derived = totalSales - validQuestTotal - adjustmentTotal;
      tipStatus = derived >= detectedTipTotal ? 'included' : 'unknown';
    } else if (deliveryTotal !== null && totalSales !== null && totalSales === deliveryTotal + validQuestTotal + adjustmentTotal) {
      tipStatus = deliveryTotal >= detectedTipTotal ? 'included' : 'unknown';
    } else if (deliveryTotal !== null && totalSales !== null && totalSales === deliveryTotal + validQuestTotal + adjustmentTotal + detectedTipTotal) {
      tipStatus = 'separate';
      deliveryTotal += detectedTipTotal;
    } else {
      tipStatus = 'unknown';
    }
    if (tipStatus !== 'unknown') tipSales = detectedTipTotal;
  }

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
    otherSales: otherIncome, // その他（現在の解析では自動で入れる行は無い。画面で手入力のみ）
    tipSales,                // うちチップ（配達報酬に含まれる額。総売上には別途加算しない）
    detectedTipSales: detectedTipTotal,
    tipStatus,
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
          // 公式取込v1（tools/official-import）で反映された日: Uber公式データを正とし、端末側データは保持。
          // ただし端末側がこの版の同梱データより新しい公式取込（クラウド経由で受け取った）を持つ日は巻き戻さない
          const own = parsed.dailyLogs[date].officialImport;
          const newerOnDevice = own && own.importedAt && log.officialImport.importedAt && own.importedAt > log.officialImport.importedAt;
          if (!newerOnDevice && syncOfficialImportedDay(parsed.dailyLogs[date], log)) hasChange = true;
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
        } else if (date <= '2026-09-17') {
          // 9/18, 9/19 以外の過去日（9/10〜9/17）から誤ったバイクシェア/レンタサイクル情報を完全排除。
          // ユーザーの経費を消す処理のため、対象はこの初期期間だけに限る（今後シードに加わる日には絶対に適用しない）
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
                    // 端末内の控えは、配達側（同期で受け取った値）より新しいときだけ反映する。
                    // 以前は起動のたびに控えで上書きしていたため、別端末の新しい評価が古い評価に戻っていた
                    if (entry) {
                      if (typeof entry === 'string') {
                        if (!pd.evaluationUpdatedAt && pd.evaluation === undefined) {
                          pd.evaluation = entry;
                          pd.evaluationReason = '';
                        }
                      } else if (typeof entry === 'object') {
                        const at = entry.updatedAt || '';
                        if (!pd.evaluationUpdatedAt || (at && at > pd.evaluationUpdatedAt)) {
                          pd.evaluation = entry.evaluation || null;
                          pd.evaluationReason = entry.reason || '';
                          if (at) pd.evaluationUpdatedAt = at;
                        }
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
                    // 控え（更新時刻なし）は、同期で受け取ったメモ（mapMemoUpdatedAt あり）を上書きしない
                    if (memosMap[pd.id] !== undefined && !pd.mapMemoUpdatedAt) {
                      pd.mapMemo = String(memosMap[pd.id]);
                    }
                  });
                }
              });
            }
          }
        }
      } catch (e) {}

      // 目標クエスト（TargetQuests）の補完
      if (!Array.isArray(parsed.targetQuests)) {
        parsed.targetQuests = seed.targetQuests ? [...seed.targetQuests] : [LEGACY_80_QUEST];
        hasChange = true;
      }
      if (!Array.isArray(parsed.deletedTargetQuestIds)) {
        parsed.deletedTargetQuestIds = seed.deletedTargetQuestIds ? [...seed.deletedTargetQuestIds] : [];
        hasChange = true;
      }

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

    // 現在のstate内のdelivery.evaluationを更新（既存のevaluationReasonは保持）。
    // evaluationUpdatedAt: 端末間の同期で新しい方を選ぶための更新時刻（評価と理由で共通）
    let changedDate = null;
    const nowIso = new Date().toISOString();
    const allLogs = this.state && this.state.dailyLogs ? Object.entries(this.state.dailyLogs) : [];
    for (const [date, log] of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          d.evaluation = cleanEval;
          if (prevReason && !d.evaluationReason) {
            d.evaluationReason = prevReason;
          }
          d.evaluationUpdatedAt = nowIso;
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
          d.evaluationUpdatedAt = new Date().toISOString();
          changedDate = date;
          break;
        }
      }
    }

    this.saveToStorage(changedDate);
    return cleanReason;
  }

  // ○／×体験評価および理由メモの取得
  // 1つの配達（trip）を ID で探す
  findDelivery(deliveryId) {
    const allLogs = this.state && this.state.dailyLogs ? Object.values(this.state.dailyLogs) : [];
    for (const log of allLogs) {
      const d = (log.deliveries || []).find(item => item && item.id === deliveryId);
      if (d) return d;
    }
    return null;
  }

  getTripEvaluationData(deliveryId) {
    if (!deliveryId) return { evaluation: null, reason: '' };
    // 端末内の控え（uber_log_trip_evaluations）と配達側（同期される）で、更新時刻の新しい方を使う
    const synced = this.findDelivery(deliveryId);
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('uber_log_trip_evaluations');
        if (raw) {
          const evalsMap = JSON.parse(raw);
          if (evalsMap && evalsMap[deliveryId]) {
            const item = evalsMap[deliveryId];
            const itemAt = item && typeof item === 'object' ? item.updatedAt || '' : '';
            if (synced && synced.evaluationUpdatedAt && synced.evaluationUpdatedAt > itemAt) {
              return { evaluation: synced.evaluation || null, reason: synced.evaluationReason || '' };
            }
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

    // 以前は保存（saveToStorage）を呼ばず、メモがクラウドへ送られなかった（端末内だけ）。
    // mapMemoUpdatedAt: 端末間の同期で新しい方を選ぶための更新時刻
    let changedDate = null;
    const allLogs = this.state && this.state.dailyLogs ? Object.entries(this.state.dailyLogs) : [];
    for (const [date, log] of allLogs) {
      if (log.deliveries) {
        const d = log.deliveries.find(item => item.id === deliveryId);
        if (d) {
          d.mapMemo = cleanMemo;
          d.mapMemoUpdatedAt = new Date().toISOString();
          changedDate = date;
          break;
        }
      }
    }
    if (changedDate) this.saveToStorage(changedDate);

    return cleanMemo;
  }

  // MAP一口メモの取得
  getTripMapMemo(deliveryId) {
    if (!deliveryId) return '';
    // 同期で受け取った新しいメモ（更新時刻つき）は端末内の控えより優先
    const synced = this.findDelivery(deliveryId);
    if (synced && synced.mapMemoUpdatedAt) return String(synced.mapMemo || '');
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

  // --- 目標クエスト（Target Quest）管理 ---

  // 全目標クエストを取得（開始日時降順）
  getTargetQuests() {
    if (!this.state || !Array.isArray(this.state.targetQuests)) return [];
    return [...this.state.targetQuests].sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  }

  // 指定IDの目標クエストを取得
  getTargetQuestById(id) {
    if (!id || !this.state || !Array.isArray(this.state.targetQuests)) return null;
    return this.state.targetQuests.find(q => q.id === id) || null;
  }

  // 現在進行中、または直近の目標クエストを取得
  // refDate: 判定基準日時（Date または 'YYYY-MM-DD' 文字列。デフォルトは現在日時）
  getActiveTargetQuest(refDate = new Date()) {
    const quests = this.getTargetQuests();
    if (!quests || quests.length === 0) return null;

    let nowMs;
    if (refDate instanceof Date) {
      nowMs = refDate.getTime();
    } else if (typeof refDate === 'string') {
      const clean = refDate.trim();
      nowMs = clean.includes('T') ? new Date(clean).getTime() : new Date(`${clean}T12:00:00+09:00`).getTime();
    } else {
      nowMs = Date.now();
    }
    if (isNaN(nowMs)) nowMs = Date.now();

    // 1. 指定日時時点で進行中（startAt <= refDate < endAt）
    const activeList = quests.filter(q => {
      const s = new Date(q.startAt).getTime();
      const e = new Date(q.endAt).getTime();
      return !isNaN(s) && !isNaN(e) && nowMs >= s && nowMs < e;
    });
    if (activeList.length > 0) {
      // 終了日時が最も近いものを優先
      return activeList.sort((a, b) => new Date(a.endAt) - new Date(b.endAt))[0];
    }

    // 2. 指定日時より未来で開始が最も近いもの（準備中・予定クエスト）
    const futureList = quests.filter(q => new Date(q.startAt).getTime() > nowMs);
    if (futureList.length > 0) {
      return futureList.sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
    }

    // 3. 直近で終了したばかりのもの（終了後24時間以内のみ結果確認として表示）
    // 24時間以上経過した過去クエストは無期限にアクティブ扱いせず null を返す（未設定状態に戻す）
    const ONE_DAY_MS = 24 * 3600 * 1000;
    const recentEndedList = quests.filter(q => {
      const e = new Date(q.endAt).getTime();
      return !isNaN(e) && nowMs >= e && (nowMs - e) <= ONE_DAY_MS;
    });
    if (recentEndedList.length > 0) {
      return recentEndedList.sort((a, b) => new Date(b.endAt) - new Date(a.endAt))[0];
    }

    // 進行中・直近未来・直近終了（24h以内）のいずれにも該当しない場合は null（未設定）
    return null;
  }

  // 目標クエストを作成または更新
  saveTargetQuest(questData) {
    if (!questData) return null;
    if (!Array.isArray(this.state.targetQuests)) this.state.targetQuests = [];
    if (!Array.isArray(this.state.deletedTargetQuestIds)) this.state.deletedTargetQuestIds = [];

    const nowIso = new Date().toISOString();
    const id = questData.id || ('tq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const existingIdx = this.state.targetQuests.findIndex(q => q.id === id);

    const cleanQuest = {
      id,
      name: String(questData.name || '目標クエスト').trim(),
      startAt: questData.startAt,
      endAt: questData.endAt,
      targetCount: Math.max(1, parseInt(questData.targetCount, 10) || 1),
      expectedReward: questData.expectedReward !== null && questData.expectedReward !== undefined && questData.expectedReward !== ''
        ? Math.max(0, parseInt(questData.expectedReward, 10) || 0)
        : null,
      memo: String(questData.memo || '').trim(),
      manualAdjust: parseInt(questData.manualAdjust, 10) || 0,
      createdAt: existingIdx >= 0 ? (this.state.targetQuests[existingIdx].createdAt || nowIso) : nowIso,
      updatedAt: nowIso
    };

    // 削除フラグ（tombstone）から解除
    this.state.deletedTargetQuestIds = this.state.deletedTargetQuestIds.filter(tid => tid !== id);

    if (existingIdx >= 0) {
      this.state.targetQuests[existingIdx] = cleanQuest;
    } else {
      this.state.targetQuests.push(cleanQuest);
    }

    this.persistState();

    // クラウド同期フック
    if (typeof window !== 'undefined' && window.cloudSyncManager && typeof window.cloudSyncManager.onTargetQuestsSaved === 'function') {
      window.cloudSyncManager.onTargetQuestsSaved();
    }

    return cleanQuest;
  }

  // 目標クエストを削除（tombstone記録＋即座に除外）
  deleteTargetQuest(id) {
    if (!id || !Array.isArray(this.state.targetQuests)) return false;
    const existing = this.state.targetQuests.find(q => q.id === id);
    if (!existing) return false;

    if (!Array.isArray(this.state.deletedTargetQuestIds)) this.state.deletedTargetQuestIds = [];
    if (!this.state.deletedTargetQuestIds.includes(id)) {
      this.state.deletedTargetQuestIds.push(id);
    }

    this.state.targetQuests = this.state.targetQuests.filter(q => q.id !== id);
    this.persistState();

    // クラウド同期フック
    if (typeof window !== 'undefined' && window.cloudSyncManager && typeof window.cloudSyncManager.onTargetQuestsSaved === 'function') {
      window.cloudSyncManager.onTargetQuestsSaved();
    }

    return true;
  }

  // 目標クエスト期間内の公式Delivery件数を集計（ダブル=2、トリプル=3）
  countTargetQuestDeliveries(quest) {
    if (!quest || !quest.startAt || !quest.endAt) return 0;
    const startMs = new Date(quest.startAt).getTime();
    const endMs = new Date(quest.endAt).getTime();
    if (isNaN(startMs) || isNaN(endMs)) return 0;

    let totalDeliveries = 0;
    if (this.state && this.state.dailyLogs) {
      Object.values(this.state.dailyLogs).forEach(log => {
        if (log.deliveries && Array.isArray(log.deliveries)) {
          log.deliveries.forEach(del => {
            const dStr = (del.date || log.date || '').replace(/\//g, '-');
            const tStr = (del.completedAt && del.completedAt.length >= 5) ? del.completedAt.slice(0, 5) : '12:00';
            const tMs = new Date(`${dStr}T${tStr}:00+09:00`).getTime();
            // [startAt, endAt): 開始日時以上、終了日時未満
            if (!isNaN(tMs) && tMs >= startMs && tMs < endMs) {
              const pts = Number(del.points);
              totalDeliveries += (!isNaN(pts) && pts > 0) ? pts : 1;
            }
          });
        }
      });
    }
    return totalDeliveries;
  }

  // 目標クエストの進捗情報を算出
  calculateTargetQuestProgress(quest, now = new Date()) {
    if (!quest) return null;
    const officialCount = this.countTargetQuestDeliveries(quest);
    const manualAdjust = Number(quest.manualAdjust) || 0;
    const currentCount = Math.max(0, officialCount + manualAdjust);
    const targetCount = Number(quest.targetCount) || 0;
    const remainingCount = Math.max(0, targetCount - currentCount);
    const percentage = targetCount > 0
      ? Math.min(100, Math.round((currentCount / targetCount) * 1000) / 10)
      : 0;

    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const startMs = new Date(quest.startAt).getTime();
    const endMs = new Date(quest.endAt).getTime();

    const isStarted = nowMs >= startMs;
    const isEnded = nowMs >= endMs;
    const isAchieved = targetCount > 0 && currentCount >= targetCount;

    // 残り時間の計算
    let remainingTimeText = '';
    if (isEnded) {
      remainingTimeText = isAchieved ? '達成・終了' : '受付終了';
    } else if (!isStarted) {
      const diffMs = startMs - nowMs;
      const days = Math.floor(diffMs / (24 * 3600 * 1000));
      const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
      remainingTimeText = `開始まで ${days > 0 ? `${days}日` : ''}${hours}時間`;
    } else {
      const diffMs = endMs - nowMs;
      const days = Math.floor(diffMs / (24 * 3600 * 1000));
      const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
      const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
      if (days > 0) {
        remainingTimeText = `残り ${days}日${hours}時間`;
      } else if (hours > 0) {
        remainingTimeText = `残り ${hours}時間${mins}分`;
      } else {
        remainingTimeText = `残り ${Math.max(1, mins)}分`;
      }
    }

    // 終了日時表示用テキスト (例: 10/02 04:00)
    const endDate = new Date(quest.endAt);
    const m = String(endDate.getMonth() + 1).padStart(2, '0');
    const d = String(endDate.getDate()).padStart(2, '0');
    const h = String(endDate.getHours()).padStart(2, '0');
    const mi = String(endDate.getMinutes()).padStart(2, '0');
    const deadlineText = `${m}/${d} ${h}:${mi}`;

    return {
      questId: quest.id,
      name: quest.name,
      title: quest.name,
      targetCount,
      currentCount,
      officialCount,
      manualAdjust,
      remainingCount,
      percentage,
      expectedReward: quest.expectedReward ? Number(quest.expectedReward) : null,
      memo: quest.memo || '',
      startAt: quest.startAt,
      endAt: quest.endAt,
      deadlineText,
      remainingTimeText,
      isStarted,
      isEnded,
      isAchieved,
      hasQuest: true
    };
  }

  // 後方互換メソッド: 今週のクエスト設定オブジェクトを取得
  // ※アクティブな目標クエストがない場合は null を返す（旧固定80回フォールバック完全撤廃）
  getCurrentWeekQuest(refDate = new Date()) {
    const active = this.getActiveTargetQuest(refDate);
    if (active) {
      const endDate = new Date(active.endAt);
      const m = endDate.getMonth() + 1;
      const d = endDate.getDate();
      const h = endDate.getHours();
      const mi = String(endDate.getMinutes()).padStart(2, '0');
      return {
        id: active.id,
        title: active.name,
        targetCount: active.targetCount,
        startAt: active.startAt,
        endAt: active.endAt,
        deadlineText: `${m}/${d} ${h}:${mi}まで`
      };
    }
    return null;
  }

  // 後方互換メソッド: 指定日時がクエスト期間内か判定
  // ※アクティブな目標クエストがない場合は false を返す（旧固定80回フォールバック完全撤廃）
  isDateTimeInQuestPeriod(dateStr, timeStr, quest = null) {
    if (!dateStr) return false;
    const cleanDate = String(dateStr).replace(/\//g, '-');
    const targetQuest = quest || this.getActiveTargetQuest(cleanDate);
    if (!targetQuest) return false;

    const cleanTime = (timeStr && timeStr.length >= 5) ? timeStr.slice(0, 5) : '12:00';
    const isoStr = `${cleanDate}T${cleanTime}:00+09:00`;
    const t = new Date(isoStr).getTime();
    const start = new Date(targetQuest.startAt).getTime();
    const end = new Date(targetQuest.endAt).getTime();
    return !isNaN(t) && !isNaN(start) && !isNaN(end) && t >= start && t < end;
  }

  // 後方互換メソッド: クエスト期間内の実配達件数を集計
  // ※アクティブな目標クエストがない場合は 0 を返す（旧固定80回フォールバック完全撤廃）
  countQuestDeliveries(quest = null) {
    const targetQuest = quest || this.getActiveTargetQuest();
    if (!targetQuest) return 0;
    return this.countTargetQuestDeliveries(targetQuest);
  }

  // 後方互換メソッド: 今週のクエスト進捗データを取得
  // ※アクティブな目標クエストがない場合は未設定オブジェクトを返す（旧固定80回フォールバック完全撤廃）
  getQuestProgress(questOrDate = null) {
    let targetQuest = null;
    let evalDate = new Date();

    if (questOrDate && typeof questOrDate === 'object' && questOrDate.id) {
      targetQuest = questOrDate;
    } else if (typeof questOrDate === 'string' && this.getTargetQuestById(questOrDate)) {
      targetQuest = this.getTargetQuestById(questOrDate);
    } else {
      if (typeof questOrDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(questOrDate)) {
        evalDate = new Date(`${questOrDate}T12:00:00+09:00`);
      }
      targetQuest = this.getActiveTargetQuest(evalDate);
    }

    if (targetQuest) {
      return this.calculateTargetQuestProgress(targetQuest, evalDate);
    }
    return {
      questId: null,
      title: '目標クエスト未設定',
      name: '目標クエスト未設定',
      targetCount: 0,
      currentCount: 0,
      remainingCount: 0,
      percentage: 0,
      deadlineText: '--',
      remainingTimeText: '',
      isStarted: false,
      isEnded: false,
      isAchieved: false,
      hasQuest: false
    };
  }

  // クエスト手動調整オフセットを保存
  saveQuestProgress(questId, manualAdjust) {
    const quest = this.getTargetQuestById(questId);
    if (quest) {
      quest.manualAdjust = manualAdjust;
      this.saveTargetQuest(quest);
      return;
    }
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

  // クエスト進捗手動設定（アクティブ目標クエスト対象）
  setQuestProgressCount(count, quest = null) {
    const targetQuest = quest || this.getActiveTargetQuest();
    if (!targetQuest) return 0;
    const targetCount = Math.max(0, Number(count) || 0);
    const logDeliveriesCount = this.countTargetQuestDeliveries(targetQuest);
    const manualAdjust = targetCount - logDeliveriesCount;
    this.saveQuestProgress(targetQuest.id, manualAdjust);
    return targetCount;
  }

  // クエスト進捗をインクリメント（＋1）
  incrementQuestProgress(quest = null) {
    const targetQuest = quest || this.getActiveTargetQuest();
    if (!targetQuest) return 0;
    const progress = this.getQuestProgress(targetQuest);
    return this.setQuestProgressCount(progress.currentCount + 1, targetQuest);
  }

  // クエスト進捗をデクリメント（－1、0未満にはしない）
  decrementQuestProgress(quest = null) {
    const targetQuest = quest || this.getActiveTargetQuest();
    if (!targetQuest) return 0;
    const progress = this.getQuestProgress(targetQuest);
    return this.setQuestProgressCount(Math.max(0, progress.currentCount - 1), targetQuest);
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

    // 3. 特別ボーナス系属性 (🏆)
    // 対象日: 新規保証・特別収入 guaranteeBonus > 0 の日（例: 2026-09-19）または
    //         特別クエスト（questType: special）の報酬がある日（例: 2026-09-24）。両方あっても1個だけ
    const hasGuaranteeBonus = (metrics && metrics.guaranteeBonus > 0) || (log && log.sales && log.sales.guaranteeBonus > 0) || dateStr === '2026-09-19';
    const hasSpecialQuest = !!(metrics && metrics.specialQuestSales > 0);
    if (hasGuaranteeBonus || hasSpecialQuest) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.special_bonus);
    }

    // 4. チップ属性 (♥): その日の配達にチップ（tip > 0）がある日
    if (metrics && metrics.tipSales > 0) {
      attrs.push(DAY_ATTRIBUTE_DEFINITIONS.tip);
    }

    // 定義された優先順位に従って固定ソート（B -> 調 -> 🏆 -> ♥）
    const priority = (typeof DAY_ATTRIBUTE_PRIORITY !== 'undefined') ? DAY_ATTRIBUTE_PRIORITY : ['bike_share', 'adjustment', 'special_bonus', 'tip'];
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

  // 表示だけに使う日別ログ（無い日は空のログを返すが、端末データには作らない）。
  // 以前は画面で日付を開いただけで getDailyLog が空の日を作り、次の保存で端末に残っていた
  // （端末ごとに「存在する日」の数が違って見える原因。SYNC_MODEL.md「日数の意味」）。入力・保存は getDailyLog を使う
  peekDailyLog(dateStr = getTodayDateString()) {
    if (this.state.dailyLogs[dateStr]) return this.getDailyLog(dateStr);
    return { date: dateStr, workStartedAt: null, workEndedAt: null, workMinutes: null, totalDistanceKm: null, workSessions: [], deliveries: [], quests: [] };
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
      this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
      this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
    return { log, delivery };
  }

  // 直前の配達記録を取り消す
  undoLastDelivery(dateStr = getTodayDateString()) {
    const log = this.getDailyLog(dateStr);
    if (!log.deliveries || log.deliveries.length === 0) {
      return null;
    }
    const removed = log.deliveries.pop();
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
      this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
      this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
    return quest;
  }

  // クエストを削除
  deleteQuest(dateStr, questId) {
    const log = this.getDailyLog(dateStr);
    const idx = log.quests.findIndex(q => q.id === questId);
    if (idx !== -1) {
      const removed = log.quests.splice(idx, 1)[0];
      log.quests = deduplicateQuests(log.quests);
      this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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
    this.saveToStorage(log.date); // 対象日を同期対象にする（過去日の編集も Supabase へ）
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

    const todayLog = this.peekDailyLog(dateStr);
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
    // 配達ごとのチップが無い日（売上取込画面で日合計だけ登録した日）は sales.tip（配達報酬に含まれる額）を使う。
    // 公式取込の日は配達ごとの tip が正なので使わない（二重計上しない）。件数は不明のため tipCount は 0 のまま
    if (tipSales === 0 && !log.officialImport && log.sales && Number(log.sales.tip) > 0 && deliverySales !== null) {
      tipSales = Math.min(Number(log.sales.tip), Math.max(deliverySales, 0));
    }
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

    // 1件あたり平均売上（総売上 ÷ 件数。後方互換）
    let avgSalesPerDelivery = null;
    if (totalSales !== null && count > 0) {
      avgSalesPerDelivery = Math.round(totalSales / count);
    }
    // 1件あたり平均（通常売上 ÷ 件数。分析の平均単価・履歴の平均単価と同じ定義: 特別クエスト・特別ボーナス・その他を除く）
    const avgRegularPerDelivery = (hourlyBaseSales !== null && count > 0) ? Math.round(hourlyBaseSales / count) : null;
    // 新規ドライバー保証等（guaranteeBonus）を除いた総売上（ホームの「通常稼働収入」）
    const salesExcludingGuarantee = totalSales !== null ? totalSales - (guaranteeBonus || 0) : null;

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
      avgRegularPerDelivery,
      salesExcludingGuarantee,
      avgFeePerDelivery: avgSalesPerDelivery,
      avgDistPerDelivery,
      quests: deduplicateQuests(log.quests || [])
    };
  }

  // 日別売上データ（Delivery, Quest, Adjustment, Other, Total）の確定保存
  // tip: うちチップ（配達報酬 delivery に含まれる額。総売上には別途加算しない。0〜配達報酬の範囲）
  saveDailySales(dateStr, { delivery, quest, adjustment, other, tip, rawText, guaranteeBonus, guaranteeBonusNote }) {
    const log = this.getDailyLog(dateStr);
    const d = Number(delivery) || 0;
    const q = Number(quest) || 0;
    const a = Number(adjustment) || 0;
    const o = Number(other) || 0;
    const t = Math.min(Math.max(Number(tip) || 0, 0), Math.max(d, 0));
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
      tip: t,
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
    // 旧名称（レンタサイクル等）は正式な値で保存する（DATA_MODEL.md §1。既存の保存値は書き換えない）
    const D = typeof window !== 'undefined' ? window.UberLogDiagnostics : null;
    log.vehicleType = (D && vehicleType ? D.canonicalVehicleType(vehicleType) : vehicleType) || null;
    this.touchManualField(log, 'vehicleType');
    this.saveToStorage(dateStr);
    return log.vehicleType;
  }

  // 手動の日別項目（MANUAL_DAY_FIELDS）の更新時刻。端末間の同期で新しい方を選ぶ（SYNC_MODEL.md）
  touchManualField(log, field) {
    log.manualUpdatedAt = { ...(log.manualUpdatedAt || {}), [field]: new Date().toISOString() };
  }

  // 手動休みの設定・解除（解除は dayOff: false として残し、同期で「休みを解除した」ことが伝わるようにする）
  setDayOff(dateStr, isOff) {
    const log = this.getDailyLog(dateStr);
    log.dayOff = !!isOff;
    this.touchManualField(log, 'dayOff');
    this.saveToStorage(dateStr);
    return log.dayOff;
  }

  // 天気の手動登録（{ type: 'sunny'|'cloudy'|'rain'|'unknown', raw }）。null で取り消し（気象庁データの表示に戻る）
  setDayWeather(dateStr, weather) {
    const log = this.getDailyLog(dateStr);
    log.weather = weather ? { type: weather.type, source: weather.source || 'manual', raw: weather.raw || '', observedDate: dateStr } : null;
    this.touchManualField(log, 'weather');
    this.saveToStorage(dateStr);
    return log.weather;
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

  // 期間集計の共通ロジック（今週・先週・今月・期間指定・全期間で共用。startDate / endDate は両端を含む。null は制限なし）
  // 金額は日別の getCalculatedMetrics をそのまま合計する（日別表示と同じ数字）。
  //  総売上        = 配達報酬（チップ除く）＋ クエスト ＋ 特別ボーナス ＋ チップ ＋ 調整 ＋ その他
  //  クエスト      = 通常クエスト（特別クエスト questType: special は特別ボーナスへ。二重計上しない）
  //  特別ボーナス  = 特別収入・保証（guaranteeBonus）＋ 特別クエスト
  //  必要経費      = 登録済み経費（amount > 0）を1件1回ずつ（日別利益の totalExpenses と同じ。バイクシェア等を含む）
  //  利益          = 総売上 − 必要経費
  //  稼働日数・件数・配達時間・配達距離・通常売上は稼働日（isWorkedDay）だけで集計
  //  平均日給      = 通常売上 ÷ 稼働日数 / 平均単価 = 通常売上 ÷ 件数（v37: 特別クエスト・特別ボーナス・その他は効率指標から除外）
  aggregateForRange(startDate, endDate) {
    const out = {
      startDate: startDate || null, endDate: endDate || null, hasData: false,
      workedDays: 0, deliveriesCount: 0, tripsCount: 0,
      totalSales: 0, deliverySales: 0, baseDeliverySales: 0, tipSales: 0, tipCount: 0,
      questSales: 0, specialQuestSales: 0, guaranteeOnlySales: 0, guaranteeBonus: 0,
      adjustmentSales: 0, otherSales: 0,
      expenses: 0, expenseCount: 0, expenseByCategory: {}, bikeExpenses: 0, necessaryCategoryExpenses: 0,
      regularSales: 0, workSeconds: 0, distanceKm: 0
    };
    this.getAllDailyLogs()
      .filter(l => (!startDate || l.date >= startDate) && (!endDate || l.date <= endDate))
      .forEach(l => {
        const m = this.getCalculatedMetrics(l);
        if (!(m.count > 0 || m.totalSales !== null || m.totalExpenses > 0)) return;
        out.hasData = true;
        out.deliverySales += (m.deliverySales || 0);
        out.baseDeliverySales += (m.baseDeliverySales || 0);
        out.tipSales += (m.tipSales || 0);
        out.tipCount += (m.tipCount || 0);
        out.questSales += (m.questSales || 0) - (m.specialQuestSales || 0);
        out.specialQuestSales += (m.specialQuestSales || 0);
        out.guaranteeOnlySales += (m.guaranteeBonus || 0);
        out.guaranteeBonus += (m.guaranteeBonus || 0) + (m.specialQuestSales || 0);
        out.adjustmentSales += (m.adjustmentSales || 0);
        out.otherSales += (m.otherSales || 0);
        out.totalSales += (m.totalSales || 0);
        out.expenses += (m.totalExpenses || 0);
        (l.expenses || []).forEach(e => {
          const amt = Number(e && e.amount);
          if (!(amt > 0)) return; // 0円・マイナス・数値でない経費は必要経費に入れない（totalExpenses と同じ条件）
          const cat = String(e.category || '').trim() || '（種類なし）';
          out.expenseByCategory[cat] = (out.expenseByCategory[cat] || 0) + amt;
          out.expenseCount++;
          if (isBikeExpense(e)) out.bikeExpenses += amt;
          else if (cat === '必要経費') out.necessaryCategoryExpenses += amt;
        });
        if (this.isWorkedDay(l)) {
          out.workedDays++;
          // 件数は稼働日だけ（店舗名も報酬もない手動タップだけの日は配達件数に入れない）
          out.deliveriesCount += m.count;
          out.tripsCount += (m.tripsCount || 0);
          out.regularSales += (m.regularSales || 0);
          out.workSeconds += (m.workSeconds || 0);
          out.distanceKm += (m.totalDistanceKm || 0);
        }
      });
    out.distanceKm = Number(out.distanceKm.toFixed(2));
    out.profit = out.totalSales - out.expenses;
    out.avgDailyEarnings = out.workedDays > 0 ? Math.round(out.regularSales / out.workedDays) : null;
    out.avgPerDelivery = out.deliveriesCount > 0 ? Math.round(out.regularSales / out.deliveriesCount) : null;
    out.durationHHMM = formatMinutesHHMM(Math.floor(out.workSeconds / 60));
    return out;
  }

  // 週・月・累計の売上サマリー取得（今週の売上を最重要管理）。集計はすべて aggregateForRange
  //  今週: 基準日を含む週の月曜〜基準日（振込対象週。日付の区切りは日本時間0時。未来日は含めない） / 先週: その前の月曜〜日曜 /
  //  今月: 当月1日〜基準日（未来日は含めない）
  getRevenueSummary(dateStr = getTodayDateString()) {
    const allLogs = this.getAllDailyLogs();

    // 先週（先週比較用：推測・捏造せずデータ存在時のみ比較）
    const prevWeekRange = getPreviousWeekRange(dateStr);
    const prevWeek = this.aggregateForRange(prevWeekRange.startStr, prevWeekRange.endStr);
    const hasPrevWeekData = prevWeek.hasData;
    const prevWeekSalesProfit = prevWeek.profit;

    let prevWeekComparison = null;
    // 今週（月曜〜基準日。基準日より後の日は含めない。表示の期間ラベル・振込予定日は月曜〜日曜のまま）
    const weekRange = getWeekRange(dateStr);
    const week = this.aggregateForRange(weekRange.startStr, weekRange.endStr < dateStr ? weekRange.endStr : dateStr);
    const weekOfficialSales = week.totalSales;

    // 「今週の売上利益」＝ 総売上 － 必要経費（先週比も先週の同じ「売上利益」と比較）
    const weekSalesProfit = week.profit;

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
      aggregatedEndDate: week.endDate, // 集計の終了日（月曜〜基準日）
      salesProfit: weekSalesProfit,
      officialSales: weekOfficialSales,
      calculatedSales: weekOfficialSales,
      deliverySales: week.deliverySales,
      questSales: week.questSales,
      // 後方互換（旧名）: adjustmentSales / otherSales は「調整＋その他」の合計。画面は adjustmentOnlySales / otherOnlySales を使う
      adjustmentSales: week.adjustmentSales + week.otherSales,
      otherSales: week.adjustmentSales + week.otherSales,
      // 内訳表示用（合計すると officialSales と一致: 配達報酬(チップ除く) + クエスト + 特別ボーナス + チップ + 調整 + その他）
      baseDeliverySales: week.baseDeliverySales,
      tipSales: week.tipSales,
      adjustmentOnlySales: week.adjustmentSales,
      otherOnlySales: week.otherSales,
      bikeExpenses: week.bikeExpenses,
      expenses: week.expenses,
      deliveriesCount: week.deliveriesCount,
      deliveryCount: week.deliveriesCount,
      tripsCount: week.tripsCount,
      guaranteeBonus: week.guaranteeBonus,
      bonusSales: week.guaranteeBonus,
      guaranteeOnlySales: week.guaranteeOnlySales,
      specialQuestSales: week.specialQuestSales,
      payoutDateText: getNextPayoutDate(weekRange.endStr),
      note: '次回振込対象・当週確定売上利益',
      prevWeek: { startDate: prevWeekRange.startStr, endDate: prevWeekRange.endStr, sales: prevWeek.totalSales, expenses: prevWeek.expenses, salesProfit: prevWeek.profit },
      prevWeekComparison
    };

    // 今月の実績（当月1日〜基準日。未来日は含めない）。売上内訳（期間指定）の既定（今月1日〜今日）と同じ範囲・同じ集計
    const currentMonthPrefix = dateStr.substring(0, 7);
    const month = this.aggregateForRange(`${currentMonthPrefix}-01`, dateStr);
    const [mY, mM] = currentMonthPrefix.split('-').map(Number);
    const cleanMonthPeriod = `${mY}年${mM}月`;

    // 稼働日数: 分子 = 当月1日〜基準日でUber実績のある日（isWorkedDay）/ 分母 = 当月1日〜基準日の経過日数（基準日を含む）
    // 休み自動判定（getDayStatus）とは別の指標。基準日がまだ終わっていなくても分母に含める
    const monthElapsedDays = Number(dateStr.slice(8, 10));
    // 休み（今月）: 当月1日〜基準日で getDayStatus が off の日（手動休み＋自動休み）。
    // 基準日（今日）は手動休みでない限り休みにならない（自動休みは「今日より前」だけ）。未来日は数えない
    let monthOffDays = 0;
    let monthOffManual = 0;
    for (let d = 1; d <= monthElapsedDays; d++) {
      const ds = `${currentMonthPrefix}-${String(d).padStart(2, '0')}`;
      const st = this.getDayStatus(ds, dateStr);
      if (st.status === 'off') {
        monthOffDays++;
        if (st.statusSource === 'manual') monthOffManual++;
      }
    }

    const thisMonth = {
      label: '今月の実績',
      periodLabel: cleanMonthPeriod,
      startDate: month.startDate,
      endDate: month.endDate,
      sales: month.totalSales,
      salesProfit: month.profit,
      calculatedSales: month.totalSales,
      expenses: month.expenses,
      bikeExpenses: month.bikeExpenses,                 // 参考内訳: バイクシェア等
      otherExpenses: month.necessaryCategoryExpenses,   // 参考内訳: 種類「必要経費」
      workedDays: month.workedDays,   // 稼働（Uber実績のある日）
      offDays: monthOffDays,          // 休み（手動＋自動。今日は未確定）
      offDaysManual: monthOffManual,
      elapsedDays: monthElapsedDays,
      deliveriesCount: month.deliveriesCount,
      regularSales: month.regularSales,
      avgDailyEarnings: month.avgDailyEarnings,
      avgPerDelivery: month.avgPerDelivery,
      workSeconds: month.workSeconds,
      durationHHMM: month.durationHHMM,
      distanceKm: month.distanceKm,
      note: `※${mM}月度 登録分（全${month.deliveriesCount}件）`
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

  // 稼働日の共通判定（日別履歴一覧・分析の日別比較/稼働日数・カレンダーで共通）。引数は日付文字列または日別ログ
  // 稼働日 = 次のいずれか
  //  - 公式の配達件数（deliveriesCount）またはトリップ数（tripsCount）が1以上
  //  - 実配達（店舗名または報酬額の入った Delivery）が1件以上
  //  - 配達売上（deliverySales）が0より大きい
  // 稼働開始時刻・workSession・手動タップ（店舗名も報酬もない空タップ）・経費・同期データだけの日、
  // 空レコード、0件/売上0の日は稼働日ではない。「今日」かどうか・レコードの有無では判定しない
  isWorkedDay(dateOrLog) {
    const log = typeof dateOrLog === 'string'
      ? (this.state && this.state.dailyLogs ? this.state.dailyLogs[dateOrLog] : null)
      : dateOrLog;
    if (!log) return false;
    if (Number(log.deliveriesCount) > 0 || Number(log.tripsCount) > 0) return true;
    const hasRealDelivery = (log.deliveries || []).some(d => d && (
      (d.restaurant && String(d.restaurant).trim() !== '') ||
      (d.fee !== null && d.fee !== undefined && d.fee !== '' && Number(d.fee) > 0)
    ));
    if (hasRealDelivery) return true;
    const metrics = this.getCalculatedMetrics(log);
    return metrics.deliverySales !== null && metrics.deliverySales > 0;
  }

  // Uber公式データの取り込み範囲（自動「休み」判定用）。
  // 公式データの日 = 確定シード（CONFIRMED_SEED_DATA。公式画面から確定した日別データ）の日、
  // または公式取込（officialImport）のある日で、かつ稼働日（isWorkedDay）の日。
  //  startDate : Uber運用開始日（公式データの最も古い日）
  //  latestDate: 公式データが取り込まれている最も新しい日
  getUberOfficialCoverage() {
    const logs = this.state && this.state.dailyLogs ? this.state.dailyLogs : {};
    const seedLogs = CONFIRMED_SEED_DATA.dailyLogs || {};
    const dates = new Set([...Object.keys(seedLogs), ...Object.keys(logs)]);
    let startDate = null;
    let latestDate = null;
    dates.forEach(date => {
      const log = logs[date] || seedLogs[date];
      if (!seedLogs[date] && !(log && log.officialImport)) return;
      if (!this.isWorkedDay(log)) return;
      if (!startDate || date < startDate) startDate = date;
      if (!latestDate || date > latestDate) latestDate = date;
    });
    return { startDate, latestDate };
  }

  // 日別の稼働状況（履歴カレンダー用。一覧・日別比較と同じ isWorkedDay で判定）。Uber履歴としての判定
  //  worked : 稼働日（isWorkedDay）
  //  off    : 休み。statusSource で区別する
  //           manual: 手動指定（CONFIRMED_DAY_OFF_DATES、または日別データの dayOff: true）
  //           auto  : 自動判定（Uber運用開始日以降・今日より前・その日より後の日まで公式データ取り込み済み・
  //                   その日にUberの稼働実績なし）。保存せず毎回判定するため、後から公式データが
  //                   取り込まれれば自動で稼働日に戻る（手動指定のデータには一切書き込まない）
  //  unknown: それ以外（今日・未来・公式データ未取り込みの日）。「休み」にはしない
  // ※ 他サービス（Rocket Now 等）が同日に稼働していても、Uberの稼働実績が無ければUber履歴上は休み
  getDayStatus(dateStr, today = getTodayDateString()) {
    const log = this.state && this.state.dailyLogs ? this.state.dailyLogs[dateStr] : null;
    const metrics = log ? this.getCalculatedMetrics(log) : null;
    if (metrics && this.isWorkedDay(log)) {
      return { status: 'worked', count: metrics.count, totalSales: metrics.totalSales, netProfit: metrics.netProfit };
    }
    if (CONFIRMED_DAY_OFF_DATES.includes(dateStr) || (log && log.dayOff === true)) {
      return { status: 'off', statusSource: 'manual' };
    }
    const { startDate, latestDate } = this.getUberOfficialCoverage();
    if (startDate && dateStr >= startDate && dateStr < today && dateStr < latestDate) {
      return { status: 'off', statusSource: 'auto' };
    }
    return { status: 'unknown' };
  }

  // 期間指定の売上内訳（開始日〜終了日、両端含む）。
  // 配達報酬はチップを除いた額、チップは配達の最終売上に含まれる内訳（総売上へは二重に加算しない）。
  // 合計: 配達報酬 + チップ + クエスト + 特別ボーナス + 調整 + その他 = 総売上
  getSalesBreakdown(startDate, endDate) {
    // 共通の期間集計（aggregateForRange）をそのまま使う。days = 稼働日数（isWorkedDay）
    const a = this.aggregateForRange(startDate, endDate);
    return { ...a, startDate, endDate, days: a.workedDays };
  }

  // その日の天気（DATA_MODEL.md「天気」）。推測しない: 登録が無い日は null（画面は「—」）
  //  1. 日別データの weather（手動・将来の登録。{ type, source, raw, observedDate }）
  //  2. 気象庁の過去の観測（data/uber_weather.js。tools/weather/fetch-jma-weather.js が生成）
  // 戻り値: { type: 'sunny'|'cloudy'|'rain'|'unknown', label, icon, source, day, night, nightRain, precipitationMm }
  getWeather(dateStr) {
    const META = { sunny: { label: '晴', icon: '☀' }, cloudy: { label: '曇', icon: '☁' }, rain: { label: '雨', icon: '🌧' }, unknown: { label: '不明', icon: '？' } };
    const log = this.state && this.state.dailyLogs ? this.state.dailyLogs[dateStr] : null;
    const own = log && log.weather && META[log.weather.type] ? log.weather : null;
    if (own) return { ...META[own.type], type: own.type, source: own.source || 'manual', day: own.raw || '', night: '', nightRain: false, precipitationMm: null };
    const bundle = getWeatherBundle();
    const e = bundle && bundle.days ? bundle.days[dateStr] : null;
    if (!e || !META[e.type]) return null;
    return { ...META[e.type], type: e.type, source: 'jma', day: e.day, night: e.night, nightRain: !!e.nightRain, precipitationMm: e.precipitationNone ? null : e.precipitationMm };
  }

  // 全体・累計・直近7日の分析データ取得
  getAnalytics() {
    const allLogs = this.getAllDailyLogs();

    // 全期間の合計（共通の期間集計 aggregateForRange を期間制限なしで使う）。分析画面の「今月」は getRevenueSummary().thisMonth を使う
    const all = this.aggregateForRange(null, null);
    const activeDaysCount = all.workedDays;
    const totalDeliveries = all.deliveriesCount;
    const totalSalesSum = all.totalSales;
    const totalRegularSalesSum = all.regularSales;
    const totalSecondsSum = all.workSeconds;
    const totalDistanceSum = all.distanceKm;
    const avgDailyEarnings = all.avgDailyEarnings;
    const avgPerDelivery = all.avgPerDelivery;
    const avgHourlyWage = totalSecondsSum > 0 ? Math.round(totalRegularSalesSum / (totalSecondsSum / 3600)) : null;

    // 配達時間テキスト（全期間の公式トリップ所要時間合計、秒省略「xx時間xx分」）
    const totalDurationText = totalSecondsSum > 0
      ? `${Math.floor(totalSecondsSum / 3600)}時間${Math.floor((totalSecondsSum % 3600) / 60)}分`
      : '0時間0分';

    // 日別比較用データ（全稼働日、降順、10円単位四捨五入時給）
    // 日別履歴一覧と同じ共通判定（isWorkedDay）。非稼働日（例: 稼働開始時刻だけ残る 9/20）は出さない
    const dailyComparison = allLogs.filter(log => this.isWorkedDay(log)).map(log => {
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
      // 日別比較の表示用（HH:MM・2桁ゼロ埋め。秒は切り捨て。例: 5時間3分 → 05:03）。記録なしは null
      const durationMinutesTotal = (metrics.workSeconds !== null && metrics.workSeconds > 0)
        ? Math.floor(metrics.workSeconds / 60)
        : ((metrics.workMinutes !== null && metrics.workMinutes > 0) ? metrics.workMinutes : null);
      const durationHHMM = durationMinutesTotal !== null ? formatMinutesHHMM(durationMinutesTotal) : null;

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
        durationHHMM,
        weather: this.getWeather(log.date), // 天気（無い日は null → 画面は「—」）
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
  // _sync: 書き出した端末の版・同期の記録・未送信・競合（tools/data-audit/data-integrity-audit.js --file で確認する。読み込み時は捨てる）
  exportJSON() {
    let sync = null;
    try {
      const get = k => { const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; return raw ? JSON.parse(raw) : null; };
      sync = {
        appVersion: (typeof window !== 'undefined' && window.UBER_LOG_APP_VERSION) || null,
        exportedAt: new Date().toISOString(),
        status: get('uber_sync_status'),
        pendingDates: get('uber_pending_sync_dates') || [],
        conflicts: get('uber_sync_conflicts') || [],
        cloudIndex: get('uber_sync_cloud_index'), // クラウドにある日の要約（端末とクラウドの差分の監査用）
        clientId: get('uber_sync_client_id')
      };
    } catch (e) { sync = null; }
    return JSON.stringify(sync ? { ...this.state, _sync: sync } : this.state, null, 2);
  }

  // 全データインポート
  importJSON(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data.dailyLogs) {
        throw new Error('無効なデータ形式です（dailyLogsが見つかりません）');
      }
      delete data._sync; // 書き出し時の記録（同期の状態）は端末データに入れない
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
  window.formatMinutesHHMM = formatMinutesHHMM;
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
    syncOfficialImportedDay,
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
    formatMinutesHHMM,
    deduplicateQuests,
    parseUberSalesText,
    Store,
    store
  };
}

