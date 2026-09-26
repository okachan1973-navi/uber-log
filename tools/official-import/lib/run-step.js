/**
 * 既存パイプライン（lib/pipeline.js）の1ステップを子プロセスで実行し、結果をJSONで標準出力へ返す。
 * ローカルbackend（server.js）が画面を止めずに既存の取込処理を呼ぶための薄い入口。取込ロジック自体は持たない。
 *
 *   node lib/run-step.js <prepare|validate|apply|report> <YYYY-MM-DD> [root]
 */
'use strict';

const path = require('path');
const pipeline = require('./pipeline.js');

const [step, date, rootArg] = process.argv.slice(2);
const root = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..', '..', '..');

function stagingView(st) {
  return {
    status: st.validation.status,
    checks: st.validation.checks,
    errors: st.validation.errors,
    warnings: st.validation.warnings,
    summary: st.summary,
    questDuplicateCandidates: st.questDuplicateCandidates || [],
    deliveries: (st.deliveries || []).map(d => ({
      id: d.id,
      file: d.screen && d.screen.file,
      time: d.screen && d.screen.time,
      amount: d.screen && d.screen.amount,
      map: d.map ? { status: d.map.status, reason: d.map.reason || '' } : null
    })),
    changed: st.plan ? st.plan.changed : null,
    isNewDay: st.plan ? st.plan.isNewDay : null
  };
}

try {
  let out;
  if (step === 'prepare') {
    const r = pipeline.prepare(root, date);
    out = { files: r.files, pending: r.pending, summary: r.summary, warnings: r.parsed.warnings };
  } else if (step === 'validate') {
    out = stagingView(pipeline.buildStaging(root, date));
  } else if (step === 'apply') {
    const r = pipeline.apply(root, date);
    out = { applied: !!r.applied, unchanged: !!r.unchanged, version: r.version || null, addedMaps: r.addedMaps || [], staging: stagingView(r.staging) };
  } else if (step === 'report') {
    out = pipeline.report(root, date);
  } else {
    throw new Error(`不明なステップ: ${step}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, result: out }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 1;
}
