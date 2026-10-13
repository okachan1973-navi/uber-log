# WORK_PROGRESS（v79 同期の一本化）

作業の進み具合。各フェーズの終わりに更新してローカル commit する（push はリリース時だけ）。
再開手順は RESUME.md。

- 開始: 2026-10-14 / 起点 v78（97ec358）/ バックアップ: ローカルブランチ `backup/pre-v79-sync-overhaul`（push しない）
- 目的: OPPO・PC・クラウドのデータを一本化し、どの端末でも同じ数字にする（通常は同期ボタン不要）

| # | フェーズ | 状態 | commit | メモ |
|---|---|---|---|---|
| 0 | 準備（バックアップ・進捗ファイル） | 完了 | — | |
| 1 | 同期構造の監査 | 完了 | （この commit） | 下の「監査の結果」 |
| 2-4 | 正本の明文化・pull-first・merge ルール | 完了 | （この commit） | 公式値=新しい officialImport・評価/メモ/手動項目=更新時刻・競合の記録・同期状態の記録・定期同期60秒 |
| 5-8 | 自動同期・OPPO/PC 運用・同期表示 | 完了 | （この commit） | ヘッダー「同期済み HH:MM」・問題時だけ 未送信あり/同期できません/競合あり・オフライン時の未送信表示 |
| 10-11 | 版の違いの表示・Supabase ライブラリ固定 | 完了 | （この commit） | 自動再読込をやめ「新しい版があります［更新する］」・supabase-js 2.117.3 固定＋SRI（ブラウザで読込確認） |
| 12 | diag.html 強化 | 完了（画面確認はフェーズ19） | （この commit） | 版・ログイン・端末ID・最終pull/push・結果・エラー・未送信日数/件数・競合・端末/クラウド日数・天気件数 |
| 13 | 2端末同期テスト | 完了 | （この commit） | sync-model-tests.js 33項目（run-all に追加）。v78 のコードでは 評価が古い値に戻る・古い PC が公式値を 21→17trip に巻き戻す ことを再現、v79 で解消 |
| 15 | 天気の自動更新 | 未着手 | | |
| 17-18 | DATA_MODEL / SYNC_MODEL・監査スクリプト | 未着手 | | |
| 19-23 | 画面確認・全体テスト・HANDOFF・リリース・push | 未着手 | | |

## フェーズ1 監査の結果（v78 時点のコード）

起動順: index.html → store.js（localStorage を読み、同梱データで不足を補完: loadFromStorage）→ cloud-sync.js（DOMContentLoaded 後に pullAndSync）→ app.js / ui.js が描画。
- pull: 起動時・ログイン時（onAuthChange）・画面復帰（visibilitychange）・online 復帰・表示中は5分ごと・設定の「今すぐ同期」。全日の行を取得して日ごとに mergeDailyLog → persistState。
- push: ローカル保存（saveToStorage(日付)）で対象日を pendingSyncDates（localStorage）に入れ、700ms 後に送信。送信前にクラウドの同じ日を取得して merge してから upsert（日付単位）。
  pull の後にも未送信の日だけ push（＝ pull-first は既にほぼ成立。未送信の日以外は送らない）。失敗時は pending を残して次回再送。
- 経費: ID 単位の和集合・同じ ID は updatedAt の新しい方・deletedExpenseIds（tombstone）は和集合で復活しない（正しく動く）。
- 問題（今回直す）
  1. ○×評価・理由: 端末ごとの localStorage（uber_log_trip_evaluations）が起動時に毎回 deliveries へ上書きされる → 別端末の新しい評価を同期で受け取っても、次の起動で古い評価に戻る。trip 側に更新時刻が無く、merge は端末側が常に勝つ。
  2. MAP 一口メモ: setTripMapMemo が保存（saveToStorage）を呼ばない → クラウドへ送られない（端末内だけ）。
  3. 公式値の新旧: mergeDailyLog は件数・距離・売上を「端末側優先」、loadFromStorage は同梱データの公式値で常に上書き → 古い版の同梱データ（古い端末）が新しい公式値を巻き戻す余地がある（officialImport.importedAt を比べていない）。
  4. 手動の日別項目（dayOff・weather・vehicleType）: 両端末で違う値のとき端末側が常に勝つ。更新時刻が無く、競合を記録しない。
  5. 同期状態: 最終 pull / push 時刻・結果・エラー・クライアント識別を保存していない（diag で見られない）。定期同期は5分。
  6. 版の違い: app.js の更新チェックは新しい版を見つけると自動で再読込する（入力中でも）。
  7. Supabase ライブラリ: `@supabase/supabase-js@2`（メジャーだけ指定）。現在の実体は 2.117.3（dist/umd/supabase.js。既定 URL は同じファイルに jsDelivr の注釈を付けたもの）。
- 同梱データ（PC の js/store.js）・PC/OPPO のランタイム（各端末の localStorage）・クラウド（Supabase）は別物。OPPO の 10月必要経費 ¥16,797 はユーザーが実機の diag で確認したもの（コードからは見られない）。

## 保留（ユーザー確認が必要）

（なし）
