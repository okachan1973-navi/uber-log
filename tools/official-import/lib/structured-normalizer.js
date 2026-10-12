/**
 * UBER_LOG 公式取込 — Uber Web 構造化データ正規化モジュール
 *
 * Uber Driver Web の getTrip レスポンスおよびアクティビティフィード（getWebActivityFeed）から
 * UBER_LOG の標準形式へ安全に変換・正規化する。
 *
 * 【重要原則】
 * 1. 順番の捏造禁止:
 *    legs[0], legs[1] だからといって実際のPICK/DROP順序だと推測しない。
 *    各legの個別タイムスタンプや明示的なイベント履歴がない場合は
 *    「2つのPICK/DROPペアは特定できるが、実際の走行順は未確定（sequence: null）」として扱う。
 * 2. 金額内訳一致:
 *    baseFee + tip === amount を厳密に検証。
 * 3. プライバシー保護:
 *    area は丁目まで。番地・号・部屋番号等は除外。
 */
'use strict';

const parser = require('./activity-parser.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeArea(area) {
  let a = parser.toHalfWidth(String(area || '')).replace(/\s+/g, '');
  a = a.replace(/^\d{2}(?=\D)/, ''); // 先頭の都道府県コード（例: 27大阪市…）
  return a;
}

function privacyIssue(area) {
  const parts = String(area || '').split(/\s*[\/／]\s*/);
  for (const part of parts) {
    if (/丁目.*\d/.test(part)) return '丁目より後ろに数字（番地等）が含まれています';
    if (/(\d+\s*番地?|\d+\s*号|号室|〒|\d+-\d+|\d+F\b|階)/i.test(part)) return '番地・部屋番号などが含まれています';
  }
  return null;
}

/**
 * 住所文字列から市区町村・丁目までを抽出し、番地・号・建物名・部屋番号を除去する。
 * 例: "大阪府大阪市西区江戸堀1丁目2-3 ABCマンション101" -> "大阪市西区江戸堀1丁目"
 */
function sanitizeAddressToArea(rawAddress) {
  if (!rawAddress) return '';
  let a = parser.toHalfWidth(String(rawAddress)).replace(/\s+/g, ' ').trim();
  // 郵便番号除去
  a = a.replace(/〒?\s*\d{3}-\d{4}/g, '').trim();
  // 日本/Japan 除去
  a = a.replace(/(?:日本|Japan)\s*,?\s*/gi, '').trim();
  // 先頭の都道府県コード（例: 27大阪市...）
  a = a.replace(/^\d{2}(?=\D)/, '');
  // 都道府県名の冗長部分を整理（必要に応じて）
  // 丁目までの抽出を試みる
  const chomeMatch = a.match(/^(.+?[都道府県]?.+?[市区町村].+?\d+丁目)/);
  if (chomeMatch) {
    let res = chomeMatch[1].replace(/^(?:大阪府|京都府|東京都|兵庫県|奈良県|滋賀県|和歌山県)/, '');
    return res.replace(/\s+/g, '');
  }
  // 丁目がない場合、町名までを抽出
  const machiMatch = a.match(/^(.+?[都道府県]?.+?[市区町村].+?[町東西南北])/);
  if (machiMatch) {
    let res = machiMatch[1].replace(/^(?:大阪府|京都府|東京都|兵庫県|奈良県|滋賀県|和歌山県)/, '');
    return res.replace(/\s+/g, '');
  }
  return normalizeArea(a);
}

/**
 * PICK/DROP の実際の配達イベント順序を確定できるか判定する。
 *
 * 【超重要】
 * 単に legs[0], legs[1] だからといって実際のPICK/DROP順序だと推測してはならない。
 * 証拠がない場合は「2つのPICK/DROPペアは特定できるが、実際の走行順は未確定」として null を返す。
 *
 * @param {Object} rawTrip Uber getTrip 生レスポンス
 * @returns {Array|null} 確定できた場合は sequence 配列、未確定なら null
 */
function resolveDeliverySequence(rawTrip) {
  if (!rawTrip) return null;

  // 1. stops または waypoints 配列に明示的な sequence / stopSequence 番号がある場合
  if (Array.isArray(rawTrip.stops) && rawTrip.stops.length > 0) {
    const valid = rawTrip.stops.every(s => s.type && (s.sequenceNumber !== undefined || s.timestamp !== undefined));
    if (valid) {
      const sorted = [...rawTrip.stops].sort((a, b) => {
        if (a.sequenceNumber !== undefined && b.sequenceNumber !== undefined) {
          return a.sequenceNumber - b.sequenceNumber;
        }
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });
      return sorted.map((s, idx) => ({
        index: idx + 1,
        type: s.type.toLowerCase().includes('pick') ? 'PICK' : 'DROP',
        legUuid: s.legUuid || null,
        address: sanitizeAddressToArea(s.address || s.formattedAddress || ''),
        time: s.timestamp ? parser.parseTime(String(s.timestamp)) : null
      }));
    }
  }

  // 2. 各legのpickup / dropoff に個別の実測タイムスタンプが存在する場合
  const legs = Array.isArray(rawTrip.legs) ? rawTrip.legs : [];
  if (legs.length > 1) {
    const events = [];
    let hasAllTimestamps = true;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const pTime = leg.pickedUpAt || leg.pickupTimestamp || (leg.pickup && leg.pickup.timestamp);
      const dTime = leg.deliveredAt || leg.dropoffTimestamp || (leg.dropoff && leg.dropoff.timestamp);

      if (!pTime || !dTime) {
        hasAllTimestamps = false;
        break;
      }
      events.push({
        type: 'PICK',
        legIndex: i,
        legUuid: leg.legUuid || leg.uuid || null,
        timestamp: new Date(pTime).getTime(),
        timeStr: pTime,
        address: sanitizeAddressToArea(leg.pickupAddress || (leg.pickup && leg.pickup.address))
      });
      events.push({
        type: 'DROP',
        legIndex: i,
        legUuid: leg.legUuid || leg.uuid || null,
        timestamp: new Date(dTime).getTime(),
        timeStr: dTime,
        address: sanitizeAddressToArea(leg.dropoffAddress || (leg.dropoff && leg.dropoff.address))
      });
    }

    if (hasAllTimestamps && events.length === legs.length * 2) {
      events.sort((a, b) => a.timestamp - b.timestamp);
      return events.map((e, idx) => ({
        index: idx + 1,
        type: e.type,
        legIndex: e.legIndex,
        legUuid: e.legUuid,
        address: e.address,
        time: parser.parseTime(String(e.timeStr))
      }));
    }
  }

  // 確たる証拠がない場合、絶対に推測しない。null を返す。
  return null;
}

/**
 * Uber getTrip API の cards / metadata 構造からフラットなオブジェクトを抽出する
 */
function extractTripFromUberResponse(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const data = raw.data || raw;
  const cards = data.cards || [];
  const meta = data.metadata || {};

  if (!cards.length && !meta.uuid) return raw; // 既にフラットな形式

  let hero = null;
  const stats = [];
  const addresses = [];
  let pointsStr = null;
  const breakdownItems = [];

  for (const card of cards) {
    for (const comp of (card.components || [])) {
      if (comp.type === 'heroV2') hero = comp.heroV2;
      if (comp.type === 'statTable') stats.push(...(comp.statTable?.stats || []));
      if (comp.type === 'addressBlockV2') addresses.push(...(comp.addressBlockV2?.addresses || []));
      if (comp.type === 'statListItemV2' && comp.statListItemV2?.label?.includes('ポイント')) {
        pointsStr = comp.statListItemV2.label;
      }
      if (comp.type === 'breakdownListV2') {
        breakdownItems.push(...(comp.breakdownListV2?.items || []));
      }
    }
  }

  let distanceStr = null;
  let durationStr = null;
  for (const s of stats) {
    if (s.label === '距離') distanceStr = s.value;
    if (s.label === '時間') durationStr = s.value;
  }

  let restaurant = null;
  let pickupAddress = null;
  let dropoffAddress = null;
  for (const a of addresses) {
    if (a.type === 'PICKUP') {
      restaurant = a.address;
      pickupAddress = a.address;
    }
    if (a.type === 'DROPOFF') {
      dropoffAddress = a.address;
    }
  }

  let points = 1;
  if (pointsStr) {
    const pm = pointsStr.match(/(\d+)\s*ポイント/);
    if (pm) points = parseInt(pm[1], 10);
  }

  let baseFee = null;
  let tip = null;
  for (const item of breakdownItems) {
    const subItems = item.items || [];
    for (const sub of subItems) {
      if (sub.label === '配送料' || sub.label === '基本料金') {
        baseFee = sub.formattedValue;
      }
      if (sub.label === 'チップ' || sub.label === 'お礼') {
        tip = sub.formattedValue;
      }
    }
    if (item.label === 'チップ' || item.label === 'お礼') {
      tip = item.formattedValue;
    }
    if (!baseFee && (item.label === '料金' || item.label === '配送料')) {
      baseFee = item.formattedValue;
    }
  }

  let timeStr = null;
  if (hero && hero.timeRequested) {
    const t = hero.timeRequested;
    const isPm = t.includes('午後');
    const m = t.match(/(\d{1,2})時(\d{2})分/);
    if (m) {
      let h = parseInt(m[1], 10);
      if (isPm && h < 12) h += 12;
      if (!isPm && h === 12) h = 0;
      timeStr = `${String(h).padStart(2, '0')}:${m[2]}`;
    }
  }

  return {
    tripUuid: meta.uuid || data.uuid || raw.uuid,
    amount: hero?.text,
    baseFee,
    tip,
    distance: distanceStr,
    duration: durationStr,
    restaurant,
    pickupAddress,
    dropoffAddress,
    points,
    time: timeStr,
    tripLegCount: meta.tripLegCount || 1,
    legs: meta.legs || [],
    statusType: meta.statusType,
    timeZone: meta.timeZone,
    vehicleType: meta.vehicleType || hero?.vehicleType,
    raw
  };
}

/**
 * 単一トリップの getTrip レスポンス（生データ）を正規化する
 *
 * @param {Object} rawTrip Uber getTrip 生レスポンス
 * @param {string} targetDate YYYY-MM-DD
 * @returns {{ trip: Object, errors: string[] }}
 */
function normalizeTripDetail(rawTrip, targetDate) {
  const errors = [];
  if (!rawTrip || typeof rawTrip !== 'object') {
    return { trip: null, errors: ['rawTrip が空または不正なオブジェクトです'] };
  }

  if (rawTrip.cards || (rawTrip.data && rawTrip.data.cards)) {
    rawTrip = extractTripFromUberResponse(rawTrip);
  }

  const tripUuid = rawTrip.tripUuid || rawTrip.uuid || rawTrip.id;
  if (!tripUuid || !UUID_RE.test(tripUuid)) {
    errors.push(`有効な trip UUID がありません: ${tripUuid}`);
  }

  // 日時
  const dateStr = rawTrip.date || rawTrip.completedDate || (rawTrip.completedAt && String(rawTrip.completedAt).slice(0, 10));
  const parsedDate = dateStr ? parser.parseDate(String(dateStr), targetDate ? targetDate.slice(0, 4) : undefined) : targetDate;
  if (targetDate && parsedDate !== targetDate) {
    errors.push(`対象日（${targetDate}）と異なる日付のトリップです: ${parsedDate}`);
  }

  // 時刻 (HH:MM)
  const timeRaw = rawTrip.time || rawTrip.completedTime || rawTrip.dropoffTime || rawTrip.completedAt;
  const time = parser.parseTime(String(timeRaw || ''));

  const statusType = String(rawTrip.statusType || rawTrip.status || '').toUpperCase();
  if (statusType === 'CANCELED' || statusType === 'CANCELLED' || rawTrip.title === 'キャンセル済み' || rawTrip.restaurant === 'キャンセル済み') {
    return {
      trip: {
        tripUuid: (tripUuid || '').toLowerCase(),
        statusType: 'CANCELED',
        isCanceled: true,
        date: parsedDate,
        time: time || '00:00',
        amount: 0,
        baseFee: null,
        tip: null,
        distanceKm: 0,
        durationSeconds: 0,
        durationStr: '0秒',
        points: 0,
        restaurant: 'キャンセル済み',
        area: '',
        tripLegCount: 0,
        legs: [],
        sequence: null,
        vehicleType: rawTrip.vehicleType || null,
        timeZone: rawTrip.timeZone || 'Asia/Tokyo',
        raw: rawTrip
      },
      errors: []
    };
  }

  if (!time) {
    errors.push(`完了時刻を解析できません: ${timeRaw}`);
  }

  // 金額 (円単位の整数)
  const parseAmt = v => (typeof v === 'number' ? v : parser.parseMoney(String(v ?? '')));
  const amount = parseAmt(rawTrip.amount ?? rawTrip.totalAmount ?? rawTrip.totalEarnings ?? rawTrip.fare);
  if (!Number.isInteger(amount) || amount <= 0) {
    errors.push(`総売上 amount が不正です: ${amount}`);
  }

  // 基本料金 (baseFee) と チップ (tip)
  let baseFee = rawTrip.baseFee !== undefined ? parseAmt(rawTrip.baseFee) : null;
  let tip = rawTrip.tip !== undefined ? parseAmt(rawTrip.tip) : null;
  if (baseFee === null && rawTrip.fare !== undefined && tip !== null) {
    baseFee = parseAmt(rawTrip.fare);
  }
  if (tip === 0) tip = null;

  // 内訳整合性チェック
  if (baseFee !== null && tip !== null) {
    if (baseFee + tip !== amount) {
      errors.push(`基本料金 ¥${baseFee} ＋ チップ ¥${tip} が総売上 ¥${amount} と一致しません`);
    }
  } else if (baseFee !== null && tip === null) {
    if (baseFee !== amount) {
      errors.push(`チップなしの場合、基本料金 ¥${baseFee} は総売上 ¥${amount} と一致する必要があります`);
    }
  } else if (baseFee === null && tip !== null) {
    baseFee = amount - tip;
  }

  // 距離 (km)
  let distanceKm = typeof rawTrip.distanceKm === 'number' ? rawTrip.distanceKm : null;
  if (distanceKm === null && rawTrip.distance !== undefined) {
    const dStr = parser.toHalfWidth(String(rawTrip.distance)).replace(/[^\d.]/g, '');
    distanceKm = parseFloat(dStr);
  }
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    errors.push(`距離 distanceKm が不正です: ${rawTrip.distanceKm || rawTrip.distance}`);
  } else {
    distanceKm = round2(distanceKm);
  }

  // 時間 (durationStr / durationSeconds)
  let durationSeconds = typeof rawTrip.durationSeconds === 'number' ? rawTrip.durationSeconds : null;
  let durationStr = rawTrip.durationStr || rawTrip.duration;
  if (durationSeconds === null && durationStr) {
    const s = parser.toHalfWidth(String(durationStr)).replace(/\s+/g, '');
    const m = s.match(/^(?:(\d+)時間)?(?:(\d+)分)?(?:(\d+)秒)?$/);
    if (m && (m[1] || m[2] || m[3])) {
      durationSeconds = (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
    }
  } else if (durationSeconds !== null && !durationStr) {
    const h = Math.floor(durationSeconds / 3600);
    const m = Math.floor((durationSeconds % 3600) / 60);
    const s = durationSeconds % 60;
    durationStr = h > 0 ? `${h}時間${m}分${s}秒` : `${m}分${s}秒`;
  }
  if (!durationSeconds || durationSeconds <= 0) {
    errors.push(`配達時間 duration が不正です: ${durationStr || durationSeconds}`);
  }

  // ポイント
  const points = typeof rawTrip.points === 'number' ? rawTrip.points : parseInt(parser.toHalfWidth(String(rawTrip.points || '1')), 10);
  if (!Number.isInteger(points) || points < 1) {
    errors.push(`ポイント points が不正です: ${rawTrip.points}`);
  }

  // legs の解析
  const rawLegs = Array.isArray(rawTrip.legs) ? rawTrip.legs : [];
  const tripLegCount = typeof rawTrip.tripLegCount === 'number' ? rawTrip.tripLegCount : Math.max(rawLegs.length, 1);
  
  const legs = [];
  if (rawLegs.length > 0) {
    rawLegs.forEach((leg, i) => {
      const legUuid = leg.legUuid || leg.uuid || null;
      const legRestaurant = String(leg.restaurant || leg.storeName || leg.pickupName || '').trim();
      const legPickup = leg.pickupAddress || (leg.pickup && leg.pickup.address) || '';
      const legDropoff = leg.dropoffAddress || (leg.dropoff && leg.dropoff.address) || '';
      const customRouteMap = leg.customRouteMap || leg.routeMap || null;
      legs.push({
        legIndex: i,
        legUuid,
        restaurant: legRestaurant,
        pickupAddress: legPickup,
        dropoffAddress: legDropoff,
        area: sanitizeAddressToArea(legDropoff),
        customRouteMap
      });
    });
  } else {
    // leg配列がない単一配達の場合
    legs.push({
      legIndex: 0,
      legUuid: tripUuid,
      restaurant: String(rawTrip.restaurant || rawTrip.storeName || '').trim(),
      pickupAddress: rawTrip.pickupAddress || '',
      dropoffAddress: rawTrip.dropoffAddress || '',
      area: sanitizeAddressToArea(rawTrip.dropoffAddress || rawTrip.area || ''),
      customRouteMap: rawTrip.customRouteMap || null
    });
  }

  // 代表店舗名・代表エリア
  let restaurant = String(rawTrip.restaurant || rawTrip.storeName || '').trim();
  if (!restaurant && legs.length > 0) {
    restaurant = legs.map(l => l.restaurant).filter(Boolean).join(' / ');
  }
  if (!restaurant) errors.push('店舗名（restaurant）が空です');

  let area = normalizeArea(rawTrip.area || '');
  if (!area && legs.length > 0) {
    area = legs.map(l => l.area).filter(Boolean).join(' / ');
  }
  if (!area) errors.push('配達先エリア（area）が空です');

  const priv = privacyIssue(area);
  if (priv) errors.push(`配達先（area: ${area}）に個人情報の可能性: ${priv}`);

  // 実行順序（sequence）の解決（証拠がない場合は null）
  const sequence = resolveDeliverySequence(rawTrip);

  const trip = {
    tripUuid: tripUuid.toLowerCase(),
    statusType: rawTrip.statusType || 'COMPLETED',
    date: parsedDate,
    time,
    amount,
    baseFee: baseFee ?? null,
    tip: tip ?? null,
    distanceKm,
    durationSeconds,
    durationStr,
    points,
    restaurant,
    area,
    tripLegCount,
    legs,
    sequence,
    vehicleType: rawTrip.vehicleType || null,
    timeZone: rawTrip.timeZone || 'Asia/Tokyo',
    raw: rawTrip
  };

  return { trip, errors };
}

/**
 * 構造化フィードデータから activity.txt 形式のプレーンテキストを生成する
 * （既存パーサーとの照合やフォールバック用）
 */
function buildActivityTextFromStructured(feed, date) {
  const lines = [];
  const items = Array.isArray(feed.feedItems)
    ? feed.feedItems
    : Array.isArray(feed.items)
      ? feed.items
      : Array.isArray(feed.data?.activities)
        ? feed.data.activities
        : Array.isArray(feed.activities)
          ? feed.activities
          : [];

  items.forEach(item => {
    const status = String(item.status || item.statusType || '').toUpperCase();
    if (status === 'CANCELED' || status === 'CANCELLED' || item.activityTitle === 'キャンセル済み') {
      return;
    }
    const type = (item.type || 'delivery').toLowerCase();
    let time = item.time;
    if (!time && item.recognizedAt) {
      time = new Date(item.recognizedAt * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    }
    if (!time) {
      time = parser.parseTime(String(item.eventTimestamp || item.timestamp || '')) || '';
    }

    const amt = item.amount !== undefined ? item.amount : parser.parseMoney(String(item.formattedAmount || item.formattedTotal || ''));
    const yenStr = amt !== null ? (amt < 0 ? `-￥${Math.abs(amt)}` : `￥${amt}`) : '';
    const uuid = item.uuid || item.tripUuid;

    if (type.includes('delivery') || type === 'trip' || type === 'ct') {
      lines.push('Delivery');
      if (date) lines.push(date);
      if (time) lines.push(time);
      if (yenStr) lines.push(yenStr);
      if (uuid) lines.push(`https://drivers.uber.com/earnings/activities/trip/${uuid}`);
      else lines.push('View Details');
      lines.push('');
    } else if (type.includes('quest')) {
      lines.push('QUEST');
      lines.push(item.activityTitle || item.title || 'クエスト');
      if (date) lines.push(date);
      if (time) lines.push(time);
      if (yenStr) lines.push(yenStr);
      lines.push('');
    } else if (type.includes('adjust') || type.includes('misc')) {
      const title = item.activityTitle || item.title || '';
      if (title.includes('クエスト')) {
        lines.push('QUEST');
        lines.push(title);
      } else {
        lines.push('MISC');
        lines.push(title || '調整');
      }
      if (date) lines.push(date);
      if (time) lines.push(time);
      if (yenStr) lines.push(yenStr);
      lines.push('');
    }
  });

  return lines.join('\r\n');
}

module.exports = {
  normalizeTripDetail,
  resolveDeliverySequence,
  sanitizeAddressToArea,
  buildActivityTextFromStructured,
  round2,
  normalizeArea,
  privacyIssue
};
