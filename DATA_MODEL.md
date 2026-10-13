# UBER_LOG データモデル（DATA_MODEL）

UBER_LOG の数字（売上・必要経費・利益・件数・時間・距離・稼働日・休み）の **正式な定義** と、データの入口・保存・同期・集計のルール。
コードを変えるときはこの文書を基準にし、定義を変えるときはこの文書とテスト（`tools/data-audit/spec/data-model-tests.js`）を同時に直す。
フィールド名は実際のコード（`js/store.js`・`js/cloud-sync.js`・`tools/official-import/lib/pipeline.js`）の名前。

---

## 0. データの置き場所と「正本」

| 置き場所 | 中身 | 誰が書くか |
|---|---|---|
| 同梱データ `js/store.js` の `CONFIRMED_SEED_DATA.dailyLogs` | Uber 公式の確定実績（trip・件数・距離・売上・クエスト・調整）。経費は 9/18〜9/22 の旧データだけ | 公式取込（`tools/official-import`）が commit する |
| 端末 `localStorage['uber_log_v1_data']` | アプリが実際に使う日別データ一式（同梱データ ＋ 端末で入力した経費・稼働セッション・手動タップ・○×評価 等） | アプリ（`store.saveToStorage` / `persistState`） |
| クラウド Supabase `uber_daily_logs`（`user_id`・`date`・`data`） | 端末の日別データの写し。ログインしている端末どうしで共有 | `cloud-sync.js`（ログイン時のみ） |
| 端末 `localStorage` のその他 | `uber_log_trip_evaluations`（○×評価）・`uber_log_trip_map_memos`・`uber_pending_sync_dates`（未送信の日） | アプリ |

- IndexedDB は使っていない。
- **画面が読むのは端末のメモリ上の `store.state.dailyLogs` だけ**。起動時に `localStorage` を読み、同梱データで不足を補い（`loadFromStorage`）、ログインしていればクラウドと統合する（`cloudSync.pullAndSync`）。
- **正本**: Uber 公式の実績（trip・件数・距離・売上）は同梱データ、経費などの手入力は端末（ログイン時はクラウドとの和集合）。
  したがって **経費は同梱データには基本的に入っていない**。PC の開発環境やテストで同梱データだけを見ると、経費は 0 円に見える。
  実際の経費を確かめるには、その端末で `diag.html` を開くか、アプリの「バックアップ書き出し」の JSON を
  `node tools/data-audit/data-integrity-audit.js --file <JSON>` で調べる。

## 1. 1日のデータ（`dailyLogs['YYYY-MM-DD']`）

| フィールド | 意味 | 管理 |
|---|---|---|
| `date` | 日付（日本時間の暦日。キーと同じ） | — |
| `deliveries[]` | **トリップ**の明細（1要素＝1トリップ。名前は旧来のまま）。`id`・`fee`（配達の最終売上・チップ込み）・`tip`・`baseFee`・`points`（そのトリップの配達数。ダブル=2）・`distanceKm`・`durationStr`・`restaurant`・`area`・`completedAt` 等 | 公式 |
| `deliveries[].evaluation` / `evaluationReason` / `mapMemo` | ○×評価・メモ | 手動 |
| `deliveriesCount` | **配達件数**（公式日は `points` の合計） | 公式 |
| `tripsCount` | トリップ数（`deliveries.length`） | 公式 |
| `officialPoints` | Uber のポイント合計（公式日は `deliveriesCount` と同じ） | 公式 |
| `totalDistanceKm` | 配達距離（トリップ距離の合計） | 公式 |
| `quests[]` | クエスト（`amount`・`questType: 'special'` は特別クエスト・`isDuplicateIgnored` は重複表示） | 公式 |
| `adjustments[]` | Uber の調整イベント（`amount` は符号付き） | 公式 |
| `sales.delivery` / `quest` / `adjustment` / `other` / `guaranteeBonus` | 売上の内訳（下記 §2） | 公式（`other`・旧取込は手動） |
| `sales.tip` | うちチップ（旧売上テキスト取込で日合計だけ登録した日。`delivery` に含まれる額） | 手動 |
| `sales.total` | 保存された総売上（**派生値**。表示・集計には使わず毎回計算する） | — |
| `expenses[]` | 経費（`id`・`category`・`amount`・`memo`・`createdAt`・`updatedAt`） | 手動 |
| `deletedExpenseIds[]` | 削除した経費の ID（同期で復活させないための記録） | 手動 |
| `workSessions[]` / `workStartedAt` / `workEndedAt` | 稼働開始・終了の記録 | 手動 |
| `workMinutes` | 旧来の稼働分（集計には使わない。配達時間は §6） | 手動 |
| `manualTapsArchive[]` | 公式データで置き換えた手動タップの退避 | 手動 |
| `vehicleType` | 移動手段 | 手動 |
| `dayOff: true` | 手動の休み | 手動 |
| `officialImport` | 公式取込で反映した日の印（`source`・`importedAt`） | 公式 |
| `manualUberSales` / `manualQuest` | 旧来の手入力売上（`sales` が無い日だけ使う） | 手動 |

- 天気（`weather`）はまだ無い。追加するなら手動項目（または取得元を `source` に持つ項目）として持ち、§10 の同期ルールで残る。

## 2. 売上（日別の計算は `store.getCalculatedMetrics`）

| 項目 | 定義 |
|---|---|
| 配達報酬 | `deliverySales − tipSales`（チップを除いた配達の売上） |
| チップ | `tipSales` ＝ 各トリップの `tip` の合計。トリップごとの `tip` が無い日（旧取込）は `sales.tip`。公式取込の日は `sales.tip` を使わない |
| クエスト | `questSales − specialQuestSales`（通常クエスト） |
| 特別ボーナス | `guaranteeBonus`（新規ドライバー保証等）＋ `specialQuestSales`（`questType: 'special'`） |
| 調整 | `sales.adjustment`（**符号付き**。マイナスを絶対値にしない） |
| その他 | `sales.other`（上のどれにも入らない Uber 収入。旧売上取込・手入力。公式取込は新しい日に 0 を入れ、既存の値は保持） |
| 総売上 | 下の不変条件 |

`deliverySales` は `sales.delivery`（無ければトリップの `fee` 合計 → `manualUberSales`）。`fee` は **チップ込み** の最終売上。

**不変条件（売上）**

```
総売上 = 配達報酬 + クエスト + 特別ボーナス + チップ + 調整 + その他
       = sales.delivery + sales.quest + sales.adjustment + sales.other + sales.guaranteeBonus
```

チップは `sales.delivery`（＝ `fee` の合計）の内数なので、総売上に **別に足さない**。同じチップを `delivery`・`tip`・`other` の複数に入れない。

旧売上テキスト取込（設定 → 取込画面。`parseUberSalesText`）のチップ:
- A: 元テキストの総売上 ＝ 配達 ＋ クエスト ＋ 調整 → 配達の行はチップ込み（配達報酬はそのまま・うちチップ ＝ チップ）
- B: 総売上 ＝ 配達 ＋ クエスト ＋ 調整 ＋ チップ → 配達の行はチップ別（配達報酬 ＝ 配達 ＋ チップ・うちチップ ＝ チップ）
- C: 判定できない → 自動では入れない（画面に警告）。チップを「その他」には入れない。調整の行はマイナスを保つ。

## 3. 必要経費・利益

- **必要経費** ＝ 対象期間の `expenses[]` のうち `amount > 0` のものを **1件1回ずつ** 合計（種類 `category` に関係なく全部。バイクシェア・必要経費・駐輪・交通費・旧カテゴリ「バイクシェア利用」等）。
  0円・マイナス・数値でない経費は入れない（監査で検出する）。
- 種類別の内訳（`expenseByCategory`）や「バイクシェア等」（`bikeExpenses`。履歴の B バッジと同じ `isBikeExpense`）は参考表示で、合計には影響しない。
- **利益** ＝ 総売上 − 必要経費（日別・今週・先週・今月・期間指定・全期間ですべて同じ）。日別で売上が無い日（経費だけの日）の日別利益は `--`、期間の利益には経費が引かれる。

## 4. 効率指標（v37 のルール）

```
通常売上（regularSales / hourlyBaseSales） = 配達報酬 + チップ + 通常クエスト + 調整
                                          = deliverySales + questSales − specialQuestSales + adjustmentSales
（特別ボーナス = guaranteeBonus・特別クエスト と、その他 sales.other は含めない）
平均日給 = 通常売上 ÷ 稼働日数
平均単価 = 通常売上 ÷ 配達件数（ホームの「1件平均」・履歴の「平均単価」も同じ）
時給     = 通常売上 ÷ 配達時間（日別比較は10円単位に丸める）
```

0 で割るときは `null`（画面は `--`）。

## 5. 件数（deliveries / trips / pickups）

- **配達件数** ＝ `deliveriesCount`（無い日は `deliveries.length`）。公式日は `points` の合計（ダブル = 2）。例: 27 trips / 30 deliveries の日は配達件数 30。
- **トリップ数** ＝ `tripsCount`（`deliveries.length`）。画面では「◯トリップ」と書き、配達件数と混ぜない。
- **ピックアップ** ＝ 店舗マップ（`data/uber_pickup_stores.json`）の `pickup_count`。トリップ単位で店舗に数える別の概念。
- 期間の配達件数・トリップ数は **稼働日（§8）だけ** を合計する（店舗名も報酬もない手動タップだけの日は入れない）。
- 目標クエストの進捗は期間内のトリップの `points`（無ければ1）を数える。
- 既知の旧データ差異（変更しない）: 2026-09-14（配達件数 4 / ポイント 5）、2026-09-16（8 / 10）。「配達件数＝ポイント合計」は v21 以降と公式取込日に適用。

## 6. 配達時間

- ＝ その日の全トリップの `durationStr`（Uber の Delivery 詳細の所要時間）の合計（`workSeconds`）。全トリップの時間が揃った日だけ確定（揃わなければ `null`）。
- オンライン時間・稼働セッションの時間ではない（稼働セッションは `workSessions[]`）。
- 表示は `HH:MM`（2桁ゼロ埋め・秒は切り捨て。`formatMinutesHHMM`）。ホーム・履歴・分析で同じ。

## 7. 配達距離

- ＝ `totalDistanceKm`（公式日はトリップの `distanceKm` の合計。Uber が各トリップに表示する距離）。
- 空走・帰り道・オンライン中の移動を含む全走行距離ではない（実測データが無いので推測しない）。
- 既知の旧データ差異: 2026-09-19（70.18km / トリップ合計 70.22km）。

## 8. 稼働日・稼働日数

- **稼働日**（`store.isWorkedDay`）: 次のいずれか — `deliveriesCount > 0` または `tripsCount > 0`／店舗名か報酬のある配達が1件以上／配達売上 > 0。
  稼働開始時刻・稼働セッション・手動タップだけ・経費だけの日、空のレコードは稼働日ではない。
- **稼働日数（今月）** ＝ 当月1日〜今日の稼働日の数 / 当月1日〜今日の日数（今日は 0 件でも分母に入る。未来日は入れない）。例 `11 / 13日`。休みの数から逆算しない。

## 9. 休み（`store.getDayStatus`）

- `worked`: 稼働日。
- `off`（`statusSource: 'manual'`）: `CONFIRMED_DAY_OFF_DATES` または `dayOff: true`。自動処理で変えない。
- `off`（`statusSource: 'auto'`）: Uber 運用開始日以降・今日より前・その日より後の日まで公式データあり・その日の Uber 実績なし。**保存せず毎回判定**（後から公式実績が入れば自動で解除）。
- それ以外（今日・未来日・公式データがまだ無い期間）は `unknown`（空欄）。

## 10. 公式管理データと手動管理データ・同期のルール

**公式管理**（公式取込・同梱データが正）: `deliveries[]`（trip）・`deliveriesCount`・`tripsCount`・`officialPoints`・`totalDistanceKm`・`quests[]`・`adjustments[]`・`sales.delivery/quest/adjustment/other/total`・`officialImport`。
**手動管理**（端末・クラウドが正）: `expenses[]`・`deletedExpenseIds[]`・`workSessions[]`・`dayOff`・`vehicleType`・`manualTapsArchive[]`・○×評価・メモ・`sales.tip`（旧取込）・今後の天気等。

- **公式取込（同梱データの更新）**: `pipeline.js` は既存の日を丸ごと置き換えず、trip を ID で照合して公式項目だけを更新する（同じ日を何度取り込んでも同じ結果・trip/売上/チップ/クエスト/調整は二重にならない）。
- **端末への反映**（`syncOfficialImportedDay`）: 公式項目だけを同梱データに合わせ、手動項目には触らない。公式に無い手動タップは削除せず `manualTapsArchive` へ退避。
- **端末内の保存**（`persistState` / `mergeDayUserData`）: 保存済みと日ごとに統合（経費は ID 単位の和集合・削除済みは復活させない）。
- **クラウド同期**（`cloudSync.mergeDailyLog`）: 片方にしか無い日はそのまま採用。両方にある日は、個別ルールのある項目（trip は ID 単位・経費は ID 単位の和集合＋tombstone・稼働セッション・クエスト・調整・売上は `updatedAt` の新しい側）以外の **すべての項目を残す**（同じ項目は端末側優先）。
  片方に無いだけで、もう片方の値を 0 や空配列で上書きしない。
- **過去日の編集**: 経費・稼働等の変更は、その **対象日** を同期待ち（`uber_pending_sync_dates`）に入れて送る（今日の日付ではない）。
- 端末に残っている旧来の誤ったデータは自動で書き換えない（必要なときは before / after・根拠・影響日数・金額を確認してから）。

## 11. 期間集計（`store.aggregateForRange(startDate, endDate)`）

今週・先週・今月・期間指定（`getSalesBreakdown`）・全期間（`getAnalytics`）はすべてこの1つの関数で集計する（両端を含む・`null` は制限なし）。
日別の `getCalculatedMetrics` をそのまま合計するので、日別の表示と期間の表示は同じ定義になる。

| 期間 | 範囲 |
|---|---|
| 今週 | 今日を含む週の **月曜〜今日**（表示の期間ラベル・振込予定日は月曜〜日曜） |
| 先週 | その前の月曜〜日曜 |
| 今月 | **当月1日〜今日**（未来日は含めない） |
| 過去月（期間指定で月を選んだとき） | 月初〜月末 |
| 期間指定 | 指定した開始日〜終了日（初期値は今月1日〜今日） |
| 全期間 | 制限なし |

主な出力: `totalSales`・内訳（`baseDeliverySales`・`questSales`・`guaranteeBonus`・`tipSales`・`adjustmentSales`・`otherSales`）・`expenses`・`expenseByCategory`・`profit`・`deliveriesCount`・`tripsCount`・`workedDays`・`workSeconds`・`durationHHMM`・`distanceKm`・`regularSales`・`avgDailyEarnings`・`avgPerDelivery`。
画面（`ui.js`）は集計済みの値を表示するだけにし、売上・件数・経費を自前で足し算しない。

## 12. 日付・タイムゾーン

- 基準タイムゾーンは **日本時間（Asia/Tokyo）**。`getTodayDateString()`・`getCurrentTimeString()` は端末のタイムゾーン設定に関係なく日本時間で返す。
- 日付は `YYYY-MM-DD` の文字列で持ち、比較は文字列で行う。`YYYY-MM-DD` を `new Date('YYYY-MM-DD')`（UTC 解釈）で読まない（年月日に分けて `new Date(y, m-1, d)`）。
- 時刻つきの比較（目標クエスト）は `+09:00` を付けて読む。
- 週は月曜始まり（`getWeekRange` / `getPreviousWeekRange`）。日付の区切りは日本時間の0時。

## 13. 保存する値と計算する値

- 保存: 公式の生データ（trip・件数・距離・クエスト・調整・売上内訳）と手入力（経費等）。
- 計算（保存しない）: 総売上・利益・平均・時給・配達時間の合計・期間の合計・休み（自動）・稼働日数。
- 例外として残っている保存値: `sales.total`（旧来・公式取込が書く）、`sales.regularTotal`（9/19）。表示・集計には使わず、監査で内訳との一致だけを確かめる。

## 14. 不変条件（テスト・監査で確かめる）

1. 総売上 ＝ 配達報酬 ＋ クエスト ＋ 特別ボーナス ＋ チップ ＋ 調整 ＋ その他（日別・すべての期間）
2. 保存された `sales.total` ＝ `delivery + quest + adjustment + other + guaranteeBonus`
3. 利益 ＝ 総売上 − 必要経費、必要経費 ＝ 期間内の全経費（`amount > 0`）を1件1回
4. 期間の値 ＝ 日別の値の直接合計（月・週・全期間・今月・今週・先週）
5. 配達件数 ＝ `deliveriesCount`、トリップ数 ＝ `tripsCount`（公式日は件数 ＝ ポイント合計・トリップ数 ＝ 明細の数・配達報酬 ＝ `fee` の合計）
6. 調整イベントの合計 ＝ `sales.adjustment`（符号付き）
7. 今月 ＝ 月初〜今日・今週 ＝ 月曜〜今日（期間外・未来日が混ざらない）
8. 経費 ID・トリップ ID は重複しない。削除済み（`deletedExpenseIds`）の経費が残らない
9. 数値項目に NaN / Infinity / 数値でない文字列が無い。日付は実在する `YYYY-MM-DD`
10. 未来日に実績・売上が無い

- テスト: `tools/data-audit/spec/data-model-tests.js`（人工データ）、`tools/official-import/spec/run-tests.js`（実データ・取込）、`tools/official-import/spec/sync-tests.js`（同期）
- 監査: `node tools/data-audit/data-integrity-audit.js [--file バックアップ.json] [--today YYYY-MM-DD]`
- 端末の診断: `diag.html`（読み取り専用・外部送信なし。アプリからはリンクしていない）
