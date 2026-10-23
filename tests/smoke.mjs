// Smoke test for a running copy of the site (local preview or the live site).
//
//   node smoke.mjs [URL] [--text]
//
// URL defaults to http://localhost:8000/ (python3 -m http.server -d docs 8000).
// --text also runs a text search; the first run downloads the 127 MB CLIP
// text model into tests/.chrome-profile, later runs reuse it.
import { launch, waitForMap, api, dataUrlOf, checker, baseUrl, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const BASE = baseUrl(args.find((a) => !a.startsWith("--")));
const TEXT = args.includes("--text");
const { check, failures } = checker();

const { browser, page, errors } = await launch({ width: 1919, height: 943 });
try {
  await page.goto(BASE);
  const album = await page.evaluate(async () => (await fetch("data/album.json")).json());
  const key = album.key;
  console.log(`${BASE}  album "${album.name}", ${album.count} photos, exported ${album.exported_at}`);

  // --- map
  await waitForMap(page);
  const map = await page.evaluate(() => {
    const gd = document.getElementById("umapPlot");
    const images = gd.layout.images || [];
    return {
      ticks: gd.layout.xaxis.showticklabels, grid: gd.layout.xaxis.showgrid,
      landmarks: images.length, framed: images.filter((i) => String(i.source).includes("pm-thumb/")).length,
      plotShare: gd.getBoundingClientRect().height / innerHeight,
      inline: document.body.classList.contains("pm-controls-inline"),
      sw: !!navigator.serviceWorker?.controller,
      planes: !!document.querySelector("#pmPlanes svg"),
    };
  });
  check("map has no grid or tick labels", map.ticks === false && map.grid === false);
  check("map shows landmark thumbnails", map.landmarks > 0, `${map.landmarks}`);
  check("service worker draws the colored frames", map.sw && map.framed > 0, `${map.framed} framed`);
  check("fullscreen map uses most of the height", map.plotShare > 0.8, `${Math.round(map.plotShare * 100)}%`);
  check("map controls share the bottom row (wide screen)", map.inline);
  check("colored planes are on the page", map.planes);

  // --- routes the shim answers
  const meta = await api(page, `index_metadata/${key}`);
  check("index_metadata", meta.body.filename_count === album.count);
  const first = await api(page, `retrieve_image/${key}/0`);
  check("retrieve_image", first.status === 200 && first.body.index === 0 && !!first.body.image_url, first.body.filename);
  const umap = await api(page, `umap_data/${key}?cluster_eps=${album.umap_eps}`);
  const clusters = new Set(umap.body.map((p) => p.cluster)).size;
  check("umap_data clusters", umap.body.length === album.count && clusters > 1, `${clusters} clusters`);
  const del = await api(page, `delete_image/${key}/0`, {});
  check("changes are refused (read-only)", del.status === 403);

  // --- search by an album photo: should find itself first, with its stored vector
  const imageData = await dataUrlOf(page, first.body.image_url);
  const byImage = await api(page, `search_with_text_and_image/${key}`, {
    image_data: imageData, positive_query: "", negative_query: "",
    image_weight: 0.5, positive_weight: 0.5, negative_weight: 0.25, min_search_score: 0.2, max_search_results: 100,
  });
  const top = byImage.body.results?.[0];
  check("search by album photo finds itself", top?.index === 0 && top.score > 0.999, top && `score ${top.score.toFixed(4)}`);

  // --- bookmarks ZIP
  const zip = await page.evaluate(async (key) => {
    const r = await fetch(`download_images_zip/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indices: [0, 1] }) });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, magic: String.fromCharCode(b[0], b[1]), size: b.length };
  }, key);
  check("bookmarks ZIP download", zip.status === 200 && zip.magic === "PK", `${zip.size} bytes`);

  // --- text search (downloads the model on first use)
  if (TEXT) {
    const t0 = Date.now();
    const text = await api(page, `search_with_text_and_image/${key}`, {
      image_data: null, positive_query: "a bridge over a river", negative_query: "",
      image_weight: 0.5, positive_weight: 0.5, negative_weight: 0.25, min_search_score: 0.2, max_search_results: 100,
    });
    const n = text.body.results?.length || 0;
    check("text search", n > 0, `${n} results in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  await sleep(300);
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}
console.log(failures() ? `\n${failures()} check(s) failed` : "\nall checks passed");
process.exit(failures() ? 1 : 0);
