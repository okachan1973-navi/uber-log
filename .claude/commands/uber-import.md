---
description: Uber公式データ（アクティビティ一覧＋Delivery詳細スクショ）をUBER_LOGへ取り込む（照合・検証・反映・HANDOFF・commit/push）
argument-hint: YYYY-MM-DD
---

# UBER_LOG 公式取込: $ARGUMENTS

対象日 `$ARGUMENTS` の公式データを `tools/official-import/inbox/$ARGUMENTS/` から UBER_LOG へ取り込む。
仕組みの詳細は `tools/official-import/README_JA.md` と正本 `C:\Users\okano\Desktop\UBER_HANDOFF.txt`（「公式取込v1」節）を参照。

## 絶対ルール
- 一次情報は Uber 公式の一覧テキストとスクショのみ。推測・逆算・補完・別日コピーは禁止。読めない値は `"UNKNOWN"` のまま残して止める。
- 検証が FAIL したら UBER_LOG 本体（`js/store.js`・`js/trip-maps.js`・`assets/maps`）を手で直して通そうとしない。ズレた項目だけをユーザーへ報告して終了する。
- 経費（バイクシェア・必要経費）はこの取込で入力しない（アプリの稼働画面で入力するもの）。Uberの「調整」は経費ではなく売上の「その他」。
- 生データ（`inbox/`・`staging/`）はコミットしない。reset --hard / force push / revert / stash / checkout による上書きは禁止。既存の未コミット変更は消さない。
- 配達先は丁目まで。注文者名・部屋番号・番地・電話番号は記入しない。

## 手順
1. **現状確認**: `git status` と `git log -n 3 --oneline`。未コミット変更があれば内容を確認し、消さずにユーザーへ伝える（取込に無関係ならそのまま続行してよい）。
2. **準備**: `node tools/official-import/import.js prepare $ARGUMENTS`
   - `activity.txt` が無い／Delivery 0件なら、取込補助画面（`tools/official-import/index.html`）で保存するよう伝えて終了。
3. **スクショ読取**: `tools/official-import/staging/$ARGUMENTS.screens.json` を開き、`screenshots` の各ファイル（`tools/official-import/inbox/$ARGUMENTS/screenshots/` 内）を Read ツールで1枚ずつ実際に見て記入する。
   - `date`（見出しの日付）、`time`（見出しの時刻・24時間表記 例: 午後12時53分 → `12:53`）、`amount`（見出し金額＝最終売上）
   - `durationStr`（時間 例: `52分31秒`）、`distanceKm`（距離の数値 例: `6.81`）、`points`（「Nポイントを獲得」のN）
   - `restaurant`（店舗名・表示どおり）、`area`（配達先・丁目まで。先頭の `27` などの都道府県コードは除く）
   - 売り上げ欄にチップがある場合のみ `baseFee`（料金）と `tip`（チップ）を数値で。無ければ `null`
   - Delivery詳細でない画像は `kind` を `"summary"`（1日の合計画面 → `daySummary` に `points`・`distanceKm`・`durationStr`・`total` を記入）または `"other"` にする
   - 1項目でも読めない・自信がない場合は `"UNKNOWN"` のまま残す（validate が止めてくれる）
   - スクショが多い場合も、必ず全枚数を読む（サンプリング禁止）
4. **検証**: `node tools/official-import/import.js validate $ARGUMENTS`
   - FAIL → ❌ の項目（何がズレたか）だけを簡潔に報告して終了。ユーザーの判断が必要なものは、`inbox/$ARGUMENTS/decisions.json` の書き方（README_JA.md「確認が必要なとき」）を添える。
   - PASS → 次へ。
5. **反映**: `node tools/official-import/import.js apply $ARGUMENTS`（「変更なし（取込済み）」なら 8 のコミットは不要。結果だけ報告）
6. **テスト**: `node tools/official-import/import.js test` → 全PASSを確認。1件でも FAIL なら commit せず報告。
   ※ テスト10節は既存確定値（9/22まで）の回帰確認。新しい日の取込で週次・月次の値が変わる場合はテストの期待値ではなく実装の問題かを確認し、正しい確定値であれば期待値を更新する（本体データを古い数字に戻さない）。
7. **HANDOFF**: `node tools/official-import/import.js report $ARGUMENTS` の数値で `C:\Users\okano\Desktop\UBER_HANDOFF.txt` を更新する。
   - 冒頭の「最終更新日時」「最新状態」、「日別実績確定データ一覧」に対象日の行（配達件数・トリップ・売上内訳・配達時間・距離・MAP）を追加／更新、進行中の週・月累計・クエスト進捗・MAP登録数、バージョン表記（sw.js / version.json）を更新。
   - 経費（Bike等）はアプリ側入力のため、ユーザーから金額を聞いていない場合は「経費: アプリ入力分（HANDOFF未把握）」と書き、推測で書かない。
   - 保存後、リポジトリ内 `HANDOFF.md` へ同じ内容をコピーし（`Copy-Item C:\Users\okano\Desktop\UBER_HANDOFF.txt HANDOFF.md -Force`）、正本を再読込して確認する。
8. **commit / push**: `git status` → 取込で変わったファイル（`js/store.js`・`js/trip-maps.js`・`assets/maps/*`・`index.html`・`sw.js`・`version.json`・`HANDOFF.md`）だけを `git add` → `git commit -m "data($ARGUMENTS): official import (<N> trips, <総売上>)"` → `git push` → `git status` が clean であることを確認。
9. **報告**: 次の形式で簡潔に。
   ```
   YYYY/MM/DD 公式取込
   Delivery: N trip
   配達: N件
   配達報酬: ¥
   Quest: ¥
   Adjustment: ¥
   総売上: ¥
   距離: km
   配達時間: H:MM:SS
   MAP: n/N
   VALIDATION: PASS
   ```
   ＋ 今週・今月の売上／80件クエスト等の進捗（report の値）、注意事項（警告があれば）、commit ID。
