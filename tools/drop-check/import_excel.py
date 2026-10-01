#!/usr/bin/env python3
"""
大阪市_タワマン一覧_Uber配達用.xlsx → data/uber_drop_buildings.json / .js

  python tools/drop-check/import_excel.py [Excelのパス] [--check]

- Excel は読み取りのみ（変更・削除しない）。全列を保持する。
- 読み（あいうえお順・ひらがな検索用）は tools/drop-check/readings.json から付ける。
- 再取込しても、本人が付けた評価・メモ（my）と id は物件ごとに引き継ぐ。
- 「Uber目安」は Excel 作成時の一般的な目安で、本人の実体験評価ではない（my.rating は初期 null＝未検証）。
- 区別集計シートがあれば件数と照合し、一致しなければ中止する。
"""
import hashlib
import json
import os
import re
import sys
import unicodedata

import openpyxl

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_JSON = os.path.join(ROOT, 'data', 'uber_drop_buildings.json')
OUT_JS = os.path.join(ROOT, 'data', 'uber_drop_buildings.js')
READINGS = os.path.join(os.path.dirname(__file__), 'readings.json')
DEFAULT_XLSX = os.path.join(os.path.expanduser('~'), 'Desktop', '大阪市_タワマン一覧_Uber配達用.xlsx')

HEADER_MAP = {'区': 'ward', 'マンション名': 'name', '所在地': 'address', '階数': 'floors', 'Uber目安': 'excel_level', '備考': 'note', '情報源': 'source_url'}
KANJI_NUM = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}


def kata_to_hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def stable_id(name, address):
    return 'bld_' + hashlib.sha1((unicodedata.normalize('NFKC', name) + '|' + unicodedata.normalize('NFKC', address or '')).encode('utf-8')).hexdigest()[:10]


def split_address(address, ward):
    """「大阪市西区江之子島2丁目1-37」→ town=江之子島, chome=2"""
    a = unicodedata.normalize('NFKC', address or '')
    m = re.search(re.escape(ward) + r'(.+)$', a)
    rest = m.group(1) if m else a
    m2 = re.match(r'^(.+?)(\d+|[一二三四五六七八九十]+)丁目', rest)
    if m2:
        c = m2.group(2)
        chome = int(c) if c.isdigit() else KANJI_NUM.get(c)
        return m2.group(1), chome
    m3 = re.match(r'^(.+?)(?:\d|$)', rest)
    return (m3.group(1) if m3 else rest), None


def load_existing():
    if not os.path.exists(OUT_JSON):
        return {}
    with open(OUT_JSON, encoding='utf-8') as f:
        data = json.load(f)
    return {b['id']: b for b in data.get('buildings', [])}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check = '--check' in sys.argv
    xlsx = args[0] if args else DEFAULT_XLSX
    if not os.path.exists(xlsx):
        sys.exit('Excel が見つかりません: ' + xlsx)
    with open(READINGS, encoding='utf-8') as f:
        readings = json.load(f)

    wb = openpyxl.load_workbook(xlsx, data_only=True)  # 読み取りのみ（保存しない）
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h).strip() if h is not None else '' for h in rows[0]]
    missing = [h for h in HEADER_MAP if h not in header]
    if missing:
        sys.exit('Excel の列が足りません: ' + ', '.join(missing))
    extra_cols = [h for h in header if h and h not in HEADER_MAP]

    existing = load_existing()
    warnings = []
    buildings = []
    for i, row in enumerate(rows[1:], start=2):
        if not any(v not in (None, '') for v in row):
            continue
        rec = {header[j]: row[j] for j in range(len(header)) if header[j]}
        b = {HEADER_MAP[k]: rec.get(k) for k in HEADER_MAP}
        b = {k: (v.strip() if isinstance(v, str) else v) for k, v in b.items()}
        for k in ('note', 'source_url', 'excel_level'):
            if b[k] in ('', None):
                b[k] = None
        if isinstance(b['floors'], float) and b['floors'].is_integer():
            b['floors'] = int(b['floors'])
        bid = stable_id(b['name'], b['address'])
        town, chome = split_address(b['address'], b['ward'])
        name_reading = readings['names'].get(b['name'])
        if not name_reading:
            warnings.append(f'読み未登録（名前のカナで代用）: {b["name"]}')
            name_reading = kata_to_hira(unicodedata.normalize('NFKC', b['name']))
        town_reading = readings['towns'].get(town)
        if not town_reading:
            warnings.append(f'町名の読み未登録: {town}（{b["name"]}）')
        old = existing.get(bid, {})
        buildings.append({
            'id': bid,
            'ward': b['ward'],
            'ward_reading': readings['wards'].get(b['ward']),
            'name': b['name'],
            'reading': name_reading,
            'address': b['address'],
            'town': town,
            'town_reading': town_reading,
            'chome': chome,
            'floors': b['floors'],
            'excel_level': b['excel_level'],
            'note': b['note'],
            'source_url': b['source_url'],
            'excel_extra': {h: rec.get(h) for h in extra_cols} or None,
            'excel_row': i,
            # 本人評価（将来ここに実体験を記録する）。Excel 掲載だけでは評価しない
            'my': old.get('my') or {'rating': None, 'note': None, 'visits': None, 'last_visit': None}
        })

    # 区別集計シートと照合
    summary = None
    for sh in wb.worksheets[1:]:
        srows = list(sh.iter_rows(values_only=True))
        if srows and srows[0][:2] == ('区', '件数'):
            summary = {r[0]: r[1] for r in srows[1:] if r and r[0]}
    counts = {}
    for b in buildings:
        counts[b['ward']] = counts.get(b['ward'], 0) + 1
    if summary is not None and summary != counts:
        sys.exit(f'区別集計シートと件数が一致しません: シート={summary} / 取込={counts}')

    data = {
        'schema_version': 1,
        'description': 'DROP先照合用の物件リスト（高層マンション等）。配達に時間がかかる可能性があるため確認したい物件で、「地雷」の確定ではない。本人の実体験評価は my.rating（A=避けたい実体験あり / B=注意 / C=未検証、null=未評価）。',
        'source': {'file': os.path.basename(xlsx), 'sheet': ws.title, 'rows': len(buildings), 'ward_counts_sheet': summary},
        'rating_levels': {
            'A': {'label': '避けたい（実体験）', 'icon': '🔴'},
            'B': {'label': '注意', 'icon': '🟠'},
            'C': {'label': '未検証', 'icon': '🟡'}
        },
        'buildings': buildings
    }
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    js = '// 自動生成ファイル（tools/drop-check/import_excel.py）。直接編集しないこと。正本: data/uber_drop_buildings.json\nwindow.UBER_DROP_BUILDINGS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'

    for w in warnings:
        print('WARN ' + w)
    print(f'物件 {len(buildings)} 件 / 区別 {counts}')
    if check:
        same = os.path.exists(OUT_JSON) and open(OUT_JSON, encoding='utf-8').read() == text and os.path.exists(OUT_JS) and open(OUT_JS, encoding='utf-8').read() == js
        print('data/uber_drop_buildings.* は Excel と一致' if same else 'ERROR data/uber_drop_buildings.* が Excel と不一致（import_excel.py を実行）')
        sys.exit(0 if same else 1)
    with open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    with open(OUT_JS, 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    print('書き出し: data/uber_drop_buildings.json, data/uber_drop_buildings.js')


if __name__ == '__main__':
    main()
