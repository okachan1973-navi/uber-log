/**
 * UBER_LOG ルート判断の計算（ブラウザ / Node 共通）
 *
 * 案件 = 現在地 → PICK → DROP の一連の移動（legs）。各区間について
 *   ・安治川（上流は堂島川）の北岸／南岸のどちらにいるか
 *   ・川を横断するか
 *   ・横断するなら、どの横断ポイント（トンネル／大橋／渡船／上流回り）が近いか（直線距離の目安）
 * を判定する。道路の経路計算ではない（将来、経路APIや実走データに差し替えられるよう結果の形を固定している）。
 */
(function (root) {
  'use strict';

  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;

  /** 2点間の距離（m）。点は {lat, lng} */
  function distance(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pathLength(path) {
    let d = 0;
    for (let i = 1; i < path.length; i++) d += distance({ lat: path[i - 1][0], lng: path[i - 1][1] }, { lat: path[i][0], lng: path[i][1] });
    return d;
  }

  const toPoint = p => (p ? { lat: +p.lat, lng: +p.lng } : null);
  const validPoint = p => !!p && isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

  /**
   * 川のどちら側か。divide_line（上流→下流）に対し、流れの右手＝北岸、左手＝南岸。
   * 線の上流端より上流・河口より沖は判定対象外（null）。
   * 戻り値: { side: 'north'|'south'|null, distanceToRiver: m, reason }
   */
  function sideOfRiver(point, river) {
    const p = toPoint(point);
    if (!validPoint(p) || !river || !river.divide_line || river.divide_line.length < 2) return { side: null, distanceToRiver: null, reason: 'invalid' };
    const line = river.divide_line;
    const k = Math.cos(rad(p.lat));
    const xy = ([la, lo]) => [lo * k, la]; // 経度を緯度の縮尺に合わせた平面
    const P = [p.lng * k, p.lat];
    let best = null;
    for (let i = 1; i < line.length; i++) {
      const A = xy(line[i - 1]), B = xy(line[i]);
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const len2 = dx * dx + dy * dy || 1e-18;
      const tRaw = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
      const t = Math.max(0, Math.min(1, tRaw));
      const Q = [A[0] + t * dx, A[1] + t * dy];
      const d2 = (P[0] - Q[0]) ** 2 + (P[1] - Q[1]) ** 2;
      if (!best || d2 < best.d2) best = { d2, i, tRaw, cross: dx * (P[1] - A[1]) - dy * (P[0] - A[0]), Q };
    }
    const distanceToRiver = distance(p, { lat: best.Q[1], lng: best.Q[0] / k });
    if (best.i === 1 && best.tRaw < 0) return { side: null, distanceToRiver, reason: 'upstream_out' };
    if (best.i === line.length - 1 && best.tRaw > 1) return { side: null, distanceToRiver, reason: 'downstream_out' };
    return { side: best.cross < 0 ? 'north' : 'south', distanceToRiver, reason: 'ok' };
  }

  /** 1区間の判定 */
  function analyzeLeg(fromKey, from, toKey, to, geo, riverId) {
    const river = (geo.rivers || []).find(r => r.id === (riverId || 'ajikawa'));
    const a = toPoint(from), b = toPoint(to);
    const direct = distance(a, b);
    const sa = sideOfRiver(a, river), sb = sideOfRiver(b, river);
    const leg = {
      from: fromKey, to: toKey, direct_m: Math.round(direct),
      from_side: sa.side, to_side: sb.side,
      crosses: null, candidates: [], best: null
    };
    if (!sa.side || !sb.side) { leg.crosses = null; leg.note = '川の判定範囲外の地点を含む'; return leg; }
    leg.crosses = sa.side !== sb.side;
    if (!leg.crosses) return leg;
    leg.candidates = (geo.crossings || []).filter(c => c.river === river.id).map(c => {
      const enFrom = c.entrances[sa.side], enTo = c.entrances[sb.side];
      const toEntrance = distance(a, { lat: enFrom.latitude, lng: enFrom.longitude });
      // 横断距離 = 入口 → 横断路（橋の歩道・トンネル等）→ 出口。階段・立坑も含めるので、合計は必ず直線以上になる
      const eF = [enFrom.latitude, enFrom.longitude], eT = [enTo.latitude, enTo.longitude];
      let body = c.path ? c.path.slice() : [];
      if (body.length > 1) {
        const d0 = distance({ lat: body[0][0], lng: body[0][1] }, { lat: eF[0], lng: eF[1] });
        const d1 = distance({ lat: body[body.length - 1][0], lng: body[body.length - 1][1] }, { lat: eF[0], lng: eF[1] });
        if (d1 < d0) body.reverse();
      }
      const crossing = pathLength([eF].concat(body, [eT]));
      const fromExit = distance({ lat: enTo.latitude, lng: enTo.longitude }, b);
      const total = toEntrance + crossing + fromExit + (c.penalty_m || 0);
      return {
        id: c.id, name: c.name, short: c.short, type: c.type, priority: c.priority,
        warning: c.warning || null, push_walk: !!(c.bike && c.bike.push_walk),
        entrance: { side: sa.side, label: enFrom.label, lat: enFrom.latitude, lng: enFrom.longitude },
        exit: { side: sb.side, label: enTo.label, lat: enTo.latitude, lng: enTo.longitude },
        to_entrance_m: Math.round(toEntrance), crossing_m: Math.round(crossing), from_exit_m: Math.round(fromExit),
        total_m: Math.round(total), detour_m: Math.max(0, Math.round(total - direct))
      };
    }).sort((x, y) => x.total_m - y.total_m || x.priority - y.priority);
    leg.best = leg.candidates[0] || null;
    return leg;
  }

  /**
   * 案件の判定。job = { current?: {lat,lng}, pick?: {lat,lng}, drop?: {lat,lng} }
   * legs は「現在地→PICK」「PICK→DROP」（地点がそろっている区間だけ）。
   */
  function analyzeJob(job, geo) {
    const order = [['current', '現在地'], ['pick', 'PICK'], ['drop', 'DROP']];
    const pts = order.filter(([k]) => job && validPoint(toPoint(job[k])));
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const [fk] = pts[i - 1], [tk] = pts[i];
      if (fk === 'current' && tk === 'drop') continue; // PICK 未設定のときに 現在地→DROP を作らない
      legs.push(analyzeLeg(fk, job[fk], tk, job[tk], geo));
    }
    const river = (geo.rivers || [])[0];
    const sides = {};
    order.forEach(([k]) => { if (job && validPoint(toPoint(job[k]))) sides[k] = sideOfRiver(job[k], river).side; });
    return {
      legs,
      sides,
      crossing_count: legs.filter(l => l.crosses).length,
      total_direct_m: legs.reduce((s, l) => s + l.direct_m, 0),
      total_best_m: legs.reduce((s, l) => s + (l.crosses && l.best ? l.best.total_m : l.direct_m), 0),
      push_walk_legs: legs.filter(l => l.best && l.best.push_walk).length
    };
  }

  /** 案件データ（将来の保存・履歴用に形を固定） */
  function createJob(init) {
    const now = new Date().toISOString();
    return Object.assign({ schema: 'uber_route_job/1', id: 'job_' + Date.now().toString(36), created_at: now, updated_at: now, current: null, pick: null, drop: null }, init || {});
  }

  const api = { distance, pathLength, sideOfRiver, analyzeLeg, analyzeJob, createJob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteJudge = api;
})(typeof window !== 'undefined' ? window : globalThis);
