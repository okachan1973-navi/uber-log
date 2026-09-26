# UBER_LOG 公式取込

**通常はデスクトップの「UBER_LOG」を開き、画面上の「取り込み実行」だけを使います。**

## 【毎日の操作】

① デスクトップの「UBER_LOG」をダブルクリック

② 日付を確認

③ Uber一覧を貼る

④ スクショを全部ドラッグ

⑤ 「取り込み実行」

以上。

- PowerShell 不要 / Claude Code の手動起動 不要 / `/uber-import` の入力 不要
- 「取り込み実行」を押すと、保存 → 一覧解析 → スクショ確認 → MAP作成・検証 → UBER_LOG反映 → テスト → HANDOFF記録 → 保存（commit・push）まで自動で進み、最後に結果が表示されます。
- 結果画面の「UBER_LOGを見る」で、同じPCの UBER_LOG（http://localhost:8088/）が開きます。
- 確認が必要なこと（地図が切れたスクショ、読めない項目、スクショの過不足など）があると、UBER_LOG には何も反映せずに画面へ表示します。
  - 地図が切れている → 「スクショを追加する」で撮り直した画像を入れ、切れた画像は × で外して、もう一度「取り込み実行」。MAPなしで良ければ「MAPなしで取り込む」。
  - 読めない・Delivery詳細でない画像 → × で外すか差し替えて、もう一度「取り込み実行」。
- 同じ日を何度「取り込み実行」しても二重登録にはなりません（取込済みなら「変更なし」と表示）。
- 日付を選ぶと、その日に保存済みの一覧・スクショが自動で読み込まれます（追加・差し替えだけで再実行できます）。
- スクショは **Delivery 詳細の部分だけ**を切り取ってください（Win + Shift + S）。
- バイクシェア・必要経費は、今までどおりスマホの「稼働」画面で入力します（この取込では入力しません）。

### 初回だけ

デスクトップに「UBER_LOG」が無い場合は、次を1回実行するとショートカットが作られます（保守用）。

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\official-import\install-shortcut.ps1
```

### しくみ（PCローカル専用）

- ショートカット → `launcher.vbs`：UBER_LOG用のローカルサーバー（`server.js`・Node.js）が未起動なら画面を出さずに起動し（起動済みなら二重起動しない）、取込画面を既定のブラウザで開きます。
- サーバーは `127.0.0.1` / `::1`（このPCの中）だけで待ち受け、LAN・インターネットには公開しません。取込画面と通常の UBER_LOG を同じサーバーから配信します。
- スクショ確認は Claude Code を画面を出さずに自動で呼び出します（読取専用。ユーザーの操作は不要）。Claude Code が入っていない場合は画面にその旨を表示して止まります。
- ログ: `tools/official-import/logs/server.log`（Git管理外）
- 以前に手動で起動していた `python -m http.server 8088` は不要です（動いているとポートが重なるため、UBER_LOG を開くとその旨を表示します）。
- スマホの UBER_LOG（GitHub Pages 公開版）はこれまでどおりで、このローカルサーバーには依存しません。

## 保守用（通常は使わない）

- Claude Code で `/uber-import YYYY-MM-DD`（`.claude/commands/uber-import.md`）… 従来の対話型取込
- `tools/official-import/run-latest-import.ps1` … inbox の最新日付で `/uber-import` を開始する対話型の入口（v25 の UBER取込.cmd の本体。cmd は v26 で廃止）
- `node tools/official-import/import.js prepare|validate|apply|report YYYY-MM-DD` / `test`
## 止まったとき

検証で1つでもズレがあると、UBER_LOG には何も反映せずに止まり、ズレた項目だけが画面に表示されます。

| よくある原因 | 対処 |
| --- | --- |
| スクショが足りない／多い | 足りない Delivery 詳細を撮って保存し直す |
| 一覧に別の日付が混ざって日付が読めない | 日付の行も含めてコピーし直す |
| 地図が画像の端で切れている | そのスクショを撮り直す（MAPなしで良い場合は下の `mapMissingOk`）。地図の左右に白い余白が1pxもなく端に接している画像は、数px欠けていても止まる。画面の表示倍率・スクショの横幅が違うだけ（例: 地図 378x210）なら縦横比 420:233 で自動判定されるので撮り直し不要 |
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
- クエストの達成表示（例: 19:15「80 回乗車クエスト ¥8,890」）と、その後の売上計上（例: 19:23「クエスト ¥8,890」）は、同じ日・同じ金額・計上が達成の0〜60分後の組だけを同一報酬として1回計上（1対1・最も近い時刻）。
- 20回以上の回数クエスト（例: 80回乗車クエスト）は「特別クエスト」（questType: special）として保存し、画面では 🏆 で表示。会計上はクエスト報酬に含む。
- 同じDeliveryを2回撮ったスクショ（時刻・金額・時間・距離・ポイント・店舗・配達先がすべて一致）は1枚として扱い、地図が切り抜ける方を MAP に使う。同じ時刻・金額でも中身が違えば別Deliveryとして止める。
- 調整（Support Adjustment など）はプラスもマイナスも売上の「その他」。経費ではない。公式名称はそのまま保持。
- 同じ日を何度取り込んでも二重登録しない。既存の trip ID・○×評価・評価理由・MAPメモ・経費・既存MAPはそのまま。
- MAP は公式スクショから既存と同じ 420×233 で切り抜くだけ（生成・加工しない）。既存 MAP は上書きしない。
- 配達先は丁目まで。番地・部屋番号などが入っていると止まる。

## フォルダ構成

```
tools/official-import/
  README_JA.md          この説明
  index.html            公式取込画面（「取り込み実行」）
  server.js             ローカルサーバー（127.0.0.1 / ::1 のみ・画面配信と取込API）
  launcher.vbs          デスクトップ「UBER_LOG」から起動（サーバー起動確認＋画面表示）
  install-shortcut.ps1  デスクトップにショートカットを作成（初回のみ）
  uber-log.ico          ショートカットのアイコン
  import.js             コマンド（保守用。/uber-import もこれを使う）
  run-latest-import.ps1 保守用の対話型入口（最新日付で /uber-import を開始）
  lib/
    activity-parser.js  一覧テキスト解析・クエスト重複排除（画面と共用）
    pipeline.js         照合・検証・UBER_LOG への反映
    crop_map.py         公式スクショから MAP を切り抜き（Pillow）
    import-job.js       「取り込み実行」1回分の流れ（保存 → 既存パイプライン → テスト → HANDOFF → commit/push）
    run-step.js         既存パイプラインの各ステップを子プロセスで実行
    screen-reader.js    スクショ読取（Claude Code 非対話・読取専用）
    handoff.js          HANDOFF の「公式取込 自動記録」ブロックの更新
  spec/                 自動テスト（9/21・9/22 の確定データを fixture に使用。server-tests.js は取り込み実行の結合テスト）
  logs/                 ← サーバーログ（Git 管理外）
  inbox/<日付>/         ← 生データ（Git 管理外）
    activity.txt
    screenshots/*.png
    decisions.json      （必要なときだけ）
  staging/              ← 中間データ（Git 管理外）
    <日付>.screens.json  スクショ読取結果（Claude Code が記入）
    <日付>.json          正規化データ＋検証結果
```

`inbox/` と `staging/` は住所などを含み得るため `.gitignore` で除外しています。反映先は既存どおり `js/store.js`（公式データ）・`js/trip-maps.js`・`assets/maps/` です。

## コマンド（保守用。通常は「取り込み実行」が自動で使う）

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
