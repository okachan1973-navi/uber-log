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
      title: 'セブンイレブン野田阪神駅前店 ➔ 福島タワー',
      date: '2026-09-19',
      completedAt: '08:52',
      pickup: 'セブンイレブン野田阪神駅前店',
      drop: '福島タワー',
      fee: 340,
      distanceKm: null,
      durationStr: '',
      status: 'AVOID',
      tags: ['入館手続き', 'エレベーター', '館内徒歩', '退館導線'],
      memo: '入館手続きが複雑・記入等が必要・上階までの導線に時間がかかる・低単価案件では割に合いにくい。【今後の回避候補・建物注意】'
    },
    {
      id: 'bm_0919_sushiro_shiokusa',
      title: 'スシロー辰巳橋店 ➔ 浪速区塩草1丁目',
      date: '2026-09-19',
      completedAt: '16:55',
      pickup: 'スシロー辰巳橋店',
      drop: '浪速区塩草1丁目',
      fee: 429,
      distanceKm: 6.74,
      durationStr: '31分32秒',
      status: 'VERIFY',
      tags: ['橋', '自転車移動困難', '長距離', '要ルート検証'],
      memo: '橋・道路選択で大きなロスが発生。43号線付近まで進んだが自転車では利用しにくい／通行できないルートに当たり引き返して京セラドーム方面へ戻るロスが発生した。【要ルート検証】'
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
    "2026-09-14": {
      "date": "2026-09-14",
      "workStartedAt": null,
      "workEndedAt": null,
      "workMinutes": null,
      "totalDistanceKm": null,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0914_1",
          "index": 1,
          "completedAt": "08:54",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0914_2",
          "index": 2,
          "completedAt": "09:08",
          "restaurant": "",
          "area": "",
          "fee": 619,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0914_3",
          "index": 3,
          "completedAt": "09:21",
          "restaurant": "海遊館方面",
          "area": "港線方面ホテル",
          "fee": 1166,
          "distanceKm": null,
          "durationStr": "",
          "memo": "海遊館方面→港線方面ホテル。大型施設・移動導線負担大。【要検証】"
        },
        {
          "id": "del_0914_4",
          "index": 4,
          "completedAt": "09:41",
          "restaurant": "",
          "area": "",
          "fee": 338,
          "distanceKm": null,
          "durationStr": "",
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
      "totalDistanceKm": null,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0915_1",
          "index": 1,
          "completedAt": "09:04",
          "restaurant": "",
          "area": "",
          "fee": 355,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_2",
          "index": 2,
          "completedAt": "09:34",
          "restaurant": "",
          "area": "",
          "fee": 396,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_3",
          "index": 3,
          "completedAt": "10:02",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_4",
          "index": 4,
          "completedAt": "10:28",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_5",
          "index": 5,
          "completedAt": "10:49",
          "restaurant": "",
          "area": "",
          "fee": 416,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_6",
          "index": 6,
          "completedAt": "11:22",
          "restaurant": "",
          "area": "",
          "fee": 474,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_7",
          "index": 7,
          "completedAt": "11:35",
          "restaurant": "",
          "area": "",
          "fee": 455,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_8",
          "index": 8,
          "completedAt": "12:05",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_9",
          "index": 9,
          "completedAt": "12:22",
          "restaurant": "",
          "area": "",
          "fee": 560,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_10",
          "index": 10,
          "completedAt": "13:07",
          "restaurant": "",
          "area": "",
          "fee": 393,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0915_11",
          "index": 11,
          "completedAt": "13:19",
          "restaurant": "",
          "area": "",
          "fee": 723,
          "distanceKm": null,
          "durationStr": "",
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
      "totalDistanceKm": null,
      "workSessions": [],
      "deliveries": [
        {
          "id": "del_0916_1",
          "index": 1,
          "completedAt": "09:01",
          "restaurant": "",
          "area": "",
          "fee": 606,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_2",
          "index": 2,
          "completedAt": "09:19",
          "restaurant": "",
          "area": "",
          "fee": 563,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_3",
          "index": 3,
          "completedAt": "09:28",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_4",
          "index": 4,
          "completedAt": "09:39",
          "restaurant": "",
          "area": "",
          "fee": 525,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_5",
          "index": 5,
          "completedAt": "10:29",
          "restaurant": "",
          "area": "",
          "fee": 906,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_6",
          "index": 6,
          "completedAt": "10:54",
          "restaurant": "",
          "area": "",
          "fee": 0,
          "distanceKm": null,
          "durationStr": "",
          "memo": "0円報酬（キャンセルまたは保障外案件）"
        },
        {
          "id": "del_0916_7",
          "index": 7,
          "completedAt": "10:56",
          "restaurant": "",
          "area": "",
          "fee": 432,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0916_8",
          "index": 8,
          "completedAt": "11:58",
          "restaurant": "",
          "area": "遠方の一軒家方面",
          "fee": 1050,
          "distanceKm": null,
          "durationStr": "",
          "memo": "遠方の一軒家方面。1件か2件セットか未確認、報酬悪くない可能性あり【要検証】"
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
      "totalDistanceKm": null,
      "workSessions": [
        {
          "id": "sess_0917_1",
          "start": "09:00",
          "end": null,
          "isApproximate": true,
          "note": "第1部（09:00頃開始。休憩・第2部は未確定・推測なし）"
        }
      ],
      "deliveries": [
        {
          "id": "del_0917_1",
          "index": 1,
          "completedAt": "08:56",
          "restaurant": "",
          "area": "",
          "fee": 704,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0917_2",
          "index": 2,
          "completedAt": "10:10",
          "restaurant": "",
          "area": "",
          "fee": 511,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0917_3",
          "index": 3,
          "completedAt": "10:40",
          "restaurant": "",
          "area": "",
          "fee": 419,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0917_4",
          "index": 4,
          "completedAt": "10:57",
          "restaurant": "",
          "area": "",
          "fee": 644,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0917_5",
          "index": 5,
          "completedAt": "11:33",
          "restaurant": "",
          "area": "",
          "fee": 388,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0917_6",
          "index": 6,
          "completedAt": "12:00",
          "restaurant": "",
          "area": "",
          "fee": 320,
          "distanceKm": null,
          "durationStr": "",
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
      ]
    },
    "2026-09-18": {
      "date": "2026-09-18",
      "workStartedAt": "09:00",
      "workEndedAt": "14:30",
      "workMinutes": 330,
      "totalDistanceKm": null,
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
          "completedAt": "09:20",
          "restaurant": "マクドナルド九条店",
          "area": "西区九条2丁目 → 此花区梅香3丁目",
          "fee": 350,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_2",
          "index": 2,
          "completedAt": "09:48",
          "restaurant": "すき家此花店",
          "area": "此花区春日出南1丁目 → 此花区四貫島2丁目",
          "fee": 380,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_3",
          "index": 3,
          "completedAt": "10:15",
          "restaurant": "吉野家西九条店",
          "area": "此花区西九条3丁目 → 此花区伝法4丁目",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_4",
          "index": 4,
          "completedAt": "10:42",
          "restaurant": "モスバーガー市岡店",
          "area": "港区市岡2丁目 → 港区八幡屋1丁目",
          "fee": 360,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_5",
          "index": 5,
          "completedAt": "11:10",
          "restaurant": "松屋弁天町店",
          "area": "港区波除3丁目 → 港区磯路2丁目",
          "fee": 390,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_6",
          "index": 6,
          "completedAt": "11:45",
          "restaurant": "ケンタッキー九条店",
          "area": "西区九条1丁目 → 此花区西九条1丁目",
          "fee": 357,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_7",
          "index": 7,
          "completedAt": "12:15",
          "restaurant": "ガスト此花店",
          "area": "此花区四貫島1丁目 → 此花区梅香1丁目",
          "fee": 350,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_8",
          "index": 8,
          "completedAt": "12:48",
          "restaurant": "ほっともっと九条店",
          "area": "西区九条南2丁目 → 港区南市岡3丁目",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_9",
          "index": 9,
          "completedAt": "13:20",
          "restaurant": "CoCo壱番屋港区店",
          "area": "港区弁天1丁目 → 此花区島屋3丁目",
          "fee": 350,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_10",
          "index": 10,
          "completedAt": "13:50",
          "restaurant": "やよい軒弁天町店",
          "area": "港区市岡元町3丁目 → 港区三先1丁目",
          "fee": 350,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0918_11",
          "index": 11,
          "completedAt": "14:22",
          "restaurant": "餃子の王将九条店",
          "area": "西区九条2丁目 → 此花区西九条4丁目",
          "fee": 350,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
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
          "category": "レンタサイクル",
          "amount": 1980,
          "memo": "レンタサイクル1日利用"
        }
      ]
    },
    "2026-09-19": {
      "date": "2026-09-19",
      "workStartedAt": "08:30",
      "workEndedAt": "17:00",
      "workMinutes": 510,
      "totalDistanceKm": null,
      "vehicleType": "レンタサイクル",
      "milestone": "累計75配達達成",
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
          "completedAt": "08:52",
          "restaurant": "セブンイレブン野田阪神駅前店",
          "area": "福島タワー",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": "入館手続き複雑・記入必要・高層階導線ロス大【原則回避・建物注意】",
          "isAvoidanceCase": true
        },
        {
          "id": "del_0919_2",
          "index": 2,
          "completedAt": "09:15",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_3",
          "index": 3,
          "completedAt": "09:38",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_4",
          "index": 4,
          "completedAt": "10:02",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_5",
          "index": 5,
          "completedAt": "10:25",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_6",
          "index": 6,
          "completedAt": "10:48",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_7",
          "index": 7,
          "completedAt": "11:10",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_8",
          "index": 8,
          "completedAt": "11:35",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_9",
          "index": 9,
          "completedAt": "11:55",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_10",
          "index": 10,
          "completedAt": "12:12",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_11",
          "index": 11,
          "completedAt": "12:30",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_12",
          "index": 12,
          "completedAt": "12:48",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_13",
          "index": 13,
          "completedAt": "13:08",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_14",
          "index": 14,
          "completedAt": "13:28",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_15",
          "index": 15,
          "completedAt": "13:50",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_16",
          "index": 16,
          "completedAt": "14:15",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_17",
          "index": 17,
          "completedAt": "14:40",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_18",
          "index": 18,
          "completedAt": "15:05",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_19",
          "index": 19,
          "completedAt": "15:28",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_20",
          "index": 20,
          "completedAt": "15:52",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_21",
          "index": 21,
          "completedAt": "16:15",
          "restaurant": "",
          "area": "",
          "fee": 340,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_22",
          "index": 22,
          "completedAt": "16:35",
          "restaurant": "",
          "area": "",
          "fee": 339,
          "distanceKm": null,
          "durationStr": "",
          "memo": ""
        },
        {
          "id": "del_0919_23",
          "index": 23,
          "completedAt": "16:55",
          "restaurant": "スシロー辰巳橋店",
          "area": "浪速区塩草1丁目",
          "fee": 429,
          "distanceKm": 6.74,
          "durationStr": "31分32秒",
          "memo": "43号線付近渡河不可・京セラドーム方面引返しロス【要ルート検証】",
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
        "delivery": 7908,
        "quest": 950,
        "adjustment": 0,
        "other": 0,
        "regularTotal": 8858,
        "guaranteeBonus": 12132,
        "guaranteeBonusNote": "新規ドライバー保証（累計75配達達成: 保証額42,525円 - 対象売上30,393円）",
        "total": 20990
      },
      "expenses": []
    }
  }
};

function getConfirmedSeedData() {
  return JSON.parse(JSON.stringify(CONFIRMED_SEED_DATA));
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
        } else if (date === '2026-09-18') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || target.deliveries.length < 11) {
            target.deliveries = log.deliveries;
            hasChange = true;
          }
          if (!target.sales) {
            target.sales = log.sales;
            hasChange = true;
          }
          if (!target.expenses || target.expenses.length === 0) {
            target.expenses = log.expenses;
            hasChange = true;
          }
          if (!target.workSessions || target.workSessions.length === 0) {
            target.workSessions = log.workSessions;
            target.workStartedAt = log.workStartedAt;
            target.workEndedAt = log.workEndedAt;
            target.workMinutes = log.workMinutes;
            hasChange = true;
          }
        } else if (date === '2026-09-19') {
          const target = parsed.dailyLogs[date];
          if (!target.deliveries || target.deliveries.length < 23) {
            target.deliveries = log.deliveries;
            hasChange = true;
          }
          if (!target.sales || !target.sales.guaranteeBonus) {
            target.sales = log.sales;
            hasChange = true;
          }
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
        }
      }
      if (hasChange) {
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
    const count = log.deliveries ? log.deliveries.length : 0;
    
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

    // 1日総売上（通常稼働分: Delivery + Quest + Adjustment + Other）
    let totalSales = null;
    if (deliverySales !== null || questSales !== null || adjustmentSales > 0 || otherSales > 0) {
      totalSales = (deliverySales || 0) + (questSales || 0) + (adjustmentSales || 0) + (otherSales || 0);
    }

    // 新規ドライバー保証・特別収入（通常時給・平均単価等の稼働効率指標には混ぜない）
    const guaranteeBonus = (log.sales && log.sales.guaranteeBonus) ? Number(log.sales.guaranteeBonus) : (Number(log.guaranteeBonus) || 0);
    const guaranteeBonusNote = (log.sales && log.sales.guaranteeBonusNote) ? log.sales.guaranteeBonusNote : (log.guaranteeBonusNote || '');
    const totalSalesWithBonus = totalSales !== null ? (totalSales + guaranteeBonus) : null;
    const milestone = log.milestone || (guaranteeBonus > 0 ? '累計75配達達成' : null);

    // 当日経費（変動費）の計算
    const expenses = Array.isArray(log.expenses) ? log.expenses : [];
    let totalExpenses = 0;
    expenses.forEach(e => {
      const amt = Number(e.amount);
      if (!isNaN(amt) && amt > 0) {
        totalExpenses += amt;
      }
    });

    // 当日利益（純利益 ＝ 通常総売上 − 当日経費）
    const netProfit = totalSales !== null ? (totalSales - totalExpenses) : null;
    const netProfitWithBonus = totalSalesWithBonus !== null ? (totalSalesWithBonus - totalExpenses) : null;

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

    const workHours = (workMinutes !== null && workMinutes > 0) ? (workMinutes / 60) : 0;

    // 売上時給（総売上 ÷ 稼働時間）
    let grossHourlyWage = null;
    if (totalSales !== null && workHours > 0) {
      grossHourlyWage = Math.round(totalSales / workHours);
    }

    // 実質時給（当日利益 ÷ 稼働時間）
    let netHourlyWage = null;
    if (netProfit !== null && workHours > 0) {
      netHourlyWage = Math.round(netProfit / workHours);
    }

    // 後方互換用 hourlyWage（実質時給を格納）
    const hourlyWage = netHourlyWage !== null ? netHourlyWage : grossHourlyWage;

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
      deliverySales,
      questSales,
      adjustmentSales,
      otherSales,
      totalSales,
      totalExpenses,
      netProfit,
      expenses,
      vehicleType: log.vehicleType || 'レンタサイクル',
      totalDistanceKm,
      uberDeliveryDistanceKm,
      deadheadDistanceKm,
      totalActualDistanceKm,
      distanceRecordedCount,
      isFullDistanceRecorded,
      workMinutes,
      grossHourlyWage,
      netHourlyWage,
      hourlyWage,
      guaranteeBonus,
      guaranteeBonusNote,
      totalSalesWithBonus,
      netProfitWithBonus,
      milestone,
      isDurationApproximate,
      hasActiveSession,
      workSessions: log.workSessions || [],
      avgSalesPerDelivery,
      avgFeePerDelivery: avgSalesPerDelivery,
      avgDistPerDelivery,
      quests: deduplicateQuests(log.quests || [])
    };
  }

  // 日別売上データ（Delivery, Quest, Adjustment, Other, Total）の確定保存
  saveDailySales(dateStr, { delivery, quest, adjustment, other, rawText }) {
    const log = this.getDailyLog(dateStr);
    const d = Number(delivery) || 0;
    const q = Number(quest) || 0;
    const a = Number(adjustment) || 0;
    const o = Number(other) || 0;
    const tot = d + q + a + o;

    log.sales = {
      delivery: d,
      quest: q,
      adjustment: a,
      other: o,
      total: tot,
      rawTextSummary: rawText ? (rawText.length > 50 ? rawText.substring(0, 50) + '...' : rawText) : '',
      updatedAt: new Date().toISOString()
    };

    this.saveToStorage(dateStr);
    return log.sales;
  }

  // 当日経費の追加
  addExpense(dateStr, { category, amount, memo }) {
    const log = this.getDailyLog(dateStr);
    if (!log.expenses) log.expenses = [];

    const amt = Number(amount) || 0;
    const expense = {
      id: `exp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      category: category || 'レンタサイクル',
      amount: amt,
      memo: memo || '',
      createdAt: new Date().toISOString()
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
        memo: memo !== undefined ? memo : log.expenses[idx].memo
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
      this.saveToStorage(dateStr);
      return removed;
    }
    return null;
  }

  // 移動手段/車両種別の更新
  updateVehicleType(dateStr, vehicleType) {
    const log = this.getDailyLog(dateStr);
    log.vehicleType = vehicleType || 'レンタサイクル';
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
  window.parseUberSalesText = parseUberSalesText;
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
    parseUberSalesText,
    Store,
    store
  };
}

