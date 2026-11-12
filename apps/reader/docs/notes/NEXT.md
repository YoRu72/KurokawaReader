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
