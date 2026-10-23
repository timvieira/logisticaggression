# Developing the site

How the static site is built, how it stands in for PhotoMap's server, how to
test it, and the traps found so far. `README.md` covers everyday use.

## The pieces

```
PhotoMap album + index  ──export_static.py──▶  docs/  ──git push──▶  GitHub Pages
(../album, PhotoMap venv)                      (static files)        timvieira.github.io/logisticaggression
```

- [PhotoMap](https://github.com/lstein/PhotoMapAI) (PhotoMapAI 1.0.1, in the
  venv `~/photomap`) indexes the photos: CLIP ViT-B/32 vectors, a UMAP layout,
  dates. Its config is `~/.config/photomap/config.yaml`; the album key is
  `hanna`.
- `export_static.py` reads the index through PhotoMap's own Python code and
  writes a self-contained site to `docs/`.
- In the browser, PhotoMap's unmodified page and scripts run on top of
  `shim/pm-static.js`, which answers their server requests from `docs/data/`.

This working copy sits in `~/projects/logisticaggression/site/`. Its parent
folder holds private material that must never be committed: `../album/`
(PhotoMap's album: the merged Instagram export and the index), `../exports/`
(raw Instagram exports), `../tools/merge_instagram_export.py`, and
`../reference/` (the print the colors come from).

**Never edit files under `docs/` by hand.** Every export regenerates them.
Change `shim/` or `export_static.py`, then re-export.

## Everyday commands

Run these from this folder.

| Task | Command |
|---|---|
| Rebuild `docs/` (incremental) | `~/photomap/bin/python export_static.py --album hanna --out docs --max-size 1080 --quality 80` |
| Preview | `python3 -m http.server -d docs 8000`, then open http://localhost:8000 |
| Smoke test | `cd tests && npm install && node smoke.mjs [URL] [--text]` |
| Screenshots | `node tests/screens.mjs [URL]`, which writes to `tests/screens/` |
| Compare with PhotoMap | see "Tests" below |
| Run PhotoMap itself | `~/photomap/bin/start_photomap`, then open http://127.0.0.1:8050 |
| Publish | `git add -A docs shim export_static.py && git commit -m "…" && git push` |

Always pass `--max-size 1080 --quality 80`. Different values rebuild every
photo, about 2.5 minutes, and change the site's size. Unchanged photos are
skipped through `docs/.export-manifest.json` (gitignored, keyed by path, size
and mtime). A fresh clone rebuilds everything once. Bump `MEDIA_VERSION` in
the exporter to force a rebuild after changing how photos are written.

Adding posts from a new Instagram export:
`~/photomap/bin/python ../tools/merge_instagram_export.py EXPORT.zip`, then
export, test and publish.

## What the export writes

| Path | Contents |
|---|---|
| `index.html` | PhotoMap's `main.html` rendered in album-locked mode, with injected tags: robots `noindex`, the Crimson Pro font, `pm-static/pm-static.css`, and `pm-static/pm-static.js` before `static/main.js` |
| `static/` | PhotoMap's frontend, copied, with the patches listed below |
| `pm-static/` | the shim's JS and CSS, copied from `shim/` |
| `pm-sw.js` | service worker; must sit at the site root so its scope covers `pm-thumb/` |
| `media/<rel>` | photos. Browser formats are copied as-is, or shrunk to 1080 px at JPEG q80 if larger. Other formats (HEIC) become `<rel>.jpg` |
| `thumbs/<rel>.webp` | 320 px WebP thumbnails |
| `data/album.json` | key, name, description, umap_eps, count, dim, last_modified, photomap_version, exported_at, title |
| `data/slides.json` | `{descriptions, slides}`. Slides are in date order, each `{p: path in album, m: media URL, t: thumb URL, d: description id, mt: mtime, md?: metadata URL, r?: reference images}` |
| `data/umap.json` | `{x, y, index}` in index-file order; `index` maps to date order |
| `data/keys.json` | `"crc32hex-bytelength"` → date-order index, for the original file, the media copy and the thumbnail |
| `data/embeddings.f32` | raw (unnormalized) CLIP vectors, float32 little-endian, count × 512, date order |
| `data/metadata/<i>.json` | per-photo metadata, only where PhotoMap has some (none for this album) |
| `.nojekyll`, `robots.txt` | serve files as-is on Pages; ask crawlers to stay out |

**Two orders.** PhotoMap's index file stores photos in file order. The UI's
"index" is date order (argsort of modification times). `umap_data` answers in
file order with date-order indices, like the server; everything else uses date
order.

**Frontend patches.** The exporter makes three kinds of edit to PhotoMap's
copied scripts. Each stops the export with an error if the text it expects
is missing, which is what a PhotoMap upgrade will trip:
1. Four thumbnail URL template strings (`thumbnails/${album}/${i}?size=…&color=…`,
   in `umap.js` and `grid-view.js`) become `window.pmThumb(i, size[, color])`.
2. `CLUSTER_PALETTE` and `UNCLUSTERED_COLOR` in `cluster-utils.js` get the
   site's colors.
3. `const controlsHeight = 230;` in `umap.js` (space the fullscreen map
   leaves under the plot) becomes a call to `window.pmMapReserve()`.

## How the shim works (`shim/pm-static.js`)

It replaces `window.fetch`. Same-origin requests under the site folder are
matched against a route table; anything unmatched goes to the network.

| Route | Answer |
|---|---|
| `version/check`, `available_albums`, `album/{k}`, `index_exists`, `index_metadata` | built from `album.json` |
| `get_umap_eps`, `set_umap_eps` | cluster strength, kept in `localStorage` (`pmStatic.umapEps.<path>`) |
| `retrieve_image`, `image_info`, `image_path`, `get_metadata` | from `slides.json` |
| `umap_data?cluster_eps=` | DBSCAN (min_samples 10) on the UMAP points, cached per eps |
| `search_with_text_and_image` | CLIP search, described below |
| `download_images_zip` | a stored (uncompressed) ZIP built in the browser |
| anything that changes files (`delete_image`, `move_images`, `update_index_async`, curation, album edits, …) | 403 with a "read-only copy" message |

- **Clusters.** The DBSCAN port reproduces scikit-learn's labels exactly:
  same point order, same `<= eps²` test, same expansion order. Neighbors come
  from a grid search.
- **Search.** The query is `w_img·img + w_pos·text − w_neg·negtext` over raw
  vectors, normalized, scored by cosine against normalized photo vectors, top
  k, then filtered by min score. Same as PhotoMap.
- **Album photos as queries.** The shim hashes the image bytes (CRC32 +
  length). If `keys.json` has the key, it uses the stored vector, so results
  match PhotoMap exactly. Keys are also learned at runtime from `media/` and
  `thumbs/` responses.
- **Outside images** run the CLIP vision model in the browser. Preprocessing
  ports Pillow's bicubic resize, torchvision's `Resize(224)` (int truncation)
  and `CenterCrop` (round half to even), so vectors match PhotoMap's.
- **Text** uses transformers.js 4.3.1 with `Xenova/clip-vit-base-patch32`.
  - Load the bundled build `dist/transformers.min.js`.
    `transformers.web.min.js` fails on bare `onnxruntime-web` imports.
  - Use fp16: 127 MB for the text model, 176 MB for vision. fp16 returns the
    same photos as PhotoMap. q8 (64 MB) changed about a third of the top 20.
  - The text model starts downloading when the search panel opens. A toast
    shows progress, counting only the `.onnx` files.
- **Thumbnails.** `window.pmThumb` returns the static WebP. For map landmarks
  it returns `pm-thumb/<i>?size&color`, which `shim/pm-sw.js` draws: fit to
  size, border `max(5, size/32)`, rounded corners, PNG. This needs a secure
  context (https or localhost); without the service worker, landmarks have no
  colored frame.
- **Housekeeping.** Curate and Export are removed from the bookmarks menu,
  since they need the server. `polishMapControls` shortens the map control
  labels.
- **Look.**
  - A `Plotly.newPlot` wrapper drops the map's grid and tick labels and
    restyles the current-photo marker.
  - `pmMapReserve` sizes the fullscreen map. On wide screens the map controls
    move into the row between the Control and Search panels (CSS class
    `pm-controls-inline`).
  - A ResizeObserver re-runs that layout when PhotoMap fills in the controls
    late.
  - The SVG planes are inserted behind the slideshow.

## The look

The style comes from a print Hanna loves (`../reference/hanna-print.jpg`, kept
private because it's someone's artwork): translucent yellow, pink and blue
planes that darken where they overlap, around a white middle, with one small
line of serif text.

- **Paper stage.** The slideshow background is `--pm-paper #efefec`. Photos
  sit on it with a soft drop shadow, like prints.
- **Planes.** An SVG in `pm-static.js` (`PLANES`), stretched to the window and
  blended with `mix-blend-mode: multiply`, hugs the window edges; the photo
  covers the middle. This is the one bold element; keep the rest quiet.
- **Ink for anything floating.** The map, the Control/Search panels, dialogs,
  the search panel and menus use `--pm-ink #22212a` with light text.
- **Accents** come from the print: lemon `#f5e45a` for "on" states, plus rose,
  sky, violet, ember and sea. The 16-color cluster palette lives in
  `export_static.py`.
- **Type.** Crimson Pro from Google Fonts.
- **Compact chrome.** The user cares about this. The panels are slim strips,
  the fullscreen map gets about 86% of the height on a 1920×943 window, and
  on phones both panels share one icon row. The map shows no grid, ticks or
  axis labels, since the coordinates mean nothing.
- Every color is a CSS variable at the top of `shim/pm-static.css`.
  PhotoMap sets many styles inline, hence the `!important`s.

## Tests (`tests/`)

Headless Chrome through puppeteer-core. They expect Chrome at
`/usr/bin/google-chrome`; set `CHROME=…` otherwise. Install once with
`cd tests && npm install`. `tests/.chrome-profile/` caches the CLIP models
between runs.

- `smoke.mjs [URL] [--text]` checks a running copy: the map (no grid,
  landmarks, framed thumbnails, height share), the shim's routes, read-only
  refusals, search by an album photo (must find itself at score 1.0), the ZIP
  download, and optionally text search. Run it on the local preview before
  pushing and on the live site after.
- `parity.mjs STATIC_URL PHOTOMAP_URL` compares route by route with
  PhotoMap's own server. Run it after upgrading PhotoMap or touching search
  or clustering:

      ~/photomap/bin/start_photomap --port 8051 --album-locked hanna --once &
      python3 -m http.server -d docs 8000 &
      node tests/parity.mjs http://localhost:8000/ http://127.0.0.1:8051

  Metadata, clusters and album-photo search must match exactly. Text and
  outside-image searches may swap near-ties (score differences under ~2e-4).
- `screens.mjs [URL]` takes screenshots at 1919×943, 1366×768 and phone
  size. Look at them after any style change.

## Hosting

- GitHub Pages serves `main:/docs` (legacy branch build, about 1–2 minutes
  after a push). Pages caps sites at 1 GB, and the site is about 680 MB, so
  watch the size as posts are added. `--thumb-size` and `--quality` are the
  levers.
- Pages sends `Cache-Control: max-age=600`, so browsers can show the old
  version for up to 10 minutes. Use a hard refresh.
- The repo is public, so the photos are too. Keep everything under `../album`
  and `../exports` out of it.

## Traps

- **PhotoMap's index stores absolute photo paths**, and PhotoMap recomputes
  the UMAP layout, which comes out different every time, whenever
  `embeddings.npz` is newer than `umap.npz`. If the album moves, rewrite the
  `filenames` array in `embeddings.npz`, update the config, and keep
  `umap.npz` newer. The published layout can be restored from
  `docs/data/umap.json` (`x`, `y` are in file order).
- **Local PhotoMap patch.** `minimum_image_size` in PhotoMap's
  `backend/embeddings.py` is lowered from 100 KB to 5 KB, because about 500
  of the photos are smaller. Upgrading PhotoMap undoes it. The merge script
  checks and stops.
- **Upgrading PhotoMap.** Re-export, which shows whether the frontend patches
  still apply. Then run `parity.mjs` and `screens.mjs`.
- **`file://` doesn't work.** Browsers block the data loading; use a server.
- **Firefox is untested.** Only Chrome has been tested.
- **Claude Code permissions.** In auto mode, Claude may not create or push to
  this repo or change Pages settings on its own (the photos are someone's
  personal data). It can when the user explicitly asks for the exact command,
  or the user runs it with `!` in the prompt.

## Known issues and ideas

- A visitor's first text search downloads 127 MB (about 15–25 s). Search by
  an outside image downloads 176 MB.
- On phones the map controls take three rows. Shorter labels on narrow
  screens would save one.
- In PhotoMap's non-fullscreen map sizes on short windows, the controls can
  fall below the window (PhotoMap's own layout).
- A report that "some controls disappear in fullscreen" was not reproduced
  (2026-10-23).
