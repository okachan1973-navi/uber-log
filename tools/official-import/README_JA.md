# UBER_LOG 公式取込 v1

その日の Uber 公式実績（売上・トリップ・距離・時間・MAP）を、長い指示文なしで UBER_LOG へ反映する仕組みです。

## 【毎日】やること

1. Uber のアクティビティ一覧をコピー
2. 取込画面 `tools/official-import/index.html`（Chrome か Edge で開く）に貼り付け
3. Delivery 詳細のスクショを全部ドラッグ
4. ［取込データを保存］
5. `UBER_LOG` フォルダの **UBER取込.cmd** をダブルクリック

これだけです。日付の入力は不要です（保存した一番新しい日付を自動で選びます）。
あとは Claude Code が照合・検証・反映・テスト・HANDOFF 更新・commit / push まで行います。

- 取込中に Claude から質問（MAPが切れている・重複候補など）や許可の確認が出たら、その画面でそのまま答えます。
- 終わったら `/exit` で Claude Code を閉じ、何かキーを押すとウィンドウが閉じます。
- エラー（activity.txt が無い・スクショが0枚・Claude Code が見つからない等）のときは、取込を始めずに理由を表示して止まります。
- 未来の日付のフォルダは自動では選びません（警告を表示）。昨日以前の日を取り込み直したいときは、Claude Code で `/uber-import 2026-09-23` のように日付を指定して実行します。

- 初回だけ、保存先に `UBER_LOG\tools\official-import\inbox` フォルダを選びます（次回からは記憶されます）。
- スクショは今までどおり **Delivery 詳細の部分だけ**を切り取ってください（Win + Shift + S）。画面全体のスクショは止まります。
- バイクシェア・必要経費は、今までどおりスマホの「稼働」画面で入力します（この取込では入力しません）。

## 止まったとき

検証で1つでもズレがあると、UBER_LOG には何も反映せずに止まり、ズレた項目だけが報告されます。

| よくある原因 | 対処 |
| --- | --- |
| スクショが足りない／多い | 足りない Delivery 詳細を撮って保存し直す |
| 一覧に別の日付が混ざって日付が読めない | 日付の行も含めてコピーし直す |
| 地図が画像の端で切れている | そのスクショを撮り直す（MAPなしで良い場合は下の `mapMissingOk`） |
| クエストの重複候補 | 同じ報酬の重複表示か、別報酬かを下の `questDuplicates` で指定 |
| 特別報酬・チップ単独などの未対応項目 | Claude Code に内容を伝えて相談（自動では入れません） |

### 確認が必要なとき（decisions.json）

`tools/official-import/inbox/<日付>/decisions.json` を作ると、確認済みの判断を取込に伝えられます。

```json
{
  "questDuplicates": { "20:09|800": "count_once" },
  "mapMissingOk": ["スクリーンショット 2026-09-23 101010.png"]
}
```

- `questDuplicates`: 同時刻・同額のクエストを `count_once`（1回だけ計上）か `count_all`（全部計上）か
- `mapMissingOk`: 地図が切り抜けないスクショを MAP なしで登録してよい場合のファイル名

## ルール（自動で守られること）

- 一次情報は Uber 公式の一覧とスクショだけ。推測・逆算・補完はしない。読めない値は `UNKNOWN` で止まる。
- 一覧の Delivery とスクショは **日付・時刻・金額が完全一致**したものだけを同じ trip とする（近い trip へ寄せない）。
- クエスト: 同時刻・同額の「クエスト（MISC）」と「N回乗車クエスト（QUEST）」は同一報酬として1回だけ計上。¥0 クエストは売上に入れない。それ以外の重なりは「重複候補」として止める。
- 調整（Support Adjustment など）はプラスもマイナスも売上の「その他」。経費ではない。公式名称はそのまま保持。
- 同じ日を何度取り込んでも二重登録しない。既存の trip ID・○×評価・評価理由・MAPメモ・経費・既存MAPはそのまま。
- MAP は公式スクショから既存と同じ 420×233 で切り抜くだけ（生成・加工しない）。既存 MAP は上書きしない。
- 配達先は丁目まで。番地・部屋番号などが入っていると止まる。

## フォルダ構成

```
tools/official-import/
  README_JA.md          この説明
  index.html            取込補助画面（PC用）
  import.js             コマンド（/uber-import が内部で使う）
  run-latest-import.ps1 UBER取込.cmd の本体（最新日付の判定・事前チェック・Claude Code 起動）
  lib/
    activity-parser.js  一覧テキスト解析・クエスト重複排除（画面と共用）
    pipeline.js         照合・検証・UBER_LOG への反映
    crop_map.py         公式スクショから MAP を切り抜き（Pillow）
  spec/                 自動テスト（9/21・9/22 の確定データを fixture に使用）
  inbox/<日付>/         ← 生データ（Git 管理外）
    activity.txt
    screenshots/*.png
    decisions.json      （必要なときだけ）
  staging/              ← 中間データ（Git 管理外）
    <日付>.screens.json  スクショ読取結果（Claude Code が記入）
    <日付>.json          正規化データ＋検証結果
```

`inbox/` と `staging/` は住所などを含み得るため `.gitignore` で除外しています。反映先は既存どおり `js/store.js`（公式データ）・`js/trip-maps.js`・`assets/maps/` です。

## コマンド（通常は /uber-import が自動実行）

```
node tools/official-import/import.js prepare  2026-09-23   # 一覧解析＋スクショ読取テンプレート作成
node tools/official-import/import.js validate 2026-09-23   # 照合・MAP切り抜き・検証（反映しない）
node tools/official-import/import.js apply    2026-09-23   # 検証 PASS 時のみ反映
node tools/official-import/import.js report   2026-09-23   # 日次・週次・月次・クエスト進捗
node tools/official-import/import.js test                  # 自動テスト
```

必要なもの: Node.js、Python（Pillow）。どちらもこの PC に導入済みです。

## 将来の自動取得について

v1 は「一覧テキスト＋スクショ → 照合 → 検証 → 反映」の受け口です。将来 Uber Web を自動巡回する場合は、

1. アクティビティ一覧のテキストを `inbox/<日付>/activity.txt` に保存
2. 各 View Details 画面の Delivery 詳細を `inbox/<日付>/screenshots/` に保存

するだけで、以降の照合・検証・反映はこのまま使えます（一覧の URL・trip UUID も照合に使えるよう解析済み）。
