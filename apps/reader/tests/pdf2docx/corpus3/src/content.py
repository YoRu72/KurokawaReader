#!/usr/bin/env python3
"""The six made-up documents of corpus3 (all text invented for this corpus; digits 0-9), as data. Each one is written out
as ../truth/<kind>.json (the shape corpus2/source.json uses, plus the blocks the new kinds need) and rendered by
gen.py into the sources the programs read (HTML, .docx, .pptx, .tex)."""
import json, os

H = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 1. invoice / letter
INVOICE = {
  'meta': {'kind': 'invoice', 'title': 'Invoice 2026-0417', 'header': '', 'footer': 'Payment within 30 days to account 40-12-77 31559284. Tools damaged beyond fair wear are charged at cost.', 'dir': 'ltr'},
  'footnotes': {},
  'blocks': [
    {'type': 'p', 'id': 'firm', 'role': 'letterhead', 'runs': [{'t': 'Brightwater Tool Hire', 'b': True}]},
    {'type': 'p', 'id': 'firm-addr', 'role': 'letterhead', 'runs': [{'t': '14 Kestrel Yard, Port Amble PA2 7LD'}]},
    {'type': 'p', 'id': 'to1', 'align': 'right', 'runs': [{'t': 'Invoice to:', 'b': True}]},
    {'type': 'p', 'id': 'to2', 'align': 'right', 'runs': [{'t': 'Marlow and Finch Builders'}]},
    {'type': 'p', 'id': 'to3', 'align': 'right', 'runs': [{'t': '22 Orchard Row'}]},
    {'type': 'p', 'id': 'to4', 'align': 'right', 'runs': [{'t': 'Hollin Vale HV3 9QT'}]},
    {'type': 'h', 'level': 1, 'text': 'Invoice 2026-0417'},
    {'type': 'p', 'id': 'date', 'runs': [{'t': 'Date: 12 March 2026'}]},
    {'type': 'p', 'id': 'thanks', 'runs': [{'t': 'Thank you for your order. The tools below were hired for the Orchard Row site and were all returned on time and in good order.'}]},
    {'type': 'table', 'id': 'items', 'money': [3, 4], 'rows': [
      [{'text': 'Group', 'header': True}, {'text': 'Item', 'header': True}, {'text': 'Days', 'header': True}, {'text': 'Rate', 'header': True}, {'text': 'Amount', 'header': True}],
      [{'text': 'Access', 'rowspan': 2}, {'text': 'Tower scaffold'}, {'text': '4'}, {'text': '25.00'}, {'text': '100.00'}],
      [{'text': 'Step ladder 3 m'}, {'text': '4'}, {'text': '6.50'}, {'text': '26.00'}],
      [{'text': 'Mixing', 'rowspan': 2}, {'text': 'Cement mixer 120 L'}, {'text': '5'}, {'text': '18.00'}, {'text': '90.00'}],
      [{'text': 'Spot board'}, {'text': '5'}, {'text': '2.00'}, {'text': '10.00'}],
      [{'text': 'Delivery and collection', 'span': 4}, {'text': '35.00'}],
    ]},
    {'type': 'p', 'id': 'sub', 'align': 'right', 'runs': [{'t': 'Subtotal 261.00'}]},
    {'type': 'p', 'id': 'vat', 'align': 'right', 'runs': [{'t': 'VAT 20% 52.20'}]},
    {'type': 'p', 'id': 'total', 'align': 'right', 'runs': [{'t': 'Total due 313.20', 'b': True}]},
    {'type': 'field', 'id': 'sign', 'label': 'Signed:'},
    {'type': 'p', 'id': 'for', 'runs': [{'t': 'For Brightwater Tool Hire'}]},
  ]}

# ---------------------------------------------------------------- 2. paper
PAPER_ABS = ('We describe a two-box model of salt and fresh water in a shallow estuary. The model needs only the river flow, '
             'the tidal range and one mixing constant, and it reproduces the salinity measured at six stations within a few units. '
             'We fit the constant from one season of readings and test it on the next.')
PAPER = {
  'meta': {'kind': 'paper', 'title': 'A Simple Model of Mixing in Shallow Estuaries', 'header': 'Notes on Tidal Mixing - Draft', 'footer': '', 'pageNumbers': True, 'dir': 'ltr'},
  'footnotes': {'1': 'The six stations are the ones used by the harbour survey of the same year.', '2': 'Readings taken in storms were left out of the fit.'},
  'blocks': [
    {'type': 'title', 'text': 'A Simple Model of Mixing in Shallow Estuaries'},
    {'type': 'p', 'id': 'authors', 'role': 'authors', 'runs': [{'t': 'Ada Rowntree'}, {'t': '1', 'sup': True}, {'t': ', Tomas Elling'}, {'t': '2', 'sup': True}]},
    {'type': 'p', 'id': 'affil', 'role': 'authors', 'runs': [{'t': '1', 'sup': True}, {'t': 'Coastal Laboratory, Port Amble. '}, {'t': '2', 'sup': True}, {'t': 'School of Water Studies, Hollin Vale.'}]},
    {'type': 'h', 'level': 2, 'text': 'Abstract', 'abstract': True},
    {'type': 'p', 'id': 'abstract', 'role': 'abstract', 'runs': [{'t': PAPER_ABS}]},
    {'type': 'h', 'level': 1, 'text': '1 Introduction'},
    {'type': 'p', 'id': 'intro', 'runs': [
      {'t': 'A shallow estuary mixes river water with sea water twice a day. Its salinity at a place depends on the river flow, on the tide and on how fast the two waters stir. Many models describe this with care; ours keeps only what a harbour office can measure. We call the salinity of box '},
      {'t': 'i', 'i': True}, {'t': ' the value '}, {'t': 's', 'i': True}, {'t': 'i', 'i': True, 'sub': True},
      {'t': ' and the river flow '}, {'t': 'Q', 'i': True}, {'t': ', and we take the mixing to grow with the square of the tidal range, '},
      {'t': 'r', 'i': True}, {'t': '2', 'sup': True}, {'t': '.'}, {'fn': 1},
      {'t': ' The rest of this note sets out the model, fits it and tests it.'}]},
    {'type': 'eq', 'id': 'eq1', 'text': 'ds/dt = k (s0 - s)', 'num': '(1)'},
    {'type': 'p', 'id': 'intro2', 'runs': [{'t': 'Equation 1 says that each box relaxes toward the sea value at a rate set by the constant k. The constant is the only number we fit, and the next section shows how.'}]},
    {'type': 'h', 'level': 1, 'text': '2 Method'},
    {'type': 'p', 'id': 'method', 'runs': [{'t': 'We read the salinity at six stations at high and low water for one season. For each station we took the mean of the two readings of a day and the river flow of the same day from the gauge above the town. The flux between two boxes is then written as a sum of the river term and the mixing term.'}]},
    {'type': 'eq', 'id': 'eq2', 'text': 'F = Q s + k A r2', 'num': '(2)'},
    {'type': 'p', 'id': 'method2', 'runs': [{'t': 'Here A is the cross-section of the channel at the boundary. We fitted k by least squares over all days of the first season and kept the second season apart for the test.'}]},
    {'type': 'figure', 'id': 'fig1', 'wide': True, 'caption': 'Figure 1: Salinity along the channel at high water.'},
    {'type': 'table', 'id': 'consts', 'wide': True, 'caption': 'Table 1: Fitted constants for the two seasons.', 'rows': [
      [{'text': 'Season', 'header': True}, {'text': 'k (per day)', 'header': True}, {'text': 'Error', 'header': True}],
      [{'text': 'Spring'}, {'text': '0.42'}, {'text': '1.8'}],
      [{'text': 'Autumn'}, {'text': '0.39'}, {'text': '2.1'}],
      [{'text': 'Both'}, {'text': '0.41'}, {'text': '1.9'}],
    ]},
    {'type': 'h', 'level': 1, 'text': '3 Results'},
    {'type': 'p', 'id': 'results', 'runs': [{'t': 'The fitted constant changed little between the seasons, as Table 1 shows. The model followed the measured salinity at five of the six stations; at the sixth, close to the weir, it ran high on every spring tide.'}, {'fn': 2}, {'t': ' We think the weir holds back fresh water that the model lets through.'}]},
    {'type': 'h', 'level': 1, 'text': 'References'},
    {'type': 'ref', 'id': 'ref1', 'text': '[1] Calloway, P. and Dene, M. Tides of small harbours. Coastal Notes 4, 2019, pages 11 to 29.'},
    {'type': 'ref', 'id': 'ref2', 'text': '[2] Rowntree, A. Salinity readings at Port Amble, a working record kept for the harbour office over three seasons. Port Amble, 2024.'},
    {'type': 'ref', 'id': 'ref3', 'text': '[3] Elling, T. Box models for teaching. Hollin Vale Press, 2021.'},
  ]}

# ---------------------------------------------------------------- 3. Arabic
AR_P1 = 'إِنَّ طَالِبَ العِلْمِ يَحْتَاجُ إِلَى صَبْرٍ طَوِيلٍ، وَهِمَّةٍ عَالِيَةٍ، وَشَيْخٍ نَاصِحٍ يَأْخُذُ بِيَدِهِ فِي أَوَّلِ الطَّرِيقِ؛ فَإِذَا اسْتَقَامَ لَهُ ذَلِكَ سَهُلَ عَلَيْهِ مَا بَعْدَهُ، وَقَرُبَ مِنْهُ مَا كَانَ بَعِيدًا.'
AR_P2 = 'قَرَأْتُ دَلِيلَ Markdown فِي 12 يَوْمًا، ثُمَّ رَاجَعْتُ مِنْهُ 3 فُصُولٍ فِي سَنَةِ 2025 مَعَ زُمَلَائِي فِي نَادِي Open Data.'
AR_P3 = 'وَخِتَامًا، فَإِنَّ هَذِهِ الوَرَقَةَ تَجْرِبَةٌ لِقِيَاسِ تَحْوِيلِ النُّصُوصِ العَرَبِيَّةِ، وَلَيْسَتْ مَنْقُولَةً مِنْ كِتَابٍ مَنْشُورٍ.'
ARABIC = {
  'meta': {'kind': 'arabic', 'title': 'فِي آدَابِ طَلَبِ العِلْمِ', 'header': '', 'footer': '', 'dir': 'rtl'},
  'footnotes': {},
  'blocks': [
    {'type': 'h', 'level': 1, 'lang': 'ar', 'text': 'فِي آدَابِ طَلَبِ العِلْمِ'},
    {'type': 'p', 'id': 'ar1', 'lang': 'ar', 'runs': [{'t': AR_P1}]},
    {'type': 'h', 'level': 2, 'lang': 'ar', 'text': 'الأُصُولُ الثَّلَاثَةُ'},
    {'type': 'ol', 'id': 'ar-ol', 'lang': 'ar', 'items': [{'text': 'النِّيَّةُ الصَّالِحَةُ قَبْلَ كُلِّ شَيْءٍ', 'level': 0}, {'text': 'مُلَازَمَةُ الدَّرْسِ وَمُذَاكَرَتُهُ', 'level': 0}, {'text': 'العَمَلُ بِمَا تَعَلَّمَهُ الطَّالِبُ', 'level': 0}]},
    {'type': 'p', 'id': 'ar2', 'lang': 'ar', 'runs': [{'t': AR_P2}]},
    {'type': 'h', 'level': 2, 'lang': 'ar', 'text': 'أَدَوَاتُ الطَّالِبِ'},
    {'type': 'ul', 'id': 'ar-ul', 'lang': 'ar', 'items': [{'text': 'الكُتُبُ المُقَرَّرَةُ', 'level': 0}, {'text': 'دَفْتَرُ المُلَاحَظَاتِ', 'level': 0}, {'text': 'قَلَمَانِ وَمِمْحَاةٌ', 'level': 0}]},
    {'type': 'h', 'level': 2, 'lang': 'ar', 'text': 'جَدْوَلُ الدُّرُوسِ'},
    {'type': 'table', 'id': 'ar-tab', 'lang': 'ar', 'dir': 'rtl', 'rows': [
      [{'text': 'اليَوْمُ', 'header': True}, {'text': 'الدَّرْسُ', 'header': True}, {'text': 'السَّاعَةُ', 'header': True}],
      [{'text': 'السَّبْتُ'}, {'text': 'النَّحْوُ'}, {'text': '8'}],
      [{'text': 'الأَحَدُ'}, {'text': 'الصَّرْفُ'}, {'text': '9'}],
      [{'text': 'الثُّلَاثَاءُ'}, {'text': 'البَلَاغَةُ'}, {'text': '10'}],
    ]},
    {'type': 'h', 'level': 2, 'lang': 'ar', 'text': 'بَيْتٌ مِنَ الشِّعْرِ'},
    {'type': 'verse', 'id': 'verse', 'lang': 'ar', 'a': 'العِلْمُ نُورٌ إِذَا مَا الدَّرْبُ أَظْلَمَ بِي', 'b': 'وَالصَّبْرُ زَادٌ إِذَا مَا الزَّادُ قَدْ عُدِمَا'},
    {'type': 'p', 'id': 'ar3', 'lang': 'ar', 'runs': [{'t': AR_P3}]},
  ]}

# ---------------------------------------------------------------- 4. slides
SLIDES = {
  'meta': {'kind': 'slides', 'title': 'Harbour Lights Project', 'header': '', 'footer': '', 'dir': 'ltr', 'landscape': True},
  'footnotes': {},
  'blocks': [
    {'type': 'slide', 'n': 1, 'boxes': [
      {'role': 'title', 'text': 'Harbour Lights Project'},
      {'role': 'text', 'text': 'Quarterly review, spring 2026'}]},
    {'type': 'slide', 'n': 2, 'picture': True, 'boxes': [
      {'role': 'title', 'text': 'What we changed'},
      {'role': 'bullets', 'items': ['New lamps on the north pier', 'Timers set by the tide tables', 'Two spare units kept in the store']},
      {'role': 'text', 'text': 'Source: harbour log, March'}]},
    {'type': 'slide', 'n': 3, 'background': True, 'boxes': [
      {'role': 'title', 'text': 'Next steps'},
      {'role': 'text', 'text': 'Order the new lenses before May'},
      {'role': 'text', 'text': 'Train the night crew on the timers'},
      {'role': 'text', 'text': 'Budget: 4200 for the year'}]},
  ]}

# ---------------------------------------------------------------- 5. form
FORM = {
  'meta': {'kind': 'form', 'title': 'Membership Application', 'header': '', 'footer': '', 'dir': 'ltr'},
  'footnotes': {},
  'blocks': [
    {'type': 'h', 'level': 1, 'text': 'Membership Application'},
    {'type': 'p', 'id': 'club', 'runs': [{'t': 'Port Amble Rowing Club'}]},
    {'type': 'field', 'id': 'f-name', 'label': 'Full name:'},
    {'type': 'field', 'id': 'f-addr', 'label': 'Address:'},
    {'type': 'field', 'id': 'f-dob', 'label': 'Date of birth:'},
    {'type': 'check', 'id': 'c-type', 'label': 'Membership type:', 'options': ['Adult', 'Junior', 'Family']},
    {'type': 'grid', 'id': 'g-num', 'label': 'Membership number:', 'n': 8},
    {'type': 'leader', 'id': 'l-fee', 'text': 'Annual fee', 'value': '120.00'},
    {'type': 'leader', 'id': 'l-boat', 'text': 'Boat storage', 'value': '45.00'},
    {'type': 'leader', 'id': 'l-key', 'text': 'Boathouse key deposit', 'value': '10.00'},
    {'type': 'layout', 'id': 'lay', 'cols': [
      ['Emergency contact', 'Name:', 'Phone:'],
      ['Club use only', 'Received by:', 'Date:']]},
    {'type': 'field', 'id': 'f-sign', 'label': 'Signature:'},
    {'type': 'p', 'id': 'fine', 'role': 'fine', 'runs': [{'t': 'By signing you agree to the club rules. Your details are kept for the length of your membership and one year after it, and are never passed on.'}]},
  ]}

# ---------------------------------------------------------------- 6. book
BOOK_C1 = [
  'The lamp on the north pier was lit at dusk every evening of the year, and for eleven of those years it was lit by Orla Penhale. She came down the harbour steps with the brass key in one hand and the oil can in the other, and she never once forgot which came first.',
  'Her father had kept the lamp before her, and his mother before him. The keeping passed down the family like a coat that was let out and taken in, never quite fitting anyone, never quite thrown away.',
  'In the first winter she kept a notebook of every ship that passed. By spring the notebook had grown into three, and the harbour master asked to borrow them, which pleased her more than she would admit.',
  'There were nights when the wind came straight off the sea and the flame bent low behind the glass. On those nights she sat in the lamp room with her back to the wall and listened to the pier groan under the weight of the water, counting the waves between the gusts.',
  'Most of the work was waiting. She trimmed the wick, wiped the soot from the glass, filled the reservoir and wrote the time in the book. Then she waited for morning, and when morning came she put the light out and walked home along the harbour wall.',
  'In the summer the work was lighter but the nights were shorter, and she found that she slept badly in the long evenings before dusk. She took to mending nets for the families on Quay Street, which earned her a little money and a great deal of conversation, most of it about the weather and the price of coal.',
  'The harbour master came to the lamp room once a month to sign the book. He was a careful man who counted the pages before he signed them, and he always asked whether the glass had cracked again. It had cracked twice in eleven years, both times in a frost, and both times she had mended it herself with a strip of lead and a borrowed iron.',
  'Visitors sometimes climbed the steps to watch her work. Children asked whether the light ever went out by itself, and she told them the truth, that it had gone out once in a gale and that she had relit it in the dark with her hands shaking so much that the third match broke.',
  'After that night she kept a second box of matches in a tin by the door, and a third in her coat. The harbour board heard of the gale and sent a letter of thanks, which she pinned above the oil shelf, and which slowly turned brown in the heat of the lamp over the following winters.',
]
BOOK_QUOTE = 'A light that is kept is a promise kept. Nobody thanks the lamp, but every boat that comes home is its answer.'
BOOK_C2 = [
  'Low water came twice a day, and twice a day the harbour showed what it had been hiding. Old ropes, a cart wheel, a bottle with no message in it, and once a small boat that nobody claimed.',
  'Orla walked the mud at low water with a long pole, testing the ground before each step. She learned which channels stayed soft and which had turned to sand, and she drew them on the back page of her notebook.',
  'The fishermen laughed at the drawings at first. Then one of them ran aground on a bank that was not on any chart but was on hers, and after that they came to the lamp room on Sundays to copy the back page.',
  'By the end of the year the drawings had become a proper map, with depths written in small figures and the softest mud shaded in pencil. The harbour board printed it at last, though they never put her name on it.',
  'She did not mind as much as people expected. The map was meant for the boats, not for her, and the boats used it. On calm evenings she could see from the lamp room how the skippers turned early at the bend below the chapel, exactly where her pencil line turned.',
  'In the autumn a surveyor came from the city with brass instruments and a boy to carry them. He measured the harbour for three weeks and found that the printed map was right in every place but one, where a winter storm had moved the sand since she had drawn it.',
]
BOOK = {
  'meta': {'kind': 'book', 'title': "The Lamp Keeper's Year", 'header': "The Lamp Keeper's Year", 'headerOdd': 'chapter', 'footer': '', 'pageNumbers': True, 'romanFront': True, 'dir': 'ltr'},
  'footnotes': {},
  'blocks': [
    {'type': 'title', 'text': "The Lamp Keeper's Year"},
    {'type': 'p', 'id': 'byline', 'role': 'byline', 'runs': [{'t': 'A made-up story for a test corpus'}]},
    {'type': 'h', 'level': 1, 'text': 'Contents', 'front': True},
    {'type': 'toc', 'id': 'toc', 'entries': [{'text': '1 The Lamp Keeper', 'page': '1'}, {'text': '2 Low Water', 'page': '3'}]},
    {'type': 'h', 'level': 1, 'text': '1 The Lamp Keeper', 'chapter': 'The Lamp Keeper'},
    {'type': 'p', 'id': 'c1p1', 'dropcap': True, 'smallcapsWords': 6, 'runs': [{'t': BOOK_C1[0]}]},
    {'type': 'p', 'id': 'c1p2', 'runs': [{'t': BOOK_C1[1]}]},
    {'type': 'p', 'id': 'c1p3', 'runs': [{'t': BOOK_C1[2]}]},
    {'type': 'quote', 'id': 'quote', 'text': BOOK_QUOTE},
    {'type': 'p', 'id': 'c1p4', 'runs': [{'t': BOOK_C1[3]}]},
    {'type': 'ornament', 'id': 'orn', 'text': '* * *'},
    {'type': 'p', 'id': 'c1p5', 'runs': [{'t': BOOK_C1[4]}]},
    {'type': 'p', 'id': 'c1p6', 'runs': [{'t': BOOK_C1[5]}]},
    {'type': 'p', 'id': 'c1p7', 'runs': [{'t': BOOK_C1[6]}]},
    {'type': 'p', 'id': 'c1p8', 'runs': [{'t': BOOK_C1[7]}]},
    {'type': 'p', 'id': 'c1p9', 'runs': [{'t': BOOK_C1[8]}]},
    {'type': 'h', 'level': 1, 'text': '2 Low Water', 'chapter': 'Low Water'},
    {'type': 'p', 'id': 'c2p1', 'dropcap': True, 'smallcapsWords': 4, 'runs': [{'t': BOOK_C2[0]}]},
    {'type': 'p', 'id': 'c2p2', 'runs': [{'t': BOOK_C2[1]}]},
    {'type': 'p', 'id': 'c2p3', 'runs': [{'t': BOOK_C2[2]}]},
    {'type': 'p', 'id': 'c2p4', 'runs': [{'t': BOOK_C2[3]}]},
    {'type': 'p', 'id': 'c2p5', 'runs': [{'t': BOOK_C2[4]}]},
    {'type': 'p', 'id': 'c2p6', 'runs': [{'t': BOOK_C2[5]}]},
  ]}

DOCS = {'invoice': INVOICE, 'paper': PAPER, 'arabic': ARABIC, 'slides': SLIDES, 'form': FORM, 'book': BOOK}

if __name__ == '__main__':
    for k, d in DOCS.items():
        with open(os.path.join(H, '..', 'truth', k + '.json'), 'w', encoding='utf-8') as f: json.dump(d, f, ensure_ascii=False, indent=1); f.write('\n')
    print('truth written:', ', '.join(DOCS))
