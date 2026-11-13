### Fixes — the app closing by itself while reading
- **Books you had closed stayed in memory.** Every book opened kept its whole text and pictures after you left it, until the phone ran short and ended the app. A closed book is now let go of. (This had been so since the first version.)
- **Pictures, once shown, were never released.** Reading a book with many pictures took more and more memory, without end. Only the pictures near the screen are kept now; the others come back as you reach them, and the text does not move.
- **Android: when the page's engine fails, the reader restarts cleanly** and returns to your book. This now also covers the app's hidden pages (the in-app browser's, printing), any of which could close the whole app while you read; and it gives up after three failures in three minutes in place of restarting for ever.

### New — the Performance page says why a session ended
- Settings → About → Performance: an unexpected end now reads as one of — the page's engine was ended by the system (most likely for memory), the engine crashed, the app stopped responding, the app was ended for memory — with what memory stood at before. As before: times, counts and kinds only, nothing sent anywhere. If the app closes by itself again, "Copy report" is what to send.
