# RESUME（作業が途中で止まったときの再開手順）

## いまの作業
v80「同期の最終監査（9/19 vehicleType の競合・端末/クラウドの日数差）」。進み具合は WORK_PROGRESS.md の表。

## 再開するとき
1. `git status` / `git log --oneline -10` で、WORK_PROGRESS.md の最後の「完了」フェーズの commit があるか確認する。
2. 未コミットの変更があれば `git diff` で中身を確認する（そのフェーズの途中。消さない）。
3. WORK_PROGRESS.md で「作業中」「未着手」の最初のフェーズから続ける。
4. 各フェーズの終わりに: テスト → WORK_PROGRESS.md / RESUME.md 更新 → ローカル commit。
5. リリース（v80）と push は、全フェーズ完了・`node tools/release-check/run-all.js` が failed 0 のときだけ。

## 守ること
- v79 までの機能（pull-first・自動同期・経費 ID マージ・tombstone・手動休み・天気・評価/メモ・公式値の巻き戻り防止・取込画面・稼働/休み）は作り直さない。
- ユーザーデータを消さない・一括で書き換えない（9/19 の値も、同義の旧名称として比べるだけ。保存値は変えない）。空の日も消さない。
- 「同梱データ」「PC/OPPO のランタイムデータ」「クラウド」を混同しない。実機を見ていないのに「実機で確認済み」と書かない。
- 31 / 29 / 26 という数字をテストに書かない（意味と構造をテストする）。
- バックアップ: ローカルブランチ `backup/pre-v80-sync-final-audit`（v79 = 302baa8）。

## 現在地
フェーズ0〜20 完了（コード・diag・テスト・DATA_MODEL/SYNC_MODEL・監査）。次はフェーズ21-28（画面確認・run-all・v80 リリース・HANDOFF 両方・push）。
