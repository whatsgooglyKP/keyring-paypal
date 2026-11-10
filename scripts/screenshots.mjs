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
await shot("03-recognizer-doesnt-look-like-you", false);
await shot("08-gemini-explanation", false);
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
