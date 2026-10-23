// Shared helpers for the browser tests.
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "url";

export const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
// A persistent profile keeps the 127 MB CLIP text model cached between runs.
export const PROFILE = process.env.PROFILE || fileURLToPath(new URL(".chrome-profile", import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function baseUrl(arg) {
  return (arg || "http://localhost:8000/").replace(/\/?$/, "/");
}

export async function launch({ width = 1919, height = 943, mobile = false, profile = PROFILE } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 900000,
    userDataDir: profile || undefined,
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  return { browser, page, errors };
}

// Wait until PhotoMap has drawn the semantic map (it opens on page load).
export async function waitForMap(page, timeout = 60000) {
  await page.waitForFunction(() => document.getElementById("umapPlot")?.data?.length > 0, { timeout });
  await sleep(1500); // landmarks and the control row settle after the first draw
}

// Call a PhotoMap API route through the page, so the static shim answers it.
export function api(page, path, body) {
  return page.evaluate(async (path, body) => {
    const r = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  }, path, body);
}

// A data: URL of a site file (an album photo), fetched in the page.
export function dataUrlOf(page, path) {
  return page.evaluate(async (path) => {
    const blob = await (await fetch(path)).blob();
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }, path);
}

export function checker() {
  let fails = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
    if (!ok) fails++;
  };
  return { check, failures: () => fails };
}
