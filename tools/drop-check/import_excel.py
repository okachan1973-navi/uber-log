#!/usr/bin/env python3
"""
大阪市_タワマン一覧_Uber配達用.xlsx → data/uber_drop_buildings.json / .js

  python tools/drop-check/import_excel.py [Excelのパス] [--check]

- Excel は読み取りのみ（変更・削除しない）。全列を保持する。
- 読み（あいうえお順・ひらがな検索用）は tools/drop-check/readings.json から付ける。
- 本人評価・本人メモはここ（基礎データ）には入れない。アプリ側の別保存（localStorage: uber_drop_personal_v1）に
  物件 id ごとに持つので、Excel を何度取り込み直しても消えない。
- そのため id は再取込でも変わらないようにする: 前回のデータに同じ名前の物件があればその id、
  なければ同じ区・同じ所在地の物件（1件だけ一致）の id を引き継ぐ。どちらも無い物件だけ新しい id。
- 「Uber目安」は Excel 作成時の一般的な目安で、本人の実体験評価ではない。
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


def load_existing(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as f:
        return json.load(f).get('buildings', [])


def keep_id(name, ward, address, previous, used):
    """前回の id を引き継ぐ（名前一致 → 区＋所在地が1件だけ一致）。本人データの紐付けを守るため"""
    n = unicodedata.normalize('NFKC', name)
    by_name = [b for b in previous if unicodedata.normalize('NFKC', b['name']) == n and b['id'] not in used]
    if by_name:
        return by_name[0]['id']
    a = unicodedata.normalize('NFKC', address or '')
    by_addr = [b for b in previous if b['ward'] == ward and unicodedata.normalize('NFKC', b.get('address') or '') == a and b['id'] not in used]
    if len(by_addr) == 1:
        return by_addr[0]['id']
    return None


def main():
    argv = list(sys.argv[1:])
    out_dir = None
    if '--out-dir' in argv:  # テスト用: 書き出し先（と前回データの読み込み元）を変える
        i = argv.index('--out-dir')
        out_dir = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if not a.startswith('--')]
    check = '--check' in argv
    out_json = os.path.join(out_dir, 'uber_drop_buildings.json') if out_dir else OUT_JSON
    out_js = os.path.join(out_dir, 'uber_drop_buildings.js') if out_dir else OUT_JS
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

    previous = load_existing(out_json)
    used = set()
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
        bid = keep_id(b['name'], b['ward'], b['address'], previous, used) or stable_id(b['name'], b['address'])
        if bid in used:
            bid = stable_id(b['name'] + '#' + str(i), b['address'])
        used.add(bid)
        town, chome = split_address(b['address'], b['ward'])
        name_reading = readings['names'].get(b['name'])
        if not name_reading:
            warnings.append(f'読み未登録（名前のカナで代用）: {b["name"]}')
            name_reading = kata_to_hira(unicodedata.normalize('NFKC', b['name']))
        town_reading = readings['towns'].get(town)
        if not town_reading:
            warnings.append(f'町名の読み未登録: {town}（{b["name"]}）')
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
            'excel_row': i
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
        'description': 'DROP先照合用の物件リスト（高層マンション等）。配達に時間がかかる可能性があるため確認したい物件で、「地雷」の確定ではない。本人評価・本人メモはこのファイルに入れず、アプリの端末保存（uber_drop_personal_v1）に物件 id ごとに持つ。',
        'source': {'file': os.path.basename(xlsx), 'sheet': ws.title, 'rows': len(buildings), 'ward_counts_sheet': summary},
        # 本人評価は3段階（本人確認済みの物件だけ）。「未検証」は評価ではなく、評価が無い状態
        'rating_levels': {
            'ok': {'label': '問題なし', 'icon': '🟢'},
            'caution': {'label': '注意', 'icon': '🟡'},
            'avoid': {'label': '避けたい', 'icon': '🔴'}
        },
        'unverified': {'label': '未検証', 'icon': '⚪'},
        'buildings': buildings
    }
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    js = '// 自動生成ファイル（tools/drop-check/import_excel.py）。直接編集しないこと。正本: data/uber_drop_buildings.json\nwindow.UBER_DROP_BUILDINGS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'

    for w in warnings:
        print('WARN ' + w)
    print(f'物件 {len(buildings)} 件 / 区別 {counts}')
    if check:
        same = os.path.exists(out_json) and open(out_json, encoding='utf-8').read() == text and os.path.exists(out_js) and open(out_js, encoding='utf-8').read() == js
        print('data/uber_drop_buildings.* は Excel と一致' if same else 'ERROR data/uber_drop_buildings.* が Excel と不一致（import_excel.py を実行）')
        sys.exit(0 if same else 1)
    with open(out_json, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    with open(out_js, 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    print('書き出し: ' + out_json + ', ' + out_js)


if __name__ == '__main__':
    main()
