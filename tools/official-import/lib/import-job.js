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
const browserFetcher = require('./browser-fetcher.js');

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
// 取込で変更してよいファイル（これ以外はコミットしない）。店舗マスタは反映後に build-stores.js で作り直す
const IMPORT_PATHS = ['js/store.js', 'js/trip-maps.js', 'assets/maps', 'index.html', 'sw.js', 'pickup-map.html', 'route-judge.html', 'version.json', 'HANDOFF.md',
  'data/uber_pickup_stores.json', 'data/uber_pickup_stores.js', 'data/uber_weather.json', 'data/uber_weather.js'];

/**
 * 取込の状態（phase）。画面はこの値だけで「見出し・説明・次に押すボタン（1つ）・進捗」を決める（DATA_MODEL.md「公式取込の状態」）。
 *  FETCHING        取得・検証中（保存・一覧解析・スクショ確認・MAP検証）
 *  PREVIEW_READY   取得完了・内容の確認待ち（まだ反映していない）→ 次: この内容でUBER_LOGへ反映する
 *  PREVIEW_BLOCKED 反映前に解決が必要な問題あり（まだ反映していない）
 *  REFLECTING      UBER_LOG へ反映中
 *  REFLECTED       反映完了（すぐ自動テストへ）
 *  TESTING         自動テスト中
 *  TEST_FAILED     反映済み・テスト失敗・GitHub 未保存 → 次: テストと保存を再開する（取得・反映はやり直さない）
 *  SAVING          記録・保存中（HANDOFF・commit・push）
 *  SAVE_FAILED     反映済み・記録/commit でエラー → 次: テストと保存を再開する
 *  PUSH_FAILED     commit 済み・GitHub への送信だけ失敗 → 次: GitHubへの送信を再試行する
 *  COMPLETE        全工程完了（変更なしを含む）
 *  ERROR           反映前のエラー（UBER_LOG は変更なし）→ 次: 最初から取得し直す
 * state（running / needs_review / error / done）は従来どおり残す（互換のため）。
 */
const PHASES = ['IDLE', 'FETCHING', 'PREVIEW_READY', 'PREVIEW_BLOCKED', 'REFLECTING', 'REFLECTED', 'TESTING', 'TEST_FAILED', 'SAVING', 'SAVE_FAILED', 'PUSH_FAILED', 'COMPLETE', 'ERROR'];
const STEP_PHASE = { save: 'FETCHING', parse: 'FETCHING', screens: 'FETCHING', validate: 'FETCHING', apply: 'REFLECTING', test: 'TESTING', record: 'SAVING', done: 'COMPLETE' };
// 画面の進捗（工程ごとに 完了／実行中／確認待ち／エラー／未実行／不要）
const PROGRESS = [
  ['fetch', '取得・検証'], ['review', '内容確認'], ['apply', 'UBER_LOG反映'], ['test', '自動テスト'],
  ['handoff', 'HANDOFF記録'], ['commit', '保存（commit）'], ['push', 'GitHubへ送信（push）']
];

function jstToday(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function gitSync(root, args) {
  const r = require('child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * 反映済みで保存（commit / push）が終わっていない取込を探す（サーバーを再起動しても分かるように、ディスクと git から判定する）
 *  uncommitted: 取込対象ファイルに未コミットの変更があり、staging/<日付>.json の generatedAt と js/store.js のその日の officialImport.importedAt が一致し、
 *               その importedAt が最新 commit の store.js に無い（＝この取込で反映した内容がまだ保存されていない）
 *  unpushed   : 未コミットの変更は無いが、最新 commit が「data(日付): official import」で送信先（upstream）より先にある
 * @returns {null | {kind:'uncommitted'|'unpushed', date:string, summary?:object, warnings?:string[]}}
 */
function detectPending(root) {
  const dirty = gitSync(root, ['status', '--porcelain', '--', ...IMPORT_PATHS]);
  if (dirty) {
    const stagingDir = path.join(root, 'tools', 'official-import', 'staging');
    const storeFile = path.join(root, 'js', 'store.js');
    if (!fs.existsSync(stagingDir) || !fs.existsSync(storeFile)) return null;
    const pipeline = require('./pipeline.js');
    let seed;
    try { seed = pipeline.readSeed(storeFile).data.dailyLogs; } catch (e) { return null; }
    const headStore = gitSync(root, ['show', 'HEAD:js/store.js']) || '';
    const found = fs.readdirSync(stagingDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(stagingDir, f), 'utf8'));
        const day = seed[st.date];
        if (day && day.officialImport && st.generatedAt && day.officialImport.importedAt === st.generatedAt && !headStore.includes(st.generatedAt)) {
          return { kind: 'uncommitted', date: st.date, generatedAt: st.generatedAt, summary: st.summary, warnings: (st.validation && st.validation.warnings) || [] };
        }
      } catch (e) { /* 読めない staging は対象外 */ }
      return null;
    }).filter(Boolean).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
    return found[0] || null;
  }
  const ahead = gitSync(root, ['rev-list', '--count', '@{u}..HEAD']);
  const subject = gitSync(root, ['log', '-1', '--format=%s']) || '';
  const m = subject.match(/^data\((\d{4}-\d{2}-\d{2})\): official import/);
  if (ahead && Number(ahead) > 0 && m) return { kind: 'unpushed', date: m[1] };
  return null;
}
/**
 * その日に保存済みの公式取込（再取込の確認画面で「前回の取込」として出す。未取込なら null）
 * 同じ日の再取込は加算ではなく、この値を最新の公式データで置き換える
 */
function previousImport(root, date) {
  try {
    const day = require('./pipeline.js').readSeed(path.join(root, 'js', 'store.js')).data.dailyLogs[date];
    if (!day || !day.officialImport) return null;
    return { trips: day.tripsCount, deliveriesCount: day.deliveriesCount, totalSales: day.sales ? day.sales.total : null, importedAt: day.officialImport.importedAt };
  } catch (e) { return null; }
}
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
    this.state = 'running'; // running | done | needs_review | error（互換）
    this.phase = 'FETCHING';
    this.step = 'save';
    this.message = '保存中...';
    this.log = [];
    this.problems = [];
    this.result = null;
    this.applied = false;          // UBER_LOG（js/store.js）へ反映したか
    this.reviewed = false;         // 内容確認（プレビュー → 反映）を経たか
    this.recordDone = {};          // 記録・保存の工程: handoff / commit / push
    this.failedRecordStep = null;
    this.pendingDate = null;       // 反映済み・保存待ちの日（別の日の取込を止めた場合）
    this.today = opts.today || jstToday();
    this.partialDay = this.date === this.today; // 今日の取込（1日が終わっていない途中のデータ）
    this.startedAt = new Date().toISOString();
  }

  // 画面の進捗（サーバーで1か所だけで作る）
  progress() {
    const st = {};
    PROGRESS.forEach(([k]) => { st[k] = 'todo'; });
    const p = this.phase;
    const after = (...keys) => keys.forEach(k => { st[k] = 'done'; });
    const unchanged = this.result && this.result.unchanged;
    if (p === 'FETCHING') st.fetch = 'doing';
    else if (p === 'PREVIEW_READY') { after('fetch'); st.review = 'waiting'; }
    else if (p === 'PREVIEW_BLOCKED') st.fetch = 'waiting';
    else if (p === 'ERROR') st.fetch = 'error';
    else {
      after('fetch');
      st.review = this.reviewed ? 'done' : 'skip';
      if (p === 'REFLECTING') st.apply = 'doing';
      else if (unchanged) { st.apply = 'done'; ['test', 'handoff', 'commit', 'push'].forEach(k => { st[k] = 'skip'; }); }
      else {
        after('apply');
        if (p === 'TESTING') st.test = 'doing';
        else if (p === 'TEST_FAILED') st.test = 'error';
        else if (p !== 'REFLECTED') {
          after('test');
          ['handoff', 'commit', 'push'].forEach(k => {
            if (this.recordDone[k]) st[k] = 'done';
            else if (p === 'SAVING' && !['handoff', 'commit', 'push'].some(x => st[x] === 'doing')) st[k] = 'doing';
          });
          if (p === 'SAVE_FAILED' && this.failedRecordStep) st[this.failedRecordStep] = 'error';
          if (p === 'PUSH_FAILED') st.push = 'error';
        }
      }
    }
    return PROGRESS.map(([key, label]) => ({ key, label: key === 'fetch' && this.sourceType === 'screenshots' ? '保存・スクショ確認・検証' : label, status: st[key] }));
  }

  // 次に押すボタン（主操作は1つだけ。無ければ null）
  nextAction() {
    switch (this.phase) {
      case 'PREVIEW_READY': return { act: 'apply', label: 'この内容でUBER_LOGへ反映する' };
      case 'TEST_FAILED':
      case 'SAVE_FAILED': return { act: 'resume', label: 'テストと保存を再開する', date: this.pendingDate || this.date };
      case 'PUSH_FAILED': return { act: 'resume', label: 'GitHubへの送信を再試行する', date: this.date };
      case 'ERROR': return { act: 'restart', label: '最初から取得し直す' };
      case 'PREVIEW_BLOCKED': {
        const types = this.problems.map(p => p.type);
        if (types.includes('auth')) return { act: 'restart', label: 'ログインしたので取得し直す' };
        // Uber Web 取得（structured）は保存済みの取得結果で検証し直す（Uber Web へは再アクセスしない）
        if (types.some(t => ['unreadable', 'other', 'activity', 'check'].includes(t))) return { act: 'revalidate', label: this.sourceType === 'structured' ? '保存済みの取得結果で検証し直す（Uber Web へは再アクセスしません）' : '直した内容で検証し直す' };
        return null; // 選択ボタン（MAPなし・クエスト重複）や保守が必要な問題は、カードの中のボタンで操作する
      }
      default: return null;
    }
  }

  // 完了後の「この日を最新データで再取込」（主操作ではない。同じ日の新しい取込ジョブを最初の取得から始める）
  reimportAction() {
    return this.phase === 'COMPLETE' ? { act: 'reimport', label: 'この日を最新データで再取込', date: this.date } : null;
  }

  view() {
    return {
      id: this.id, date: this.date, state: this.state, phase: this.phase, step: this.step, message: this.message,
      sourceType: this.sourceType || 'screenshots',
      steps: STEPS.map(([key, label]) => ({ key, label })),
      progress: this.progress(), next: this.nextAction(), reimport: this.reimportAction(),
      partialDay: this.partialDay, today: this.today, pendingDate: this.pendingDate, applied: this.applied,
      problems: this.problems, result: this.result, log: this.log.slice(-40), startedAt: this.startedAt
    };
  }

  setStep(step, message) {
    this.step = step;
    if (STEP_PHASE[step]) this.phase = STEP_PHASE[step];
    this.message = message || `${STEPS.find(s => s[0] === step)[1]}...`;
    this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${this.message}`);
  }

  // 確認待ち: 処理は止まっている（動いていない）。phase で意味を区別する（PREVIEW_READY / PREVIEW_BLOCKED / TEST_FAILED）
  needsReview(problems, phase = 'PREVIEW_BLOCKED') {
    this.state = 'needs_review';
    this.phase = phase;
    this.message = NEEDS_REVIEW_MESSAGE;
    this.problems = problems;
    this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${phase}（${STEPS.find(s => s[0] === this.step)[1].replace(/中$/, '')}）: ${problems.map(p => p.title).join(' / ')}`);
  }

  // エラー停止: 処理は止まっている。反映後のエラーは「反映済み・保存待ち」として扱う（取得・反映はやり直さない）
  fail(message) {
    this.state = 'error';
    this.message = `エラーで停止しました: ${message}`;
    if (this.applied) {
      this.phase = this.step === 'record' ? 'SAVE_FAILED' : 'TEST_FAILED';
      if (this.step === 'record') this.failedRecordStep = ['handoff', 'commit', 'push'].find(k => !this.recordDone[k]) || 'commit';
      this.problems = [{ type: this.phase === 'SAVE_FAILED' ? 'save' : 'test', title: this.phase === 'SAVE_FAILED' ? '記録・保存でエラーになりました' : '自動テストでエラーになりました',
        detail: `UBER_LOG へは反映済みです。取り込みはやり直さないでください。GitHub への保存はまだです。\n${message}` }];
    } else {
      this.phase = 'ERROR';
      this.problems = [{ type: 'error', title: 'エラー', detail: `UBER_LOG には反映していません。\n${message}` }];
    }
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
      // 前回の取込が「反映済み・保存待ち」なら、取得・反映をやり直さず「テストと保存を再開する」へ案内する（二重取込を防ぐ）
      const pending = detectPending(this.root);
      if (pending && pending.kind === 'uncommitted') {
        this.pendingDate = pending.date;
        this.result = { date: pending.date, summary: pending.summary, applied: true, committed: false };
        this.needsReview([{ type: 'pending', title: `${pending.date} の取込は UBER_LOG へ反映済みで、保存（commit・push）が終わっていません`,
          detail: '取り込みをやり直さないでください（もう一度取得・反映する必要はありません）。「テストと保存を再開する」を押すと、自動テスト → HANDOFF → commit → push だけを行います。' }], 'TEST_FAILED');
        return;
      }
      this.needsReview([{ type: 'git', title: 'UBER_LOG に未保存（未コミット）の変更があります',
        detail: `取込で更新するファイルに別の作業の変更があるため、混ざらないよう自動取込を止めました（保守で確認が必要です）。\n${dirty}` }]);
      return;
    }

    // 1. 保存
    this.setStep('save');
    const isBrowser = !!payload.useBrowser;
    const isStructuredInput = !!payload.structured;
    this.sourceType = isBrowser || isStructuredInput ? 'structured' : 'screenshots';

    if (isBrowser) {
      let structuredData;
      const structuredFile = path.join(inbox, 'structured.json');
      if (payload.confirmed) this.reviewed = true;
      if (payload.confirmed || payload.decisions || payload.revalidate) {
        // 反映・選択・検証のやり直しは、この取込で取得して確認した結果（structured.json）だけを使う（Uber Web へは再アクセスしない）。
        // 確認画面の取得日時（fetchedAt）と違う・無い場合は使わない（前回の取込の古い取得結果を反映しない）
        let raw = null;
        try { raw = fs.readFileSync(structuredFile); structuredData = JSON.parse(raw.toString('utf8')); } catch (e) { structuredData = null; }
        if (!structuredData) throw new Error('確認した取得結果が見つかりません。「最初から取得し直す」を押してください（UBER_LOG は変更なし）。');
        if ((payload.confirmed || payload.revalidate) && !payload.fetchedAt) throw new Error('どの取得結果を確認したか分からないため反映・検証しません。「最初から取得し直す」を押してください（UBER_LOG は変更なし）。');
        if (payload.fetchedAt && structuredData.fetchedAt !== payload.fetchedAt) {
          throw new Error(`確認した取得結果（${payload.fetchedAt}）と保存されている取得結果（${structuredData.fetchedAt || '取得日時なし'}）が違うため反映しません。「最初から取得し直す」を押してください（UBER_LOG は変更なし）。`);
        }
        if (payload.revalidate) {
          // 保存済みの取得結果だけで検証し直す: 対象日・内容（sha256）・一覧テキスト（activity.txt）が取得結果と一致することを確かめる。
          // 一致しない・足りないときは推測で直さずに止める（保存済みのファイルは書き換えない）
          if (structuredData.targetDate !== date) {
            throw new Error(`保存されている取得結果の対象日（${structuredData.targetDate || '不明'}）が ${date} と違うため検証しません。「最初から取得し直す」を押してください（UBER_LOG は変更なし）。`);
          }
          if (!payload.structuredSha256 || sha256(raw) !== payload.structuredSha256) {
            throw new Error('保存されている取得結果の内容が、確認画面に出した取得結果と一致しないため検証しません。「最初から取得し直す」を押してください（UBER_LOG は変更なし）。');
          }
          const actFile = path.join(inbox, 'activity.txt');
          const expected = require('./structured-normalizer.js').buildActivityTextFromStructured(structuredData.activity || structuredData, date);
          if (!fs.existsSync(actFile) || fs.readFileSync(actFile, 'utf8') !== expected) {
            throw new Error('保存されている一覧（activity.txt）が取得結果（structured.json）から作った内容と一致しないため検証しません。保守で確認してください（UBER_LOG は変更なし）。');
          }
          this.log.push(`再検証: Uber Web へは再アクセスせず、保存済みの取得結果（取得日時 ${structuredData.fetchedAt}・${(structuredData.trips || []).length} trips）を今の検証ロジックで解析し直します`);
        }
        this.log.push(`読込: この取込で取得した構造化データ（取得日時 ${structuredData.fetchedAt}・${(structuredData.trips || []).length} trips）を使用します`);
      } else {
        // 取得は毎回 Uber Web から新しく行う。失敗したら止める（保存済みの前回の取得結果では代用しない・inbox / staging も書き換えない）
        this.message = 'Uber Web から実績データを自動取得中...';
        try {
          structuredData = await browserFetcher.fetchUberDataForDate(this.root, date, {}, msg => {
            this.message = msg;
            this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
          });
        } catch (err) {
          if (/ログイン/i.test(err.message)) {
            this.needsReview([{
              type: 'auth',
              title: 'Uberへのログインが必要です',
              detail: 'ブラウザ画面で手動ログイン（パスキー・2段階認証含む）を完了してから、もう一度「自動取得」を押してください。'
            }]);
            return;
          }
          throw new Error(`Uber Web から最新データを取得できませんでした。保存済みの前回の取得結果は使っていません（取得結果・UBER_LOG とも変更なし）。\n${err.message}`);
        }
        browserFetcher.saveStructuredInbox(this.root, date, structuredData);
        this.log.push(`保存: Uber Web から取得した構造化データ（取得日時 ${structuredData.fetchedAt}・${(structuredData.trips || []).length} trips）`);
      }
      this.fetchedAt = structuredData.fetchedAt || null;
      this.lastTripAt = structuredData.lastTripAt || null;
      this.structuredSha256 = fs.existsSync(structuredFile) ? sha256(fs.readFileSync(structuredFile)) : null;
    } else if (isStructuredInput) {
      if (payload.confirmed) this.reviewed = true;
      browserFetcher.saveStructuredInbox(this.root, date, payload.structured);
      this.log.push(`保存: 構造化データを保存 (${(payload.structured.trips || []).length} trips)`);
    } else {
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
      const files = fs.readdirSync(shotDir).filter(f => IMAGE_EXT.test(f)).sort((a, b) => a.localeCompare(b, 'ja'));
      if (!files.length) throw new Error('公式スクリーンショットが0枚です');
      this.log.push(`保存: activity.txt / スクショ ${files.length}枚（新規・更新 ${incoming.length}枚${leftovers.length ? ` / 外した ${leftovers.length}枚は _previous へ退避` : ''}）`);
    }

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

    // 2. 一覧解析（既存 prepare）
    this.setStep('parse');
    const prep = await this.step_('prepare');
    if (!prep.summary.delivery) {
      if (this.fetchedAt) this.result = { status: 'FAIL', fetchedAt: this.fetchedAt, structuredSha256: this.structuredSha256 || null };
      this.needsReview([{ type: 'activity', title: `${date} の Delivery が一覧に見つかりません`, detail: '日付とコピー範囲（日付の行を含めて）を確認してください。' }]);
      return;
    }

    // 3. スクショ確認（未読・内容が変わった画像だけ Claude Code で読む。構造化データ取込時はスキップ）
    this.setStep('screens');
    const doc = JSON.parse(fs.readFileSync(screensFile, 'utf8'));
    if (doc.sourceType === 'structured') {
      this.log.push('構造化データ取込: スクショ読取スキップ（公式JSONを使用）');
    } else {
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
    }

    // 4. MAP作成・検証（既存 validate）
    this.setStep('validate');
    const v = await this.step_('validate');
    if (v.status !== 'PASS') {
      this.needsReview(this.explain(v, doc));
      this.result = { summary: v.summary, status: v.status, fetchedAt: this.fetchedAt || null, structuredSha256: this.structuredSha256 || null };
      return;
    }

    // 初回構造化取得時は自動applyせず、プレビュー確認のため停止する（誤反映防止）
    if ((isBrowser || (isStructuredInput && payload.previewFirst)) && !payload.confirmed) {
      const previous = previousImport(this.root, date);
      const lastTripAt = this.lastTripAt || (v.deliveries || []).map(d => d.time).filter(Boolean).sort().pop() || null;
      this.needsReview([{
        type: 'preview',
        title: `【プレビュー】${date} Uber Web構造化取得・検証完了（未反映）`,
        detail: `全 ${v.summary.trips} 件のトリップ（配達件数: ${v.summary.deliveriesCount}）を正常に取得・検証しました。本体（store.js）への確定反映は保留しています。下の内訳を確認してください。`,
        summary: v.summary,
        items: (v.deliveries || []).map(d => ({
          time: d.time,
          amount: d.amount,
          reason: `${d.restaurant || ''} / ${d.area || ''} / ${d.distanceKm || 0}km / ${d.durationStr || ''}${d.tripLegCount > 1 ? ` 【${d.tripLegCount}件配達】` : ''}${d.tip ? ` (チップ: ¥${d.tip})` : ''}` +
            ((d.changes || []).some(c => c.field === 'fee') ? ` 【Uber公式の金額変更を反映: ¥${d.changes.find(c => c.field === 'fee').from} → ¥${d.amount}】` : '') +
            (d.listDiff ? ` 【一覧は ¥${d.listDiff.listAmount}・内訳つきの詳細 ¥${d.listDiff.detailAmount} を採用】` : '')
        }))
      }], 'PREVIEW_READY');
      this.result = { date, summary: v.summary, status: 'PASS', preview: true, deliveries: v.deliveries, warnings: v.warnings, previous, fetchedAt: this.fetchedAt || null, structuredSha256: this.structuredSha256 || null, lastTripAt };
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
      this.result = { date, summary, status: 'PASS', unchanged: true, partialDay: this.partialDay, warnings: a.staging.warnings };
      return;
    }
    this.applied = true;
    this.phase = 'REFLECTED';
    this.log.push(`[${new Date().toLocaleTimeString('ja-JP')}] UBER_LOG へ反映しました${this.partialDay ? '（今日の途中のデータ。この後の配達は含まれない）' : ''}`);
    this.result = { date, summary, status: 'PASS', applied: true, committed: false, partialDay: this.partialDay, warnings: a.staging.warnings };
    this.rebuildStores();
    const warnings = [...(a.staging.warnings || []), ...(await this.updateWeatherSafe())];
    this.result.warnings = warnings;

    await this.testAndRecord({ date, summary, version: a.version ? a.version.to : null, warnings });
  }

  // 配達マップの店舗マスタを作り直す（取込で trip が増えると古くなるため。build-stores.js が無い環境では省略）
  rebuildStores() {
    const tool = path.join(this.root, 'tools', 'pickup-map', 'build-stores.js');
    if (!fs.existsSync(tool)) return;
    const r = require('child_process').spawnSync(process.execPath, [tool], { cwd: this.root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`店舗マスタの再生成に失敗しました: ${(r.stderr || r.stdout).slice(0, 300)}`);
    const line = (r.stdout.match(/A 総トリップ.*/) || [''])[0];
    this.log.push(`店舗マスタを再生成${line ? `（${line}）` : ''}`);
  }

  // 天気（気象庁）のまだ登録されていない過去日だけを追加する。取得できなくても取込は止めない（警告だけ・天気データは変更しない）
  // 環境変数 UBER_WEATHER_UPDATE=skip で省略（テスト・保守用）。tools/weather が無い環境でも省略
  async updateWeatherSafe() {
    const tool = path.join(this.root, 'tools', 'weather', 'fetch-jma-weather.js');
    if (process.env.UBER_WEATHER_UPDATE === 'skip' || !fs.existsSync(tool)) return [];
    try {
      const { updateWeather } = require(tool);
      const r = await updateWeather({ root: this.root, missingOnly: true, today: this.today, timeoutMs: 20000 });
      if (!r.ok) {
        const w = `天気（気象庁）を更新できませんでした（取込には影響なし・次の取込で再確認）: ${r.error}`;
        this.log.push(w);
        return [w];
      }
      this.log.push(`天気（気象庁）: ${r.added.length ? `${r.added.join(', ')} を追加` : '追加なし'}${r.unpublished.length ? `・未発表 ${r.unpublished.join(', ')}（次の取込で再確認）` : ''}`);
      return [];
    } catch (e) {
      const w = `天気（気象庁）の更新でエラー（取込には影響なし）: ${e.message}`;
      this.log.push(w);
      return [w];
    }
  }

  // 6. テスト → 7. 記録（report → HANDOFF → commit → push）。反映後の通常の流れと「テストと保存を再開する」で共通
  async testAndRecord({ date, summary, version, warnings }) {
    this.setStep('test');
    if (this.testCommand !== 'skip') {
      const t = await run(this.testCommand[0], this.testCommand.slice(1), { cwd: this.root });
      const failedLines = t.out.split(/\r?\n/).filter(l => /❌/.test(l));
      if (t.code !== 0) {
        this.needsReview([{ type: 'test', title: '自動テストが失敗しました',
          detail: `UBER_LOG へは反映済みです。取り込みはやり直さないでください。GitHub への保存（commit・push）はまだです。\n${failedLines.slice(0, 10).join('\n') || (t.err || t.out).slice(0, 400)}` }], 'TEST_FAILED');
        this.result = { ...(this.result || {}), date, summary, status: 'PASS', applied: true, committed: false };
        return;
      }
      this.log.push(`テスト: ${(t.out.match(/結果: .*/) || ['PASS'])[0]}`);
    }

    this.setStep('record');
    const rep = await this.step_('report');
    if (this.handoffFile && fs.existsSync(this.handoffFile)) {
      updateHandoff(this.handoffFile, { date, report: rep, version });
      fs.copyFileSync(this.handoffFile, path.join(this.root, 'HANDOFF.md'));
    } else {
      this.log.push(`HANDOFF が見つからないため記録を省略: ${this.handoffFile}`);
    }
    this.recordDone.handoff = true;
    await this.git(['add', '--', ...IMPORT_PATHS.filter(p => fs.existsSync(path.join(this.root, p)))]);
    const staged = (await this.git(['diff', '--cached', '--name-only'])).split(/\r?\n/).filter(Boolean);
    const outside = staged.filter(f => !IMPORT_PATHS.some(p => f === p || f.startsWith(p + '/')));
    if (outside.length) throw new Error(`取込以外のファイルがコミット対象に含まれています: ${outside.join(', ')}`);
    const yenStr = n => '¥' + Number(n).toLocaleString('en-US');
    await this.git(['commit', '-q', '-m', `data(${date}): official import (${summary.trips} trips, ${yenStr(summary.totalSales)})`]);
    this.recordDone.commit = true;
    const commit = await this.git(['rev-parse', '--short', 'HEAD']);
    await this.pushAndFinish({ date, summary, version, warnings, commit, report: rep });
  }

  async pushAndFinish({ date, summary, version, warnings, commit, report }) {
    let pushed = true;
    let pushError = '';
    try {
      await this.git(['push', '-q']);
      this.recordDone.push = true;
    } catch (e) {
      pushed = false;
      pushError = e.message;
    }
    this.state = 'done';
    this.setStep('done', pushed ? '完了' : '完了（GitHub への送信に失敗）');
    if (!pushed) this.phase = 'PUSH_FAILED';
    this.result = { ...(this.result || {}), date, summary, status: 'PASS', applied: true, committed: true, commit, pushed, pushError, version, report, warnings, partialDay: this.partialDay };
    this.problems = pushed ? [] : [{ type: 'push', title: 'GitHub への送信（push）だけ失敗しました', detail: `UBER_LOG への反映と保存（commit ${commit}）は完了しています。取り込みはやり直さないでください。\n${pushError}` }];
  }

  /**
   * 「テストと保存を再開する」: 反映済みの取込について、取得・反映はやり直さずに テスト → 記録（HANDOFF・commit・push）だけを行う。
   * commit 済みで送信だけ失敗している場合は push だけを行う。
   */
  async resume() {
    try {
      const pending = detectPending(this.root);
      if (!pending || pending.date !== this.date) {
        this.state = 'error';
        this.phase = 'ERROR';
        this.problems = [{ type: 'error', title: '再開できる取込がありません', detail: `${this.date} について、反映済みで保存待ちの取込は見つかりませんでした（すでに保存済みか、別の日です）。` }];
        return this;
      }
      this.applied = true;
      this.reviewed = true;
      this.sourceType = 'structured';
      const summary = pending.summary || {};
      const versionNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'version.json'), 'utf8')).version; } catch (e) { return null; } })();
      const versionHead = (() => { try { return JSON.parse(gitSync(this.root, ['show', 'HEAD:version.json']) || '{}').version; } catch (e) { return null; } })();
      this.log.push(`再開: ${this.date} の反映済みデータで テスト → 記録・保存 を行います（取得・反映はしません）`);
      if (pending.kind === 'unpushed') {
        this.recordDone = { handoff: true, commit: true };
        this.setStep('record', 'GitHub へ送信中...');
        const commit = await this.git(['rev-parse', '--short', 'HEAD']);
        await this.pushAndFinish({ date: this.date, summary, version: versionNow, warnings: [], commit, report: null });
      } else {
        this.result = { date: this.date, summary, status: 'PASS', applied: true, committed: false, partialDay: false };
        this.rebuildStores();
        const warnings = [...(pending.warnings || []), ...(await this.updateWeatherSafe())];
        await this.testAndRecord({ date: this.date, summary, version: versionNow !== versionHead ? versionNow : null, warnings });
      }
    } catch (e) {
      this.fail(e.message);
    }
    this.finishedAt = new Date().toISOString();
    return this;
  }

  // 検証結果を画面向けの「確認が必要です」に変換
  explain(v, doc) {
    const problems = [];
    const isStructured = doc && doc.sourceType === 'structured';
    const mapFailed = (v.deliveries || []).filter(d => d.map && d.map.status === 'failed');
    if (mapFailed.length) {
      if (isStructured) {
        problems.push({
          type: 'map',
          title: `${mapFailed.length}件のMAP情報を取得できません`,
          detail: 'Uber Web からルート地図を取得できませんでした。MAPなしで取り込む場合は「MAPなしで取り込む」を選択してください。',
          items: mapFailed.map(d => ({ file: d.file, time: d.time, amount: d.amount, reason: d.map && d.map.reason })),
          actions: ['mapMissingOk']
        });
      } else {
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
    }
    const unreadable = (doc.screenshots || []).filter(s => (s.kind || 'delivery') === 'delivery' && SCREEN_FIELDS.some(k => isUnknown(s[k])));
    if (unreadable.length) {
      if (isStructured) {
        problems.push({
          type: 'unreadable',
          title: `${unreadable.length}件のトリップ詳細で取得できない項目があります`,
          detail: 'Uber Web の構造化データを確認してください。',
          items: unreadable.map(s => ({ file: s.file, fields: SCREEN_FIELDS.filter(k => isUnknown(s[k])).join('・') }))
        });
      } else {
        problems.push({
          type: 'unreadable',
          title: `${unreadable.length}枚のスクショで読み取れない項目があります`,
          detail: 'Delivery詳細の画面全体（見出し・時間・距離・店舗・配達先・ポイント）が写ったスクショに差し替えてください。',
          items: unreadable.map(s => ({ file: s.file, fields: SCREEN_FIELDS.filter(k => isUnknown(s[k])).join('・') }))
        });
      }
    }
    const others = (doc.screenshots || []).filter(s => s.kind === 'other');
    if (others.length && !isStructured) {
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
    (v.checks || []).filter(c => !c.ok && !/^MAP/.test(c.name) && !(dups.length && /^クエスト重複/.test(c.name)) && !(unreadable.length + others.length && /スクショ全件読取済み|構造化トリップ詳細読込/.test(c.name)))
      .forEach(c => problems.push({ type: 'check', title: c.name, detail: c.detail }));
    if (!problems.length) problems.push({ type: 'check', title: '検証で止まりました', detail: (v.errors || []).join('\n') });
    return problems;
  }
}

module.exports = { ImportJob, STEPS, IMPORT_PATHS, NEEDS_REVIEW_MESSAGE, PHASES, PROGRESS, detectPending, jstToday };
