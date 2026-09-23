/**
 * Delivery詳細スクショの読取（Claude Code を非対話 `claude -p` で起動）
 *
 * - 使えるツールは Read だけ（--tools Read）。ファイルの書込・コマンド実行はさせない。
 * - 許可確認が必要な操作はすべて自動拒否（--permission-prompts none）。権限スキップは使わない。
 * - 結果は --json-schema の構造化出力（structured_output）で受け取り、backend が staging へ書く。
 * - 読めない値は "UNKNOWN"。推測・補完はさせない（検証で止まる）。
 *
 * テスト用: 環境変数 UBER_SCREEN_READER_MOCK に読取結果JSON（{screenshots:[...]}）のパスを指定すると Claude を呼ばない。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BATCH = 8;

const SCHEMA = {
  type: 'object',
  properties: {
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          kind: { type: 'string', enum: ['delivery', 'summary', 'other'] },
          date: { type: 'string' },
          time: { type: 'string' },
          amount: { type: 'string' },
          baseFee: { type: ['number', 'null'] },
          tip: { type: ['number', 'null'] },
          durationStr: { type: 'string' },
          distanceKm: { type: 'string' },
          restaurant: { type: 'string' },
          area: { type: 'string' },
          points: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['file', 'kind', 'date', 'time', 'amount', 'baseFee', 'tip', 'durationStr', 'distanceKm', 'restaurant', 'area', 'points', 'note']
      }
    }
  },
  required: ['screenshots']
};

function buildPrompt(date, relFiles) {
  return [
    `UBER_LOG 公式取込: ${date} の Uber「Delivery詳細」スクリーンショットを読み取ってください。`,
    '次の画像ファイルを Read ツールで1枚ずつ必ず全部開き、画面に表示されている値だけを記入します（推測・逆算・補完は禁止）。',
    '',
    ...relFiles.map(f => `- ${f}`),
    '',
    '記入ルール（1枚につき1件。file は上のパスのファイル名部分だけ）:',
    '- kind: Delivery詳細なら "delivery"。1日の合計画面なら "summary"、それ以外の画像（ダイアログのキャプチャ等）は "other"。delivery 以外は他の項目を "UNKNOWN"、baseFee/tip を null に。',
    '- date: 見出しの日付を YYYY-MM-DD（例: 2026年9月23日 → 2026-09-23）',
    '- time: 見出しの時刻を24時間表記 HH:MM（例: 午後12時53分 → 12:53、午前8時01分 → 08:01）',
    '- amount: 見出しの金額（最終売上。チップ込み）を数字のみ（例: "538"）',
    '- baseFee / tip: 売り上げ欄に「チップ」がある場合のみ、料金とチップを数値で。チップが無ければ両方 null',
    '- durationStr: 「時間」欄（例: "52分31秒"）  distanceKm: 「距離」欄の数値だけ（例: "6.81"）  points: 「Nポイントを獲得」の N（例: "2"）',
    '- restaurant: 店舗名を表示どおり（英字併記もそのまま、改行は半角スペースでつなぐ）',
    '- area: 配達先を丁目まで。先頭の都道府県コード（27 など）は付けない（例: "27大阪市西区本田1丁目" → "大阪市西区本田1丁目"）。番地・部屋番号・氏名は絶対に書かない。',
    '  配達先がローマ字表記だけの場合（例: "2-chōme Osaka Osaka Enokojima 日本"）は、町名を日本語に直せるときだけ "大阪市 江之子島2丁目" のように区名を推測せず記入し、',
    '  note に "公式配達先表記: <原文>" を入れる。直せなければ area は "UNKNOWN"。',
    '- note: 上記以外は空文字 ""',
    '- 読めない・自信がない項目は "UNKNOWN"（数値項目 baseFee/tip は null）。1枚も飛ばさないこと。'
  ].join('\n');
}

function findClaude() {
  if (process.env.UBER_CLAUDE_EXE) {
    return fs.existsSync(process.env.UBER_CLAUDE_EXE) ? process.env.UBER_CLAUDE_EXE : null;
  }
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  (process.env.PATH || '').split(path.delimiter).forEach(dir => {
    if (dir) candidates.push(path.join(dir, 'claude.exe'));
  });
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

function runClaude(exe, root, prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--tools', 'Read', '--permission-prompts', 'none', '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence'];
    const child = spawn(exe, args, { cwd: root, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('スクショ読取がタイムアウトしました（10分）')); }, 10 * 60 * 1000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch (e) { /* 下で扱う */ }
      if (code !== 0 || !j || j.is_error || !j.structured_output) {
        const msg = (j && (j.result || j.api_error_status)) || err.trim() || out.trim().slice(0, 300);
        reject(new Error(`Claude Code のスクショ読取に失敗しました: ${msg}`));
        return;
      }
      resolve(j.structured_output.screenshots || []);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/**
 * @param {string} root UBER_LOG ルート
 * @param {string} date YYYY-MM-DD
 * @param {string[]} files screenshots フォルダ内のファイル名
 * @param {(msg:string)=>void} onProgress
 * @returns {Promise<Object[]>} screens.json の screenshots 形式
 */
async function readScreens(root, date, files, onProgress = () => {}) {
  if (!files.length) return [];
  if (process.env.UBER_SCREEN_READER_MOCK) {
    const mock = JSON.parse(fs.readFileSync(process.env.UBER_SCREEN_READER_MOCK, 'utf8'));
    return files.map(f => mock.screenshots.find(s => s.file === f)).filter(Boolean);
  }
  const exe = findClaude();
  if (!exe) throw new Error('Claude Code が見つかりません（スクショ読取に必要です）。Claude Code をインストール・ログインしてから、もう一度「取り込み実行」を押してください。');
  const rel = f => path.posix.join('tools/official-import/inbox', date, 'screenshots', f);
  const results = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    onProgress(`スクショ確認中... ${Math.min(i + chunk.length, files.length)}/${files.length}枚`);
    const got = await runClaude(exe, root, buildPrompt(date, chunk.map(rel)));
    chunk.forEach(f => {
      const hit = got.find(g => g.file === f || path.basename(String(g.file || '')) === f);
      if (hit) results.push({ ...hit, file: f });
    });
  }
  return results;
}

module.exports = { readScreens, findClaude, buildPrompt, SCHEMA };
