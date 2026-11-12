<!-- Collected for the next release (renamed to v<version>.md when it is cut). -->
### Fixes
- **No longer thrown out of a book.** A link inside a web novel's chapter, a Markdown or an HTML book (a translator's footnote mark, most often) closed the book when touched — also by a touch meant to turn the page. Such a link now goes to its place in the book, or does nothing.
- **Back in your book after a restart you did not ask for.** When the phone ends the app while you read (memory), the book reopens at your place on the next start. On Android, a failure of the page's engine restarts the reader in place of closing the app, and changing the system font size or screen zoom no longer restarts it.

### Faster
- **Long text books open about five to eight times faster** and take far less memory (a 4.7 MB text: about 12 s → under 2 s on a slowed phone imitation).
- **EPUBs with many chapters open up to twice as fast.**
- **Long PDFs** no longer read every page when opened.

### New
- **Performance page** (Settings → About → Performance). The app keeps a small record on your device of start-up time, how long books take to open, slow moments, how each session ended and why a book was left — times, counts and kinds only: no titles, file names or text, and nothing is sent anywhere. "Copy report" gives it as text you can send when something is slow or a book closes by itself.
- **Volume buttons turn pages** (Android; Reader settings → Behaviour; off by default), with **Swap direction**. They work only while a book is open and nothing is playing: during read-aloud or music, and everywhere outside a book, they change the volume as usual. Holding a button keeps turning. (An earlier form of this setting took the buttons everywhere in the app and only scrolled.)
- **Back twice to leave a book** (off by default): the first Back closes what is open, the next shows a reminder, and a second within two seconds leaves. The arrow at the top always leaves at once.
- **Page-turn swipes protected at the screen edges** (Android, on by default, in the chapter modes): a swipe along the middle of the left or right edge changes the chapter in place of being taken as Back. Back still works from the top and bottom of the edge.
- Space and Page Up/Down now carry on into the next or previous chapter in "Chapter by chapter" mode too.
- **The reading bar shows what you choose.** Page in the chapter «١٢ / ٣٤», pages left in the chapter, the chapter's and the book's percentage, page and pages left in the book, time left in the chapter and in the book, clock, battery, chapter name, book title — each switched on or off, placed at the start, middle or end, in the order you want (Visual options → Show the reading bar). It stays hidden until you switch it on; "Show / hide the reading bar" is in the More menu and can be set as a tap-zone action.
- **The reading bar in immersive mode**: its own switch — keep it while the other bars are hidden, or hide it with them.
- A page is one screen of text at your font and size; the count follows font, margin and rotation changes. For a book of several chapters, "page in the book" is an estimate, marked «≈».

### Fixes (reading bar)
- **Text no longer sits under the toolbar or the reading bar**; and showing or hiding the bars no longer moves the text.
- In Arabic the bar's numbers, percentage and clock are written the Arabic way («٤:٤٤ م», «١٥٪»).

### New — place the reader's buttons as you like
- **Customise buttons** (More → Customise buttons, or Reader options → Reader buttons). Every action of the reader — contents, search, bookmark, translate, glossary, read aloud, day/night, full screen and the rest; the PDF reader's too — can be put at the start or end of the top bar, on the toolbar, in the More menu, or hidden; and ordered within its place. Separate layouts for books and for PDFs; "Reset to default" brings back today's layout.
- **The toolbar itself** can sit at the bottom, at the top, or along either side, floating or docked to the edge. Text always ends clear of it.
- What does not fit a bar on a narrow screen moves into More by itself, and comes back when there is room.
- The back arrow, More and "Customise buttons" stay where they are, so the way out of a book and back to this page is never lost. A hidden action still answers its keyboard shortcut and its tap zone.
- The More menu no longer repeats what is already on the bars.
