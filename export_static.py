#!/usr/bin/env python3
"""Export a PhotoMap album as a static website.

Run it with PhotoMap's own Python, so it can reuse PhotoMap's index code:

    ~/photomap/bin/python ~/Downloads/photomap-static/export_static.py --album hanna

Preview the result (any plain static file server works):

    python3 -m http.server -d ~/Downloads/photomap-static/site-hanna 8000
    # then open http://localhost:8000

Re-run it after the album's index changes. Unchanged photos are skipped.

How it works: the page is PhotoMap's own interface, rendered in "album locked"
mode. A small script (shim/pm-static.js) answers the page's server requests
from the exported data files, and runs clustering and CLIP search in the browser.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHIM_DIR = HERE / "shim"

# Formats every major browser can display as-is.
BROWSER_FORMATS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
PIL_SAVE_FORMAT = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}

# Bump when the per-image output format changes, to force regeneration.
MEDIA_VERSION = 1


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--album", help="album key from PhotoMap's config (default: the first album)")
    p.add_argument("--config", help="PhotoMap config file (default: ~/.config/photomap/config.yaml)")
    p.add_argument("--out", help="output folder (default: site-<album> next to this script)")
    p.add_argument("--thumb-size", type=int, default=320, help="thumbnail size in pixels (default: 320)")
    p.add_argument("--max-size", type=int, default=0,
                   help="shrink photos larger than this many pixels on their long side (default: keep originals)")
    p.add_argument("--quality", type=int, default=88, help="JPEG/WebP quality for converted photos (default: 88)")
    p.add_argument("--title", help="page title (default: the album name)")
    p.add_argument("--jobs", type=int, default=os.cpu_count() or 4, help="parallel image workers")
    return p.parse_args()


# ---------------------------------------------------------------- image work


def file_key(path):
    """CRC32 + byte length. The browser computes the same key to recognize album photos."""
    crc = 0
    size = 0
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            crc = zlib.crc32(chunk, crc)
            size += len(chunk)
    return f"{crc:08x}-{size}"


def process_image(task):
    """Write the web copy and thumbnail for one photo. Runs in a worker process."""
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        pass

    src, media_out, thumb_out, thumb_size, max_size, quality, do_media, do_thumb = task
    src, media_out, thumb_out = Path(src), Path(media_out), Path(thumb_out)
    try:
        if do_media:
            media_out.parent.mkdir(parents=True, exist_ok=True)
            ext = src.suffix.lower()
            convert = ext not in BROWSER_FORMATS
            if not convert and max_size:
                with Image.open(src) as im:
                    convert = max(im.size) > max_size and not getattr(im, "is_animated", False)
            if convert:
                with Image.open(src) as im:
                    im = ImageOps.exif_transpose(im)
                    if max_size:
                        im.thumbnail((max_size, max_size), Image.LANCZOS)
                    fmt = PIL_SAVE_FORMAT.get(media_out.suffix.lower(), "JPEG")
                    if fmt == "JPEG":
                        im = im.convert("RGB")
                        im.save(media_out, "JPEG", quality=quality, progressive=True, optimize=True)
                    elif fmt == "WEBP":
                        im.save(media_out, "WEBP", quality=quality, method=4)
                    else:
                        im.save(media_out, fmt)
            else:
                shutil.copy2(src, media_out)
        if do_thumb:
            thumb_out.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im)
                im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
                im.thumbnail((thumb_size, thumb_size), Image.LANCZOS)
                im.save(thumb_out, "WEBP", quality=80, method=4)
        return {"src_key": file_key(src), "media_key": file_key(media_out), "thumb_key": file_key(thumb_out)}
    except Exception as e:  # keep going; report at the end
        return {"error": f"{src}: {e}"}


def media_name(relpath, max_size):
    """Output path (relative to media/) for a photo."""
    ext = Path(relpath).suffix.lower()
    if ext not in BROWSER_FORMATS:
        return relpath + ".jpg"  # e.g. IMG_1.heic -> IMG_1.heic.jpg (never collides with IMG_1.jpg)
    return relpath


def url_path(path):
    return urllib.parse.quote(path, safe="/")


# ---------------------------------------------------------------- page


THUMB_URL_RE = re.compile(
    r"`thumbnails/\$\{state\.album\}/\$\{\s*([\w.\[\]]+)\s*\}"
    r"\?size=(?:\$\{\s*([\w.]+)\s*\}|(\d+))"
    r"(?:&color=\$\{encodeURIComponent\(\s*([\w.]+)\s*\)\})?`"
)


def patch_thumbnail_urls(js_dir):
    """Route PhotoMap's thumbnail URLs through window.pmThumb (defined in pm-static.js)."""
    total = 0
    for js in sorted(js_dir.glob("*.js")):
        text = js.read_text()

        def repl(m):
            idx, size_expr, size_lit, color = m.groups()
            args = [idx, size_expr or size_lit] + ([color] if color else [])
            return f"window.pmThumb({', '.join(args)})"

        new, n = THUMB_URL_RE.subn(repl, text)
        if n:
            js.write_text(new)
            total += n
        if "thumbnails/" in new:
            sys.exit(f"error: {js.name} still builds a thumbnails/ URL the export doesn't know how to patch")
    if total == 0:
        sys.exit("error: found no thumbnail URLs to patch; PhotoMap's frontend has changed")
    return total


def render_page(frontend, album_key, version, title):
    from jinja2 import Environment, FileSystemLoader

    env = Environment(loader=FileSystemLoader(str(frontend / "templates")), autoescape=True)
    html = env.get_template("main.html").render(
        album=album_key,
        delay=0,
        mode=None,
        highWaterMark=None,
        version=version,
        album_locked=True,
        inline_upgrades_allowed=False,
    )
    module_tag = '<script type="module" src="static/main.js"></script>'
    if module_tag not in html:
        sys.exit("error: main.html no longer loads static/main.js; PhotoMap's frontend has changed")
    shim_tags = (
        '<meta name="robots" content="noindex, nofollow" />\n'
        '    <link rel="stylesheet" href="pm-static/pm-static.css" />\n'
        '    <script src="pm-static/pm-static.js"></script>\n'
        f"    {module_tag}"
    )
    html = html.replace(module_tag, shim_tags)
    html = re.sub(r'(<title id="slideshow_title">)[^<]*(</title>)', lambda m: m.group(1) + escape_html(title) + m.group(2), html)
    return html


def escape_html(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ---------------------------------------------------------------- main


def main():
    args = parse_args()
    if args.config:
        os.environ["PHOTOMAP_CONFIG"] = str(Path(args.config).expanduser().resolve())

    import numpy as np
    import photomap
    from photomap.backend.args import get_version
    from photomap.backend.config import get_config_manager
    from photomap.backend.embeddings import Embeddings
    from photomap.backend.metadata_formatting import format_metadata

    cm = get_config_manager()
    albums = cm.get_albums() or {}
    if not albums:
        sys.exit("error: no albums in PhotoMap's config")
    key = args.album or next(iter(albums))
    album = cm.get_album(key)
    if album is None:
        sys.exit(f"error: no album '{key}'. Albums: {', '.join(albums)}")

    out = Path(args.out).expanduser().resolve() if args.out else HERE / f"site-{key}"
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print(f"Exporting album '{key}' ({album.name}) to {out}")

    # --- index data, via PhotoMap's own loaders
    emb = Embeddings(embeddings_path=Path(album.index))
    data = emb.open_cached_embeddings(emb.embeddings_path)
    filenames = data["filenames"]  # index (file) order
    sorted_filenames = data["sorted_filenames"]  # date order: what the UI calls "index"
    filename_map = data["filename_map"]
    n = len(sorted_filenames)
    if len(filename_map) != len(filenames):
        sys.exit("error: the index lists some files twice; rebuild the index in PhotoMap first")
    umap_xy = np.asarray(emb.umap_embeddings, dtype=np.float32)  # recomputed by PhotoMap if stale
    if umap_xy.shape[0] != len(filenames):
        sys.exit("error: the map layout is out of date; open the album in PhotoMap once to rebuild it")
    to_sorted = np.array([filename_map[f] for f in filenames], dtype=np.int64)
    print(f"  {n} photos in the index")

    roots = [Path(p).resolve() for p in album.image_paths]

    def relpath_of(path):
        p = Path(path)
        for k, root in enumerate(roots):
            try:
                rel = p.relative_to(root).as_posix()
            except ValueError:
                continue
            return rel if len(roots) == 1 else f"{k}/{rel}"
        return "other/" + p.name

    # --- photos and thumbnails (incremental)
    manifest_path = out / ".export-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {}
    opts = {"v": MEDIA_VERSION, "thumb": args.thumb_size, "max": args.max_size, "q": args.quality}
    if manifest.get("opts") != opts:
        manifest = {"opts": opts, "files": {}}
    old_files = manifest["files"]
    new_files = {}

    items = []
    tasks = []
    for i in range(n):
        src = Path(str(sorted_filenames[i]))
        rel = relpath_of(src)
        media_rel = "media/" + media_name(rel, args.max_size)
        thumb_rel = "thumbs/" + rel + ".webp"
        try:
            st = src.stat()
        except OSError:
            print(f"  warning: missing photo {src}")
            st = None
        sig = [st.st_size, st.st_mtime_ns] if st else None
        prev = old_files.get(rel)
        entry = {"sig": sig, "media": media_rel, "thumb": thumb_rel}
        do_media = do_thumb = st is not None
        if prev and prev.get("sig") == sig and prev.get("media") == media_rel and "src_key" in prev:
            do_media = not (out / media_rel).exists()
            do_thumb = not (out / thumb_rel).exists()
            entry.update({k: prev[k] for k in ("src_key", "media_key", "thumb_key") if k in prev})
        if do_media or do_thumb:
            tasks.append((i, (str(src), str(out / media_rel), str(out / thumb_rel), args.thumb_size,
                              args.max_size, args.quality, do_media, do_thumb)))
        new_files[rel] = entry
        items.append((i, src, rel, media_rel, thumb_rel))

    errors = []
    if tasks:
        print(f"  writing {len(tasks)} photos/thumbnails with {args.jobs} workers...")
        rel_of_index = {i: rel for i, _, rel, _, _ in items}
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for done, ((i, _), res) in enumerate(zip(tasks, pool.map(process_image, [t for _, t in tasks], chunksize=8)), 1):
                if "error" in res:
                    errors.append(res["error"])
                else:
                    new_files[rel_of_index[i]].update(res)
                if done % 250 == 0 or done == len(tasks):
                    print(f"    {done}/{len(tasks)}")
    else:
        print("  photos and thumbnails are up to date")

    # Fill in keys missing from older manifests.
    for i, src, rel, media_rel, thumb_rel in items:
        e = new_files[rel]
        for k, path in (("src_key", src), ("media_key", out / media_rel), ("thumb_key", out / thumb_rel)):
            if k not in e and Path(path).is_file():
                e[k] = file_key(path)

    # Remove outputs for photos that left the index.
    keep = {e["media"] for e in new_files.values()} | {e["thumb"] for e in new_files.values()}
    removed = 0
    for rel, e in old_files.items():
        for path in (e.get("media"), e.get("thumb")):
            if path and path not in keep and (path.startswith("media/") or path.startswith("thumbs/")):
                target = out / path
                if target.is_file():
                    target.unlink()
                    removed += 1
    if removed:
        print(f"  removed {removed} files for photos no longer in the album")

    # --- data files
    data_dir = out / "data"
    shutil.rmtree(data_dir, ignore_errors=True)
    (data_dir / "metadata").mkdir(parents=True)

    descriptions, desc_ids, slides, keys = [], {}, [], {}
    sorted_mtimes = data["sorted_modification_times"]
    sorted_metadata = data["sorted_metadata"]
    for i, src, rel, media_rel, thumb_rel in items:
        meta = sorted_metadata[i] if isinstance(sorted_metadata[i], dict) else {}
        summary = format_metadata(src, meta, i, n)
        d = summary.description or ""
        if d not in desc_ids:
            desc_ids[d] = len(descriptions)
            descriptions.append(d)
        slide = {"p": rel, "m": url_path(media_rel), "t": url_path(thumb_rel), "d": desc_ids[d],
                 "mt": float(sorted_mtimes[i])}
        if meta:
            (data_dir / "metadata" / f"{i}.json").write_text(json.dumps(meta, indent=2, default=str))
            slide["md"] = f"data/metadata/{i}.json"
        if summary.reference_images:
            slide["r"] = list(summary.reference_images)
        slides.append(slide)
        e = new_files[rel]
        for k in (e.get("src_key"), e.get("media_key"), e.get("thumb_key")):
            if k:
                keys[k] = i

    write_json(data_dir / "slides.json", {"descriptions": descriptions, "slides": slides})
    write_json(data_dir / "keys.json", keys)
    write_json(data_dir / "umap.json", {
        # File order, as PhotoMap's server clusters it; "index" is the date-order index.
        "x": [float(v) for v in umap_xy[:, 0]],
        "y": [float(v) for v in umap_xy[:, 1]],
        "index": [int(v) for v in to_sorted],
    })
    vectors = np.empty_like(data["embeddings"], dtype=np.float32)
    vectors[to_sorted] = data["embeddings"]  # date order, raw (not normalized), like PhotoMap
    (data_dir / "embeddings.f32").write_bytes(vectors.astype("<f4").tobytes())

    version = get_version()
    title = args.title or album.name or key
    write_json(data_dir / "album.json", {
        "key": key,
        "name": album.name,
        "description": album.description or "",
        "umap_eps": float(album.umap_eps),
        "count": n,
        "dim": int(vectors.shape[1]),
        "last_modified": Path(album.index).stat().st_mtime,
        "photomap_version": version,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "title": title,
    })

    # --- page and scripts
    frontend = Path(photomap.__file__).parent / "frontend"
    shutil.rmtree(out / "static", ignore_errors=True)
    shutil.copytree(frontend / "static", out / "static")
    patched = patch_thumbnail_urls(out / "static" / "javascript")
    (out / "index.html").write_text(render_page(frontend, key, version, title))
    shutil.rmtree(out / "pm-static", ignore_errors=True)
    (out / "pm-static").mkdir()
    for f in ("pm-static.js", "pm-static.css"):
        shutil.copy2(SHIM_DIR / f, out / "pm-static" / f)
    shutil.copy2(SHIM_DIR / "pm-sw.js", out / "pm-sw.js")  # must sit at the site root
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n")
    (out / ".nojekyll").write_text("")  # GitHub Pages: serve files as-is, skip Jekyll

    manifest_path.write_text(json.dumps({"opts": opts, "files": new_files}))

    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"  patched {patched} thumbnail URLs in PhotoMap's scripts")
    print(f"Done in {time.time() - t0:.0f}s. Site size: {size / 1e6:.0f} MB")
    if errors:
        print(f"{len(errors)} photos failed:")
        for e in errors[:20]:
            print("  " + e)
    print(f"\nPreview:  python3 -m http.server -d '{out}' 8000   then open http://localhost:8000")


def write_json(path, obj):
    path.write_text(json.dumps(obj, separators=(",", ":")))


if __name__ == "__main__":
    main()
