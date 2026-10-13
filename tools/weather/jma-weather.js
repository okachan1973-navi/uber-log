/**
 * 気象庁「過去の気象データ検索」日ごとの値（主な要素）の読み取りと天気の分類
 *
 * 対象ページ（GET・APIキー不要・無料）:
 *   https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php?prec_no=62&block_no=47772&year=YYYY&month=MM&day=&view=
 *   （大阪 = 府県番号 62・地点番号 47772。表 id='tablefix1'・1行1日・21列）
 * 使う列（2026年9月・10月の実ページで確認）:
 *   [0] 日 / [3] 降水量 合計(mm) / [16] 日照時間(h) / [19] 天気概況 昼(06:00-18:00) / [20] 天気概況 夜(18:00-翌日06:00)
 *   降水量の「--」は「該当現象なし（降水なし）」、「0.0」は 0.5mm 未満の降水あり。天気概況は数日後に入る（未発表の日は空欄）。
 *
 * 天気の分類（DATA_MODEL.md「天気」）。昼（06:00-18:00）の天気概況だけで決める:
 *   rain   … 昼の天気概況に「雨」「雪」「みぞれ」「ひょう」「あられ」を含む（一時雨・時々雨・後雨・大雨・雷を伴う も含む）
 *   sunny  … 降水なしで、昼の天気概況の最初の天気が「快晴」「晴」
 *   cloudy … 降水なしで、昼の天気概況の最初の天気が「薄曇」「曇」
 *   unknown… 上のどれにも当てはまらない（霧・煙霧など）
 *   天気概況が空欄（未発表）の日は保存しない（画面は「—」）。
 * 例: 「晴後曇」→ sunny（最初の天気）、「曇後晴」→ cloudy、「曇時々晴後時々雨、雷を伴う」→ rain、「曇後一時雨」→ rain。
 * 夜（18:00-翌06:00）の概況は分類に使わず、そのまま保存する（夜だけ雨の日は nightRain: true）。
 */
'use strict';

const STATION = { name: '大阪（大阪府）', prec_no: '62', block_no: '47772' };
const PRECIP_WORDS = /雨|雪|みぞれ|ひょう|あられ/;
const TYPES = ['sunny', 'cloudy', 'rain', 'unknown'];

function pageUrl(year, month) {
  return `https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php?prec_no=${STATION.prec_no}&block_no=${STATION.block_no}&year=${year}&month=${String(month).padStart(2, '0')}&day=&view=`;
}

/** 昼の天気概況 → 'sunny' | 'cloudy' | 'rain' | 'unknown' | null（空欄） */
function classify(dayText) {
  const t = String(dayText || '').trim();
  if (!t) return null;
  if (PRECIP_WORDS.test(t)) return 'rain';
  const first = t.replace(/^大/, '').match(/^(快晴|晴|薄曇|曇)/);
  if (!first) return 'unknown';
  return /晴/.test(first[1]) ? 'sunny' : 'cloudy';
}

const cell = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const num = s => {
  const t = cell(s).replace(/[\])]/g, '').trim();
  if (t === '' || t === '--' || t === '///' || t === '×') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * ページの HTML を日別の値に変換する
 * @returns {{date:string, day:string, night:string, precipitationMm:number|null, precipitationNone:boolean, sunshineH:number|null}[]}
 */
function parseDailyPage(html, year, month) {
  const i = html.indexOf("id='tablefix1'");
  if (i < 0) throw new Error('気象庁のページに表（tablefix1）が見つかりません（ページの形式が変わった可能性）');
  const table = html.slice(i);
  const head = table.slice(0, table.indexOf('<tr class="mtx" style="text-align:right;">'));
  if (!/天気概況/.test(head) || !/昼<br \/>\(06:00-18:00\)/.test(head) || !/夜<br \/>\(18:00-翌日06:00\)/.test(head)) {
    throw new Error('気象庁のページの見出しが想定と違います（天気概況 昼・夜 の列が見つからない）');
  }
  const rows = [...table.matchAll(/<tr class="mtx" style="text-align:right;">([\s\S]*?)<\/tr>/g)]
    .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]));
  return rows.filter(c => c.length === 21).map(c => {
    const d = Number(cell(c[0]));
    const precipRaw = cell(c[3]);
    return {
      date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      day: cell(c[19]),
      night: cell(c[20]),
      precipitationMm: num(c[3]),
      precipitationNone: precipRaw === '--',
      sunshineH: num(c[16])
    };
  });
}

/** 保存する1日分（天気概況が空欄の日は null） */
function toEntry(row) {
  const type = classify(row.day);
  if (!type) return null;
  return {
    type,
    day: row.day,
    night: row.night || '',
    nightRain: !!row.night && PRECIP_WORDS.test(row.night),
    precipitationMm: row.precipitationMm,
    precipitationNone: row.precipitationNone,
    sunshineH: row.sunshineH
  };
}

module.exports = { STATION, TYPES, pageUrl, classify, parseDailyPage, toEntry };
