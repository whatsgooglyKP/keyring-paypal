// Drives the real UI in headless Chromium and saves screenshots: node scripts/screenshots.mjs [baseUrl]
// Resets the demo first (deletes the demo's own sandbox vault tokens).
import { chromium } from "playwright";
const BASE = process.argv[2] || "http://localhost:3001";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" }); }
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
page.on("dialog", (d) => d.accept());
const shot = async (name, full = true) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}${name}.png`, fullPage: full }); console.log(`${OUT}${name}.png`); };
const wait = () => page.waitForLoadState("networkidle");
const charge = async (sel) => { await Promise.all([page.waitForResponse((r) => r.url().includes("/charge")), page.click(sel)]); await page.waitForResponse((r) => r.url().includes("/api/key/api-log")); await page.waitForTimeout(300); };

await page.goto(BASE); await wait();
await page.click("#reset"); await page.waitForTimeout(3000); await wait();
await page.click("#createKey"); await wait();
for (const m of ["streamco", "beanbrew", "ironworks"]) { await page.click(`[data-save="${m}"]`); await page.waitForSelector(`[data-save="${m}"]:not([disabled])`); await wait(); }
await page.click("#verify"); await page.waitForSelector("#verify:not([disabled])"); await wait();
await shot("01-keyring-saved-cards");

await charge('[data-charge="streamco"][data-i="0"]');
await charge('[data-charge="beanbrew"][data-i="0"]');
await charge('[data-charge="ironworks"][data-i="0"]');
await page.locator("#charges").scrollIntoViewIfNeeded();
await shot("02-charges-with-recognizer");

const aiDone = () => page.waitForSelector("#aiExplain[data-source]", { timeout: 45000 });
await page.locator(".row.charge", { hasText: "IronWorks" }).first().click(); await page.waitForSelector("#drawer:not([hidden])");
await aiDone();
console.log("gym explanation source:", await page.getAttribute("#aiExplain", "data-source"));
// 03: crop to the model score + feature reasons (hide Gemini / ask / facts so this shot is not identical to 08).
await page.evaluate(() => {
  const root = document.querySelector("#drawerContent");
  if (!root) return;
  const hide = [];
  const ai = root.querySelector("#aiExplain");
  if (ai) hide.push(ai);
  for (const card of root.querySelectorAll(".card")) {
    const h = card.querySelector("h3")?.textContent || "";
    if (card.classList.contains("ask") || h.includes("What we know") || h.includes("Card")) hide.push(card);
  }
  for (const el of hide) { el.setAttribute("data-shot-hide", "1"); el.style.display = "none"; }
});
await page.locator("#drawer .verdict .big").scrollIntoViewIfNeeded();
const reasons = page.locator("#drawerContent .card", { hasText: "Model's top reasons" });
await reasons.scrollIntoViewIfNeeded();
const vbox = await page.locator("#drawer .verdict").boundingBox();
const rbox = await reasons.boundingBox();
if (!vbox || !rbox) throw new Error("missing verdict or reasons for shot 03");
const x = Math.max(0, Math.min(vbox.x, rbox.x) - 16);
const y = Math.max(0, Math.min(vbox.y, rbox.y) - 12);
const right = Math.min(1360, Math.max(vbox.x + vbox.width, rbox.x + rbox.width) + 16);
const bottom = Math.min(900, Math.max(vbox.y + vbox.height, rbox.y + rbox.height) + 16);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}03-recognizer-doesnt-look-like-you.png`, clip: { x, y, width: right - x, height: bottom - y } });
console.log(`${OUT}03-recognizer-doesnt-look-like-you.png`);
await page.evaluate(() => {
  document.querySelectorAll("[data-shot-hide]").forEach((el) => { el.style.display = ""; el.removeAttribute("data-shot-hide"); });
});
// 08: focus on the Gemini explanation and recommended action.
await page.locator("#aiExplain").scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const aiBox = await page.locator("#aiExplain").boundingBox();
if (!aiBox) throw new Error("missing #aiExplain for shot 08");
const pad = 12;
await page.screenshot({
  path: `${OUT}08-gemini-explanation.png`,
  clip: {
    x: Math.max(0, aiBox.x - pad),
    y: Math.max(0, aiBox.y - pad),
    width: Math.min(1360, aiBox.width + pad * 2),
    height: Math.min(900, aiBox.height + pad * 2),
  },
});
console.log(`${OUT}08-gemini-explanation.png`);
await page.locator(".chip").first().click();
await page.waitForSelector("#askOut .answer[data-source]", { timeout: 45000 });
console.log("Q&A source:", await page.getAttribute("#askOut .answer", "data-source"));
await page.locator("#askOut").scrollIntoViewIfNeeded();
await shot("09-ask-about-charge", false);
await page.click("#drawer [data-close].close");
await page.locator(".row.charge", { hasText: "StreamCo" }).first().click(); await page.waitForSelector("#drawer:not([hidden])");
await aiDone();
console.log("streamco explanation source:", await page.getAttribute("#aiExplain", "data-source"));
await shot("04-recognizer-looks-like-you", false);
await page.click("#drawer [data-close].close");

const gymRow = page.locator(".row", { hasText: "IronWorks Gym" }).filter({ has: page.locator("[data-lock]") });
await gymRow.locator("[data-lock]").click(); await wait(); await page.waitForTimeout(600);
await charge('[data-charge="ironworks"][data-i="0"]');
await page.locator("#toast").scrollIntoViewIfNeeded();
await shot("05-locked-card-charge-blocked", false);

const scRow = page.locator(".row", { hasText: "StreamCo+" }).filter({ has: page.locator("[data-revoke]") });
await scRow.locator("[data-revoke]").click(); await page.waitForSelector("#modal:not([hidden])");
await page.check("#ack");
await shot("06-revoke-confirm-subscription-warning", false);
await page.click("#doRevoke"); await page.waitForSelector("#modal", { state: "hidden" }); await wait(); await page.waitForTimeout(1500);
await charge('[data-charge="streamco"][data-i="0"]');
await shot("07-after-revoke-and-api-log");
await browser.close();
