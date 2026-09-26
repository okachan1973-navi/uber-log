/**
 * ローカルbackend（server.js）＋「取り込み実行」フローの結合テスト
 *   node tools/official-import/spec/server-tests.js   （run-tests.js からも呼ばれる）
 *
 * 一時フォルダに UBER_LOG 一式のコピーと git リポジトリ（送信先の bare リポジトリ付き）を作り、
 * 画面と同じ HTTP 呼び出しで保存 → 検証 → 反映 → HANDOFF → commit → push を確認する。
 * スクショ読取（Claude Code）は fixture の読取結果で代用（UBER_SCREEN_READER_MOCK）。本物のデータ・GitHub には触れない。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const pipeline = require('../lib/pipeline.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIX = path.join(__dirname, 'fixtures');
const PORT = 8097;
let passed = 0;
let failed = 0;
const check = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ FAIL: ${m}`); } };
const section = t => console.log(`\n【${t}】`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function request(method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { Host: host || `localhost:${PORT}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* HTMLなど */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const apiGet = p => request('GET', p, { headers: { 'X-UBER-LOG': '1' } });
const apiPost = (p, body) => request('POST', p, { body, headers: { 'X-UBER-LOG': '1' } });

async function waitJob(id) {
  for (let i = 0; i < 600; i++) {
    const r = await apiGet(`/api/jobs/${id}`);
    if (r.json && r.json.state !== 'running') return r.json;
    await sleep(500);
  }
  throw new Error('ジョブが終わりません');
}

// ------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uberlog-server-'));
const root = path.join(tmp, 'UBER_LOG');
const remote = path.join(tmp, 'remote.git');
const handoff = path.join(tmp, 'UBER_HANDOFF.txt');
let server = null;

function copy(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function setupRoot() {
  ['js/store.js', 'js/trip-maps.js', 'js/cloud-sync.js', 'js/ui.js', 'js/app.js', 'index.html', 'sw.js', 'version.json', 'manifest.json', '.gitignore', 'HANDOFF.md',
    'tools/official-import/server.js', 'tools/official-import/index.html', 'tools/official-import/import.js'].forEach(copy);
  fs.readdirSync(path.join(ROOT, 'tools', 'official-import', 'lib')).filter(f => /\.(js|py)$/.test(f)).forEach(f => copy(`tools/official-import/lib/${f}`));
  fs.mkdirSync(path.join(root, 'assets', 'maps'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'HANDOFF.md'), handoff);
  // 9/22 を未取込の状態にし、del_0922_10 の既存MAPを外す（地図が切れたスクショで MAP 不足になる状況）
  const storeFile = path.join(root, 'js', 'store.js');
  const seed = pipeline.readSeed(storeFile);
  const later = seed.blocks.filter(b => b.date >= '2026-09-22').map(b => b.date);
  let src = seed.src;
  const first = seed.blocks.find(b => b.date === later[0]);
  const prev = seed.blocks[seed.blocks.indexOf(first) - 1];
  src = src.slice(0, prev.end) + src.slice(seed.blocks[seed.blocks.length - 1].end);
  fs.writeFileSync(storeFile, src.replace(/\n/g, seed.eol), 'utf8');
  const tmFile = path.join(root, 'js', 'trip-maps.js');
  const tm = pipeline.readTripMaps(tmFile);
  const kept = Object.entries(tm.catalog).filter(([id]) => id !== 'del_0922_10' && !id.startsWith('del_0923_'));
  const body = kept.map(([id, e]) => `  ${JSON.stringify(id)}: {\n    "map": "${e.map}",\n    "full": "${e.full}",\n    "cropped": true,\n    "box": [${e.box.join(', ')}],\n    "origFile": ${JSON.stringify(e.origFile)}\n  }`).join(',\n');
  fs.writeFileSync(tmFile, `// UBER_LOG 公式トリップ地図画像カタログ\nconst TRIP_MAP_CATALOG = {\n${body}\n};\n\nif (typeof module !== 'undefined') module.exports = { TRIP_MAP_CATALOG };\n`, 'utf8');

  sh('git', ['init', '-q', '-b', 'main'], root);
  sh('git', ['config', 'user.email', 'test@example.invalid'], root);
  sh('git', ['config', 'user.name', 'uberlog-test'], root);
  sh('git', ['config', 'core.autocrlf', 'false'], root);
  sh('git', ['add', '-A'], root);
  sh('git', ['commit', '-q', '-m', 'base'], root);
  sh('git', ['init', '-q', '--bare', remote], tmp);
  sh('git', ['remote', 'add', 'origin', remote], root);
  sh('git', ['push', '-q', '-u', 'origin', 'main'], root);
}

async function startServer(env) {
  server = spawn(process.execPath, [path.join(root, 'tools', 'official-import', 'server.js')], {
    env: { ...process.env, UBER_LOG_PORT: String(PORT), UBER_LOG_ROOT: root, UBER_HANDOFF_PATH: handoff, UBER_IMPORT_TEST_CMD: 'skip', ...env },
    windowsHide: true
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await request('GET', '/api/health'); if (r.status === 200) return; } catch (e) { /* 起動待ち */ }
    await sleep(250);
  }
  throw new Error('server が起動しません');
}

(async () => {
  try {
    setupRoot();
    const screens = JSON.parse(fs.readFileSync(path.join(FIX, '2026-09-22.screens.json'), 'utf8'));
    const mock = path.join(tmp, 'screens-mock.json');
    fs.writeFileSync(mock, JSON.stringify({ screenshots: screens.screenshots.map(({ _fixtureId, _fixtureFull, ...s }) => s) }), 'utf8');
    await startServer({ UBER_SCREEN_READER_MOCK: mock });
    const activity = fs.readFileSync(path.join(FIX, '2026-09-22.activity.txt'), 'utf8');
    const images = screens.screenshots.map(s => ({ name: s.file, data: fs.readFileSync(path.join(ROOT, s._fixtureFull)).toString('base64') }));
    const storeFile = path.join(root, 'js', 'store.js');
    const head = () => sh('git', ['rev-parse', 'HEAD'], root);

    // ==========================================================
    section('13-1. ローカルbackend: 配信・localhost限定・保護');
    const h = await request('GET', '/api/health');
    check(h.status === 200 && h.json.app === 'uber-log-local', 'health: UBER_LOG ローカルbackend');
    const page = await request('GET', '/tools/official-import/');
    check(page.status === 200 && page.text.includes('取り込み実行'), '公式取込画面（/tools/official-import/）を配信・主ボタン「取り込み実行」');
    const app = await request('GET', '/');
    check(app.status === 200 && app.text.includes('UBER_LOG_APP_VERSION'), '通常の UBER_LOG（/）を同じサーバーから配信');
    check((await request('GET', '/api/health', { host: 'evil.example:80' })).status === 403, 'Host が localhost 以外なら拒否（DNS rebinding 対策）');
    check((await request('POST', '/api/import', { body: {} })).status === 403, 'X-UBER-LOG ヘッダーの無い API 呼び出しは拒否（他サイトからの実行防止）');
    check((await request('POST', '/api/import', { body: {}, headers: { 'X-UBER-LOG': '1', Origin: 'https://example.com' } })).status === 403, '他サイトの Origin は拒否');
    fs.mkdirSync(path.join(root, 'tools', 'official-import', 'inbox', '2026-09-22'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'official-import', 'inbox', '2026-09-22', 'activity.txt'), 'x');
    check((await request('GET', '/tools/official-import/inbox/2026-09-22/activity.txt')).status === 404 && (await request('GET', '/.git/config')).status === 404,
      '生データ（inbox / staging / logs）・.git は静的配信しない');
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (lan) {
      const refused = await new Promise(resolve => {
        const s = net.connect({ host: lan.address, port: PORT });
        s.on('connect', () => { s.destroy(); resolve(false); });
        s.on('error', () => resolve(true));
      });
      check(refused, `LAN のアドレス（${lan.address}）からは接続できない（127.0.0.1 / ::1 のみで待受け）`);
    }
    check((await apiPost('/api/import', { date: '2099-01-01', activity: 'x' })).status === 400, '未来の日付は受け付けない');

    // ==========================================================
    section('13-2. 取り込み実行 → MAP不足は画面で確認（本体は非反映）');
    const beforeStore = fs.readFileSync(storeFile, 'utf8');
    const head0 = head();
    let r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: [], files: images });
    check(r.status === 202 && r.json.state === 'running', '「取り込み実行」を受付（処理状況をポーリング）');
    let job = await waitJob(r.json.id);
    const mapP = (job.problems || []).find(p => p.type === 'map');
    check(job.state === 'needs_review' && job.message === '確認待ちのため停止しています' && job.step === 'validate',
      `確認待ちで停止（${job.message}・停止した工程: ${job.step}）— 「処理中」とは区別`);
    check(mapP && mapP.items.every(i => i.reason) && /推測で切り抜かず/.test(mapP.detail), `MAPを確認できない理由を画像ごとに表示（${mapP && mapP.items.map(i => i.reason).join(' / ')}）`);
    check(mapP && /1件のMAP画像を確認できません/.test(mapP.title) && mapP.items.length === 1 && mapP.items[0].time === '14:48' && mapP.items[0].amount === 331,
      `MAP不足を時刻・金額つきで表示（${mapP && mapP.title}: ${mapP && mapP.items.map(i => `${i.time} ¥${i.amount}`).join(', ')}）`);
    check(fs.readFileSync(storeFile, 'utf8') === beforeStore && head() === head0, 'UBER_LOG 本体（store.js）・git は変更なし');
    const inbox = await apiGet('/api/inbox/2026-09-22');
    check(inbox.json.activity.trim() === activity.trim().replace(/\r\n/g, '\n') && inbox.json.screenshots.length === 18,
      `日付フォルダ inbox/2026-09-22 に activity.txt・スクショ ${inbox.json.screenshots.length}枚を保存`);
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'official-import', 'staging', '2026-09-22.screens.json'), 'utf8'));
    check(doc.screenshots.every(s => s._sha256 && s.readBy === 'claude-code'), 'スクショ読取結果を staging に保存（画像ごとのハッシュ付き）');

    // ==========================================================
    section('13-3. 「MAPなしで取り込む」→ 反映・HANDOFF・commit・push まで完了');
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots, files: [], decisions: { mapMissingOk: [mapP.items[0].file] } });
    job = await waitJob(r.json.id);
    const res = job.result || {};
    const s = res.summary || {};
    check(job.state === 'done' && res.status === 'PASS', `完了（${job.message}）`);
    check(s.trips === 18 && s.deliveriesCount === 25 && s.deliverySales === 8250 && s.questSales === 1600 && s.adjustmentSales === -607 && s.totalSales === 9243 && s.distanceKm === 67.13 && s.maps === '17/18',
      `結果: ${s.trips}トリップ / ${s.deliveriesCount}配達 / 総売上 ¥${s.totalSales} / ${s.distanceKm}km / MAP ${s.maps}`);
    check(res.committed && res.pushed && head() !== head0 && sh('git', ['rev-parse', 'main'], remote) === head(), `commit ${res.commit} を作成し push 済み（送信先と一致）`);
    check(sh('git', ['log', '-1', '--format=%s'], root) === 'data(2026-09-22): official import (18 trips, ¥9,243)', 'commit メッセージ（data(日付): official import）');
    const changedFiles = sh('git', ['show', '--name-only', '--format=', 'HEAD'], root).split(/\r?\n/);
    check(changedFiles.every(f => /^(js\/store\.js|js\/trip-maps\.js|assets\/maps\/|index\.html|sw\.js|version\.json|HANDOFF\.md)/.test(f)) && !changedFiles.some(f => /inbox|staging|logs/.test(f)),
      `commit は取込対象ファイルのみ（生データ・staging は含まない）: ${changedFiles.length}ファイル`);
    check(sh('git', ['status', '--porcelain'], root) === '', 'git status clean');
    const ho = fs.readFileSync(handoff, 'utf8');
    check(ho.includes('公式取込 自動記録 開始') && /- 2026-09-22 \(火\): 配達 25件 \(18トリップ\).*売上 ¥9,243.*MAP 17\/18/.test(ho), 'HANDOFF の自動記録ブロックに 9/22 の行を追加');
    check(fs.readFileSync(path.join(root, 'HANDOFF.md'), 'utf8') === ho, 'HANDOFF.md（リポジトリ内）へ同期');
    const log22 = pipeline.readSeed(storeFile).data.dailyLogs['2026-09-22'];
    check(log22 && log22.tripsCount === 18 && log22.sales.total === 9243 && log22.officialImport, '既存の公式取込パイプラインで js/store.js に反映');

    // ==========================================================
    section('13-4. 同じ日をもう一度「取り込み実行」→ 二重登録なし');
    const head1 = head();
    const store1 = fs.readFileSync(storeFile, 'utf8');
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots, files: [] });
    job = await waitJob(r.json.id);
    check(job.state === 'done' && job.result.unchanged === true, `完了（取込済み・変更なし）: ${job.message}`);
    check(fs.readFileSync(storeFile, 'utf8') === store1 && head() === head1, 'store.js・git は変更なし（新しい commit なし）');

    // ==========================================================
    section('13-5. 取込エラー時は本体に反映しない');
    r = await apiPost('/api/import', { date: '2026-09-21', activity: fs.readFileSync(path.join(FIX, '2026-09-21.activity.txt'), 'utf8'), keep: [], files: [{ name: 'dummy.png', data: images[0].data }] });
    job = await waitJob(r.json.id);
    check(job.state === 'needs_review' && (job.problems || []).some(p => p.type === 'unreadable' || /Delivery件数一致/.test(p.title)),
      `読み取れないスクショ・件数不一致 → 確認が必要です（${(job.problems || []).map(p => p.title).join(' / ')}）`);
    check(fs.readFileSync(storeFile, 'utf8') === store1 && head() === head1, 'UBER_LOG 本体・git は変更なし');

    fs.appendFileSync(storeFile, '\n// 別作業の未コミット変更\n');
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots, files: [] });
    job = await waitJob(r.json.id);
    check(job.state === 'needs_review' && job.problems[0].type === 'git', '取込対象ファイルに未コミットの変更があれば混ぜずに停止');
    fs.writeFileSync(storeFile, store1, 'utf8');

    // 画面で外した画像は削除せず退避
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots.slice(1), files: [] });
    job = await waitJob(r.json.id);
    const prevDir = path.join(root, 'tools', 'official-import', 'inbox', '2026-09-22', '_previous');
    check(fs.existsSync(prevDir) && fs.readdirSync(prevDir).some(d => fs.readdirSync(path.join(prevDir, d)).includes(inbox.json.screenshots[0])),
      '画面で × にした画像は削除せず _previous へ退避');
    check(job.state === 'needs_review' && fs.readFileSync(storeFile, 'utf8') === store1, 'スクショが1枚足りない → 確認が必要です・本体は変更なし');

    // ==========================================================
    section('13-5b. 取込画面の表示（完了／処理中／確認待ちで停止／エラー停止の区別・クエスト重複の指定）');
    const ui = (await request('GET', '/tools/official-import/')).text;
    check(ui.includes('確認待ちのため停止しています（処理は動いていません') && ui.includes("'確認待ちで停止'") && ui.includes("'エラーで停止'") && ui.includes("'処理中…'") && ui.includes("'未実行'"),
      '進捗は工程ごとに 完了／処理中…／確認待ちで停止／エラーで停止／未実行 を表示');
    check(/replace\(\/中\(\?=（\|\$\)\/, ''\)/.test(ui), '完了・停止した工程に「保存中」などの「〜中」を出さない');
    check(ui.includes('data-act="count_once"') && ui.includes('data-act="count_all"') && ui.includes('questDuplicates'),
      'クエスト重複は画面のボタン（同じ報酬＝count_once / 別々の報酬＝count_all）で指定できる');
    check(ui.includes('前回と同じ理由で停止しました'), '同じ理由で繰り返し止まった場合は「前回と同じ理由で停止」と表示');

    // ==========================================================
    section('13-6. Claude Code が見つからない場合');
    delete process.env.UBER_SCREEN_READER_MOCK;
    process.env.UBER_CLAUDE_EXE = path.join(tmp, 'no-such-claude.exe');
    const { readScreens } = require('../lib/screen-reader.js');
    let msg = '';
    try { await readScreens(root, '2026-09-22', ['a.png']); } catch (e) { msg = e.message; }
    check(/Claude Code が見つかりません/.test(msg), `スクショ読取は「Claude Code が見つかりません」で停止（${msg.slice(0, 40)}…）`);
  } catch (e) {
    failed++;
    console.log(`  ❌ 例外: ${e.stack}`);
  } finally {
    if (server) server.kill();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 一時フォルダの削除失敗は無視 */ }
    console.log(`\n結果: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
