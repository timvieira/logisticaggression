// Compares the static site's answers with PhotoMap's own server, route by
// route. Run it after upgrading PhotoMap or changing the shim.
//
//   ~/photomap/bin/start_photomap --port 8051 --album-locked hanna --once &
//   python3 -m http.server -d docs 8000 &
//   node parity.mjs http://localhost:8000/ http://127.0.0.1:8051
//
// Expected: everything matches exactly except text searches, where photos
// whose scores differ by under ~1e-4 may swap places (the browser's CLIP text
// model runs at half precision). The first run downloads the text and image
// models (127 + 176 MB) into tests/.chrome-profile.
import { launch, api, dataUrlOf, checker, baseUrl, sleep } from "./lib.mjs";

const STATIC = baseUrl(process.argv[2]);
const LIVE = (process.argv[3] || "http://127.0.0.1:8051").replace(/\/$/, "");
const { check, failures } = checker();

const live = async (path, body) => {
  const r = await fetch(`${LIVE}/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
};

const { browser, page } = await launch();
try {
  await page.goto(STATIC);
  await sleep(3000);
  const album = await page.evaluate(async () => (await fetch("data/album.json")).json());
  const key = album.key, n = album.count;

  const lm = await live(`index_metadata/${key}`);
  check("index_metadata count", lm.body.filename_count === n, `${lm.body.filename_count} vs ${n}`);

  for (const i of [0, 5, Math.floor(n / 2), n - 1]) {
    const a = (await live(`retrieve_image/${key}/${i}`)).body, b = (await api(page, `retrieve_image/${key}/${i}`)).body;
    const same = ["filename", "description", "index", "total"].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
      && a.filepath.endsWith("/" + b.filepath);
    check(`retrieve_image ${i}`, same);
    const ia = (await live(`image_info/${key}/${i}`)).body, ib = (await api(page, `image_info/${key}/${i}`)).body;
    check(`image_info ${i}`, ia.last_modified === ib.last_modified && ia.image_path.endsWith("/" + ib.image_path));
  }

  for (const eps of [0.05, 0.1, 0.2, 0.35]) {
    const a = (await live(`umap_data/${key}?cluster_eps=${eps}`)).body, b = (await api(page, `umap_data/${key}?cluster_eps=${eps}`)).body;
    const same = a.length === b.length && a.every((p, k) => p.x === b[k].x && p.y === b[k].y && p.index === b[k].index && p.cluster === b[k].cluster);
    check(`umap_data eps=${eps}`, same, `${new Set(a.map((p) => p.cluster)).size} clusters`);
  }

  const base = { negative_query: "", image_data: null, image_weight: 0.5, positive_weight: 0.5, negative_weight: 0.25, min_search_score: 0.2, max_search_results: 100 };
  const compare = (name, a, b, exact) => {
    const ai = a.results.map((r) => r.index), bi = b.results.map((r) => r.index);
    const same = ai.length === bi.length && ai.every((v, k) => v === bi[k]);
    const overlap = ai.filter((v) => bi.includes(v)).length;
    const shift = Math.max(0, ...ai.map((v, k) => (bi.includes(v) ? Math.abs(bi.indexOf(v) - k) : 999)));
    const maxd = Math.max(0, ...a.results.map((r, k) => (b.results[k] ? Math.abs(r.score - b.results[k].score) : 1)));
    const ok = exact ? same : overlap >= Math.min(ai.length, bi.length) - 2 && shift <= 3;
    check(name, ok, `${ai.length} vs ${bi.length} results, same order: ${same}, max rank shift ${shift}, max score diff ${maxd.toExponential(1)}`);
  };

  for (const [q, neg] of [["a bridge over a river", ""], ["birthday cake", ""], ["snow", "people"]]) {
    const req = { ...base, positive_query: q, negative_query: neg };
    compare(`text "${q}"${neg ? ` minus "${neg}"` : ""}`, (await live(`search_with_text_and_image/${key}`, req)).body,
      (await api(page, `search_with_text_and_image/${key}`, req)).body, false);
  }

  // An album photo (exact: both sides use the stored vector) and an outside
  // image made in the page by cropping that photo (both sides run CLIP on it).
  const first = (await api(page, `retrieve_image/${key}/0`)).body;
  const albumPhoto = await dataUrlOf(page, first.image_url);
  const outside = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = 400; c.height = 300;
    c.getContext("2d").drawImage(img, img.width * 0.1, img.height * 0.2, img.width * 0.7, img.height * 0.5, 0, 0, 400, 300);
    return c.toDataURL("image/png");
  }, first.image_url);
  for (const [name, image_data, exact] of [["album photo", albumPhoto, true], ["outside image", outside, false]]) {
    const req = { ...base, image_data, positive_query: "" };
    compare(`image search: ${name}`, (await live(`search_with_text_and_image/${key}`, req)).body,
      (await api(page, `search_with_text_and_image/${key}`, req)).body, exact);
  }
} finally {
  await browser.close();
}
console.log(failures() ? `\n${failures()} check(s) failed` : "\nall checks passed");
process.exit(failures() ? 1 : 0);
