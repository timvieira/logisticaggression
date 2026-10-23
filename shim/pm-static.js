// pm-static.js: lets PhotoMap's own interface run without its server.
//
// PhotoMap's page talks to its Python server with fetch(). This script loads
// before the page's modules and replaces window.fetch: requests for server
// endpoints are answered from the exported data/ files, and the parts that need
// computation (map clustering, CLIP search, ZIP downloads) run here in the browser.
// Everything else goes to the network unchanged.
(() => {
  "use strict";

  // Same OpenAI ViT-B/32 CLIP weights PhotoMap uses, converted to ONNX.
  // Half precision gives the same search results as PhotoMap; 8-bit does not.
  const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
  const MODEL_ID = "Xenova/clip-vit-base-patch32";
  const MODEL_DTYPE = "fp16";
  const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
  const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
  const READ_ONLY = "This is a read-only copy of PhotoMap; that feature needs the PhotoMap server.";

  const realFetch = window.fetch.bind(window);
  const siteRoot = new URL(".", document.baseURI); // folder that holds index.html

  // ------------------------------------------------------------------ data

  const getJSON = async (path) => {
    const r = await realFetch(new URL(path, siteRoot));
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };

  let SLIDES = null; // set once data/slides.json has loaded (pmThumb needs it synchronously)
  const core = Promise.all([getJSON("data/album.json"), getJSON("data/slides.json")]).then(([album, s]) => {
    SLIDES = s.slides;
    return { album, slides: s.slides, descriptions: s.descriptions };
  });
  core.catch((e) => console.error("[pm-static] could not load the album data:", e));

  let umapP, keysP, vectorsP;
  const umapPoints = () => (umapP ||= getJSON("data/umap.json"));
  const fileKeys = () => (keysP ||= getJSON("data/keys.json").then((o) => new Map(Object.entries(o))));
  const vectors = () => (vectorsP ||= loadVectors());

  async function loadVectors() {
    const { album } = await core;
    const r = await realFetch(new URL("data/embeddings.f32", siteRoot));
    if (!r.ok) throw new Error(`data/embeddings.f32: HTTP ${r.status}`);
    const raw = new Float32Array(await r.arrayBuffer()); // little-endian, like every browser
    const n = album.count, dim = album.dim;
    const unit = new Float32Array(raw.length);
    for (let row = 0; row < n; row++) {
      const o = row * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += raw[o + k] * raw[o + k];
      const inv = 1 / Math.max(Math.sqrt(s), 1e-12);
      for (let k = 0; k < dim; k++) unit[o + k] = raw[o + k] * inv;
    }
    return { n, dim, raw, unit };
  }

  // Settings the real server would store in its config file.
  const epsKey = () => `pmStatic.umapEps.${location.pathname}`;
  function storedEps(fallback) {
    try {
      const v = parseFloat(localStorage.getItem(epsKey()));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    } catch { return fallback; }
  }

  // ------------------------------------------------------------------ routes

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const text = (s) => new Response(s, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const parse = (body) => (typeof body === "string" && body ? JSON.parse(body) : {});

  async function albumInfo() {
    const { album } = await core;
    return {
      key: album.key, name: album.name, description: album.description,
      image_paths: [], index: "", umap_eps: storedEps(album.umap_eps),
    };
  }

  async function slideAt(i) {
    const c = await core;
    const s = c.slides[i];
    if (!s) throw Object.assign(new Error("Index out of range"), { status: 404 });
    return { c, s };
  }

  const routes = [
    ["GET", /^version\/check$/, async () => {
      const { album } = await core;
      const v = album.photomap_version;
      return json({ current_version: v, latest_version: v, update_available: false });
    }],
    ["GET", /^available_albums\/?$/, async () => json([await albumInfo()])],
    ["GET", /^album\/[^/]+\/?$/, async () => json(await albumInfo())],
    ["GET", /^index_exists\/[^/]+$/, async () => json({ exists: true })],
    ["GET", /^index_metadata\/[^/]+$/, async () => {
      const { album } = await core;
      return json({ filename_count: album.count, embeddings_path: "", last_modified: album.last_modified });
    }],
    ["POST", /^get_umap_eps\/?$/, async () => json({ success: true, eps: (await albumInfo()).umap_eps })],
    ["POST", /^set_umap_eps\/?$/, async (url, body) => {
      const eps = parseFloat(parse(body).eps);
      try { localStorage.setItem(epsKey(), String(eps)); } catch {}
      return json({ success: true, eps });
    }],
    ["GET", /^retrieve_image\/[^/]+\/(\d+)$/, async (url, body, m) => {
      const i = +m[1];
      const { c, s } = await slideAt(i);
      return json({
        filename: basename(s.p), filepath: s.p, description: c.descriptions[s.d],
        image_url: s.m, metadata_url: s.md || "", index: i, total: c.album.count,
        reference_images: s.r || [],
      });
    }],
    ["GET", /^image_info\/([^/]+)\/(\d+)$/, async (url, body, m) => {
      const i = +m[2];
      const { s } = await slideAt(i);
      return json({ image_path: s.p, last_modified: s.mt, album_key: m[1], index: i });
    }],
    ["GET", /^image_path\/[^/]+\/(\d+)$/, async (url, body, m) => text((await slideAt(+m[1])).s.p)],
    ["GET", /^get_metadata\/[^/]+\/(\d+)$/, async (url, body, m) => {
      const { s } = await slideAt(+m[1]);
      return s.md ? realFetch(new URL(s.md, siteRoot)) : json({});
    }],
    ["GET", /^umap_data\/[^/]+$/, async (url) => {
      const { album } = await core;
      const q = url.searchParams;
      const eps = q.has("cluster_eps") ? parseFloat(q.get("cluster_eps")) : storedEps(album.umap_eps);
      const minSamples = q.has("cluster_min_samples") ? parseInt(q.get("cluster_min_samples"), 10) : 10;
      return json(await umapData(eps, minSamples));
    }],
    ["POST", /^search_with_text_and_image\/[^/]+$/, async (url, body) => json(await search(parse(body)))],
    ["POST", /^download_images_zip\/[^/]+$/, async (url, body) => zipResponse(parse(body).indices || [])],
    ["GET", /^locationiq_key\/?$/, async () => json({ has_key: false, key: "" })],
    ["*", /^(update_index_async|index_progress|remove_index|cancel_index|delete_image|move_images|copy_images|add_album|update_album|delete_album|filetree|version\/update|version\/restart|api\/curation|locationiq_key)\b/,
      async () => json({ detail: READ_ONLY }, 403)],
  ];

  function route(method, path) {
    for (const [m, re, fn] of routes) {
      if (m !== "*" && m !== method) continue;
      const match = path.match(re);
      if (match) return (url, body) => fn(url, body, match);
    }
    return null;
  }

  window.fetch = async function (input, init = {}) {
    const req = input instanceof Request ? input : null;
    let url;
    try { url = new URL(req ? req.url : String(input), document.baseURI); } catch { return realFetch(input, init); }
    if (url.origin === siteRoot.origin && url.pathname.startsWith(siteRoot.pathname)) {
      const path = decodeURIComponent(url.pathname.slice(siteRoot.pathname.length));
      const method = (init.method || (req && req.method) || "GET").toUpperCase();
      const handler = route(method, path);
      if (handler) {
        try {
          let body = init.body;
          if (body === undefined && req) body = await req.clone().text();
          return await handler(url, body);
        } catch (e) {
          console.error(`[pm-static] ${method} ${path}:`, e);
          return json({ detail: String((e && e.message) || e) }, e.status || 500);
        }
      }
      if (path.startsWith("media/") || path.startsWith("thumbs/")) return learnFileKey(url, realFetch(input, init));
    }
    return realFetch(input, init);
  };

  const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

  // ------------------------------------------------------------------ thumbnails

  // PhotoMap's scripts are patched to call this instead of building thumbnails/ URLs.
  // Plain thumbnails are static files. Map landmarks get a cluster-colored frame,
  // drawn by the service worker (pm-sw.js) like PhotoMap's server does.
  window.pmThumb = (index, size, color) => {
    const s = SLIDES && SLIDES[index];
    if (!s) return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=";
    const thumb = new URL(s.t, siteRoot).href;
    if (color && navigator.serviceWorker && navigator.serviceWorker.controller) {
      return new URL(`pm-thumb/${index}?size=${size}&color=${encodeURIComponent(color)}`, siteRoot).href;
    }
    return thumb;
  };

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL("pm-sw.js", siteRoot)).catch((e) =>
      console.info("[pm-static] service worker unavailable; map thumbnails will have no colored frames.", e));
  }

  // ------------------------------------------------------------------ server-only menu items

  // PhotoMap's locked mode already disables Move and Delete. Curate and Export
  // also need the server (they write files on disk), so drop them from the
  // bookmarks menu here.
  const SERVER_ONLY_ITEMS = new Set(["Curate", "Export"]);
  new MutationObserver((records) => {
    for (const rec of records) for (const node of rec.addedNodes) {
      if (node.id !== "bookmarkActionsMenu") continue;
      for (const btn of node.querySelectorAll("button")) {
        if (SERVER_ONLY_ITEMS.has(btn.textContent.trim())) btn.remove();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ------------------------------------------------------------------ map controls

  // Shorter labels for the compact control row (styled in pm-static.css).
  // Only text and one link move; PhotoMap's handlers stay attached by id.
  function polishMapControls() {
    const labelOf = (id) => document.getElementById(id)?.closest("label");
    const setText = (label, text) => {
      if (!label) return;
      for (const node of label.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) { node.textContent = text; return; }
      }
    };
    setText(document.querySelector('label[for="umapEpsSpinner"]'), "Cluster strength");
    setText(labelOf("umapClickSelectsClusterRadio"), "Cluster");
    setText(labelOf("umapClickSelectsImageRadio"), "Image");
    const click = document.getElementById("umapClickBehaviorContainer");
    if (click && !click.parentNode.querySelector(".pm-group-label")) {
      const span = document.createElement("span");
      span.className = "pm-group-label";
      span.textContent = "Click selects";
      click.before(span);
    }
    setText(labelOf("umapShowLandmarks"), "Landmarks");
    setText(labelOf("umapShowHoverThumbnails"), "Hover thumbnails");
    const highlight = labelOf("umapHighlightSelection");
    const clear = document.getElementById("umapClearSelectionLink");
    if (highlight && clear && highlight.contains(clear)) {
      highlight.after(clear);
      clear.textContent = "Clear";
      clear.classList.add("pm-clear-link");
      const span = highlight.querySelector("span");
      if (span) span.textContent = "Highlight selection";
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", polishMapControls);
  else polishMapControls();

  // ------------------------------------------------------------------ look

  // The site's look comes from a print Hanna likes: translucent yellow, pink
  // and blue planes that darken where they overlap, around a white middle.
  // Colors live in pm-static.css; the cluster palette is patched into
  // cluster-utils.js by the exporter.
  const INK = "#22212a";

  // Map: the coordinates mean nothing, so no grid, ticks or axis labels.
  // The current photo gets a white marker, since yellow is a cluster color now.
  if (window.Plotly) {
    const newPlot = Plotly.newPlot.bind(Plotly);
    Plotly.newPlot = (div, data, layout = {}, config) => {
      const id = typeof div === "string" ? div : div?.id;
      if (id === "umapPlot") {
        const bare = { showgrid: false, zeroline: false, showticklabels: false, showline: false, ticks: "" };
        layout.xaxis = { ...layout.xaxis, ...bare };
        layout.yaxis = { ...layout.yaxis, ...bare };
        layout.margin = { t: 6, r: 6, b: 6, l: 6, pad: 0 };
        layout.modebar = { bgcolor: "rgba(0,0,0,0)", color: "#8f8d9c", activecolor: "#f5e45a" };
        for (const trace of data || []) {
          if (trace.name === "Current Image") {
            trace.marker = { ...trace.marker, color: "#ffffff", size: 15, line: { color: INK, width: 3 } };
          }
        }
      }
      return newPlot(div, data, layout, config);
    };
  }

  // Fullscreen map: umap.js asks how much height to leave for the title bar,
  // the map controls and the Control/Search panels (PhotoMap leaves 230 px).
  // When the map controls fit between the two panels, they share that band.
  window.pmMapReserve = () => {
    const body = document.body;
    const rect = (id) => document.getElementById(id)?.getBoundingClientRect();
    const title = document.getElementById("umapTitlebar")?.offsetHeight || 40;
    // Measured at the full window width: PhotoMap calls this before it widens the window.
    const controlsH = () => {
      const c = document.getElementById("umapControls");
      if (!c) return 44;
      const saved = c.style.width;
      c.style.width = window.innerWidth - 8 + "px";
      const h = c.offsetHeight;
      c.style.width = saved;
      return h + 8;
    };
    if (window.innerWidth <= 600) {
      // Phones: the map window stops just above the row of panel icons, and
      // its controls sit under the plot (pm-static.css undoes PhotoMap's
      // overlay positioning).
      body.classList.remove("pm-controls-inline");
      const stack = rect("panelStackContainer");
      const bandTop = stack?.height ? stack.top : window.innerHeight - 60;
      document.documentElement.style.setProperty("--pm-phone-map-height", Math.round(bandTop - 6) + "px");
      return Math.ceil(window.innerHeight - bandTop + 6 + title + 14 + controlsH());
    }
    const cp = rect("controlPanel"), sp = rect("searchPanel");
    const panelH = Math.max(cp?.height || 0, sp?.height || 0);
    const bottom = cp ? window.innerHeight - cp.bottom : 12;
    const band = panelH ? panelH + bottom + 10 : 16;
    const row = document.querySelector("#umapControls > div");
    let inline = false;
    if (row && cp?.width && sp?.width) {
      row.classList.add("pm-measure");
      const need = row.offsetWidth;
      row.classList.remove("pm-measure");
      inline = need + 48 <= sp.left - cp.right;
    }
    body.classList.toggle("pm-controls-inline", inline);
    document.documentElement.style.setProperty("--pm-band-bottom", bottom + "px");
    document.documentElement.style.setProperty("--pm-band-height", panelH + "px");
    return title + 10 + (inline ? 0 : controlsH()) + band;
  };

  // PhotoMap fills in parts of the control row after it sizes the map (and
  // the web font can arrive late), so redo the fullscreen layout whenever
  // the row changes size. PhotoMap's own resize handler does the work.
  function watchMapControls() {
    const controls = document.getElementById("umapControls");
    if (!controls || !window.ResizeObserver) return;
    let last = "", queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const r = controls.getBoundingClientRect();
        const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
        const full = document.getElementById("umapResizeFullscreen")?.classList.contains("active");
        if (size !== last && last && full) window.dispatchEvent(new Event("resize"));
        last = size;
      });
    }).observe(controls);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchMapControls);
  else watchMapControls();

  // The planes behind the slideshow. Drawn in a 1000 x 1000 box stretched
  // to the window, so they hug the edges at any shape; the photo covers the
  // middle. Each plane multiplies with what's under it, like ink.
  const PLANES = `
<svg viewBox="0 0 1000 1000" preserveAspectRatio="none" focusable="false">
  <defs>
    <filter id="pmSoft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
    <linearGradient id="pmPinkFade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#ec8db4"/><stop offset=".7" stop-color="#f4b9d0"/><stop offset="1" stop-color="#f4b9d0" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="pmSkyFade" x1="1" x2="0" y1="0" y2="0">
      <stop offset="0" stop-color="#3f9fe0"/><stop offset=".75" stop-color="#7cc0ec"/><stop offset="1" stop-color="#7cc0ec" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <polygon class="p-lemon" points="190,0 820,0 772,92 545,122 330,66"/>
  <polygon class="p-ember" points="78,0 215,0 152,186 106,258"/>
  <polygon class="p-ink"   points="0,64 70,44 44,176 0,300"/>
  <polygon class="p-fade"  fill="url(#pmPinkFade)" filter="url(#pmSoft)" points="0,108 142,40 186,520 122,1000 0,1000"/>
  <polygon class="p-lemon" points="0,772 176,744 232,1000 0,1000"/>
  <polygon class="p-ember" points="0,882 36,872 50,1000 0,1000"/>
  <polygon class="p-lemon" points="214,956 430,966 446,1000 200,1000"/>
  <polygon class="p-ember" points="768,0 906,0 842,228 760,300"/>
  <polygon class="p-sea"   points="872,0 1000,0 1000,252 906,322 846,148"/>
  <polygon class="p-fade"  fill="url(#pmSkyFade)" filter="url(#pmSoft)" points="1000,168 1000,1000 736,1000 816,690 880,402"/>
  <polygon class="p-sky"   points="540,962 744,890 792,1000 514,1000"/>
  <polygon class="p-violet" points="1000,648 1000,1000 806,1000 884,804"/>
  <polygon class="p-ink"   points="962,372 1000,360 1000,1000 942,1000 954,668"/>
</svg>`;
  function addPlanes() {
    if (document.getElementById("pmPlanes")) return;
    const div = document.createElement("div");
    div.id = "pmPlanes";
    div.setAttribute("aria-hidden", "true");
    div.innerHTML = PLANES;
    document.body.prepend(div);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addPlanes);
  else addPlanes();

  // ------------------------------------------------------------------ map clusters

  // DBSCAN, matching scikit-learn's labels exactly (same point order, same
  // tie handling), so clusters and their colors match the PhotoMap server.
  const umapCache = new Map();
  async function umapData(eps, minSamples) {
    const key = `${eps}|${minSamples}`;
    if (!umapCache.has(key)) {
      const pts = await umapPoints();
      const labels = dbscan(pts.x, pts.y, eps, minSamples);
      umapCache.set(key, pts.x.map((x, i) => ({ x, y: pts.y[i], index: pts.index[i], cluster: labels[i] })));
    }
    return umapCache.get(key);
  }

  function dbscan(xs, ys, eps, minSamples) {
    const n = xs.length, r2 = eps * eps, cell = eps > 0 ? eps : 1;
    const grid = new Map();
    const cx = new Float64Array(n), cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      cx[i] = Math.floor(xs[i] / cell); cy[i] = Math.floor(ys[i] / cell);
      const k = cx[i] + "," + cy[i];
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const neighbors = new Array(n);
    for (let i = 0; i < n; i++) {
      const list = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get((cx[i] + dx) + "," + (cy[i] + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          const ddx = xs[i] - xs[j], ddy = ys[i] - ys[j];
          if (ddx * ddx + ddy * ddy <= r2) list.push(j);
        }
      }
      neighbors[i] = list;
    }
    const isCore = neighbors.map((l) => l.length >= minSamples);
    const labels = new Array(n).fill(-1);
    let label = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== -1 || !isCore[i]) continue;
      const stack = [i];
      while (stack.length) {
        const p = stack.pop();
        if (labels[p] !== -1) continue;
        labels[p] = label;
        if (isCore[p]) for (const q of neighbors[p]) if (labels[q] === -1) stack.push(q);
      }
      label++;
    }
    return labels;
  }

  // ------------------------------------------------------------------ search

  // Same scoring as PhotoMap's search_images_by_text_and_image: a weighted sum
  // of raw CLIP vectors (image + positive text - negative text), normalized,
  // then cosine similarity against every photo.
  async function search(req) {
    let wImg = num(req.image_weight, 0.5), wPos = num(req.positive_weight, 0.5), wNeg = num(req.negative_weight, 0.5);
    const pos = (req.positive_query || "").trim() ? req.positive_query : "";
    const neg = (req.negative_query || "").trim() ? req.negative_query : "";
    if (!req.image_data) wImg = 0;
    if (!pos) wPos = 0;
    if (!neg) wNeg = 0;
    if (wImg === 0 && wPos === 0 && wNeg === 0) return { results: [] };

    const [V, img, p, q] = await Promise.all([
      vectors(),
      wImg > 0 ? imageVector(req.image_data) : null,
      wPos > 0 ? textVector(pos) : null,
      wNeg > 0 ? textVector(neg) : null,
    ]);
    const dim = V.dim, query = new Float64Array(dim);
    for (let k = 0; k < dim; k++) {
      query[k] = (img ? wImg * img[k] : 0) + (p ? wPos * p[k] : 0) - (q ? wNeg * q[k] : 0);
    }
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += query[k] * query[k];
    norm = Math.max(Math.sqrt(norm), 1e-12);
    const qn = new Float32Array(dim);
    for (let k = 0; k < dim; k++) qn[k] = query[k] / norm;

    const scores = new Float32Array(V.n);
    for (let row = 0; row < V.n; row++) {
      const o = row * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += V.unit[o + k] * qn[k];
      scores[row] = s;
    }
    const topK = Math.max(1, parseInt(req.max_search_results, 10) || 100);
    const minScore = num(req.min_search_score, 0.2);
    const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, topK);
    return { results: order.filter((i) => scores[i] >= minScore).map((i) => ({ index: i, score: scores[i] })) };
  }

  const num = (v, d) => (v === undefined || v === null || Number.isNaN(+v) ? d : +v);

  // --- text: CLIP text encoder, loaded on first use (127 MB, then cached by the browser)
  let transformersP, textModelP, visionModelP;
  const loadTransformers = () => (transformersP ||= import(TRANSFORMERS_URL).then((T) => {
    T.env.allowLocalModels = false;
    return T;
  }).catch((e) => { transformersP = null; throw e; }));

  function loadTextModel() {
    return (textModelP ||= (async () => {
      const T = await loadTransformers();
      const progress = downloadProgress("Loading the text search model");
      try {
        const [tokenizer, model] = await Promise.all([
          T.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: progress.update }),
          T.CLIPTextModelWithProjection.from_pretrained(MODEL_ID,
            { dtype: MODEL_DTYPE, device: "wasm", progress_callback: progress.update }),
        ]);
        progress.done();
        return { tokenizer, model };
      } catch (e) {
        progress.fail("Couldn't load the text search model. Check your connection and try again.");
        throw e;
      }
    })().catch((e) => { textModelP = null; throw e; }));
  }

  const textCache = new Map();
  async function textVector(query) {
    if (!textCache.has(query)) {
      const { tokenizer, model } = await loadTextModel();
      const { text_embeds } = await model(tokenizer([query], { padding: true, truncation: true }));
      textCache.set(query, Float32Array.from(text_embeds.data));
    }
    return textCache.get(query);
  }

  // Start downloading the model as soon as the search panel opens.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#textSearchBtn")) loadTextModel().catch(() => {});
  }, true);

  // --- images: album photos use their stored vector (exact); other photos run
  // through the CLIP image encoder with PhotoMap's preprocessing.
  async function imageVector(dataUrl) {
    const bytes = base64ToBytes(String(dataUrl).split(",").pop());
    const i = (await fileKeys()).get(keyOf(bytes));
    if (i !== undefined) {
      const V = await vectors();
      return V.raw.subarray(i * V.dim, (i + 1) * V.dim);
    }
    return outsideImageVector(bytes);
  }

  // If a host re-encodes images, the stored file keys won't match. Learn the
  // served bytes' key whenever the page itself fetches an album photo or thumbnail.
  async function learnFileKey(url, responseP) {
    const response = await responseP;
    try {
      if (response.ok) {
        const { slides } = await core;
        const rel = url.pathname.slice(siteRoot.pathname.length);
        const i = slides.findIndex((s) => s.m === rel || s.t === rel);
        if (i >= 0) {
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          (await fileKeys()).set(keyOf(bytes), i);
        }
      }
    } catch {}
    return response;
  }

  function loadVisionModel() {
    return (visionModelP ||= (async () => {
      const T = await loadTransformers();
      const progress = downloadProgress("Loading the image search model");
      try {
        const model = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID,
          { dtype: MODEL_DTYPE, device: "wasm", progress_callback: progress.update });
        progress.done();
        return { T, model };
      } catch (e) {
        progress.fail("Couldn't load the image search model. Check your connection and try again.");
        throw e;
      }
    })().catch((e) => { visionModelP = null; throw e; }));
  }

  async function outsideImageVector(bytes) {
    const [{ T, model }, pixels] = await Promise.all([loadVisionModel(), clipPixels(bytes)]);
    const { image_embeds } = await model({ pixel_values: new T.Tensor("float32", pixels, [1, 3, 224, 224]) });
    return Float32Array.from(image_embeds.data);
  }

  // OpenAI CLIP preprocessing, as PhotoMap runs it through PIL and torchvision:
  // EXIF-rotate, resize the short side to 224 with PIL's antialiased bicubic
  // filter, center-crop 224x224, normalize.
  async function clipPixels(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]),
      { imageOrientation: "from-image", colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const w = bmp.width, h = bmp.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const src = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      src[j] = rgba[i]; src[j + 1] = rgba[i + 1]; src[j + 2] = rgba[i + 2];
    }
    const S = 224;
    const [nw, nh] = w <= h ? [S, Math.floor((S * h) / w)] : [Math.floor((S * w) / h), S];
    const resized = pilResize(src, w, h, nw, nh);
    const top = roundHalfEven((nh - S) / 2), left = roundHalfEven((nw - S) / 2);
    const out = new Float32Array(3 * S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = ((y + top) * nw + (x + left)) * 3;
      for (let c = 0; c < 3; c++) out[c * S * S + y * S + x] = (resized[o + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
    }
    return out;
  }

  const roundHalfEven = (v) => {
    const f = Math.floor(v), d = v - f;
    return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  };

  // Port of Pillow's ImagingResample (Resample.c) for 8-bit RGB with the
  // bicubic filter: horizontal pass, then vertical, fixed-point coefficients.
  function pilResize(src, w, h, nw, nh) {
    const PREC = 22;
    const bicubic = (x) => {
      const a = -0.5;
      x = Math.abs(x);
      if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
      if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
      return 0;
    };
    const coeffs = (inSize, outSize) => {
      const scale = inSize / outSize, filterscale = Math.max(scale, 1), support = 2 * filterscale;
      const ksize = Math.ceil(support) * 2 + 1;
      const bounds = new Int32Array(outSize * 2), kk = new Int32Array(outSize * ksize);
      const tmp = new Float64Array(ksize);
      for (let xx = 0; xx < outSize; xx++) {
        const center = (xx + 0.5) * scale, ss = 1 / filterscale;
        let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
        let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
        xmax -= xmin;
        let ww = 0;
        for (let x = 0; x < xmax; x++) { const v = bicubic((x + xmin - center + 0.5) * ss); tmp[x] = v; ww += v; }
        for (let x = 0; x < ksize; x++) {
          const v = x < xmax && ww !== 0 ? tmp[x] / ww : 0;
          kk[xx * ksize + x] = Math.trunc(v * (1 << PREC) + (v < 0 ? -0.5 : 0.5));
        }
        bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
      }
      return { ksize, bounds, kk };
    };
    const clip8 = (v) => {
      const r = Math.floor(v / 2 ** PREC);
      return r < 0 ? 0 : r > 255 ? 255 : r;
    };
    const H = coeffs(w, nw), Vc = coeffs(h, nh);
    const yFirst = Vc.bounds[0], yLast = Vc.bounds[(nh - 1) * 2] + Vc.bounds[(nh - 1) * 2 + 1];
    const needH = nw !== w, needV = nh !== h;
    let img = src, iw = w, ih = h, yOff = 0;
    if (needH) {
      const rows = yLast - yFirst, tmp = new Uint8Array(nw * rows * 3);
      for (let y = 0; y < rows; y++) for (let xx = 0; xx < nw; xx++) {
        const xmin = H.bounds[xx * 2], xmax = H.bounds[xx * 2 + 1], k = xx * H.ksize;
        let s0 = 2 ** (PREC - 1), s1 = s0, s2 = s0;
        for (let x = 0; x < xmax; x++) {
          const c = H.kk[k + x], o = ((y + yFirst) * w + x + xmin) * 3;
          s0 += src[o] * c; s1 += src[o + 1] * c; s2 += src[o + 2] * c;
        }
        const o = (y * nw + xx) * 3;
        tmp[o] = clip8(s0); tmp[o + 1] = clip8(s1); tmp[o + 2] = clip8(s2);
      }
      img = tmp; iw = nw; ih = rows; yOff = yFirst;
    }
    if (!needV) return img;
    const out = new Uint8Array(nw * nh * 3);
    for (let yy = 0; yy < nh; yy++) {
      const ymin = Vc.bounds[yy * 2] - (needH ? yOff : 0), ymax = Vc.bounds[yy * 2 + 1], k = yy * Vc.ksize;
      for (let xx = 0; xx < iw; xx++) {
        let s0 = 2 ** (PREC - 1), s1 = s0, s2 = s0;
        for (let y = 0; y < ymax; y++) {
          const c = Vc.kk[k + y], o = ((y + ymin) * iw + xx) * 3;
          s0 += img[o] * c; s1 += img[o + 1] * c; s2 += img[o + 2] * c;
        }
        const o = (yy * nw + xx) * 3;
        out[o] = clip8(s0); out[o + 1] = clip8(s1); out[o + 2] = clip8(s2);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ bytes

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // Same key as export_static.py's file_key().
  const keyOf = (bytes) => crc32(bytes).toString(16).padStart(8, "0") + "-" + bytes.length;

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Uncompressed ("stored") ZIP of the chosen photos; they're already compressed.
  async function zipResponse(indices) {
    const { slides } = await core;
    const enc = new TextEncoder(), parts = [], central = [], used = new Set();
    let offset = 0;
    for (const i of indices) {
      const s = slides[i];
      if (!s) continue;
      const r = await realFetch(new URL(s.m, siteRoot));
      if (!r.ok) throw new Error(`Couldn't download ${s.p}`);
      const data = new Uint8Array(await r.arrayBuffer());
      let name = decodeURIComponent(basename(s.m));
      for (let k = 2; used.has(name); k++) name = name.replace(/(\.[^.]*)?$/, (ext) => `-${k}${ext || ""}`);
      used.add(name);
      const nameBytes = enc.encode(name), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(12, 33, true); // 1980-01-01
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true); cen.setUint16(14, 33, true); cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true); cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
      parts.push(local, nameBytes, data);
      central.push(cen, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((a, b) => a + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length / 2, true);
    end.setUint16(10, central.length / 2, true); end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Response(new Blob([...parts, ...central, end], { type: "application/zip" }),
      { headers: { "Content-Type": "application/zip" } });
  }

  // ------------------------------------------------------------------ progress toast

  function downloadProgress(label) {
    const files = new Map();
    let el = null, timer = null;
    const show = (msg, cls) => {
      if (!el) {
        el = document.createElement("div");
        el.className = "pm-static-toast";
        el.setAttribute("role", "status");
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.classList.toggle("pm-static-toast-error", cls === "error");
    };
    // Only show the toast if loading takes a moment (it's instant once cached).
    timer = setTimeout(() => show(`${label}…`), 400);
    return {
      update(p) {
        // Count the model weights only; the tokenizer and config files are small.
        if (p.status !== "progress" || !p.total || !/\.onnx/.test(p.file || "")) return;
        files.set(p.file, p);
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        show(`${label} (one-time download): ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`);
      },
      done() { clearTimeout(timer); if (el) el.remove(); },
      fail(msg) {
        clearTimeout(timer);
        show(msg, "error");
        setTimeout(() => el && el.remove(), 8000);
      },
    };
  }
})();
