// Simplified Chinese UI strings. Keys mirror en.ts; anything missing falls back to English.
import type { Strings } from './en';

export const zh: Partial<Strings> = {
  appName: '黑川阅读器',
  tagline: '能读的都能读。',

  library: '书库', importBooks: '添加图书', images: '图片', settings: '设置', back: '返回', close: '关闭', cancel: '取消', done: '完成', delete: '删除', open: '打开', openTogether: '一起阅读', select: '选择', selectAll: '全选', selectNone: '取消全选', shareFile: '分享文件', selectedCount: '已选 {n} 项', more: '更多', hideQuotes: '隐藏每日一句', showQuote: '在书库页显示我高亮中的一句', readInOrder: '按顺序阅读', readInOrderHint: '这些书将依次阅读：一本读完后，继续滚动即打开下一本。排好顺序后开始。随时可在阅读器菜单中更改或停止。', startReading: '开始阅读', orderKept: '已保存阅读顺序', orderCleared: '已取消阅读顺序', stopOrder: '停止按顺序阅读', nextInOrder: '下一本', remove: '移除', itemsPerRow: '每行数量', autoFit: '自动', speedReading: '速读', speedWpm: '每分钟词数', wpm: '词/分', pause: '暂停', nextVolume: '下一卷', volumeOf: '共 {total} 卷，第 {n} 卷', readingRuler: '阅读标尺', readingRulerHint: '几行高的清晰条带跟随鼠标或最后一次点按，其余部分略微变暗。', customCss: '自定义 CSS', customCssHint: '像 Moon+ 一样为书籍正文添加自己的样式（p、h1、blockquote、img…）。规则只作用于正文。', backToPlace: '回到原来的位置', updateReady: '更新已下载 — 退出时安装', restartNow: '立即重启', updateChannel: '更新', channelStable: '稳定版', channelBeta: '测试版（含预发布）', updateEvery: '检查', everyLaunch: '每次启动', everyDay: '每天', everyWeek: '每周', updateAutoDownload: '在后台下载更新并在退出时安装', updateAutoDownloadHint: '只获取变化的部分（几 MB）。准备好后会提示重启，否则在下次关闭应用时安装。', noteOnPage: '在此页添加备注…', tapWhereNote: '点按页面上要放置备注的位置',

  emptyLibraryTitle: '书库是空的', emptyLibraryBody: '可添加 EPUB、PDF、DOCX、XLSX、PPTX、TXT 等。所有内容都保存在本设备上。', dropHint: '将文件拖到这里添加', importing: '正在添加 {n}…', imported: '已添加 {n}', importFailed: '无法添加 {name}：{error}', searchLibrary: '搜索书库', sortBy: '排序', sortRecent: '最近打开', sortAdded: '最近添加', sortTitle: '书名', sortAuthor: '作者', continueReading: '继续阅读', unknownAuthor: '作者不详', deleteConfirm: '从书库删除 {n} 本书？文件也会从本设备删除。', bookDetails: '详情', format: '格式', size: '大小', added: '添加日期', lastOpened: '上次打开', never: '从未', progress: '进度', pages: '页数',

  loading: '加载中…', contents: '目录', bookmarks: '书签', search: '搜索', searchInBook: '在书中搜索', searchPlaceholder: '输入搜索内容…', noResults: '没有结果', resultsCount: '{n} 个结果', addBookmark: '添加书签', bookmarkAdded: '已添加书签', noBookmarks: '还没有书签', noContents: '这本书没有目录', visualOptions: '显示设置', readAloud: '朗读', stopReading: '停止朗读', autoScroll: '自动滚动', autoScrollSpeed: '速度', fullscreen: '全屏', nowReading: '正在阅读', of: '/', percentRead: '已读 {p}%', chapter: '章', openedTogether: '已一起打开 {n} 本书', booksInSession: '一起打开的书', jumpToBook: '跳转到图书', unsupportedFormat: '暂不支持此文件类型', openError: '无法打开此文件：{error}',

  page: '页', pageOf: '第 {n} / {total} 页', goToPage: '跳转到页码', go: '跳转', previousPage: '上一页', nextPage: '下一页', zoomIn: '放大', zoomOut: '缩小', fitWidth: '适合宽度', pdfSearching: '正在搜索 {total} 页中的第 {n} 页…', invertColors: '页面深色模式',

  copySelected: '复制', copied: '已复制', searchSelected: '搜索', defineSelected: '释义', translateSelected: '翻译', highlight: '高亮', highlights: '高亮', noHighlights: '还没有高亮', speakSelected: '朗读', define: '释义', translate: '翻译', translateTo: '翻译为', translating: '正在翻译…', lookingUp: '正在查询…', offlineService: '需要联网。阅读器本身可完全离线使用，释义和翻译会在联网时从网络获取。', noDefinition: '未找到释义。', openInDictionary: '在词典中打开', openInTranslator: '在翻译器中打开', serviceFailed: '无法连接到服务。',

  theme: '主题', themeDark: '深色', themeBlack: '纯黑', themeSepia: '复古', themeLight: '浅色', themePaper: '纸张', latinFont: '西文字体', arabicFont: '阿拉伯文字体', fontPublisher: '出版方', fontSystemSerif: '系统衬线体', fontSystemSans: '系统无衬线体', fontSize: '字号', lineHeight: '行距', paragraphSpacing: '段距', pageWidth: '正文宽度', margins: '边距', textAlign: '对齐', alignStart: '行首对齐', alignJustify: '两端对齐', alignCenter: '居中', publisherStyles: '使用出版方样式', dimImages: '深色主题下调暗图片', hyphenate: '连字符断词', resetDefaults: '恢复默认', wordSpacing: '词距', letterSpacing: '字距',

  galleryTitle: '图片', galleryEmpty: '打开的书中没有图片', galleryCount: '{n} 张图片', jumpToImage: '在正文中显示', saveImage: '保存图片', imageFrom: '来自 {title}',

  language: '语言', languageEnglish: 'English', languageArabic: 'العربية', uiFont: '界面字体', storage: '存储', storageUsed: '已用 {used} / {quota}', storageUnknown: '无法获取存储信息', about: '关于', aboutBody: '黑川阅读器完全离线运行，你的书永远不会离开本设备。', supportedFormats: '支持的格式', version: '版本', installApp: '安装应用', installed: '已安装', clearLibrary: '删除所有图书', keyboardShortcuts: '键盘快捷键', fonts: '字体', fontsBody: '西文使用 Lora，阿拉伯文使用 Uthman TN1，界面使用 Inter 和 Sultan。',

  fmtEpub: 'EPUB 电子书', fmtPdf: 'PDF 文档', fmtDocx: 'Word 文档 (DOCX)', fmtXlsx: 'Excel 工作簿 (XLSX) 和 CSV', fmtPptx: 'PowerPoint 演示文稿 (PPTX)', fmtText: '纯文本、Markdown、HTML', fmtFb2: 'FictionBook (FB2)', fmtOdt: 'OpenDocument 文本 (ODT)', fmtCbz: '漫画压缩包 (CBZ)', fmtImages: '图片 (JPEG、PNG、GIF、WebP、SVG)',

  savedProgress: '进度已保存', error: '出错了', sheet: '工作表', slide: '幻灯片', rows: '{n} 行', showMoreRows: '显示更多行', shortcutsBody: 'J / K 或方向键：滚动 · [ ]：上一本 / 下一本 · / ：搜索 · B：书签 · G：图片 · V：显示设置 · F：全屏 · Esc：关闭面板',

  background: '背景', comfort: '护眼', typeSection: '文字', layoutSection: '版式', behaviourSection: '行为', themeCustom: '自定义', customColors: '自定义颜色', backgroundColor: '页面颜色', textColor: '文字颜色', texture: '纹理', textureNone: '无', texturePaper: '纸张', textureLinen: '亚麻', textureParchment: '羊皮纸', textureDots: '圆点', bookFormat: '书籍排版', smartTypography: '排版标点', vocabulary: '生词本', saveShelf: '保存为书架', shelfName: '书架名称（例如：未读的阿拉伯语 PDF）', shelfSaved: '已保存书架「{name}」', shelfRemoveConfirm: '删除书架「{name}」？书籍会保留。', vocabularyBody: '查过的每个词都会连同所在句子留在这里。导入 Anki：导出文件，然后在 Anki 中「文件 › 导入」（制表符分隔：正面、背面、标签）。', vocabSave: '保存查过的词', openVocabulary: '打开生词本', wordsCount: '{n} 个词', vocabEmpty: '还没有生词。阅读时选中一个词并选择「释义」。', exportAnki: '导出到 Anki', vocabExported: '已保存 — 在 Anki 中选择「文件 › 导入」', vocabClearConfirm: '清空整个生词本？', clearAll: '全部清除', smartTypographyHint: '弯引号、真正的破折号和省略号；数字与单位保持在同一行。', focusMode: '专注模式', focusModeHint: '正在阅读的段落清晰突出，其余部分淡化。', bookOnly: '仅此书的设置', bookOnlyHint: '开启后可为本书单独设置字体、字号、主题和版式；其他书保持共用设置。', bookOnlyOn: '以下更改仅作用于本书。关闭即可恢复共用设置。', bookFormatHint: '两端对齐、连字符断词、段首缩进，如印刷书籍。', texturePolka: '波点', polkaAmount: '波点数量', polkaPlace: '波点位置', polkaBoth: '两侧页边', polkaLeft: '左侧页边', polkaRight: '右侧页边', polkaEdges: '四周边缘', polkaSize: '波点大小', textureStrength: '纹理强度', backgroundImage: '背景图片', chooseImage: '选择图片', removeImage: '移除图片', imageOpacity: '图片不透明度', imageBlur: '图片模糊', warmth: '暖色（夜间滤镜）', dimScreen: '调暗页面', sampleBooks: '先添加两本书', sampleBooksBody: '哈里里《玛卡梅集》（阿拉伯语）和《爱丽丝梦游仙境》（英语）。', addingSamples: '正在添加示例书…', presets: '预设', presetNight: '夜晚', presetCandle: '烛光', presetManuscript: '手稿', presetDaylight: '白昼', presetEink: '墨水屏',

  appearance: '外观', uiMode: '界面模式', uiSystem: '跟随系统', uiLight: '浅色', uiDark: '深色', uiPage: '跟随页面', accent: '强调色', accentAqua: '水蓝', accentGold: '金色', accentRose: '玫瑰', accentMint: '薄荷', accentOlive: '橄榄', accentSand: '沙色', accentViolet: '紫罗兰', accentMono: '单色', accentCustom: '自定义', orientation: '屏幕方向', orientationAuto: '自动', orientationPortrait: '竖屏', orientationLandscape: '横屏', readerSettings: '阅读器',

  customFonts: '我的字体', customFontsBody: '从本设备添加字体文件（TTF、OTF、WOFF、WOFF2），或从网址获取。它们会出现在显示设置的字体列表中。', addFontFile: '从设备添加', addFontUrl: '从网络获取', fontUrlPlaceholder: 'https://…/font.ttf', fontAdded: '已添加字体：{name}', fontRemoved: '已删除字体', noCustomFonts: '还没有自定义字体', fontForLatin: '西文', fontForArabic: '阿拉伯文',

  bookInfo: '图书信息', readingHours: '阅读时间', readingSpeed: '阅读速度（词/分）', readingHistory: '阅读记录', charsInBook: '字符数', wordsInBook: '词数', chapters: '章节', currentChapter: '当前章节', currentPage: '当前页', minsLeftChapter: '本章还剩 {n}', minsLeftBook: '本书还剩 {n}', hoursMinutes: '{h} 小时 {m} 分', today: '今天',

  readingStats: '阅读统计', totalReading: '总阅读时间', readingSessions: '阅读次数', pagesRead: '已读页数', daysRead: '阅读天数', readingStreak: '连续天数', dailyGoal: '每日目标', goalValue: '{n} 分钟', goalOff: '关闭', setGoal: '设置每日目标', goalProgress: '{done} / {goal} 分钟', last14Days: '最近 14 天', mostRead: '读得最多的书', noReadingYet: '还没有阅读记录',

  shareImage: '分享图片', savePageImage: '将页面存为 PNG', sharePage: '分享页面', pagesGrid: '页面', pageSaved: '页面已保存', imageSaved: '图片已保存', shareUnavailable: '这里无法分享，已改为保存文件。',

  note: '笔记', addNote: '添加笔记', notePlaceholder: '写点什么…', noteSaved: '笔记已保存', textAsImage: '文字转图片', shareText: '分享', systemTranslate: '用其他应用翻译…', searchWeb: '网页搜索', wikipedia: '维基百科', highlightColor: '高亮颜色', removeHighlight: '删除高亮',

  folders: '文件夹', newFolder: '新建文件夹', folderName: '文件夹名称', allBooks: '全部图书', moveToFolder: '移动到文件夹', removeFromFolder: '移出文件夹', deleteFolder: '删除文件夹', deleteFolderConfirm: '删除文件夹“{name}”？书会留在书库中。', renameFolder: '重命名文件夹', dropOnFolder: '拖到文件夹上即可移动', emptyFolder: '此文件夹是空的', importHere: '添加到此文件夹', noFolder: '无文件夹',

  tags: '标签', tagName: '标签名', newTag: '新标签', addTag: '添加', manageTags: '编辑标签', noTags: '还没有标签', renameTag: '重命名标签', deleteTag: '删除标签', deleteTagConfirm: '从所有书中删除标签“{name}”？', noTaggedBooks: '没有带此标签的书',

  direction: '布局方向', dirAuto: '随语言', dirLtr: '从左到右', dirRtl: '从右到左', langSystem: '跟随系统', readingMode: '阅读方式', modeChapters: '逐章', modeFlow: '滚动进入下一章', modeContinuous: '连续滚动', pullForNext: '继续滚动进入下一章', pullForPrev: '继续滚动回到上一章', nextChapter: '下一页', prevChapter: '上一页', endOfBook: '全书完', hideSystemBars: '阅读时隐藏状态栏和导航栏', textColorOverride: '文字颜色', pageColorOverride: '页面颜色', useThemeColor: '主题默认', libraryView: '书库视图', viewChips: '文件夹选项卡', viewCards: '文件夹与书并列', sortSize: '大小', sortTitleNum: '书名（数字顺序）', showAll: '显示全部', themeGrey: '灰色', themeSlate: '石板', themeMintPaper: '薄荷纸', themeSand: '沙色', themeOlive: '橄榄', themeAmber: '琥珀', themeForest: '森林', themePlum: '梅子', themeInk: '墨色', themeCoffee: '咖啡', themeLavender: '薰衣草', themeSky: '天空', themeCharcoal: '炭黑', themeNord: 'Nord', themeDracula: 'Dracula', themeSolarizeddark: 'Solarized 深色', themeGruvbox: 'Gruvbox', themeSolarizedlight: 'Solarized 浅色', themeCream: '奶油', themePeach: '蜜桃', themeRosePaper: '玫瑰纸', themeNight: '夜蓝', accentGraphite: '石墨', accentTeal: '青绿', accentCoral: '珊瑚', openFolder: '打开文件夹', booksInFolder: '{n} 本', create: '创建', rename: '重命名',

  updates: '应用更新', checkUpdates: '检查更新', checking: '正在检查…', upToDate: '已是最新版本', updateAvailable: '有可用更新：{v}', updateAvailableShort: '可更新到 {v}', autoCheck: '联网时自动检查', downloadInstall: '下载并安装', downloading: '正在下载… {p}%', installStarted: '已打开安装程序', installWithAltStore: '用 AltStore 安装', installWithSideStore: '用 SideStore 安装', installWithTrollStore: '用 TrollStore 安装', addAltStoreSource: '添加源到 AltStore', addSideStoreSource: '添加源到 SideStore', useWebApp: '改用网页版（无需签名）', openReleasePage: '打开发布页', reloadToUpdate: '重新加载以更新', lastChecked: '上次检查：{d}', updateFailed: '无法检查更新', whatsNew: '新功能', iosUpdateHint: 'iOS 不能在应用内安装应用。TrollStore 可永久安装；AltStore 和 SideStore 用你的 Apple ID 签名（免费账号 7 天，开发者账号 1 年）——添加一次源，更新就会出现在它们的目录里。网页版完全不需要签名：在 Safari 中打开并添加到主屏幕。', portableHint: '便携版：请从发布页下载新的 EXE 替换当前文件。', tapToTurn: '点按页面向上或向下翻一屏',

  showStatusLine: '显示状态行（章节、屏数、时钟、电量）', translatorChoice: '翻译选中文字时使用', translatorBuiltin: '内置翻译', translatorSystem: '本设备上的应用', snapshot: '文字快照', snapStyle: '快照样式', snapPlain: '简洁 — 文字在页面底色上', snapCard: '卡片 — 带书名和作者', snapFolder: '快照保存到', copyImage: '复制图片', copyPageImage: '将页面复制为 PNG', copyFailed: '这里无法复制图片', savedTo: '已保存到 {f}', saveFailed: '无法保存图片', importButtonPlace: '“添加图书”按钮', invertLineArt: '深色页面上反转线稿', translateAhead: '预先翻译', translateAheadBody: '在后台翻译章节，打开时即已翻译（本书共 {n} 章）。', translatingAhead: '正在翻译… {n}/{total} 段', translateAheadDone: '完成 — 已翻译并保存 {n} 段。', translateAheadPartial: '已停止 — 已翻译 {n}/{total} 段，请重试剩余部分。', alreadyTranslated: '这里已全部翻译。', nextChapters: '接下来的章节（从本章起）', chapterRange: '从第…章到第…章', wholeBook: '整本书', translateWholeBook: '翻译整本书', brightnessMode: '亮度控制', brightnessApp: '应用内调暗（边缘滑动）', brightnessDevice: '设备亮度（不在应用内调暗）', browseModels: '浏览模型', noModelsFound: '此密钥没有可用模型。', aiModelHint: '输入模型名称，或浏览你的密钥可用的模型。', linkFiles: '保留文件原位置', linkFilesHint: '书库只记录位置，应用体积保持很小。文件被移动或删除后需要重新添加。', linkedFileMissing: '“{title}”的文件已不在原位置，请重新添加。',
  chapterReadDone: '本章结束。', speechScope: '朗读', speechChapter: '本章', speechBook: '直到全书结束', readings: '读音（假名 / 拼音）', noReadings: '所选内容中没有中文或日文。', autoReadings: '选中中文 / 日文时显示读音', favorites: '收藏', favorite: '收藏', unfavorite: '取消收藏', addedToFavorites: '已加入收藏', removedFromFavorites: '已取消收藏', appNameOnDevice: '本设备上的应用名称', appNameAuto: '跟随系统语言', appNameHint: '修改主屏幕图标下的名称；启动器可能需要片刻才会显示。', appNameChanged: '应用名称已更改', convertFile: '转换', pickAFile: '选择文件…', convertBody: '将“{title}”（{format}）转换为：', convertDone: '完成：{name} · {size}', convertFailed: '转换失败', convertUnsupported: '无法转换此格式。', conv_render: '正在读取图书…', conv_images: '正在收集图片…', conv_pdfPage: '正在读取页面…', conv_build: '正在生成文件…', conv_done: '完成', saveFile: '保存', addToLibrary: '加入书库', addedToLibrary: '已加入书库', sendToKindle: '发送到 Kindle', kindleHint: '分享到 Kindle 应用，或将文件发到你的 Send-to-Kindle 邮箱。Kindle 直接支持 EPUB，字体由设备决定。', pdfConvertHint: '根据 PDF 中定位的文字片段重建正文：按位置成行，阿拉伯文行从右到左，按间距分段，按字号识别标题；PDF 内嵌的字体会带入 EPUB。扫描版 PDF（只有图片）没有可转换的文字。', pdfImageHint: '手机上生成的 PDF 由页面图片组成（文字不可选）；桌面版会生成文字 PDF。', pdfPasswordPrompt: '此 PDF 受保护。密码：', pdfPasswordWrong: '密码错误，请重试：', importMode: '添加的文件', importLink: '保留原位置', importCopy: '复制到应用内', importModeHint: '保留原位置只存储文件位置，添加 25 本书也不会让应用增加几百 MB。被移动或删除的文件需要重新添加。', snapWatermark: '快照上显示应用名', resetThis: '恢复默认', importChips: '与文件夹并列', importTop: '顶栏', importFab: '底部悬浮', statusUnread: '未读', statusReading: '在读', statusFinished: '读完', keepAwake: '阅读时保持屏幕常亮', volumeKeys: '用音量键翻页', exportNotes: '导出高亮和笔记', notesFile: 'notes', brightness: '亮度', edgeBrightness: '在左边缘滑动调暗页面', pinchText: '双指缩放改变字号', speechRate: '朗读速度', speechVoice: '声音', voiceDefault: '系统默认', openLastOnLaunch: '启动时打开上次的书', coverSize: '封面大小', coverSmall: '小', coverMedium: '中', coverLarge: '大', backup: '备份', backupBody: '设置、文件夹、书签、高亮、笔记和阅读进度。完整备份还包含图书文件。', backupNotes: '备份设置和笔记', backupFull: '完整备份（含图书）', restore: '从备份恢复', restored: '已恢复 {n} 项', restoreFailed: '无法读取该备份', presetClassic: '经典', presetLargePrint: '大字', presetCompact: '紧凑', presetFocus: '专注', presetMushaf: '手稿页面', sleepTimer: '睡眠定时', sleepTimerOff: '取消睡眠定时', sleepTimerSet: '{n} 后停止', sleepTimerDone: '睡眠定时：已停止', minutes: '{n} 分钟', pdfPinchZoom: 'PDF：双指缩放', pdfPageNumbers: 'PDF：在页面上显示页码', aiTranslate: 'AI 章节翻译', aiTranslateBody: '用 AI 模型翻译正在阅读的章节，按段落随滚动翻译。译文按书保存，开关即时切换。', aiNeedsKey: '请先添加 API 密钥', aiProvider: '服务商', aiModel: '模型', aiBaseUrl: 'API 地址（自建服务）', aiPrompt: '给译者的指示', resetPrompt: '默认指示', getKey: '获取密钥', translatorOn: '已翻译', translatorOff: '原文', translatedCount: '已翻译 {n}/{total}', retranslate: '重新翻译本章', clearTranslationCache: '清除已保存的译文', customize: '自定义', aiVoice: 'AI 语音', speechEngine: '朗读引擎', speechSystem: '设备语音', speechAi: 'AI 语音 (API)', aiTtsModel: '语音模型', toolbarButtons: '工具栏按钮', toolbarButtonsBody: '选择悬浮工具栏显示哪些按钮以及顺序。', moveUp: '上移', moveDown: '下移', systemFontsPick: '系统字体', systemFontsBody: '可以直接使用本电脑已安装的字体。', browseFonts: '在线查找字体', openAs: '打开为…', openAsFont: '字体（加入我的字体）', openAsFontsZip: '字体（其中所有 TTF/OTF）', openAsBook: '图书 / 漫画', fontsAdded: '已添加 {n} 个字体', selectTextFirst: '请先选中文字', separator: '分隔线', aiSection: 'AI 翻译与语音', aiSetup: '服务商、密钥、模型、指示', browseFontsBody: '在浏览器中下载字体（TTF/OTF/WOFF2 或其 ZIP），然后用黑川阅读器打开或在此添加。', skipVersion: '跳过此版本', versionSkipped: '不再提示版本 {v}', notes: '笔记', noNotes: '还没有笔记 — 选中文字后选择“笔记”。', editNote: '编辑笔记', noPdfNotes: '此文档没有笔记 — 选中文字或长按某处即可添加。', pdfNoteStyle: 'PDF 笔记样式', pinBadge: '编号气泡', pinIcon: '笔记图标', pinDot: '小圆点', allNotes: '书签与笔记', noNotesAnywhere: '所有书的书签和笔记会汇集在这里。', itemsCount: '{n} 项', updateNow: '更新', defaultApps: '设为 PDF、EPUB 等的默认应用', defaultAppsBody: 'Windows 在设置中选择默认应用；这里会打开该页面。', aiTask: 'AI 的任务', aiTaskTranslate: '翻译章节', aiTaskFurigana: '为日文加注假名', aiPromptHint: '留空或不修改即使用所选语言的内置指示。可在其下方添加你的偏好。', aiPromptPrefill: '在框中显示内置指示', insertDefaultPrompt: '插入内置指示', furigana: '在文字上方显示读音（日文假名、中文拼音）', pinyinOffline: '拼音需要一次性下载词典（约 2 MB）；请联网后重新打开本书。', noFileForPlatform: '发布中没有适合本设备的文件', chooseFile: '选择其他文件', cancelled: '已取消', furiganaOffline: '假名需要一次性下载日语词典（约 6 MB）；请联网后重新打开本书。', furiganaBody: '日文读音在设备上生成；词典只需下载一次（约 6 MB）。', pickColor: '选择颜色', highlightColors: '高亮颜色', savePagesRange: '将页面存为 PNG…', savePagesBody: '输入页码或范围（如 1-5, 8）。单页保存为 PNG，多页打包为 ZIP。', pagesSelected: '{n} 页', thisPage: '本页', allPages: '全部页面', pagesFile: '{n} 页', searchSettings: '搜索设置', shortcutsEditBody: '点击组合键后按下新的按键（Esc 取消）。', pressNewShortcut: '更改快捷键', pressKeys: '请按键…', syncNeedsAppKey: '请先输入 Dropbox 应用密钥', syncConnected: '已连接 — 正在同步', syncNotConnected: '尚未设置同步', sync: '账户与同步', syncBody: '让阅读进度、书签、高亮、笔记和文件夹在每台设备上保持一致。数据保存在你自己的存储中。', syncProvider: '同步到', syncNone: '关闭', syncDropbox: 'Dropbox', syncWebdav: 'WebDAV（Nextcloud、坚果云、Box…）', syncFolderOpt: '本电脑上的文件夹（Google Drive / OneDrive / Dropbox 文件夹）', syncAuto: '自动同步（启动时、恢复联网时、阅读后）', syncNow: '立即同步', syncing: '正在同步…', syncDone: '同步完成 · 更新了 {n} 本书', syncFailed: '同步失败', syncLast: '上次同步：{d}', syncNever: '从未同步', syncDisconnect: '断开连接', syncConnect: '连接', syncDropboxKey: 'Dropbox 应用密钥', syncDropboxHelp: '在 dropbox.com/developers 创建免费应用（Scoped access · App folder），添加此重定向 URI，并粘贴其 App key：', syncWebdavUrl: 'WebDAV 文件夹地址', syncUser: '用户名', syncPass: '密码 / 应用密码', syncPickFolder: '选择文件夹', syncAsk: '你在离线时阅读了 — 现在同步吗？', syncAskBody: '本设备上的更改还没有同步到你的其他设备。', later: '稍后', allowInstallHint: '在打开的页面中允许黑川阅读器安装更新，然后返回。', installNotAllowed: '尚未允许此应用安装更新（设置 → 安装未知应用）。', imageShade: '调暗图片', imageSaturation: '图片色彩', imageFit: '图片填充', fitCover: '填满', fitContain: '适应', fitTile: '平铺', imagePosition: '图片位置', posTop: '顶部', posCenter: '居中', posBottom: '底部', restoreConfirm: '将此备份恢复到书库？现有的书、笔记和设置会合并，而不是被替换。', clearFilters: '清除筛选', filterFormats: '格式', scanDevice: '扫描本设备上的文件夹', scanBody: '选择一个文件夹，列出其中所有可读文件。选择要添加的内容和位置。', wholeDevice: '整个设备', storageDenied: '扫描整个设备需要“所有文件访问”权限。请授权后重试，或选择一个文件夹。', pickFolder: '选择文件夹', scanning: '正在扫描…', found: '找到 {n} 个', importSelected: '添加所选', importAll: '全部添加', destination: '添加到', destinationNone: '书库', destinationNew: '新建文件夹…', nothingFound: '该文件夹中没有可读文件', notSupportedHere: '此平台上不可用', alreadyInLibrary: '已在书库中',
  ankiDeck: 'Anki 卡组',
  ankiBrowse: '浏览卡片',
  ankiOptions: '卡组选项',
  ankiNew: '新卡',
  ankiLearning: '学习中',
  ankiReview: '复习',
  ankiDoneToday: '恭喜 — 这个卡组暂时学完了。',
  ankiStudy: '开始学习',
  ankiSubdeck: '子卡组',
  ankiTotal: '{n} 张卡片',
  ankiStudied: '已学 {n} 张',
  ankiMature: '已掌握 {n} 张',
  ankiShowAnswer: '显示答案',
  ankiAgain: '重来',
  ankiHard: '困难',
  ankiGood: '良好',
  ankiEasy: '简单',
  ankiPreview: '卡片',
  ankiForget: '重置这张卡',
  ankiReset: '卡片已重置为新卡',
  ankiNewPerDay: '每日新卡数',
  ankiAutoplay: '自动播放音频',
  ankiOptionsHint: '学习步骤 1 分钟、10 分钟，之后按天（Anki 规则）。按键：空格显示答案，1–4 评分，R 重播音频。',
  ankiResetAll: '重置全部进度',
  ankiResetConfirm: '清除此卡组的全部学习进度？',
  play: '播放',
  sleepEndOfChapter: '本章结束时',
  audioError: '此设备无法播放这个音频文件。',
  starterDecks: '学习卡组',
  starterDecksBody: '用于学习日语和中文的可选 Anki 卡组。在你选择之前不会安装任何内容；优先从本应用的镜像获取，镜像不可用时再从作者的仓库获取。',
  deckDownload: '下载',
  kaishiBody: '1500 个基础日语词，含例句、音频和插图（约 104 MB）。',
  hskBody: '汉语 HSK 词汇（新 HSK 2025），含音频。',
  openInBrowser: '打开下载页面',
  downloadingDeck: '正在下载卡组… {p}%',
  audiobooks: '有声书',
  storageAppTotal: '应用占用 {size}',
  storageBooks: '{n} 本书：{linked} 本保留原位置，{copied} 本复制在应用内（{size}）',
  storageCache: '缓存 {size}',
  freeSpace: '释放空间',
  spaceFreed: '已释放 {size}',
  moveOut: '将 {n} 本复制的书移出应用（{size}）',
  movedOut: '已将 {n} 本书移出应用',
  deckMirror: '黑川阅读器镜像',
  deckSources: '来源',
  deckLicense: '许可',
  deckSourceMissing: '无法从 {source} 获取',
  deckTryingNext: '该来源失败 — 正在尝试下一个…',
  deckOpenedInBrowser: '已在浏览器中打开；下载完成后请添加该文件。',
  hskSentencesBody: '同一 HSK 卡组，附例句。',
  addBooks: '添加图书', addBooksNow: '现在就添加图书', tagExists: '已有同名标签', tagCreated: '已创建标签', addedToTag: '已将 {n} 本添加到“{name}”', emptyTagBody: '此标签为空。请从书库中添加图书。',
};
