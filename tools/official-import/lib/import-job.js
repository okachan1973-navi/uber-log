/**
 * 「取り込み実行」1回分の処理（ローカルbackend から呼ばれる）
 *
 *   保存（inbox/<日付>）→ 一覧解析（prepare）→ スクショ確認（Claude Code 非対話）→ MAP作成・検証（validate）
 *   → UBER_LOG反映（apply）→ テスト → report → HANDOFF 自動記録 → commit → push
 *
 * 取込の判断ロジックは既存の lib/pipeline.js（/uber-import と同じもの）をそのまま使う。
 * 検証が1つでも FAIL なら UBER_LOG 本体には何も書かず「確認が必要です」として画面へ返す。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readScreens } = require('./screen-reader.js');
const { updateHandoff } = require('./handoff.js');

const STEPS = [
  ['save', '保存中'],
  ['parse', '一覧解析中'],
  ['screens', 'スクショ確認中'],
  ['validate', 'MAP作成・検証中'],
  ['apply', 'UBER_LOG反映中'],
  ['test', 'テスト中'],
  ['record', '記録・保存中（HANDOFF・commit・push）'],
  ['done', '完了']
];
const NEEDS_REVIEW_MESSAGE = '確認待ちのため停止しています';
// 取込で変更してよいファイル（これ以外はコミットしない）
const IMPORT_PATHS = ['js/store.js', 'js/trip-maps.js', 'assets/maps', 'index.html', 'sw.js', 'version.json', 'HANDOFF.md'];
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const SCREEN_FIELDS = ['date', 'time', 'amount', 'durationStr', 'distanceKm', 'restaurant', 'area', 'points'];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isUnknown = v => v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim().toUpperCase() === 'UNKNOWN');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, ...(opts.env || {}) } });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: -1, out, err: err + e.message }));
    child.on('close', code => resolve({ code, out, err }));
  });
}

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.') || !IMAGE_EXT.test(base) || /[\\/:*?"<>|]/.test(base)) return null;
  return base;
}

class ImportJob {
  /**
   * @param {{root:string, handoffFile:string, date:string, testCommand?:string[]|'skip'}} opts
   */
  constructor(opts) {
    this.id = `job_${Date.now()}`;
    this.root = opts.root;
    this.handoffFile = opts.handoffFile;
    this.date = opts.date;
    this.testCommand = opts.testCommand || [process.execPath, path.join('tools', 'official-import', 'import.js'), 'test'];
    this.state = 'running'; // running | done | needs_review | error
    this.step = 'save';
    this.message = '保存中...';
    this.log = [];
    this.problems = [];
    this.result = null;
    this.startedAt = new Date().toISOString();
  }

  view() {
    return {
      id: this.id, date: this.date, state: this.state, step: this.step, message: this.message,
      steps: STEPS.map(([key, label]) => ({ key, label })),
      problems: this.problems, result: this.result, log: this.log.slice(-40), startedAt: this.startedAt
    };
  }

  setStep(step, message) {
    this.step = step;
    this.message = message || `${STEPS.find(s => s[0] === step)[1]}...`;
    this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${this.message}`);
  }

  // 確認待ち: 処理は止まっている（動いていない）。止まった工程は this.step
  needsReview(problems) {
    this.state = 'needs_review';
    this.message = NEEDS_REVIEW_MESSAGE;
    this.problems = problems;
    this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] 確認待ちで停止（${STEPS.find(s => s[0] === this.step)[1].replace(/中$/, '')}）: ${problems.map(p => p.title).join(' / ')}`);
  }

  // エラー停止: 処理は止まっている。止まった工程は this.step
  fail(message) {
    this.state = 'error';
    this.message = `エラーで停止しました: ${message}`;
    this.problems = [{ type: 'error', title: 'エラー', detail: message }];
  }

  async step_(name, args) {
    const r = await run(process.execPath, [path.join(__dirname, 'run-step.js'), name, this.date, this.root], { cwd: this.root });
    let j;
    try { j = JSON.parse(r.out); } catch (e) { throw new Error(`${name} の実行に失敗しました: ${(r.err || r.out).slice(0, 400)}`); }
    if (!j.ok) throw new Error(j.error);
    return j.result;
  }

  async git(args) {
    const r = await run('git', args, { cwd: this.root });
    if (r.code !== 0) throw new Error(`git ${args[0]} に失敗しました: ${(r.err || r.out).trim().slice(0, 400)}`);
    return r.out.trim();
  }

  /**
   * @param {{activity:string, keep?:string[], files?:{name:string,data:string}[], decisions?:Object}} payload
   */
  async run(payload) {
    try {
      await this.run_(payload);
    } catch (e) {
      this.fail(e.message);
    }
    this.finishedAt = new Date().toISOString();
    return this;
  }

  async run_(payload) {
    const date = this.date;
    const inbox = path.join(this.root, 'tools', 'official-import', 'inbox', date);
    const shotDir = path.join(inbox, 'screenshots');
    const screensFile = path.join(this.root, 'tools', 'official-import', 'staging', `${date}.screens.json`);

    // 0. 他の作業（未コミット変更）と混ざらないことを確認
    const dirty = await this.git(['status', '--porcelain', '--', ...IMPORT_PATHS]);
    if (dirty) {
      this.needsReview([{ type: 'git', title: 'UBER_LOG に未保存（未コミット）の変更があります',
        detail: `取込で更新するファイルに別の作業の変更があるため、混ざらないよう自動取込を止めました。\n${dirty}` }]);
      return;
    }

    // 1. 保存
    this.setStep('save');
    if (!String(payload.activity || '').trim()) throw new Error('Uberアクティビティ一覧が空です');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'activity.txt'), String(payload.activity).replace(/\r?\n/g, '\r\n'), 'utf8');
    const keep = new Set((payload.keep || []).map(safeName).filter(Boolean));
    const incoming = [];
    for (const f of payload.files || []) {
      const name = safeName(f.name);
      if (!name) throw new Error(`画像として扱えないファイル名です: ${f.name}`);
      incoming.push({ name, buf: Buffer.from(String(f.data || ''), 'base64') });
    }
    const wanted = new Set([...keep, ...incoming.map(f => f.name)]);
    const leftovers = fs.readdirSync(shotDir).filter(f => IMAGE_EXT.test(f) && !wanted.has(f));
    if (leftovers.length) {
      // 画面で外した画像は削除せず退避
      const prev = path.join(inbox, '_previous', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(prev, { recursive: true });
      leftovers.forEach(f => fs.renameSync(path.join(shotDir, f), path.join(prev, f)));
    }
    incoming.forEach(f => fs.writeFileSync(path.join(shotDir, f.name), f.buf));
    const missingKeep = [...keep].filter(f => !fs.existsSync(path.join(shotDir, f)));
    if (missingKeep.length) throw new Error(`保存済みの画像が見つかりません: ${missingKeep.join(', ')}`);
    if (payload.decisions) {
      const decFile = path.join(inbox, 'decisions.json');
      const cur = fs.existsSync(decFile) ? JSON.parse(fs.readFileSync(decFile, 'utf8')) : {};
      const next = { ...cur };
      if (payload.decisions.mapMissingOk) next.mapMissingOk = [...new Set([...(cur.mapMissingOk || []), ...payload.decisions.mapMissingOk])];
      if (payload.decisions.questDuplicates) {
        const valid = Object.entries(payload.decisions.questDuplicates)
          .filter(([k, v]) => /^\d{1,2}:\d{2}\|-?\d+$/.test(k) && (v === 'count_once' || v === 'count_all'));
        next.questDuplicates = { ...(cur.questDuplicates || {}), ...Object.fromEntries(valid) };
      }
      fs.writeFileSync(decFile, JSON.stringify(next, null, 2), 'utf8');
    }
    const files = fs.readdirSync(shotDir).filter(f => IMAGE_EXT.test(f)).sort((a, b) => a.localeCompare(b, 'ja'));
    if (!files.length) throw new Error('公式スクリーンショットが0枚です');
    this.log.push(`保存: activity.txt / スクショ ${files.length}枚（新規・更新 ${incoming.length}枚${leftovers.length ? ` / 外した ${leftovers.length}枚は _previous へ退避` : ''}）`);

    // 2. 一覧解析（既存 prepare）
    this.setStep('parse');
    const prep = await this.step_('prepare');
    if (!prep.summary.delivery) {
      this.needsReview([{ type: 'activity', title: `${date} の Delivery が一覧に見つかりません`, detail: '日付とコピー範囲（日付の行を含めて）を確認してください。' }]);
      return;
    }

    // 3. スクショ確認（未読・内容が変わった画像だけ Claude Code で読む）
    this.setStep('screens');
    const doc = JSON.parse(fs.readFileSync(screensFile, 'utf8'));
    const pending = [];
    doc.screenshots = doc.screenshots.map(s => {
      const hash = sha256(fs.readFileSync(path.join(shotDir, s.file)));
      let entry = s;
      if (s._sha256 && s._sha256 !== hash) {
        entry = { file: s.file, kind: 'delivery', ...Object.fromEntries(SCREEN_FIELDS.map(k => [k, 'UNKNOWN'])), baseFee: null, tip: null, note: '' };
      }
      entry._sha256 = hash;
      if ((entry.kind || 'delivery') === 'delivery' && SCREEN_FIELDS.some(k => isUnknown(entry[k]))) pending.push(entry.file);
      return entry;
    });
    if (pending.length) {
      const read = await readScreens(this.root, date, pending, msg => { this.message = msg; });
      doc.screenshots = doc.screenshots.map(s => {
        const r = read.find(x => x.file === s.file);
        if (!r) return s;
        const merged = { ...s, ...r, file: s.file, _sha256: s._sha256, readBy: 'claude-code' };
        if (merged.kind !== 'delivery') { merged.baseFee = null; merged.tip = null; }
        return merged;
      });
      fs.writeFileSync(screensFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } else {
      fs.writeFileSync(screensFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    }
    this.log.push(`スクショ確認: ${pending.length ? `${pending.length}枚を読取` : '全枚数 読取済み'}`);

    // 4. MAP作成・検証（既存 validate）
    this.setStep('validate');
    const v = await this.step_('validate');
    if (v.status !== 'PASS') {
      this.needsReview(this.explain(v, doc));
      this.result = { summary: v.summary, status: v.status };
      return;
    }

    // 5. 反映（既存 apply）
    this.setStep('apply');
    const a = await this.step_('apply');
    if (!a.applied && !a.unchanged) {
      this.needsReview(this.explain(a.staging, doc));
      return;
    }
    const summary = a.staging.summary;
    if (a.unchanged) {
      this.state = 'done';
      this.setStep('done', '完了（取込済み・変更なし）');
      this.result = { date, summary, status: 'PASS', unchanged: true, warnings: a.staging.warnings };
      return;
    }

    // 6. テスト
    this.setStep('test');
    if (this.testCommand !== 'skip') {
      const t = await run(this.testCommand[0], this.testCommand.slice(1), { cwd: this.root });
      const failedLines = t.out.split(/\r?\n/).filter(l => /❌/.test(l));
      if (t.code !== 0) {
        this.needsReview([{ type: 'test', title: '自動テストが失敗したため、保存（commit）していません',
          detail: `UBER_LOG へは反映済みですが、GitHub へは送っていません。保守で確認が必要です。\n${failedLines.slice(0, 10).join('\n') || t.err.slice(0, 400)}` }]);
        this.result = { date, summary, status: 'PASS', applied: true, committed: false };
        return;
      }
      this.log.push(`テスト: ${(t.out.match(/結果: .*/) || ['PASS'])[0]}`);
    }

    // 7. 記録（report → HANDOFF → commit → push）
    this.setStep('record');
    const rep = await this.step_('report');
    const version = a.version ? a.version.to : null;
    if (this.handoffFile && fs.existsSync(this.handoffFile)) {
      updateHandoff(this.handoffFile, { date, report: rep, version });
      fs.copyFileSync(this.handoffFile, path.join(this.root, 'HANDOFF.md'));
    } else {
      this.log.push(`HANDOFF が見つからないため記録を省略: ${this.handoffFile}`);
    }
    await this.git(['add', '--', ...IMPORT_PATHS.filter(p => fs.existsSync(path.join(this.root, p)))]);
    const staged = (await this.git(['diff', '--cached', '--name-only'])).split(/\r?\n/).filter(Boolean);
    const outside = staged.filter(f => !IMPORT_PATHS.some(p => f === p || f.startsWith(p + '/')));
    if (outside.length) throw new Error(`取込以外のファイルがコミット対象に含まれています: ${outside.join(', ')}`);
    const yenStr = n => '¥' + Number(n).toLocaleString('en-US');
    await this.git(['commit', '-q', '-m', `data(${date}): official import (${summary.trips} trips, ${yenStr(summary.totalSales)})`]);
    const commit = await this.git(['rev-parse', '--short', 'HEAD']);
    let pushed = true;
    let pushError = '';
    try {
      await this.git(['push', '-q']);
    } catch (e) {
      pushed = false;
      pushError = e.message;
    }

    this.state = 'done';
    this.setStep('done', pushed ? '完了' : '完了（GitHub への送信に失敗）');
    this.result = { date, summary, status: 'PASS', applied: true, committed: true, commit, pushed, pushError, version, report: rep, warnings: a.staging.warnings };
    if (!pushed) {
      this.problems = [{ type: 'push', title: 'GitHub への送信（push）に失敗しました', detail: `UBER_LOG への反映と保存（commit ${commit}）は完了しています。\n${pushError}` }];
    }
  }

  // 検証結果を画面向けの「確認が必要です」に変換
  explain(v, doc) {
    const problems = [];
    const mapFailed = (v.deliveries || []).filter(d => d.map && d.map.status === 'failed');
    if (mapFailed.length) {
      problems.push({
        type: 'map',
        title: `${mapFailed.length}件のMAP画像を確認できません`,
        detail: '地図全体が写っていることを確認できなかったため、推測で切り抜かずに止めています（理由は各行）。' +
          '地図の上下左右に白い余白が入るように撮り直したスクショを追加してください（古い画像は × で外す）。MAPなしで良い場合は「MAPなしで取り込む」。\n' +
          '※ 画面の表示倍率・スクショの横幅が違うだけなら自動で検出されます（縦横比 420:233）。',
        items: mapFailed.map(d => ({ file: d.file, time: d.time, amount: d.amount, reason: d.map && d.map.reason })),
        actions: ['replace', 'mapMissingOk']
      });
    }
    const unreadable = (doc.screenshots || []).filter(s => (s.kind || 'delivery') === 'delivery' && SCREEN_FIELDS.some(k => isUnknown(s[k])));
    if (unreadable.length) {
      problems.push({
        type: 'unreadable',
        title: `${unreadable.length}枚のスクショで読み取れない項目があります`,
        detail: 'Delivery詳細の画面全体（見出し・時間・距離・店舗・配達先・ポイント）が写ったスクショに差し替えてください。',
        items: unreadable.map(s => ({ file: s.file, fields: SCREEN_FIELDS.filter(k => isUnknown(s[k])).join('・') }))
      });
    }
    const others = (doc.screenshots || []).filter(s => s.kind === 'other');
    if (others.length) {
      problems.push({ type: 'other', title: 'Delivery詳細ではない画像が含まれています', detail: '× で外してから、もう一度「取り込み実行」を押してください。', items: others.map(s => ({ file: s.file })) });
    }
    const dups = v.questDuplicateCandidates || [];
    if (dups.length) {
      problems.push({
        type: 'quest',
        title: `クエスト重複の確認が必要です（${dups.length}件）`,
        detail: '同じ時刻・同じ金額のクエストが複数表示されています。同じ報酬が2種類の表示になっているだけなら「同じ報酬（1回だけ計上）」、' +
          '別々に受け取った報酬なら「別々の報酬（両方計上）」を選んでください。\n選ばずに「取り込み実行」を押しても、同じ確認で止まります（二重計上を防ぐため）。',
        items: dups.map(c => ({ key: c.key, time: c.key.split('|')[0], amount: Number(c.key.split('|')[1]), labels: c.items.map(i => (i.category ? i.category + ' ' : '') + i.title) })),
        actions: ['count_once', 'count_all']
      });
    }
    (v.checks || []).filter(c => !c.ok && !/^MAP/.test(c.name) && !(dups.length && /^クエスト重複/.test(c.name)) && !(unreadable.length + others.length && /スクショ全件読取済み/.test(c.name)))
      .forEach(c => problems.push({ type: 'check', title: c.name, detail: c.detail }));
    if (!problems.length) problems.push({ type: 'check', title: '検証で止まりました', detail: (v.errors || []).join('\n') });
    return problems;
  }
}

module.exports = { ImportJob, STEPS, IMPORT_PATHS, NEEDS_REVIEW_MESSAGE };
