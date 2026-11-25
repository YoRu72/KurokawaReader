#!/usr/bin/env python3
"""Writes ../source.json: the ONE made-up source document every corpus PDF is rendered from, as data.
Inline markup in the strings below: **bold**, *italic*, [text](url), `mono`, ^[n] footnote reference n.
Run: python3 make/mksource.py  (from tests/pdf2docx/corpus2)"""
import json, re, os

def runs(s):
    out = []; pos = 0
    pat = re.compile(r'\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\)|`(.+?)`|\^\[(\d+)\]')
    for m in pat.finditer(s):
        if m.start() > pos: out.append({'t': s[pos:m.start()]})
        if m.group(1): out.append({'t': m.group(1), 'b': True})
        elif m.group(2): out.append({'t': m.group(2), 'i': True})
        elif m.group(3): out.append({'t': m.group(3), 'link': m.group(4)})
        elif m.group(5): out.append({'t': m.group(5), 'mono': True})
        else: out.append({'fn': int(m.group(6))})
        pos = m.end()
    if pos < len(s): out.append({'t': s[pos:]})
    return out

def P(id, s, lang='en'): return {'type': 'p', 'id': id, 'lang': lang, 'runs': runs(s)}
def H(id, level, s, lang='en'): return {'type': 'h', 'id': id, 'level': level, 'lang': lang, 'text': s}

LONG = (
    "The survey crew began each morning at the outer breakwater, where the first sounding line was run toward the "
    "old signal mast. **Every reading was logged twice**, once on the handheld sheet and once in the boat's own memory, "
    "so that a smudged figure could always be checked against its twin.^[2] The official office rules asked for a fresh "
    "calibration before the first line, and the crew followed them: a weighted cord was lowered at the quay wall, its "
    "length was compared with the sounder's display, and the small difference was written down in the margin. "
    "Fluffy weather made the work slow, because a flowing swell lifted the hull and shuffled the readings by several "
    "centimetres, and the *first* hour of every day was therefore spent only on the calm side of the basin. "
    "By midday the lines had moved across the channel, and the notes began to describe the bottom in plain words: "
    "soft silt near the slipway, hard sand under the old ferry berth, and a narrow trough of coarse gravel that the "
    "older charts had drawn as a single dotted line. The word the crew used for such rough ground in their private "
    "shorthand was electroencephalographically, a joke nobody could spell twice in the same way, but the notes "
    "themselves stayed careful. When the afternoon tide turned, the boat crossed back over the earlier lines, and "
    "the second set of readings was laid beside the first so that any drift in the instrument would show as a "
    "steady gap rather than as scattered noise. The harbour master read the sheets each evening, circled the "
    "doubtful stations in red, and asked for them to be repeated if the gap was wider than the width of a hand. "
    "Because the repeated lines were cheap and the doubtful ones were few, the whole plan fitted inside nine "
    "working days, with two spare days kept for wind, and the data were later copied into the shared "
    "[harbour data sheet](https://example.org/lanternfield/data) in the order in which they had been taken. "
    "A second pass in the narrow inner basin used the same method, with shorter lines and a slower boat, so that the "
    "readings near the slipway and the ferry berth could be compared with the open water readings without any "
    "change of procedure. Wherever the two passes disagreed, the crew wrote both figures, the time of each, and a "
    "short remark about the wind, the swell and the state of the tide, and the harbour master decided which "
    "figure to keep. In the end only five of the stations needed a third reading, and each of them was settled "
    "within a single morning, which the crew counted as the best result of the whole season. The final sheets "
    "were typed up during the quiet week that followed, checked line by line against the margin notes, and filed "
    "together with the weighted cord, the spare batteries and the faded paper map of the outer basin."
)

src = {
    'meta': {
        'title': 'The Tidewater Survey of Lanternfield Harbour',
        'note': 'All text is made up for this corpus. Digits are 0-9.',
        'header': 'Tidewater Survey - Working Draft',
        'footer': 'Lanternfield Harbour Board',
        'pageNumberPattern': 'Page {n}',
        'longWord': 'electroencephalographically',
        'ligatureWords': ['office', 'official', 'fluffy', 'flowing', 'shuffled', 'first', 'fitted', 'fresh'],
    },
    'footnotes': {
        '1': 'The harbour board asked for a plain-language report, so tables are kept short.',
        '2': 'The twin log was a precaution after a lost sheet in an earlier season.',
        '3': 'Depths are given below the chart datum, in metres.',
    },
    'blocks': [
        {'type': 'title', 'id': 'title', 'text': 'The Tidewater Survey of Lanternfield Harbour', 'lang': 'en'},
        H('h-intro', 1, 'Introduction'),
        P('p-intro', "This note describes how the small **Tidewater** survey of Lanternfield Harbour was planned, carried out and written up. "
          "It was prepared for the *harbour board*, which wanted a short account of the water depth along the "
          "north pier and in the outer basin, and it points to the [published chart index](https://example.org/lanternfield/charts) "
          "for readers who want the wider picture.^[1] The sections below follow the order in which the work was done."),
        P('p-intro2', "The work covered eight stations, five of them along the north pier and three in the outer basin. Each station was visited on two different tides, and the board asked that every figure in this note be traceable to a dated sheet. The paragraphs that follow are written for a reader who has never been on the water: they say what was done, in which order and with which tools, and they leave the raw numbers to the table near the end. A reader in a hurry can skip straight to the results, but the method explains why the figures can be trusted, and why a few of them were measured three times."),
        P('p-intro3', "Two limits should be kept in mind. First, the survey measured depth only along its own lines, so the chart between the lines is an interpolation. Second, wind and swell changed from day to day, and although the crew waited for calm water whenever it was possible, the readings carry a small, honest margin of error."),
        H('h-method', 2, 'Method of the soundings'),
        P('p-long', LONG),
        H('h-instr', 3, 'Instruments and steps'),
        P('p-instr', 'The crew carried the following equipment and followed these steps.'),
        {'type': 'ul', 'id': 'ul-1', 'items': [
            {'level': 0, 'text': 'Depth sounder'},
            {'level': 1, 'text': 'Handheld unit'},
            {'level': 1, 'text': 'Hull-mounted unit'},
            {'level': 0, 'text': 'Tide gauge'},
            {'level': 0, 'text': 'Weighted cord'}]},
        {'type': 'ol', 'id': 'ol-1', 'items': [
            {'level': 0, 'text': 'Calibrate the sounder at the quay wall'},
            {'level': 0, 'text': 'Run each sounding line twice'},
            {'level': 0, 'text': 'Compare the two sets of readings'}]},
        H('h-results', 1, 'Results'),
        P('p-results', 'The table below lists the depth and the tide height measured at four stations.^[3]'),
        {'type': 'table', 'id': 'tbl-en', 'lang': 'en', 'rows': [
            [{'text': 'Station', 'header': True}, {'text': 'Depth (m)', 'header': True}, {'text': 'Tide (cm)', 'header': True}],
            [{'text': 'Mill Quay\n(east side)'}, {'text': '6.4'}, {'text': '35'}],
            [{'text': 'Slipway'}, {'text': '4.8'}, {'text': '31'}],
            [{'text': 'North pier, both gauges', 'span': 2}, {'text': '12.0'}]]},
        {'type': 'figure', 'id': 'fig-1', 'caption': 'Figure 1. Sounding lines across the outer basin.'},
        H('h-log', 2, 'Field log'),
        {'type': 'columns', 'id': 'cols-1', 'n': 2, 'blocks': [
            P('c-1', 'Alpha entry: the morning began calm, and the first line along the breakwater, a task the crew called electroencephalographically dull, was finished before the gulls arrived on the old signal mast.'),
            P('c-2', 'Bravo entry: a light swell came in from the west during the second line, and the boat was turned toward the slipway to keep the readings steady.'),
            P('c-3', 'Charlie entry: the tide gauge was checked against the weighted cord at noon, a step that proved electroencephalographically thorough, and the small difference was entered in the margin of the sheet.'),
            P('c-4', 'Delta entry: the last line was run in the evening light, and the sheets were handed to the harbour master before the lamps were lit.')]},
        P('p-code-lead', 'The reading routine on the boat was a short script:'),
        {'type': 'code', 'id': 'code-1', 'lines': [
            'depth = read_sounder(port)',
            'tide = read_gauge(station)',
            'log.append((station, depth, tide))']},
        H('h-ar', 1, 'ملخص المسح بالعربية', 'ar'),
        P('ar-1', 'أجري المسح في مرفأ لانترنفيلد خلال فصل الخريف، وشمل ثماني محطات موزعة على الرصيف الشمالي والحوض الخارجي. وسجلت الأعماق بجهاز سبر محمول، ثم قورنت بقراءات مقياس المد.', 'ar'),
        P('ar-2', 'بلغ عمق المرفأ 12 مترا عند المحطة 7 وفق قياسات عام 2024، واعتمد الفريق جهاز GPS بدقة 3 أمتار، ثم ارتفع المد 35 سنتيمترا في المساء.', 'ar'),
        {'type': 'ul', 'id': 'ul-ar', 'lang': 'ar', 'items': [
            {'level': 0, 'text': 'قياس العمق بجهاز السبر'},
            {'level': 0, 'text': 'تسجيل ارتفاع المد كل ساعة'},
            {'level': 0, 'text': 'مطابقة الإحداثيات مع الخريطة'}]},
        {'type': 'table', 'id': 'tbl-ar', 'lang': 'ar', 'rows': [
            [{'text': 'المحطة', 'header': True}, {'text': 'العمق (م)', 'header': True}],
            [{'text': 'الرصيف الشمالي'}, {'text': '12'}]]},
        P('ja-1', '港の測量は秋に行われ、北桟橋と外港の八つの地点で水深が記録された。測定値は潮位計の読みと照らし合わせて確認された。', 'ja'),
        P('zh-1', '这次港口测量在秋季进行，八个站点分布在北码头和外港。水深数据与潮位计读数进行了对照，结果记录在表格中。', 'zh'),
    ],
}

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'source.json')
    json.dump(src, open(out, 'w'), ensure_ascii=False, indent=1)
    print('wrote', out, len(json.dumps(src, ensure_ascii=False)), 'bytes')
