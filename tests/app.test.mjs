// Run with: npm test   (node:test + Playwright, no network needed)
// Each test names the bug or behaviour it protects; see docs/history.md.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, openBook, tab, keyboard, stored, entry, textBlock, IPHONE, IPAD_LANDSCAPE } from "./helpers.mjs";

after(close);

test("new entry: Cancel creates nothing, Create entry creates it", async () => {
  const { page, errors } = await open(IPHONE);
  await tab(page, "notebooks");
  await page.tap("#newEntry"); await page.tap("#newCancel"); await page.waitForTimeout(100);
  assert.equal(Object.keys(await page.evaluate(() => window.__store.entries)).length, 0);
  await page.tap("#newEntry"); await page.fill("#newTitle", "261114_PAPA_Nucleofection"); await page.tap("#newCreate"); await page.waitForTimeout(200);
  const all = Object.values(await page.evaluate(() => window.__store.entries));
  assert.equal(all.length, 1); assert.equal(all[0].title, "261114_PAPA_Nucleofection");
  assert.deepEqual(errors, []);
});

test("text lines save and stay visible on iPhone (frozen data, v4 bug)", async () => {
  const { page, errors } = await open(IPHONE, { entries: entry([textBlock("a", "existing line")]) });
  await openBook(page); await page.tap("#tText");
  for (const t of ["first", "second"]) { await page.fill("#compTa", t); await page.tap("#compAdd"); await page.waitForTimeout(150); }
  const e = await stored(page, "e1");
  assert.deepEqual(e.blocks.map(b => b.text), ["existing line", "first", "second"]);
  const visible = await page.evaluate(() => { const ls = [...document.querySelectorAll(".line")], box = document.querySelector("#lines").getBoundingClientRect(), r = ls.at(-1).getBoundingClientRect(); return box.height > 50 && r.bottom <= box.bottom + 2; });
  assert.ok(visible, "newest line is on screen");
  assert.deepEqual(errors, []);
});

test("handwriting: Add + new page keeps the canvas open for the next note", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry() });
  await openBook(page); await page.click("#tDraw"); await page.waitForTimeout(200);
  const c = await page.locator(".paper canvas").boundingBox();
  for (const action of ["next", "done"]) {
    await page.mouse.move(c.x + 40, c.y + 40); await page.mouse.down(); await page.mouse.move(c.x + 160, c.y + 100, { steps: 5 }); await page.mouse.up();
    await page.click(`[data-d="${action}"]`); await page.waitForTimeout(250);
  }
  assert.deepEqual((await stored(page, "e1")).blocks.map(b => b.type), ["ink", "ink"]);
  assert.ok(await page.isVisible("[data-again]"), "offers another note");
  assert.deepEqual(errors, []);
});

for (const [name, vp] of [["iPad landscape", IPAD_LANDSCAPE], ["iPhone", IPHONE]]) {
  test(`keyboard open on ${name}: Add line and tools stay on screen`, async () => {
    const { page, errors } = await open(vp, { entries: entry([textBlock("a", "line")]) });
    await openBook(page); await page.click("#tText"); await keyboard(page);
    const m = await page.evaluate(() => {
      const vh = visualViewport.height, add = document.querySelector("#compAdd").getBoundingClientRect(), dock = document.querySelector(".dock");
      return { vh, add: add.bottom, dockShown: getComputedStyle(dock).display !== "none", dock: dock.getBoundingClientRect().bottom, scroll: document.querySelector(".editor").scrollHeight - document.querySelector(".editor").clientHeight };
    });
    assert.ok(m.add <= m.vh + 1, `Add line at ${m.add} within ${m.vh}`);
    if (m.dockShown) assert.ok(m.dock <= m.vh + 1, `tools at ${m.dock} within ${m.vh}`);
    assert.equal(m.scroll, 0, "editor itself never scrolls");
    assert.deepEqual(errors, []);
  });
}

test("Fix terms with an empty box fixes the last line, in two passes, and asks about unsure words", async () => {
  const sampleScript = `
    const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
    if (!prompt.includes("second, context check"))
      return { text: JSON.stringify({ text: line.replace("new cliff fiction", "nucleofection"), changes: [{ from: "new cliff fiction", to: "nucleofection" }] }), modelApplied: "claude-sonnet-5-5" };
    return { text: JSON.stringify({ text: line, changes: [], unsure: [{ words: "seed dance", guesses: ["Seahorse"] }] }), modelApplied: "claude-sonnet-5-5" };`;
  const { page, errors } = await open(IPHONE, { entries: entry([textBlock("a", "doing new cliff fiction for the seed dance plates")]), glossary: ["nucleofection"], sampleScript });
  await openBook(page); await page.tap("#tText"); await page.tap("#compFixBtn"); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__prompts.length), 2, "term pass + context pass");
  assert.equal((await stored(page, "e1")).blocks[0].text, "doing nucleofection for the seed dance plates");
  assert.ok(await page.isVisible(".unsure"));
  await page.fill(".unsure .other input", "SeaDance"); await page.tap(".unsure .other button"); await page.waitForTimeout(250);
  assert.equal((await stored(page, "e1")).blocks[0].text, "doing nucleofection for the SeaDance plates");
  assert.equal((await page.evaluate(() => window.__store.config.glossary.terms))[0], "SeaDance", "typed answer joins the vocabulary");
  const wide = await page.evaluate(() => document.querySelector("#lines").scrollWidth > document.querySelector("#lines").clientWidth);
  assert.ok(!wide, "question box fits the phone width");
  assert.deepEqual(errors, []);
});

test("a failed save keeps the line, warns, and retries", async () => {
  const { page, errors } = await open(IPHONE, { entries: entry(), failFirstUpdate: true });
  await openBook(page); await page.tap("#tText"); await page.fill("#compTa", "during outage"); await page.tap("#compAdd"); await page.waitForTimeout(250);
  assert.ok(await page.isVisible("#saveBanner"), "warning shown");
  await page.waitForTimeout(5500);
  assert.deepEqual((await stored(page, "e1")).blocks.map(b => b.text), ["during outage"]);
  assert.ok(!(await page.isVisible("#saveBanner")), "warning cleared");
  assert.deepEqual(errors, []);
});

test("vocabulary settings: add and remove terms", async () => {
  const { page, errors } = await open(IPHONE, { glossary: ["Accutase", "Matrigel"] });
  await page.tap("#openSettings"); await page.fill("#vNew", "eTeSR Plus"); await page.press("#vNew", "Enter"); await page.waitForTimeout(100);
  await page.tap('[data-term="Matrigel"]'); await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__store.config.glossary.terms), ["eTeSR Plus", "Accutase"]);
  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  assert.deepEqual(errors, []);
});
