// The iPad bug: while editing the last text line with the keyboard open, the view kept scrolling up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, keyboard, openBook, entry, textBlock, IPAD_LANDSCAPE } from "./helpers.mjs";

after(close);

test("editing the last line with the keyboard open does not scroll the lines away (iPad)", async () => {
  const long = "Counted the plate after Accutase and resuspended in StemFlex with RevitaCell, then split across wells. ".repeat(6);
  const blocks = Array.from({ length: 30 }, (_, i) => textBlock("l" + i, "line " + i)).concat([textBlock("last", long)]);
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry(blocks) });
  await page.addStyleTag({ content: "*{overflow-anchor:none!important}" });   // iPad Safari has no scroll anchoring; Chromium and Firefox do, which hid the bug on a Mac
  await openBook(page);
  const ta = page.locator('[data-key="b:last"] textarea.ta');
  await ta.click(); await keyboard(page);
  await page.evaluate(() => { const b = document.querySelector("#lines"); b.scrollTop = b.scrollHeight; });
  const before = await page.evaluate(() => document.querySelector("#lines").scrollTop);
  assert.ok(before > 0, "the lines area is scrolled");
  for (const ch of ["a", "b", "c"]) { await page.keyboard.type(ch); await page.waitForTimeout(1100); }   // each pause lets the save and its snapshot land
  const m = await page.evaluate(() => { const b = document.querySelector("#lines"), r = document.querySelector('[data-key="b:last"] textarea.ta').getBoundingClientRect(), bx = b.getBoundingClientRect(); return { top: b.scrollTop, caretLineVisible: r.bottom <= bx.bottom + 2 && r.bottom > bx.top, win: window.scrollY }; });
  assert.ok(m.top >= before - 2, `lines stayed put (was ${before}, now ${m.top})`);
  assert.ok(m.caretLineVisible, "the end of the edited line is still on screen");
  assert.equal(m.win, 0, "the page itself did not scroll");
  assert.deepEqual(errors, []);
});
