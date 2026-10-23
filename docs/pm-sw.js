// pm-sw.js: draws the cluster-colored thumbnail frames on the semantic map.
//
// PhotoMap's server draws these on request (thumbnails/...?color=...). This
// service worker answers pm-thumb/<index>?size=&color= the same way: shrink to
// fit `size`, add a border max(5, size/32) px wide, round the corners, PNG.
// It must sit at the site root so its scope covers pm-thumb/.

const ROOT = new URL("./", self.location.href);
let slidesP = null;
const cache = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname + "pm-thumb/")) return;
  event.respondWith(framedThumb(url));
});

async function framedThumb(url) {
  const index = parseInt(url.pathname.slice((ROOT.pathname + "pm-thumb/").length), 10);
  slidesP ||= fetch(new URL("data/slides.json", ROOT)).then((r) => r.json());
  const slide = (await slidesP).slides[index];
  if (!slide) return new Response("Not found", { status: 404 });
  const thumbUrl = new URL(slide.t, ROOT);
  const key = `${index}${url.search}`;
  try {
    if (!cache.has(key)) cache.set(key, draw(thumbUrl, url.searchParams));
    const blob = await cache.get(key);
    return new Response(blob, { headers: { "Content-Type": "image/png", "Cache-Control": "max-age=3600" } });
  } catch (e) {
    cache.delete(key);
    return fetch(thumbUrl); // plain thumbnail rather than nothing
  }
}

async function draw(thumbUrl, params) {
  const size = Math.max(16, Math.min(1024, parseInt(params.get("size"), 10) || 256));
  const color = params.get("color") || "#000000";
  const radius = params.has("radius") ? parseInt(params.get("radius"), 10) : 12;
  const r = await fetch(thumbUrl);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const border = Math.max(5, Math.floor(size / 32));
  const W = w + 2 * border, H = h + 2 * border;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, W, H, radius);
  else ctx.rect(0, 0, W, H);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, border, border, w, h);
  return canvas.convertToBlob({ type: "image/png" });
}
