# RESUME（作業が途中で止まったときの再開手順）

## いまの作業
v79「同期の一本化（OPPO・PC・クラウド）」。進み具合は WORK_PROGRESS.md の表。

## 再開するとき
1. `git status` / `git log --oneline -10` で、WORK_PROGRESS.md の最後の「完了」フェーズの commit があるか確認する。
2. 未コミットの変更があれば `git diff` で中身を確認する（そのフェーズの途中。消さない）。
3. WORK_PROGRESS.md で「作業中」「未着手」の最初のフェーズから続ける。
4. 各フェーズの終わりに: テスト → WORK_PROGRESS.md / RESUME.md 更新 → ローカル commit。
5. リリース（v79）と push は、全フェーズ完了・`node tools/release-check/run-all.js` が failed 0 のときだけ。

## 守ること
- v78 の機能（稼働/休み・休み自動判定・天気・取込画面の状態・同日再取込・仮の数字なし・途中取込の注意）は作り直さない。
- ユーザーデータを消さない。古い端末のデータで新しいデータを上書きしない。
- 「同梱データ」「PC/OPPO のランタイムデータ」「クラウド」を混同しない。実機を見ていないのに「実機で確認済み」と書かない。
- バックアップ: ローカルブランチ `backup/pre-v79-sync-overhaul`（v78 = 97ec358）。

## 現在地
フェーズ 12 完了（diag.html の同期の状態）。次はフェーズ 13（2端末同期テスト tools/data-audit/spec/sync-model-tests.js。sync-harness.js を使う）。
