import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { installMock } from "./mock-claude.mjs";
export const PAGE = new URL("../src/index.html", import.meta.url).href;
export const IPHONE = { width: 390, height: 844 }, IPAD_LANDSCAPE = { width: 1180, height: 820 };
let browser;
export async function launch() { browser = browser || await chromium.launch(); return browser; }
export async function close() { if (browser) await browser.close(); browser = null; }
/* Open the app with the mock runtime. Returns {page, errors}. */
export async function open(viewport, mockOpts = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());   // tests run offline
  await page.addInitScript(installMock, mockOpts);
  await page.goto(PAGE);
  await page.waitForTimeout(300);
  return { page, errors };
}
/* Pretend the on-screen keyboard took part of the screen. */
export async function keyboard(page, fraction = 0.55) {
  await page.evaluate(f => { const vv = window.visualViewport; Object.defineProperty(vv, "height", { value: Math.round(innerHeight * f), configurable: true }); vv.dispatchEvent(new Event("resize")); }, fraction);
  await page.waitForTimeout(150);
}
export const stored = (page, id) => page.evaluate(id => window.__store.entries[id], id);
export const entry = (blocks = [], title = "261114_Test") => ({ e1: { title, createdAt: new Date().toISOString(), protocols: [], blocks } });
export const textBlock = (id, text) => ({ id, type: "text", text, at: new Date().toISOString() });
/* Go to a tab (daily, notebooks, meetings, todo, docs). */
export async function tab(page, name) { await page.locator(`.tab[data-tab="${name}"]`).click(); await page.waitForTimeout(80); }
/* Open a notebook (or meeting) from its list. */
export async function openBook(page, id = "e1", where = "notebooks") {
  if (await page.locator(".tab").count()) await tab(page, where);
  await page.locator(`[data-open="${id}"]`).click(); await page.waitForTimeout(80);
}
export const IPAD_PORTRAIT = { width: 820, height: 1180 };
export const VIEWPORTS = [["iPad landscape", IPAD_LANDSCAPE], ["iPad portrait", IPAD_PORTRAIT], ["iPhone", IPHONE]];
