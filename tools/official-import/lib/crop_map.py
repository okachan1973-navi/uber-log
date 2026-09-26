"""
UBER_LOG 公式MAP crop（既存 assets/maps/map_*.png と同じ規格: 420x233）

Uber公式 Delivery 詳細スクリーンショットから地図領域だけを切り出す。
地図の生成・描き足し・加工は一切しない（元画像の該当領域をそのまま切り抜くだけ）。

検出方法（地図は幅420px・高さ233pxの固定サイズで、上下が白い余白に接している）:
  1. 各行の「白ではない画素」の数を数える
  2. 「直前の行が白っぽく、その行から非白が多い」行を地図上端の候補とする
  3. 候補ごとに、上端から233行の窓内で非白が多い列の最長連続区間（=地図の横範囲）を求め、
     窓の塗り率・直後の行が白いこと（地図下端）で採点する
  4. 規格（420x233）に合う候補がなければ、表示倍率が違うスクショとして _detect_scaled で検出する
     （縦横比 420:233・左右上下の白い余白で地図全体が写っていることを確かめる。例: 9/26 の地図 378x210）
  5. どちらでも見つからなければ失敗として止める（推測で切り出さない・画像端で切れた地図は通さない）
  表示倍率が違う場合の切り抜きは元の大きさのまま保存する（アプリは幅100%で表示するため拡大縮小しない）

使い方:
  python crop_map.py detect <image>                -> JSON {"ok":..,"box":[l,t,r,b],...}
  python crop_map.py crop <image> <out_map.png> [<out_full.png>]
"""
import json
import sys

from PIL import Image

MAP_W, MAP_H = 420, 233
WIDTH_TOLERANCE = 3
WHITE = 246            # これ以上明るいRGBは「白」
COL_RATIO = 0.20       # 地図の列: 窓内の非白画素がこの割合以上（地図外の余白はほぼ0、縦の白い道路でも途切れない値）
MIN_FILL = 0.60        # 地図窓全体の非白率の下限
ROAD_GAP = 12          # 地図内の縦の白い道路としてつなぐ最大幅(px)
# 表示倍率が違うスクショ用（_detect_scaled）
SCALED_MIN_H = 150     # 地図の高さの下限（見積もり料金の枠などの低い帯を除外）
SCALED_MIN_W, SCALED_MAX_W = 300, 520
SCALED_ASPECT_TOL = 2  # 幅と「高さ x 420/233」の許容差(px)
EDGE_WHITE_MAX = 0.05  # 地図の外側の列はほぼ白（非白率がこれ未満）


def _load(path):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    data = img.load()
    nonwhite = [[0] * w for _ in range(h)]
    for y in range(h):
        row = nonwhite[y]
        for x in range(w):
            r, g, b = data[x, y]
            row[x] = 0 if (r >= WHITE and g >= WHITE and b >= WHITE) else 1
    return img, w, h, nonwhite


def _fill_gaps(flags, max_gap):
    """地図を縦に貫く白い道路（数px〜十数px）で横範囲が途切れないよう、短い空白をつなぐ"""
    out = list(flags)
    i = 0
    n = len(out)
    while i < n:
        if not out[i]:
            j = i
            while j < n and not out[j]:
                j += 1
            if 0 < i and j < n and j - i <= max_gap:
                for k in range(i, j):
                    out[k] = True
            i = j
        else:
            i += 1
    return out


def _longest_run(flags):
    best, start = (0, -1), None
    for i, f in enumerate(flags + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if i - start > best[1] - best[0] + 1:
                best = (start, i - 1)
            start = None
    return best


def _detect_scaled(w, h, nw, row_sum):
    """表示倍率の違うスクショの地図検出（420x233 固定で見つからない場合のみ使う）。

    地図の縦横比は常に 420:233。高さ（上下の白い余白に挟まれた濃い行の範囲）と
    幅（その範囲で非白の多い列）を別々に測り、次をすべて満たす場合だけ地図全体が写っていると判定する:
      - 上下: 地図の上の行・下の行が白っぽい（画像の上端・下端に接していない）
      - 左右: 地図の左右に白い列が1列以上ある（画像の左端・右端に接していない）
      - 縦横比: 幅 = 高さ x 420/233 （±SCALED_ASPECT_TOL px）。横が切れた地図は幅が足りず不合格
      - 大きさ: 幅が SCALED_MIN_W〜SCALED_MAX_W、窓の塗り率が MIN_FILL 以上
    切り抜きは元画像の該当領域をそのまま（拡大縮小しない）。
    """
    dense = w * 0.5
    reasons = []
    y = 1
    while y < h:
        if not (row_sum[y] >= dense and row_sum[y - 1] < dense):
            y += 1
            continue
        top = y
        bottom = top
        while bottom < h and row_sum[bottom] >= w * 0.3:
            bottom += 1
        y = bottom + 1
        height = bottom - top
        if height < SCALED_MIN_H:
            continue  # 地図より低い帯（見積もり料金の灰色の枠など）
        cols = [sum(nw[yy][x] for yy in range(top, bottom)) / height for x in range(w)]
        left, right = _longest_run(_fill_gaps([c >= COL_RATIO for c in cols], ROAD_GAP))
        if right < 0:
            continue
        width = right - left + 1
        expected_w = height * MAP_W / MAP_H
        if bottom >= h:
            reasons.append("地図の下端が画像の端で切れています")
            continue
        if left == 0 or cols[left - 1] >= EDGE_WHITE_MAX:
            reasons.append(f"地図の左端が画像の端で切れています（地図 {width}x{height}px）")
            continue
        if right >= w - 1 or cols[right + 1] >= EDGE_WHITE_MAX:
            reasons.append(f"地図の右端が画像の端で切れています（地図 {width}x{height}px）")
            continue
        if not (SCALED_MIN_W <= width <= SCALED_MAX_W):
            continue
        if abs(width - expected_w) > SCALED_ASPECT_TOL:
            reasons.append(f"地図の縦横比が規格と合いません（地図 {width}x{height}px・高さからの想定幅 {expected_w:.0f}px。地図の一部が切れている可能性）")
            continue
        fill = sum(sum(nw[yy][left:right + 1]) for yy in range(top, bottom)) / (width * height)
        if fill < MIN_FILL:
            continue
        return {"ok": True, "box": [left, top, right + 1, bottom], "fill": round(fill, 3),
                "size": [w, h], "scaled": True}
    return {"ok": False, "reason": reasons[0] if reasons else None, "size": [w, h]}


def detect(path):
    img, w, h, nw = _load(path)
    row_sum = [sum(r) for r in nw]
    dense = min(w, MAP_W) * 0.5

    candidates = []
    for top in range(0, h - MAP_H + 1):
        if row_sum[top] < dense or (top > 0 and row_sum[top - 1] >= dense):
            continue
        bottom = top + MAP_H  # exclusive
        cols = [sum(nw[y][x] for y in range(top, bottom)) / MAP_H >= COL_RATIO for x in range(w)]
        left, right = _longest_run(_fill_gaps(cols, ROAD_GAP))
        if right < 0:
            continue
        width = right - left + 1
        fill = sum(sum(nw[y][left:right + 1]) for y in range(top, bottom)) / (width * MAP_H)
        # 地図下端: 窓の直後の行が白っぽい（または画像下端）
        after = row_sum[bottom] / w if bottom < h else 0.0
        candidates.append({"top": top, "left": left, "width": width, "fill": fill, "after": after})

    good = [c for c in candidates
            if c["fill"] >= MIN_FILL and c["after"] < 0.3 and abs(c["width"] - MAP_W) <= WIDTH_TOLERANCE]
    if not good:
        # 画面の表示倍率が違うスクショ（例: 2026-09-26 の地図 378x210）は、縦横比で完全性を確かめて検出する
        scaled = _detect_scaled(w, h, nw, row_sum)
        if scaled["ok"]:
            return scaled
        near = sorted(candidates, key=lambda c: -c["fill"])[:3]
        return {"ok": False, "reason": scaled.get("reason") or "規格(420x233)の地図領域を検出できません（画像端で地図が切れている等）",
                "size": [w, h], "candidates": near}
    if len(good) > 1:
        good.sort(key=lambda c: (-c["fill"], c["top"]))
    c = good[0]
    left = c["left"]
    if c["width"] != MAP_W:
        # 地図の端が数px白っぽい場合の補正。画像内に420pxが収まる場合のみ
        left = max(0, min(left, w - MAP_W))
    if left + MAP_W > w:
        return {"ok": False, "reason": "地図が画像端で切れています", "size": [w, h]}
    return {"ok": True, "box": [left, c["top"], left + MAP_W, c["top"] + MAP_H],
            "fill": round(c["fill"], 3), "size": [w, h]}


def crop(path, out_map, out_full=None):
    res = detect(path)
    if not res["ok"]:
        return res
    img = Image.open(path)
    img.crop(tuple(res["box"])).save(out_map, "PNG")
    if out_full:
        img.save(out_full, "PNG")
    return res


def batch(json_path):
    """[{"src":..., "map":..., "full":...}, ...] をまとめて処理（full は PNG で保存）"""
    with open(json_path, encoding="utf-8") as f:
        jobs = json.load(f)
    results = []
    for job in jobs:
        try:
            img = Image.open(job["src"])
            size = list(img.size)
            img.close()
            res = crop(job["src"], job["map"], job.get("full"))
            res.setdefault("size", size)
        except Exception as e:  # 読めない画像は失敗として返す（推測で補わない）
            res = {"ok": False, "reason": f"画像を読み込めません: {e}"}
        res["src"] = job["src"]
        results.append(res)
    return results


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "detect" and len(sys.argv) == 3:
        print(json.dumps(detect(sys.argv[2]), ensure_ascii=False))
    elif cmd == "crop" and len(sys.argv) in (4, 5):
        print(json.dumps(crop(*sys.argv[2:]), ensure_ascii=False))
    elif cmd == "batch" and len(sys.argv) == 3:
        print(json.dumps(batch(sys.argv[2]), ensure_ascii=False))
    else:
        print(__doc__)
        sys.exit(2)
