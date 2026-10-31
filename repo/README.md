# Kurokawa add-on repository

The add-ons of the Kurokawa apps, fetched by the apps themselves (Settings → Add-ons, or a word typed in the + sheet):

- `reader/` — KurokawaReader's: web folders of books (manifests of kind `folder`).
- `tools/` — Kurokawa Tools': torrent search extensions, anime (AniList, AniChart, LiveChart), subtitle sources, debrid services, archives.

`index.json` lists the apps; each app's `index.json` lists its add-ons, parents with their children. Nothing here is installed until the reader asks for it.
