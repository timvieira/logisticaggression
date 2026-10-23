// Screenshots of the main screens at three window sizes, for checking the look.
//
//   node screens.mjs [URL] [OUT_DIR]
//
// Writes <size>-<screen>.png (map, slide, grid, search, settings) to OUT_DIR
// (default tests/screens/). Uses a fresh browser profile each time.
import { launch, waitForMap, baseUrl, sleep } from "./lib.mjs";
import fs from "fs";
import { fileURLToPath } from "url";

const BASE = baseUrl(process.argv[2]);
const OUT = process.argv[3] || fileURLToPath(new URL("screens", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "wide", width: 1919, height: 943 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "phone", width: 412, height: 915, mobile: true },
];
const click = (page, id) => page.evaluate((id) => document.getElementById(id)?.click(), id);

for (const size of SIZES) {
  const { browser, page, errors } = await launch({ ...size, profile: null });
  const shot = (screen) => page.screenshot({ path: `${OUT}/${size.name}-${screen}.png` });
  try {
    await page.goto(BASE);
    await waitForMap(page);
    await shot("map");
    await click(page, "umapCloseBtn"); await sleep(1200);
    await shot("slide");
    if (!size.mobile) {
      await click(page, "gridViewBtn"); await sleep(2500); await shot("grid");
      await click(page, "gridViewBtn"); await sleep(1200);
      await click(page, "textSearchBtn"); await sleep(800); await shot("search");
      await click(page, "closeTextSearchBtn"); await sleep(400);
      await click(page, "settingsBtn"); await sleep(800); await shot("settings");
    }
    console.log(`${size.name}: done${errors.length ? "; page errors: " + errors.join(" | ") : ""}`);
  } finally {
    await browser.close();
  }
}
console.log(`screenshots in ${OUT}`);
