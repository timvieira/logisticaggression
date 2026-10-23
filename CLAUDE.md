# CLAUDE.md

Static copy of a PhotoMap album (Hanna's Instagram, @logisticaggression) with
in-browser CLIP search, published from `docs/` to
https://timvieira.github.io/logisticaggression/ by GitHub Pages. The repo is
public. Read `DEVELOPING.md` before changing code; it has the architecture,
data formats, tests and traps.

## Map

- `export_static.py`: builds `docs/` from PhotoMap's index. Run it with
  `~/photomap/bin/python`.
- `shim/pm-static.js`: stands in for PhotoMap's server in the browser.
  `shim/pm-static.css`: the site's look. `shim/pm-sw.js`: colored thumbnail
  frames.
- `docs/`: generated output. Never edit it by hand; re-export instead.
- `tests/`: puppeteer-core browser tests (`smoke.mjs`, `parity.mjs`,
  `screens.mjs`).
- Private, outside the repo, never to be committed: `../album/` (photos and
  PhotoMap index), `../exports/`, `../tools/`, `../reference/`.

## Commands

```
~/photomap/bin/python export_static.py --album hanna --out docs --max-size 1080 --quality 80
python3 -m http.server -d docs 8000                # preview at http://localhost:8000
cd tests && npm install && node smoke.mjs         # add --text to include text search
node tests/parity.mjs http://localhost:8000/ http://127.0.0.1:8051   # vs PhotoMap's server
```

## Rules

- Always export with `--max-size 1080 --quality 80`. Other values rebuild
  every photo and change the site's size (Pages caps it at 1 GB; it's about
  680 MB).
- After changing `shim/` or the exporter: re-export, run `smoke.mjs` on the
  preview, and look at `screens.mjs` output for style changes. Run
  `parity.mjs` after anything touching search, clustering or a PhotoMap
  upgrade.
- Keep the look consistent with DEVELOPING.md ("The look"). The user wants
  compact controls and no grid or ticks on the map.
- Publishing is a public push of personal photos. Claude Code's auto mode
  blocks Claude from doing it unprompted. Let the user run
  `git add -A docs shim export_static.py && git commit -m "…" && git push`
  (with `!` in the prompt), or run it when they explicitly ask. Pages
  updates about 1–2 minutes later; check the live site with `smoke.mjs`.
- Moving `../album` breaks PhotoMap's index (it stores absolute paths) and
  can reshuffle the map layout. See "Traps" in DEVELOPING.md.
