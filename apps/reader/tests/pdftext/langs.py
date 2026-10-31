# python3 tests/pdftext/langs.py <outdir>: one PDF per writing system (LibreOffice from a .docx), each with a
# few sentences whose text is known — langs.json beside them — to measure what copying/searching reads back.
# Arabic with harakat, Persian, Urdu, English with ligatures and a hyphenated line, French, German, Russian,
# Greek, Japanese, Chinese, Korean, Hindi, Thai, Vietnamese, Turkish.
import sys, os, json, subprocess
import docx
from docx.shared import Pt
from docx.oxml.ns import qn
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
TEXTS = {
  'ar': ['اللَّفْظُ: وَسَمَّيْنَاهُ فِي تَقْسِيمِنَا: اللِّسَانَ.', 'وقد سبق إلى ذكر هذه العلامات المناطقة حين قسموا الدلالة إلى دلالة وضعية، ودلالة عقلية، ودلالة طبيعية.', 'قال الجاحظ (ت ٢٥٥هـ) في «البيان والتبيين»: جميع أصناف الدلالات على المعاني خمسة أشياء لا تنقص ولا تزيد.'],
  'fa': ['زبان فارسی یکی از زبان‌های هندواروپایی است که در ایران، افغانستان و تاجیکستان گفته می‌شود.', 'کتاب‌های بسیاری به این زبان نوشته شده‌اند.'],
  'ur': ['اردو پاکستان کی قومی زبان ہے اور بھارت میں بھی بولی جاتی ہے۔', 'یہ کتاب بہت دلچسپ ہے۔'],
  'en': ['The office finds that efficient workflows affect the final outcome significantly.', 'A sufficiently long sentence that the typesetter will have to break across lines, with hyphenation of extraordinarily long words.'],
  'fr': ['Le café de la rue Saint-Honoré était déjà fermé à cette heure-là, évidemment.', 'Œuvre complète, naïveté et cœur.'],
  'de': ['Die Straße war überfüllt; Größe, Übung und Ärger gehören dazu.', 'Weißt du, daß die Schließung groß war?'],
  'ru': ['Съешь же ещё этих мягких французских булок, да выпей чаю.', 'Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.'],
  'el': ['Η γρήγορη καφέ αλεπού πηδάει πάνω από το τεμπέλικο σκυλί.', 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.'],
  'ja': ['吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。', '何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。'],
  'zh': ['春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。', '学而时习之，不亦说乎？有朋自远方来，不亦乐乎？'],
  'ko': ['나랏말싸미 듕귁에 달아 문자와로 서르 사맛디 아니할쎄.', '이 책은 매우 재미있습니다.'],
  'hi': ['हिन्दी भारत की राजभाषा है और इसे देवनागरी लिपि में लिखा जाता है।', 'यह पुस्तक बहुत रोचक है।'],
  'th': ['ภาษาไทยเป็นภาษาราชการของประเทศไทย', 'หนังสือเล่มนี้น่าสนใจมาก'],
  'vi': ['Tiếng Việt là ngôn ngữ chính thức của Việt Nam, được viết bằng chữ Quốc ngữ.', 'Quyển sách này rất thú vị.'],
  'tr': ['İstanbul, Türkiye\'nin en kalabalık şehridir; Çağdaş yazı ğ, ı, ş, ü harflerini kullanır.', 'Bu kitap çok ilginç.'],
}
FONT = { 'ar': 'DejaVu Sans', 'fa': 'DejaVu Sans', 'ur': 'DejaVu Sans', 'ja': 'Noto Serif CJK JP', 'zh': 'Noto Serif CJK SC', 'ko': 'Noto Serif CJK KR', 'hi': 'FreeSerif', 'th': 'Loma', 'vi': 'DejaVu Serif' }
RTL = {'ar', 'fa', 'ur'}
for lang, lines in TEXTS.items():
    d = docx.Document()
    for ln in lines:
        p = d.add_paragraph(); r = p.add_run(ln); r.font.size = Pt(14); r.font.name = FONT.get(lang, 'Liberation Serif')
        rpr = r._element.get_or_add_rPr(); rf = rpr.find(qn('w:rFonts'))
        if rf is None: rf = rpr.makeelement(qn('w:rFonts'), {}); rpr.append(rf)
        for k in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'): rf.set(qn(k), FONT.get(lang, 'Liberation Serif'))
        if lang in RTL:
            ppr = p._element.get_or_add_pPr(); bidi = ppr.makeelement(qn('w:bidi'), {}); ppr.append(bidi)
            rtl = rpr.makeelement(qn('w:rtl'), {}); rpr.append(rtl)
    name = f'lang-{lang}'; d.save(os.path.join(out, name + '.docx'))
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', out, os.path.join(out, name + '.docx')], check=True, capture_output=True)
    os.remove(os.path.join(out, name + '.docx'))
json.dump(TEXTS, open(os.path.join(out, 'langs.json'), 'w'), ensure_ascii=False, indent=1)
print('made', len(TEXTS))
