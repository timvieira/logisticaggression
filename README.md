# logisticaggression

Photos from Instagram's [@logisticaggression](https://www.instagram.com/logisticaggression/),
browsable as a semantic map with text search:
**https://timvieira.github.io/logisticaggression/**

The site is a static copy of a [PhotoMap](https://github.com/lstein/PhotoMapAI)
album. It keeps PhotoMap's interface: the semantic map with clusters, the
slideshow, grid view, bookmarks, and CLIP search (text, "By Image", and
uploaded photos), all running in the browser. No server is needed.

- `docs/`: the built site, served by GitHub Pages.
- `export_static.py`: builds `docs/` from the PhotoMap album.
- `shim/`: the browser code that stands in for PhotoMap's server.

## Update the site

1. Add the new photos to the PhotoMap album (for Instagram exports:
   `~/Downloads/photo-explorer/merge_instagram_export.py EXPORT.zip`).
2. Rebuild `docs/`. Only new or changed photos are processed:

       ~/photomap/bin/python export_static.py --album hanna --out docs --max-size 1080 --quality 80

3. Commit and push. GitHub Pages publishes the new version within a few
   minutes:

       git add -A docs && git commit -m "Update site" && git push

Photos larger than 1080 px are shrunk to 1080 px and saved at JPEG quality 80.
This keeps the site (about 680 MB) under GitHub Pages' 1 GB limit. Thumbnails
are 320 px WebP.

## Preview locally

    python3 -m http.server -d docs 8000

Then open http://localhost:8000. Opening `docs/index.html` directly from disk
does not work, because browsers block the data loading on `file://` pages.

## What works

- Everything PhotoMap's "album locked" mode offers for viewing: map,
  clusters (including the cluster strength setting), slideshow, grid, the info
  drawer, bookmarks (stored in each visitor's browser), and downloading
  bookmarked photos as a ZIP.
- Text search. The first search downloads the CLIP text model (127 MB, from
  Hugging Face); the browser caches it after that.
- Search by image. Album photos use their stored CLIP vectors, so results
  match PhotoMap exactly. An uploaded outside photo downloads the CLIP image
  model (176 MB) the first time.

Clusters and photo-to-photo search match the PhotoMap server exactly. Text
search returns the same photos as PhotoMap; photos whose scores differ by less
than 0.0001 can swap places, because the browser model runs at half precision.

Not available (they change files on disk): deleting, moving, curation, export
to a folder, album management, re-indexing.

The site is public: anyone with the link can view and download the photos. The
page asks search engines not to index it.

## How it works

- `export_static.py` reads the album through PhotoMap's own code (run it with
  PhotoMap's Python), copies the photos (HEIC is converted to JPEG), makes
  WebP thumbnails, and writes `data/` (slide list, map coordinates, CLIP
  vectors). It renders PhotoMap's page in album-locked mode and copies its
  scripts, rewriting the four places that build thumbnail URLs. Options:
  `--out`, `--max-size`, `--quality`, `--thumb-size`, `--title`, `--config`.
- `shim/pm-static.js` loads before PhotoMap's scripts and answers their server
  requests from `data/`: clustering (DBSCAN, same labels as scikit-learn), CLIP
  search with transformers.js, and ZIP downloads. `shim/pm-static.css` restyles
  the map controls.
- `shim/pm-sw.js` is a service worker that draws the cluster-colored frames
  around map thumbnails, which PhotoMap's server normally draws.
