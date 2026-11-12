# Kurokawa Reader — performance plan (all platforms)

Written 2026-11-12. Reported by the owner on a Samsung phone, Android 17: lag, and the reader sometimes closing by itself.
Rule: one piece at a time, each measured before and after, tested and released before the next.

## 0. What can and cannot be measured here
- Here: a phone imitated in a desktop browser engine (phone screen size, touch, processor slowed 4× and 6×, memory capped), and desktop size at full speed. Good for finding what the app itself does badly.
- Not here: a real Samsung, its web view, its memory and battery management, its gesture navigation. Those need the owner's phone.
- So each piece ends with a short list of what to try on the phone, and **piece P0 adds a way for the phone to report back**.

## P0 — See what the phone sees (first)
- A hidden "Performance" page in Settings → About: start-up time, time to open the last book, slowest screen updates, memory in use, web view version, device. One button copies it as text to send.
- A small local record of the last few sessions: how each ended (closed by the user, sent to the background, reloaded unexpectedly) and what was open. Stays on the device; nothing is sent anywhere.
- With that, "it threw me out" and "it lags" become numbers and a cause, not a guess.

## P1 — Never thrown out of a book (running now)
- Every path that can close the reader without the user asking is traced: the system Back gesture at the screen edge during a page turn, the web view being killed for memory or restarted on rotation / fold / theme change, a background sync or backup re-drawing the screen, a sheet closing and stepping back twice, an error sending the app home.
- Whatever the cause: after any reload the app did not ask for, it returns to the same book at the same place.
- Back inside the reader first closes what is open (sheet, toolbar); a Back that arrives in the same instant as an edge page-turn is ignored.

## P2 — Start-up
- Load at start only what the library screen needs; everything else (PDF engine, converter, translator, editors, sources) loads when first opened.
- First screen drawn from saved data at once; covers, sync, update check and clean-ups wait until the screen is usable.
- Budget kept as a test: size of the first load; nothing heavy loaded before it is needed.

## P3 — Library
- Draw only the books on screen (thousands of books cost the same as fifty); covers decoded at thumbnail size, only when near the screen.
- Search, filters and sorting without re-drawing the whole list on each key press.
- Budget: screen elements and decoded covers for a 2,000-book library under a ceiling.

## P4 — Reading ordinary books (EPUB, text, web novels)
- Open: show the reading place first; highlights, search index, typography and furigana passes after, in idle time.
- Long chapters: sections off screen skipped by the browser's own mechanism; no work on every scroll event; position saved without blocking the scroll.
- Page turns: animation on the compositor only (no layout during the turn).
- Fonts: only the faces in use loaded.

## P5 — Reading PDFs
- Open: first page shown without touching every page of the file; page sizes learned as pages are met.
- Scrolling and zooming: only pages near the screen kept; rendered at the size needed; old pages released; text layer built only when needed (selection, search).
- Memory: a fixed ceiling on rendered pages, lower on devices with little memory.

## P6 — Background work
- Sync, auto-backup, downloads of chapters, translation ahead, statistics: never on the path of a touch; batched; paused while the user is turning pages; none of them re-draws the reader.
- Database writes grouped; nothing large read whole when a part is enough.

## P7 — Heavy tools (converter, translator, PDF tools)
- Converter memory is already cut (0.60.23). Next: its remaining double reading of each page; lanes chosen from the phone's real memory once P0 reports it.
- All heavy work off the main thread where the platform allows, with honest progress and a clear message on failure.

## P8 — Desktop (Windows, macOS, Linux) and iPhone
- Desktop: start-up of the shell, window show before load completes, same library and reader gains as above; large libraries and large PDFs measured at full speed.
- iPhone/iPad: same web code, so the same gains; its web view's memory limit is stricter — the PDF and converter ceilings follow it.

## P9 — Android shell
- Web view settings checked for speed (hardware layers, no needless redraw on keyboard / bars), rotation and fold handled without reloading the page, renderer loss handled by restoring instead of a blank or a restart at the library.
- Samsung: note in Settings on excluding the app from "sleeping apps" if P0 shows background kills.

## Order
P1 (running) → P0 → P2 → P3 → P4 → P5 → P6 → P9 → P7 → P8. P0's report from the owner's phone may reorder what follows.
The two new reading features (volume-button page turning; pages in chapter on the reading bar, bar hidden by default) are separate pieces placed after P1/P0.

## Proof for each piece
Before → after numbers (imitated phone at 4× and 6×, and desktop), a budget test that fails on the old code, the full suite, then the owner's phone check.
