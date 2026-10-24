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
  ['js/store.js', 'js/trip-maps.js', 'js/cloud-sync.js', 'js/ui.js', 'js/app.js', 'index.html', 'sw.js', 'pickup-map.html', 'route-judge.html', 'version.json', 'manifest.json', '.gitignore', 'HANDOFF.md',
    'tools/release-check/version.js', 'tools/official-import/server.js', 'tools/official-import/index.html', 'tools/official-import/import.js'].forEach(copy);
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
    check(page.status === 200 && page.text.includes('id="primary"') && page.text.includes('スクショで取り込む'), '公式取込画面（/tools/official-import/）を配信・主ボタンは「次にやること」の1つ（#primary）');
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
    check(job.state === 'needs_review' && job.phase === 'PREVIEW_BLOCKED' && job.step === 'validate' && job.next === null && job.progress[0].status === 'waiting',
      `反映前の確認待ち（phase ${job.phase}・停止した工程: ${job.step}）— MAP の選択はカードのボタン・主ボタンなし`);
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
    check(job.state === 'done' && job.phase === 'COMPLETE' && res.status === 'PASS' && job.next === null && job.progress.every(p => p.status === 'done' || (p.key === 'review' && p.status === 'skip')),
      `完了（phase ${job.phase}・進捗 ${job.progress.map(p => p.status).join('/')}・次に押すボタンなし）`);
    check(s.trips === 18 && s.deliveriesCount === 25 && s.deliverySales === 8250 && s.questSales === 1600 && s.adjustmentSales === -607 && s.totalSales === 9243 && s.distanceKm === 67.13 && s.maps === '17/18',
      `結果: ${s.trips}トリップ / ${s.deliveriesCount}配達 / 総売上 ¥${s.totalSales} / ${s.distanceKm}km / MAP ${s.maps}`);
    check(res.committed && res.pushed && head() !== head0 && sh('git', ['rev-parse', 'main'], remote) === head(), `commit ${res.commit} を作成し push 済み（送信先と一致）`);
    check(sh('git', ['log', '-1', '--format=%s'], root) === 'data(2026-09-22): official import (18 trips, ¥9,243)', 'commit メッセージ（data(日付): official import）');
    const changedFiles = sh('git', ['show', '--name-only', '--format=', 'HEAD'], root).split(/\r?\n/);
    check(changedFiles.every(f => /^(js\/store\.js|js\/trip-maps\.js|assets\/maps\/|index\.html|sw\.js|pickup-map\.html|route-judge\.html|version\.json|HANDOFF\.md)/.test(f)) && !changedFiles.some(f => /inbox|staging|logs/.test(f)),
      `commit は取込対象ファイルのみ（生データ・staging は含まない）: ${changedFiles.length}ファイル`);
    check(['pickup-map.html', 'route-judge.html'].every(f => changedFiles.includes(f)) && sh('git', ['status', '--porcelain'], root) === '',
      '版更新した pickup-map.html・route-judge.html も同じ commit に含まれ、取込後に未コミットの変更が残らない');
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
    check(job.state === 'done' && job.phase === 'COMPLETE' && job.result.unchanged === true && ['test', 'handoff', 'commit', 'push'].every(k => job.progress.find(p => p.key === k).status === 'skip'),
      `完了（取込済み・変更なし）: ${job.message}・テスト/保存は不要`);
    check(fs.readFileSync(storeFile, 'utf8') === store1 && head() === head1, 'store.js・git は変更なし（新しい commit なし）');

    // ==========================================================
    section('13-5. 取込エラー時は本体に反映しない');
    r = await apiPost('/api/import', { date: '2026-09-21', activity: fs.readFileSync(path.join(FIX, '2026-09-21.activity.txt'), 'utf8'), keep: [], files: [{ name: 'dummy.png', data: images[0].data }] });
    job = await waitJob(r.json.id);
    check(job.state === 'needs_review' && job.phase === 'PREVIEW_BLOCKED' && job.next && job.next.act === 'revalidate' && (job.problems || []).some(p => p.type === 'unreadable' || /Delivery件数一致/.test(p.title)),
      `読み取れないスクショ・件数不一致 → 確認が必要です（${(job.problems || []).map(p => p.title).join(' / ')}）`);
    check(fs.readFileSync(storeFile, 'utf8') === store1 && head() === head1, 'UBER_LOG 本体・git は変更なし');

    fs.appendFileSync(storeFile, '\n// 別作業の未コミット変更\n');
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots, files: [] });
    job = await waitJob(r.json.id);
    check(job.state === 'needs_review' && job.phase === 'PREVIEW_BLOCKED' && job.problems[0].type === 'git', '取込と関係ない未コミットの変更があれば混ぜずに停止（保守で確認）');
    fs.writeFileSync(storeFile, store1, 'utf8');

    // 画面で外した画像は削除せず退避
    r = await apiPost('/api/import', { date: '2026-09-22', activity, keep: inbox.json.screenshots.slice(1), files: [] });
    job = await waitJob(r.json.id);
    const prevDir = path.join(root, 'tools', 'official-import', 'inbox', '2026-09-22', '_previous');
    check(fs.existsSync(prevDir) && fs.readdirSync(prevDir).some(d => fs.readdirSync(path.join(prevDir, d)).includes(inbox.json.screenshots[0])),
      '画面で × にした画像は削除せず _previous へ退避');
    check(job.state === 'needs_review' && fs.readFileSync(storeFile, 'utf8') === store1, 'スクショが1枚足りない → 確認が必要です・本体は変更なし');

    // ==========================================================
    section('13-5b. 取込画面の表示（状態ごとの案内は1か所・主ボタンは1つ・仮の数字なし）');
    const ui = (await request('GET', '/tools/official-import/')).text;
    const PH = ['IDLE', 'FETCHING', 'PREVIEW_READY', 'PREVIEW_BLOCKED', 'REFLECTING', 'REFLECTED', 'TESTING', 'TEST_FAILED', 'SAVING', 'SAVE_FAILED', 'PUSH_FAILED', 'COMPLETE', 'ERROR'];
    check(PH.every(p => new RegExp(`\\b${p}: \\{ cls:`).test(ui)), '見出し・説明は状態（phase）ごとの表1か所だけ（全13状態）');
    check((ui.match(/class="primary"/g) || []).length === 1 && !/class="primary"[^>]*data-act=/.test(ui), '緑の主ボタンは画面に1つだけ（#primary。問題カードの中に緑のボタンを作らない）');
    check(ui.includes("done: ['✓', '完了']") && ui.includes("doing: ['●', '実行中']") && ui.includes("waiting: ['Ⅱ', 'ユーザー確認待ち']") && ui.includes("error: ['×', 'エラー']") && ui.includes("todo: ['・', '未実行']"),
      '進捗の印: ✓ 完了 / ● 実行中 / Ⅱ ユーザー確認待ち / × エラー / ・ 未実行（確認待ちとエラーは別の表示）');
    check(!/4982|: 16;|: 13;|questSales : 1000|sm\.trips : 13/.test(ui) && ui.includes("'—'"), '仮の数字（13 trip・16件・¥4,982・¥1,000）を表示しない（値が無ければ「—」）');
    check(!/もう一度「取り込み実行」|従来の「取り込み実行」/.test(ui), '「もう一度取り込み実行」「従来の取り込み実行」の曖昧な案内を出さない');
    check(ui.includes('UBER_LOG には反映済みです。') && ui.includes('取り込みをやり直さないでください。') && ui.includes('GitHub への保存はまだです。'),
      'テスト失敗時: 反映済み・やり直さない・GitHub 未保存 を表示');
    check(ui.includes('本日はまだ終了していません。この後の配達は含まれません。'), '今日の日付を取り込むときの注意を表示');
    check(ui.includes('data-act="count_once"') && ui.includes('data-act="count_all"') && ui.includes('questDuplicates'),
      'クエスト重複は画面のボタン（同じ報酬＝count_once / 別々の報酬＝count_all）で指定できる');
    check(ui.includes('前回と同じ理由で停止しました'), '同じ理由で繰り返し止まった場合は「前回と同じ理由で停止」と表示');
    check(ui.includes('id="btn-reimport"') && /v\.reimport \?/.test(ui) && /function reimport\(date, sourceType\)[\s\S]*?\$\('date'\)\.value = date;[\s\S]*?render\(null\);[\s\S]*?startBrowserFetch\(false\);/.test(ui),
      '全工程完了の画面に「この日を最新データで再取込」: 同じ日付のまま最初の取得（内容確認つき）から始める');
    check(ui.includes('反映すると下の最新の公式データに置き換わります（加算されません）'), '再取込の確認画面: 前回の取込と「置き換え（加算しない）」を表示');

    // ==========================================================
    // Uber Web 構造化データ（structured-tests と同じ形の人工データ。trip の数だけ作る）
    const trip = (date, i, amount, points = 1, tip = null) => ({
      tripUuid: `${String(i).repeat(8).slice(0, 8)}-1111-1111-1111-${String(date.replace(/-/g, '')).padStart(12, '0')}`.slice(0, 36),
      statusType: 'COMPLETED', date, time: `1${i}:0${i}`, amount, baseFee: tip ? amount - tip : amount, tip, distanceKm: 2 + i, durationStr: `${10 + i}分0秒`, points,
      restaurant: `テスト店${i}`, area: '大阪市港区弁天1丁目', tripLegCount: points,
      legs: Array.from({ length: points }, (_, k) => ({ legUuid: `leg-${date}-${i}-${k}`, restaurant: `テスト店${i}`, pickupAddress: '大阪市港区弁天1-2-3', dropoffAddress: '大阪市港区弁天1丁目5-6' }))
    });
    // quests: 金額 または [[時刻, 金額], ...]
    const structured = (date, trips, quests) => ({
      source: 'uber-driver-web', fetchedAt: new Date().toISOString(), targetDate: date,
      activity: { feedItems: [...trips.map(t => ({ type: 'delivery', tripUuid: t.tripUuid, time: t.time, amount: t.amount })),
        ...(!quests ? [] : (Array.isArray(quests) ? quests : [['20:00', quests]]).map(([time, amount]) => ({ type: 'quest', title: 'クエスト', time, amount })))] },
      trips
    });
    const storeNow = () => fs.readFileSync(storeFile, 'utf8');
    const seedDay = d => pipeline.readSeed(storeFile).data.dailyLogs[d];

    section('13-7. PREVIEW_READY: 取得完了 → 内容確認 → 「この内容でUBER_LOGへ反映する」→ COMPLETE');
    const d24 = '2026-09-24';
    const p24 = structured(d24, [trip(d24, 1, 372), trip(d24, 2, 702, 2, 97)], 400);
    const storeA = storeNow();
    r = await apiPost('/api/import', { date: d24, structured: p24, previewFirst: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_READY' && job.next && job.next.act === 'apply' && job.next.label === 'この内容でUBER_LOGへ反映する',
      `取得・検証が終わったら PREVIEW_READY・主ボタンは「${job.next && job.next.label}」だけ`);
    check(job.progress.find(p => p.key === 'fetch').status === 'done' && job.progress.find(p => p.key === 'review').status === 'waiting', '進捗: 取得・検証 ✓・内容確認 Ⅱ（ユーザー確認待ち）');
    const pv = (job.problems || []).find(p => p.type === 'preview');
    check(pv && pv.summary.trips === 2 && pv.summary.deliveriesCount === 3 && pv.summary.totalSales === 1474 && job.result.deliveries.length === 2,
      `確認する数字は実データ（${pv && pv.summary.trips}trip・${pv && pv.summary.deliveriesCount}件・総売上 ¥${pv && pv.summary.totalSales}）`);
    check(storeNow() === storeA, 'PREVIEW_READY ではまだ UBER_LOG に反映しない');
    r = await apiPost('/api/import', { date: d24, structured: p24, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && job.progress.every(p => p.status === 'done') && job.result.committed && job.result.pushed,
      `反映 → テスト → HANDOFF → commit → push まで完了（${job.progress.map(p => `${p.label}:${p.status}`).join(' / ')}）`);
    check(seedDay(d24) && seedDay(d24).tripsCount === 2 && sh('git', ['status', '--porcelain'], root) === '', 'store.js に反映・git clean');

    section('13-8. 同じ日の再取込（途中データ → 最新の公式データ）: 重複しない・手動データを消さない');
    // 既にある公式データ（クエスト ¥400）が新しい取得結果に無い場合は、消さずに止める（PREVIEW_BLOCKED）
    const storeB = storeNow();
    r = await apiPost('/api/import', { date: d24, structured: structured(d24, [trip(d24, 1, 372), trip(d24, 2, 702, 2, 97), trip(d24, 3, 500)], [['21:00', 260]]), confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_BLOCKED' && storeNow() === storeB && (job.problems || []).some(p => /既存クエスト/.test(p.detail || '')),
      '再取込で既存の公式データ（クエスト ¥400）が見つからなければ、消さずに止める（UBER_LOG は変更なし）');
    // 10/12 の実例と同じ: 夕方の trip とクエストが増えた最新データ
    const p24b = structured(d24, [trip(d24, 1, 372), trip(d24, 2, 702, 2, 97), trip(d24, 3, 500)], [['20:00', 400], ['21:00', 260]]);
    r = await apiPost('/api/import', { date: d24, structured: p24b, confirmed: true });
    job = await waitJob(r.json.id);
    const day24 = seedDay(d24);
    const ids24 = day24.deliveries.map(d => d.id);
    check(job.phase === 'COMPLETE' && day24.tripsCount === 3 && day24.deliveriesCount === 4 && new Set(ids24).size === 3 && day24.sales.total === 702 + 372 + 500 + 400 + 260,
      `再取込で trip 2 → 3・配達 3 → 4件・総売上 ¥${day24.sales.total}（同じ trip を二重にしない: ${ids24.join(',')}）`);
    check(day24.deliveries[0].id === 'del_0924_1' && day24.deliveries[1].tip === 97, '既存の trip ID・チップは変わらない');

    section('13-11. 全工程完了の画面から同じ日を最新データで再取込（12 trip → 15 trip・加算しない・手入力を残す）');
    const d26 = '2026-09-26';
    // trip 番号ごとに一意の tripUuid・時刻（4の倍数はダブル配達）
    const trip26 = i => ({
      tripUuid: `${String(i).padStart(8, '0')}-2222-2222-2222-${d26.replace(/-/g, '').padStart(12, '0')}`,
      statusType: 'COMPLETED', date: d26, time: `${String(8 + i).padStart(2, '0')}:${String(i).padStart(2, '0')}`, amount: 300 + i * 10, baseFee: 300 + i * 10, tip: null,
      distanceKm: 2 + i / 10, durationStr: `${10 + i}分0秒`, points: i % 4 === 0 ? 2 : 1, restaurant: `再取込店${i}`, area: '大阪市港区弁天1丁目', tripLegCount: i % 4 === 0 ? 2 : 1,
      legs: Array.from({ length: i % 4 === 0 ? 2 : 1 }, (_, k) => ({ legUuid: `leg-${d26}-${i}-${k}`, restaurant: `再取込店${i}`, pickupAddress: '大阪市港区弁天1-2-3', dropoffAddress: '大阪市港区弁天1丁目5-6' }))
    });
    const range = n => Array.from({ length: n }, (_, k) => trip26(k + 1));
    const sales = n => range(n).reduce((a, t) => a + t.amount, 0);
    const points = n => range(n).reduce((a, t) => a + t.points, 0);
    const p26a = structured(d26, range(12), 500);
    r = await apiPost('/api/import', { date: d26, structured: p26a, previewFirst: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_READY' && job.result.previous === null, '1回目（未取込の日）: 確認画面に「前回の取込」は無い');
    r = await apiPost('/api/import', { date: d26, structured: p26a, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && seedDay(d26).tripsCount === 12 && seedDay(d26).deliveriesCount === points(12) && seedDay(d26).sales.total === sales(12) + 500,
      `1回目の取込: 12 trip・${points(12)}件・¥${sales(12) + 500}`);
    check(job.next === null && job.reimport && job.reimport.act === 'reimport' && job.reimport.date === d26 && job.reimport.label === 'この日を最新データで再取込',
      `全工程完了（COMPLETE）の画面に「${job.reimport && job.reimport.label}」（主ボタンではない・同じ日 ${job.reimport && job.reimport.date}）`);
    // 取込の後に端末で入力した手入力データ（経費・休みの指定・trip のメモ／評価・手動の天気）
    const manual = seedDay(d26);
    manual.expenses = [{ id: 'exp_manual_0926', category: 'バイクシェア', amount: 330, memo: '手入力の経費', createdAt: '2026-09-26T12:00:00Z', updatedAt: '2026-09-26T12:00:00Z' }];
    manual.dayOff = false;
    manual.weather = { type: 'rain', source: 'manual', raw: '', observedDate: d26 };
    manual.deliveries[2].memo = '手入力のメモ';
    Object.assign(manual.deliveries[2], { evaluation: 'AVOID', evaluationReason: '手入力の評価理由', evaluationUpdatedAt: '2026-09-26T12:00:00Z' });
    delete manual.officialImport;
    const imported26 = seedDay(d26).officialImport;
    pipeline.writeSeedDay(storeFile, d26, { ...manual, officialImport: imported26 });
    sh('git', ['commit', '-q', '-am', 'test: 手入力データ'], root);
    const idsBefore = manual.deliveries.map(d => d.id);

    // 「この日を最新データで再取込」= 同じ日の新しい取込ジョブ（取得 → 内容確認 → 反映 → テスト → HANDOFF → commit → push）
    const p26b = structured(d26, range(15), 500);
    const storeC = storeNow();
    r = await apiPost('/api/import', { date: job.reimport.date, structured: p26b, previewFirst: true });
    check(r.status === 202, '完了済み（COMPLETE）の取込があっても、同じ日の新しい取込を受け付ける');
    job = await waitJob(r.json.id);
    const prev26 = job.result && job.result.previous;
    check(job.phase === 'PREVIEW_READY' && prev26 && prev26.trips === 12 && prev26.deliveriesCount === points(12) && prev26.totalSales === sales(12) + 500 && job.result.summary.trips === 15,
      `再取込の確認画面: 前回 ${prev26 && prev26.trips} trip → 今回 ${job.result.summary.trips} trip（まだ反映しない）`);
    check(storeNow() === storeC, '内容確認の段階では UBER_LOG を変更しない');
    const headC = head();
    r = await apiPost('/api/import', { date: d26, structured: p26b, confirmed: true });
    job = await waitJob(r.json.id);
    const day26 = seedDay(d26);
    const ids26 = day26.deliveries.map(d => d.id);
    check(job.phase === 'COMPLETE' && job.progress.every(p => p.status === 'done') && job.result.committed && job.result.pushed && head() !== headC && sh('git', ['status', '--porcelain'], root) === '',
      `再取込も 反映 → テスト → HANDOFF → commit → push まで完了（${sh('git', ['log', '-1', '--format=%s'], root)}）`);
    check(day26.tripsCount === 15 && day26.deliveries.length === 15 && new Set(ids26).size === 15, `trip は 15（12＋15＝27 にならない）: ${day26.tripsCount} trip / ${day26.deliveries.length} 件の明細`);
    check(day26.deliveriesCount === points(15) && day26.officialPoints === points(15), `配達件数は ${points(15)}（加算されない: ${day26.deliveriesCount}）`);
    check(day26.sales.delivery === sales(15) && day26.sales.total === sales(15) + 500 && day26.quests.length === 1, `売上は最新の公式値 ¥${day26.sales.total}（加算されない・クエストも1件のまま）`);
    check(idsBefore.every((id, k) => ids26[k] === id), '既存の trip ID は変わらない（新しい3件だけ追加）');
    check(day26.expenses.length === 1 && day26.expenses[0].id === 'exp_manual_0926' && day26.expenses[0].amount === 330, '手入力の経費を保持');
    check(day26.dayOff === false, '手入力の休みの指定（dayOff）を保持');
    const t3 = day26.deliveries.find(d => d.id === manual.deliveries[2].id);
    check(t3.memo === '手入力のメモ' && t3.evaluation === 'AVOID' && t3.evaluationReason === '手入力の評価理由', 'trip のメモ・評価（○／×と理由）を保持');
    check(day26.weather && day26.weather.type === 'rain' && day26.weather.source === 'manual', '手動の天気を保持');
    check(day26.officialImport && day26.officialImport.importedAt !== imported26.importedAt, '公式取込の時刻（officialImport.importedAt）は新しい取込に更新');

    // 同じ最新データをもう一度: 変更なし（二重にならない）
    const storeD = storeNow();
    r = await apiPost('/api/import', { date: d26, structured: p26b, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && job.result.unchanged === true && storeNow() === storeD && job.reimport && job.reimport.date === d26,
      '同じ内容でもう一度再取込しても変更なし（3回目も可能・二重にならない）');
    // 古い公式データ（12 trip の途中データ）への巻き戻しは止める
    r = await apiPost('/api/import', { date: d26, structured: p26a, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_BLOCKED' && storeNow() === storeD && (job.problems || []).some(p => /既存trip/.test(`${p.title} ${p.detail || ''}`)),
      '古い途中データ（12 trip）で再取込しても 15 trip を巻き戻さない（消さずに止める・UBER_LOG は変更なし）');
    // 別の日の取込は従来どおり
    const d27 = '2026-09-27';
    r = await apiPost('/api/import', { date: d27, structured: structured(d27, [trip(d27, 6, 480)]), confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && seedDay(d27).tripsCount === 1 && seedDay(d26).tripsCount === 15 && job.reimport.date === d27,
      '別の日の取込も従来どおり完了（再取込した日は変わらない）');

    section('13-9. TEST_FAILED: 反映済み・テスト失敗 →「テストと保存を再開する」（取得・反映はやり直さない）');
    server.kill();
    await sleep(500);
    await startServer({ UBER_IMPORT_TEST_CMD: JSON.stringify([process.execPath, '-e', 'console.log("❌ FAIL: わざと失敗"); process.exit(1)']) });
    const d25 = '2026-09-25';
    const headBefore = head();
    r = await apiPost('/api/import', { date: d25, structured: structured(d25, [trip(d25, 4, 640)]), confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'TEST_FAILED' && job.applied === true && job.next && job.next.act === 'resume' && job.next.label === 'テストと保存を再開する',
      `反映済みでテスト失敗 → TEST_FAILED・主ボタン「${job.next && job.next.label}」`);
    check(job.progress.find(p => p.key === 'apply').status === 'done' && job.progress.find(p => p.key === 'test').status === 'error' && job.progress.find(p => p.key === 'commit').status === 'todo',
      '進捗: UBER_LOG反映 ✓・自動テスト ×・commit 未実行');
    check(/UBER_LOG へは反映済み/.test(job.problems[0].detail) && /やり直さないで/.test(job.problems[0].detail) && /わざと失敗/.test(job.problems[0].detail), '反映済み・やり直さない・失敗したテストの行を表示');
    check(seedDay(d25) && head() === headBefore, 'store.js には反映済み・commit はしていない');
    const pend = await apiGet('/api/pending');
    check(pend.json.pending && pend.json.pending.kind === 'uncommitted' && pend.json.pending.date === d25, `保存待ちを検出（${JSON.stringify(pend.json.pending && { kind: pend.json.pending.kind, date: pend.json.pending.date })}）`);
    const store25 = storeNow();
    r = await apiPost('/api/import', { date: d24, structured: p24b, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'TEST_FAILED' && job.pendingDate === d25 && job.next.date === d25 && storeNow() === store25,
      '保存待ちのまま別の取込を押しても取得・反映しない（TEST_FAILED のまま・再開ボタンは保存待ちの日）');
    server.kill();
    await sleep(500);
    const browserMock = path.join(tmp, 'browser-mock.json'); // Uber Web 取得の代わり（13-12）。本物の Uber にはつながない
    fs.writeFileSync(browserMock, JSON.stringify({ __mockError: '未設定' }), 'utf8');
    await startServer({ UBER_BROWSER_MOCK: browserMock });
    check((await apiGet('/api/jobs/current')).status === 404 && (await apiGet('/api/pending')).json.pending.date === d25, 'サーバーを再起動しても保存待ちが分かる（/api/pending）');
    r = await apiPost('/api/resume', { date: d25 });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && job.result.committed && job.result.pushed && sh('git', ['status', '--porcelain'], root) === '' && sh('git', ['rev-parse', 'main'], remote) === head(),
      `再開でテスト → HANDOFF → commit → push だけを実行（取得・反映なし）: ${sh('git', ['log', '-1', '--format=%s'], root)}`);
    check(seedDay(d25).tripsCount === 1 && storeNow() === store25, '再開しても UBER_LOG のデータは変わらない（二重反映なし）');
    r = await apiPost('/api/resume', { date: d25 });
    job = await waitJob(r.json.id);
    check(job.phase === 'ERROR' && /再開できる取込がありません/.test(job.problems[0].title), '保存待ちが無いときの再開は何もしない（ERROR・UBER_LOG は変更なし）');

    section('13-10. 今日の取込（1日が終わっていない途中のデータ）');
    const { jstToday } = require('../lib/import-job.js');
    const today = jstToday();
    r = await apiPost('/api/import', { date: today, structured: structured(today, [trip(today, 5, 450)]), previewFirst: true });
    job = await waitJob(r.json.id);
    check(job.partialDay === true && job.today === today && job.phase === 'PREVIEW_READY', `今日（${today}）の取込は partialDay（画面に「本日はまだ終了していません」）・取込自体はできる`);

    section('13-12. Uber Web 取得の再取込は毎回新しく取得する（失敗時に前回の取得結果で代用しない）');
    const d28 = '2026-09-28';
    const inbox28 = path.join(root, 'tools', 'official-import', 'inbox', d28, 'structured.json');
    const staging28 = path.join(root, 'tools', 'official-import', 'staging', `${d28}.json`);
    const fetchAs = (trips, fetchedAt) => fs.writeFileSync(browserMock, JSON.stringify({ ...structured(d28, trips, 300), fetchedAt, lastTripAt: `9/28 ${trips[trips.length - 1].time}` }), 'utf8');
    // 1回目（昼）: 2 trip を取得 → 確認 → 反映
    const T1 = '2026-09-28T03:00:00.000Z';
    fetchAs([trip(d28, 1, 400), trip(d28, 2, 500)], T1);
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: false });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_READY' && job.result.fetchedAt === T1 && job.result.lastTripAt === '9/28 12:02' && job.result.summary.trips === 2,
      `取得結果の確認画面に取得日時（${job.result.fetchedAt}）と Uber Web の最終トリップ（${job.result.lastTripAt}）`);
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: true, fetchedAt: T1 });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && seedDay(d28).tripsCount === 2, '確認した取得結果（取得日時が一致）を反映して完了');
    // 2回目（夜）: Uber Web 側に trip が増えた → 新しく取得した 3 trip が出る（保存済みの 2 trip ではない）
    const T2 = '2026-09-28T12:00:00.000Z';
    fetchAs([trip(d28, 1, 400), trip(d28, 2, 500), trip(d28, 3, 600)], T2);
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: false });
    job = await waitJob(r.json.id);
    check(job.phase === 'PREVIEW_READY' && job.result.summary.trips === 3 && job.result.fetchedAt === T2 && job.result.previous.trips === 2 && JSON.parse(fs.readFileSync(inbox28, 'utf8')).fetchedAt === T2,
      `再取込は Uber Web から新しく取得（前回 ${job.result.previous && job.result.previous.trips} trip → 今回 ${job.result.summary.trips} trip・取得日時 ${job.result.fetchedAt}）`);
    // 取得に失敗（10/18 の実例: getTrip の応答なし）→ 前回の取得結果で代用しない・取得結果（inbox / staging）も UBER_LOG も変えない
    const inboxBefore = fs.readFileSync(inbox28, 'utf8');
    const stagingBefore = fs.readFileSync(staging28, 'utf8');
    const storeE = storeNow();
    fs.writeFileSync(browserMock, JSON.stringify({ __mockError: 'getTrip db06ec4c を取得できませんでした（3回試行）: CDPコマンドタイムアウト (Runtime.evaluate)' }), 'utf8');
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: false });
    job = await waitJob(r.json.id);
    check(job.phase === 'ERROR' && job.next && job.next.act === 'restart' && /保存済みの前回の取得結果は使っていません/.test(job.problems[0].detail) && /CDPコマンドタイムアウト/.test(job.problems[0].detail),
      `取得失敗は ERROR（「最初から取得し直す」）: ${job.problems[0].detail.split('\n')[0]}`);
    check(!job.result && !(job.problems || []).some(p => p.type === 'preview'), '取得失敗を「取得成功」の確認画面として出さない（数字を出さない）');
    check(fs.readFileSync(inbox28, 'utf8') === inboxBefore && fs.readFileSync(staging28, 'utf8') === stagingBefore && storeNow() === storeE,
      '取得失敗では inbox の取得結果・staging・UBER_LOG を書き換えない（新しい取得に成功したときだけ更新）');
    // HTTP 403（10/24 の実例）→ ERROR で止まる。ログイン待ち・取得成功にはしない・inbox / staging / UBER_LOG を変えない
    const { http403Message } = require('../lib/browser-fetcher.js');
    fs.writeFileSync(browserMock, JSON.stringify({ __mockError: http403Message('getTrip 874d7c7d', { status: 403, statusText: 'Forbidden', contentType: 'text/html', bodyKind: 'html', bodyLength: 1234, hints: ['login'] }) }), 'utf8');
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: false });
    job = await waitJob(r.json.id);
    check(job.phase === 'ERROR' && job.state === 'error' && /HTTP 403（アクセス拒否）/.test(job.problems[0].detail) && /原因はまだ確定していません/.test(job.problems[0].detail) && /時間を空けて/.test(job.problems[0].detail),
      `HTTP 403 は ERROR（原因未確定・時間を空けて確認）: ${job.problems[0].detail.split('\n')[1] || ''}`);
    check(!job.result && !(job.problems || []).some(p => p.type === 'preview' || p.type === 'auth'), 'HTTP 403 を取得成功・ログイン待ちとして扱わない');
    check(fs.readFileSync(inbox28, 'utf8') === inboxBefore && fs.readFileSync(staging28, 'utf8') === stagingBefore && storeNow() === storeE,
      'HTTP 403 では inbox の取得結果・staging・UBER_LOG を書き換えない');
    // 確認していない取得結果を反映しない
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: true, fetchedAt: T1 });
    job = await waitJob(r.json.id);
    check(job.phase === 'ERROR' && /確認した取得結果/.test(job.problems[0].detail) && storeNow() === storeE, '確認画面と違う取得結果（取得日時が不一致）は反映しない');
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: true });
    job = await waitJob(r.json.id);
    check(job.phase === 'ERROR' && storeNow() === storeE, '取得日時の無い反映要求は反映しない（確認なしで反映しない）');
    r = await apiPost('/api/import', { date: d28, useBrowser: true, confirmed: true, fetchedAt: T2 });
    job = await waitJob(r.json.id);
    check(job.phase === 'COMPLETE' && seedDay(d28).tripsCount === 3 && seedDay(d28).sales.total === 1800, '確認した最新の取得結果（3 trip）を反映して完了（加算しない: ¥1,800）');
    const ui2 = (await request('GET', '/tools/official-import/')).text;
    check(ui2.includes('payload.fetchedAt = fetchedAt') && ui2.includes('前回の取込と同じ内容です'), '画面: 反映は確認した取得結果（取得日時）を指定・前回と同じ内容なら注意を表示');

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
