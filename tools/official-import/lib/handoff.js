/**
 * HANDOFF の自動更新（「取り込み実行」で公式取込を反映したとき）
 *
 * 正本 UBER_HANDOFF.txt の中の「公式取込 自動記録」ブロック（開始／終了マーカーの間）だけを書き換える。
 * 手書きの記録は変更しない。ブロックが無ければ冒頭（最初の「■」節の前）に作る。
 * 日別の行は日付ごとに追加・更新し、集計（今週・今月・クエスト・MAP）は最新値で置き換える。
 */
'use strict';

const fs = require('fs');

const START = '<<< 公式取込 自動記録 開始（取り込み実行ボタンで自動更新・手で編集しない） >>>';
const END = '<<< 公式取込 自動記録 終了 >>>';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const yen = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Number(n) || 0).toLocaleString('en-US');
function hms(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dayRow(date, r) {
  const d = r.day;
  const wd = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
  return `- ${date} (${wd}): 配達 ${d.count}件 (${d.trips}トリップ) | 配達報酬 ${yen(d.delivery)} ＋ クエスト ${yen(d.quest)} ＋ 調整 ${yen(d.adjustment)} ＝ 売上 ${yen(d.total)}` +
    ` | 配達時間 ${hms(d.seconds)} | 走行 ${Number(d.distance).toFixed(2)}km | MAP ${d.maps}/${d.trips} | 経費: アプリ入力分（HANDOFF未把握）`;
}

function buildBlock(existingRows, info) {
  const { date, report: r, version, commit } = info;
  const rows = new Map(existingRows.map(l => [l.slice(2, 12), l]));
  rows.set(date, dayRow(date, r));
  const w = r.week;
  const m = r.month;
  const a = r.analytics;
  return [
    START,
    '■ 公式取込 自動記録（デスクトップの UBER_LOG →「取り込み実行」で反映した日）',
    `最終取込: ${stamp()}（対象 ${date} / version ${version || '変更なし'}${commit ? ` / commit ${commit}` : ''}）`,
    '【日別】',
    ...[...rows.keys()].sort().map(k => rows.get(k)),
    '【最新の集計（アプリ同梱データ。端末で入力した経費は含まない）】',
    `- 今週 ${w.periodLabel}: 売上 ${yen(w.officialSales)}（配達報酬 ${yen(w.deliverySales)} / クエスト ${yen(w.questSales)} / 特別 ${yen(w.guaranteeBonus)} / その他 ${yen(w.otherSales)}） / Bike ${yen(w.bikeExpenses)} / 売上利益 ${yen(w.salesProfit)} / ${w.deliveriesCount}件`,
    `- 今月 ${m.periodLabel}: 売上 ${yen(m.sales)} / Bike ${yen(m.bikeExpenses)} / 必要経費 ${yen(m.otherExpenses)} / 売上利益 ${yen(m.salesProfit)} / ${m.deliveriesCount}件 / ${r.monthTrips}trip`,
    `- 通常分析売上 ${yen(a.regular)} / 稼働 ${a.days}日 / 平均日給 ${yen(a.avgDaily)} / 平均単価 ${yen(a.avgPer)} / 平均時給 ${yen(a.avgHourly)} / 配達時間 ${hms(a.seconds)} / 距離 ${a.distance}km`,
    `- ${r.quest.title}: ${r.quest.current}/${r.quest.target}（残 ${r.quest.remaining}）`,
    `- MAP登録数: ${r.maps.mapped}/${r.maps.total}`,
    END
  ].join('\n');
}

/**
 * @param {string} file UBER_HANDOFF.txt のパス
 * @param {{date:string, report:Object, version?:string, commit?:string}} info
 */
function updateHandoff(file, info) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = raw.replace(/\r\n/g, '\n');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  let rows = [];
  if (s >= 0 && e > s) {
    rows = text.slice(s, e).split('\n').filter(l => /^- \d{4}-\d{2}-\d{2} /.test(l));
    text = text.slice(0, s) + buildBlock(rows, info) + text.slice(e + END.length);
  } else {
    const first = text.search(/\n■ /);
    const block = buildBlock(rows, info);
    text = first >= 0 ? text.slice(0, first + 1) + block + '\n\n' + text.slice(first + 1) : text + '\n' + block + '\n';
  }
  text = text.replace(/^最終更新日時: .*$/m, `最終更新日時: ${stamp()} (JST)`);
  fs.writeFileSync(file, eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  // 書込後の再読込確認
  const check = fs.readFileSync(file, 'utf8');
  if (!check.includes(START) || !check.includes(`- ${info.date} (`)) throw new Error('HANDOFF の書込後確認に失敗しました');
}

module.exports = { updateHandoff, START, END };
