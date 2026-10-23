# Glyph labels for the Advent (3B2) Arabic fonts, by scheme. Values are Unicode text in reading order.
L = lambda s: dict(x.split('=', 1) for x in s.split())
ISO = L("A=ء B=آ C=أ D=ؤ E=إ F=ئ G=ا H=ب I=ة J=ت K=ث L=ج M=ح N=خ O=د P=ذ Q=ر R=ز S=س T=ش U=ص V=ض W=ط X=ظ Y=ع Z=غ "
        "a=ف b=ق c=ك d=ل e=م f=ن g=ه h=و i=ى j=ي "
        "k=ً l=ٌ m=ٍ n=َ o=ُ p=ِ q=ّ r=ْ "
        "zero=٠ one=١ two=٢ three=٣ four=٤ five=٥ six=٦ seven=٧ eight=٨ nine=٩ "
        "colon=: comma=، semicolon=؛ question=؟ exclam=! hyphen=- slash=/ asterisk=* parenleft=( parenright=) "
        "bar=ﷺ braceleft=﴿ braceright=﴾ y=» z=« v=\u0640 t=\u200b")
FORMS = L("D=ح E=ح F=ح G=خ H=خ I=خ J=د K=ذ L=ر M=ز O=س P=س Q=س R=ش S=ش T=ش U=ص V=ص W=ص X=ض Y=ض Z=ض a=ظ "
          "ampersand=ؤ asciicircum=ظ at=ج b=ع backslash=ط bracketleft=ط bracketright=ط c=ع colon=ت comma=ئ d=ع dollar=لأ "
          "e=غ eight=ت equal=ث exclam=لآ f=غ g=غ greater=ج hyphen=ئ k=ف l=ف less=ث m=ف "
          "nine=ت numbersign=أ one=ب parenleft=إ parenright=لإ percent=لأ period=ا plus=ئ q=ق question=ج quotedbl=لآ r=ق "
          "s=ق semicolon=ث seven=ة slash=لا space=آ t=ك three=ب two=ب u=ك underscore=ظ v=ك zero=لا")
FORMS2 = L("X=عليه_السلام ampersand=ن comma=ه dollar=م exclam=ل hyphen=ه numbersign=م one=ي parenleft=ن parenright=ن "
           "percent=م period=و plus=ه quotedbl=ل slash=ى space=ل two=ي zero=ي "
           "four=ٌّ five=ٍّ six=َّ seven=ُّ eight=ِّ "
           "R=رضي_الله_عنهم S=رضي_الله_عنه Y=رحمه_الله Z=رضي_الله_عنها bracketleft=رضي_الله_عنهما at=.")
F533 = L("B=ج C=ح G=ص H=ض I=ط K=ع N=ق O=ك Q=م R=ن S=ه T=ي X=ا Z=ة at=ت b=د bracketright=ج c=ذ colon=م e=ز "
         "eight=ك equal=ي l=ع nine=ل o=ق question=ب space=ئ two=ط u=و z=لا")
F534 = L("D=لأ v=َّ w=ُّ x=ِّ")
FAN = L("AE=لأ C127=ث C131=ج C138=خ C141=د C142=د C143=ذ C144=ذ C145=ر C146=ر C147=ز C148=ز C149=س C150=س C151=ش C152=ش "
        "C153=ص C154=ص C155=ض C156=ض C157=\u0640 C158=\u0640 C159=ط C160=ط C181=ف C192=ل C201=ن C204=ه C209=ى C210=ى C211=ي C212=ي "
        "C213=ي C214=ي C223=لا C224=لا C229=لآ Thorn=ح acute=ل asciitilde=ث asterisk=❖ bar=ت braceleft=ت breve=م bullet=ق "
        "caron=و cedilla=ه cent=ط circumflex=م colon=: comma=، currency=ع d=ء daggerdbl=ف dieresis=ن dotaccent=ن eight=٨ "
        "ellipsis=ك emdash=و eth=ح exclamdown=ط ffi=ج ffl=ج fi=غ five=٥ four=٤ fraction=ظ g=أ grave=ل guillemotleft=غ "
        "guillemotright=ك guilsinglleft=غ hungarumlaut=ه j=ؤ k=إ m=ئ macron=م n=ئ nine=٩ ogonek=ه one=١ onehalf=خ "
        "onequarter=ح ordfeminine=لإ p=ئ paragraph=ف periodcentered=ض plus=+ plusminus=خ q=ا questiondown=ل "
        "quotedblbase=ق quotedblleft=ع quotedblright=ق quotesinglbase=ق quotesingle=ع r=ا ring=ن s=ب section=ع seven=٧ "
        "six=٦ space=\u200b t=ب thorn=ح three=٣ tilde=م two=٢ u=ب v=ب w=ة x=ة y=ت yen=ظ z=ت zero=٠ "
        "A=. B=\u0640 I=\u064b J=\u064c K=\u064e L=\u064f M=\u0651 N=\u0652 P=\u200b T=\u064e\u0651 U=\u064f\u0651 V=\u0650\u0651 ampersand=× hyphen=- parenleft=( parenright=) period=، slash=/ perthousand=لك sterling=ظ")
SCHEMES = {'Adv_Lots_Ma': ISO, 'Adv_Lots_Ba': ISO, 'Adv.QAM603': ISO, 'Font260': FORMS, 'Font323': FORMS,
           'Font261': FORMS2, 'Font324': FORMS2, 'Font533': F533, 'Font534': F534, 'Adv.Fan5Bd': FAN, 'Adv.Fan7-L': FAN}
Q = {
 'Advzy0': L("o=﴿ p=﴾"),
 'Advzy120303': L("A=رَبِّكَ C=اقْرَأْ D=بِاسْمِ"),
 'Advzy133596': L("A=أَجِدُ B=فِي C=قُلْ D=لَا E=إِلَيَّ F=مُحَرَّمًا G=مَا H=أُوحِيَ"),
 'Advzy191556': L("braceleft=تَنْزِيلُ bar=الم"),
 'Advzy261806': L("Q=اللَّهُ R=بِاللَّغْوِ S=فِي T=أَيْمَانِكُمْ"),
 'Advzy354511': L("hyphen=الْعَالَمِينَ period=رَبِّ slash=لِلَّهِ zero=الْحَمْدُ"),
 'Advzy358179': L("nine=اسْمَ colon=رَبِّكَ semicolon=الْأَعْلَى at=سَبِّحِ h=الْغَاشِيَةِ i=حَدِيثُ j=أَتَاكَ k=هَلْ"),
 'Advzy363275': L("percent=وَلَا ampersand=تُلْقُوا quoteright=بِأَيْدِيكُمْ parenleft=إِلَى nine=التَّهْلُكَةِ"),
 'Advzy381368': L("v=اللَّهِ w=وَجْهُ x=فَثَمَّ y=تُوَلُّوا z=فَأَيْنَمَا"),
 'Advzy566283': L("k=أَيْمَانُكُمْ l=مَلَكَتْ m=مَا n=إِلَّا o=النِّسَاءِ p=مِنَ q=وَالْمُحْصَنَاتُ"),
 'Advzy569112': L("A=الصَّفَا B=وَالْمَرْوَةَ C=مِنْ D=شَعَائِرِ E=اللَّهِ"),
 'Advzy603578': L("exclam=لِلَّهِ quotedbl=قَانِتِينَ percent=الصَّلَوَاتِ ampersand=وَالصَّلَاةِ quoteright=الْوُسْطَى parenleft=وَقُومُوا semicolon=حَافِظُوا less=عَلَى"),
 'Advzy612535': L("a=إِنَّ"),
 'Advzy635430': L("w=قُوَّةٍ x=مِنْ y=اسْتَطَعْتُمْ z=مَا braceleft=لَهُمْ bar=وَأَعِدُّوا"),
 'Advzy655561': L("three=ق five=الْمَجِيدِ six=وَالْقُرْآنِ"),
 'Advzy686931': L("I=أُسْوَةٌ J=حَسَنَةٌ M=لَكُمْ N=فِي O=رَسُولِ P=اللَّهِ S=لَقَدْ T=كَانَ"),
 'Advzy727953': L("exclam=عَذَابَ quotedbl=النَّارِ numbersign=حَسَنَةً dollar=وَقِنَا parenright=آتِنَا asterisk=فِي comma=رَبَّنَا hyphen=وَفِي period=الْآخِرَةِ slash=الدُّنْيَا zero=حَسَنَةً"),
 'Advzy811985': L("u=الْإِنْسَانِ v=عَلَى w=أَتَى x=هَلْ"),
 'Advzy840386': L("exclam=السَّمَاءُ quotedbl=إِذَا dollar=انْشَقَّتْ"),
 'Advzy855422': L("l=ص"),
 'Advzy900580': L("R=الْكَافِرُونَ S=يَا_أَيُّهَا T=قُلْ"),
 'Advzy905018': L("one=وَإِنْ two=كُنْتُمْ equal=عَلَى greater=سَفَرٍ question=مَرْضَى at=أَوْ"),
 'Advzy905895': L("a=يس"),
 'Advzy926539': L("one=حَرْثٌ two=نِسَاؤُكُمْ a=يُؤَاخِذُكُمُ b=لَا asciitilde=لَكُمْ"),
 'Advzy969560': L("G=اللَّهِ H=بِسْمِ I=الرَّحِيمِ J=الرَّحْمَنِ"),
 'Advzy986278': L("percent=رَبِّ ampersand=الْعَالَمِينَ quoteright=الْحَمْدُ parenleft=لِلَّهِ asterisk=يَوْمِ plus=الرَّحْمَنِ comma=الرَّحِيمِ slash=الدِّينِ colon=وَلَا question=الضَّالِّينَ"),
 'Advzy989522': L("equal=مَالِكِ S=قُلْ T=هُوَ U=اللَّهُ V=أَحَدٌ"),
 'Adv_IslSymb': L("c=ﷺ"),
 'AdvTT4ff65459': L("braceleft=۞"),
}
SCHEMES.update(Q)
