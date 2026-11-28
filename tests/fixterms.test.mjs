// Fix terms: a replacement must sound like what was written, a doubtful one is asked, and every applied
// change can be corrected to another word. Bug: "pyromycin" became "mycoplasma" with no way to say "puromycin".
// Run with: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, openBook, stored, entry, textBlock, IPHONE, VIEWPORTS } from "./helpers.mjs";

after(close);

const LINE = "added pyromycin to the wells";
/* what "Claude" answers: the term pass makes swap1 (and may list unsure1), the context pass makes swap2 */
const script = ({ swap1 = null, unsure1 = null, swap2 = null } = {}) => `
  const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
  const swap = ${JSON.stringify(swap1)}, unsure = ${JSON.stringify(unsure1)}, swap2 = ${JSON.stringify(swap2)};
  const answer = (s, extra) => ({ text: JSON.stringify({ text: s && line.includes(s.from) ? line.replace(s.from, s.to) : line, changes: s && line.includes(s.from) ? [s] : [], ...extra }), modelApplied: "claude-sonnet-5-5" });
  if (!prompt.includes("second, context check")) return answer(swap, unsure ? { unsure } : {});
  return answer(swap2, { unsure: [] });`;
const WRONG = { from: "pyromycin", to: "mycoplasma" }, RIGHT = { from: "pyromycin", to: "puromycin" };
const lineOf = async page => (await stored(page, "e1")).blocks[0].text;
const voiceOf = page => page.evaluate(() => (window.__store.config.voice || { pairs: [] }).pairs.map(p => [p.heard, p.said, p.n]));
const fixLast = async (opts, vp = IPHONE, line = LINE) => {
  const r = await open(vp, { entries: entry([textBlock("a", line)]), ...opts });
  await openBook(r.page); await r.page.tap("#tText"); await r.page.tap("#compFixBtn"); await r.page.waitForTimeout(400);
  return r;
};

test("a misheard word becomes the vocabulary term that sounds like it", async () => {
  const { page, errors } = await fixLast({ glossary: ["puromycin", "mycoplasma"], sampleScript: script({ swap1: RIGHT }) });
  assert.equal(await lineOf(page), "added puromycin to the wells");
  assert.equal(await page.locator(".unsure").count(), 0, "a swap that sounds right is not questioned");
  assert.deepEqual(await voiceOf(page), [["pyromycin", "puromycin", 1]]);
  assert.deepEqual(errors, []);
});

test("a swap for a term that does not sound like the word is not applied: the closer vocabulary term is offered first", async () => {
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "puromycin", "Proteinase K"], sampleScript: script({ swap1: WRONG }) });
  assert.equal(await lineOf(page), LINE, "the line keeps the word as written");
  assert.deepEqual(await voiceOf(page), [], "the refused swap is not learned");
  assert.deepEqual(await page.locator(".unsure [data-g]").allTextContents(), ["puromycin", "mycoplasma"]);
  await page.locator(".unsure [data-g]").first().tap(); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "added puromycin to the wells");
  assert.deepEqual(await voiceOf(page), [["pyromycin", "puromycin", 1]]);
  assert.deepEqual(errors, []);
});

test("with no term that sounds alike, the word is asked about, never swapped for an unrelated term", async () => {
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "Matrigel"], sampleScript: script({ swap1: WRONG }) });
  assert.equal(await lineOf(page), LINE);
  assert.deepEqual(await page.locator(".unsure [data-g]").allTextContents(), ["mycoplasma"]);
  await page.tap(".unsure [data-keep]"); await page.waitForTimeout(150);
  assert.equal(await lineOf(page), LINE);
  assert.deepEqual(await voiceOf(page), []);
  assert.deepEqual(errors, []);
});

test("the context pass is held to the same rule", async () => {
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "puromycin"], sampleScript: script({ swap2: WRONG }) });
  assert.equal(await lineOf(page), LINE);
  assert.deepEqual(await page.locator(".unsure [data-g]").allTextContents(), ["puromycin", "mycoplasma"]);
  assert.equal(await page.locator(".unsure").count(), 1, "one question for the word, not one per pass");
  assert.deepEqual(errors, []);
});

test("the term pass can say it is not sure, and the word is asked", async () => {
  const unsure1 = [{ words: "pyromycin", guesses: ["puromycin", "hygromycin B"] }];
  const { page, errors } = await fixLast({ glossary: ["Matrigel"], sampleScript: script({ unsure1 }) });
  assert.match((await page.evaluate(() => window.__prompts))[0], /"unsure"/, "the term pass is asked for unsure words");
  assert.equal(await lineOf(page), LINE);
  assert.deepEqual(await page.locator(".unsure [data-g]").allTextContents(), ["puromycin", "hygromycin B"]);
  assert.deepEqual(errors, []);
});

test("the term pass is told that a replacement must sound like what was written", async () => {
  const { page, errors } = await fixLast({ glossary: ["puromycin"], sampleScript: script() });
  const p = (await page.evaluate(() => window.__prompts))[0];
  assert.match(p, /must sound like the words it replaces/);
  assert.match(p, /not listed/);
  assert.deepEqual(errors, []);
});

test("a swap you confirmed before is applied without asking again", async () => {
  const voice = { pairs: [{ heard: "pyromycin", said: "mycoplasma", n: 1, at: "2026-01-01T00:00:00.000Z", sure: true }] };
  const { page, errors } = await fixLast({ glossary: ["mycoplasma"], voice, sampleScript: script({ swap1: WRONG }) });
  assert.equal(await lineOf(page), "added mycoplasma to the wells");
  assert.equal(await page.locator(".unsure").count(), 0);
  assert.deepEqual(errors, []);
});

test("a learned swap that does not sound alike is not shown to Claude as evidence, unless you confirmed it", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const voice = { pairs: [{ heard: "pyromycin", said: "mycoplasma", n: 1, at }, { heard: "healthened", said: "Proteinase K", n: 1, at, sure: true }, { heard: "new cliff fiction", said: "nucleofection", n: 2, at }] };
  const { page, errors } = await fixLast({ glossary: ["puromycin"], voice, sampleScript: script() });
  const p = (await page.evaluate(() => window.__prompts))[0];
  assert.ok(!p.includes("pyromycin → mycoplasma"), "the unrelated swap is left out");
  assert.match(p, /healthened → Proteinase K \(1\)/);
  assert.match(p, /new cliff fiction → nucleofection \(2\)/);
  assert.deepEqual(errors, []);
});

const TWO = "pure oh selection after new cliff fiction";
const twoScript = `
  const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
  if (prompt.includes("second, context check")) return { text: JSON.stringify({ text: line, changes: [], unsure: [] }), modelApplied: "claude-sonnet-5-5" };
  return { text: JSON.stringify({ text: line.replace("pure oh", "PuroR").replace("new cliff fiction", "nucleofection"), changes: [{ from: "pure oh", to: "PuroR" }, { from: "new cliff fiction", to: "nucleofection" }] }), modelApplied: "claude-sonnet-5-5" };`;

for (const [name, vp] of VIEWPORTS) {
  test(`an applied change can be corrected to a word you type (${name})`, async () => {
    const { page, errors } = await fixLast({ glossary: ["PuroR", "nucleofection"], sampleScript: twoScript }, vp, TWO);
    assert.equal(await lineOf(page), "PuroR selection after nucleofection");
    assert.equal(await page.locator("[data-chg]").count(), 2, "each change is its own button");
    await page.locator("[data-chg]").first().tap(); await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const row = document.querySelector(".unsure.fixrow"), box = document.querySelector("#lines");
      const small = [...row.querySelectorAll("button, input")].filter(n => n.getBoundingClientRect().height < 44).map(n => n.textContent || n.placeholder);
      const cut = [...document.querySelectorAll("[data-chg], .fixrow button")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent);
      return { small, cut, wide: box.scrollWidth > box.clientWidth, rowWide: row.getBoundingClientRect().right > innerWidth + 1 };
    });
    assert.deepEqual(fit, { small: [], cut: [], wide: false, rowWide: false });
    await page.fill(".fixrow .other input", "puromycin"); await page.tap(".fixrow .other button"); await page.waitForTimeout(300);
    assert.equal(await lineOf(page), "puromycin selection after nucleofection");
    assert.equal((await page.evaluate(() => window.__store.config.glossary.terms))[0], "puromycin", "the typed word joins the vocabulary");
    assert.deepEqual((await voiceOf(page)).sort(), [["new cliff fiction", "nucleofection", 1], ["pure oh", "puromycin", 1]], "the wrong pair is forgotten, the typed one learned");
    assert.match(await page.locator("[data-chg]").first().textContent(), /pure oh → puromycin/);
    await page.tap(".fixnote [data-undo]"); await page.waitForTimeout(250);
    assert.equal(await lineOf(page), TWO, "Undo still restores the whole line");
    assert.deepEqual(await voiceOf(page), []);
    assert.deepEqual(errors, []);
  });
}

test("an applied change can be corrected with one tap when the vocabulary has a word that sounds like it", async () => {
  const swap1 = { from: "pyromycin", to: "hygromycin B" };
  const { page, errors } = await fixLast({ glossary: ["hygromycin B", "puromycin"], sampleScript: script({ swap1 }) });
  assert.equal(await lineOf(page), "added hygromycin B to the wells", "a swap that sounds close enough is applied");
  await page.tap("[data-chg]"); await page.waitForTimeout(150);
  assert.deepEqual(await page.locator(".fixrow [data-g]").allTextContents(), ["puromycin"]);
  await page.tap(".fixrow [data-g]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "added puromycin to the wells");
  assert.deepEqual(await voiceOf(page), [["pyromycin", "puromycin", 1]]);
  assert.deepEqual(errors, []);
});

test("one change can be put back while the others stay", async () => {
  const { page, errors } = await fixLast({ glossary: ["PuroR", "nucleofection"], sampleScript: twoScript }, IPHONE, TWO);
  await page.locator("[data-chg]").first().tap(); await page.waitForTimeout(150);
  await page.tap(".fixrow [data-back]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "pure oh selection after nucleofection");
  assert.deepEqual(await voiceOf(page), [["new cliff fiction", "nucleofection", 1]]);
  assert.equal(await page.locator("[data-chg]").count(), 1);
  assert.deepEqual(errors, []);
});

test("a change in the text box, before the line is added, can be corrected too", async () => {
  const { page, errors } = await open(IPHONE, { entries: entry(), glossary: ["hygromycin B"], sampleScript: script({ swap1: { from: "pyromycin", to: "hygromycin B" } }) });
  await openBook(page); await page.tap("#tText"); await page.fill("#compTa", LINE); await page.tap("#compFixBtn"); await page.waitForTimeout(400);
  assert.equal(await page.inputValue("#compTa"), "added hygromycin B to the wells");
  await page.tap("#compFix [data-chg]"); await page.fill("#compFix .other input", "puromycin"); await page.tap("#compFix .other button"); await page.waitForTimeout(250);
  assert.equal(await page.inputValue("#compTa"), "added puromycin to the wells");
  assert.deepEqual(errors, []);
});

test("a refused swap leaves the line exactly as written, also where the same term stands rightly elsewhere", async () => {
  const line = "mycoplasma test negative, added Pyromycin";
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "puromycin"], sampleScript: script({ swap1: { from: "Pyromycin", to: "mycoplasma" } }) }, IPHONE, line);
  assert.equal(await lineOf(page), line);
  await page.locator(".unsure [data-g]").first().tap(); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "mycoplasma test negative, added puromycin");
  assert.deepEqual(errors, []);
});

test("when Claude's text is more than its listed changes, a refused swap is still taken back without touching the rest", async () => {
  const sampleScript = `
    const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
    if (prompt.includes("second, context check")) return { text: JSON.stringify({ text: line, changes: [], unsure: [] }), modelApplied: "claude-sonnet-5-5" };
    return { text: JSON.stringify({ text: line.replace("pyromycin", "mycoplasma").replace("37 C", "37 °C"), changes: [{ from: "pyromycin", to: "mycoplasma" }] }), modelApplied: "claude-sonnet-5-5" };`;
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "puromycin"], sampleScript }, IPHONE, "added pyromycin at 37 C");
  assert.equal(await lineOf(page), "added pyromycin at 37 °C");
  assert.deepEqual(await page.locator(".unsure [data-g]").allTextContents(), ["puromycin", "mycoplasma"]);
  assert.deepEqual(errors, []);
});

test("every refused swap is asked, however many there are", async () => {
  const words = ["pyromycin", "byromycin", "piromycin", "puromysin", "pyromysin", "pyromicin"];
  const sampleScript = `
    const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
    if (prompt.includes("second, context check")) return { text: JSON.stringify({ text: line, changes: [], unsure: [] }), modelApplied: "claude-sonnet-5-5" };
    const words = ${JSON.stringify(words)};
    return { text: JSON.stringify({ text: words.reduce((t, w) => t.replace(w, "mycoplasma"), line), changes: words.map(w => ({ from: w, to: "mycoplasma" })) }), modelApplied: "claude-sonnet-5-5" };`;
  const { page, errors } = await fixLast({ glossary: ["mycoplasma"], sampleScript }, IPHONE, words.join(" then "));
  assert.equal(await lineOf(page), words.join(" then "));
  assert.equal(await page.locator(".unsure").count(), words.length);
  assert.deepEqual(errors, []);
});

test("an answer to a question is remembered as confirmed, and can itself be corrected or undone", async () => {
  const { page, errors } = await fixLast({ glossary: ["mycoplasma", "puromycin"], sampleScript: script({ swap1: WRONG }) });
  await page.locator(".unsure [data-g]").nth(1).tap(); await page.waitForTimeout(250);   /* the wrong one, by mistake */
  assert.equal(await lineOf(page), "added mycoplasma to the wells");
  assert.deepEqual(await page.evaluate(() => window.__store.config.voice.pairs.map(p => [p.heard, p.said, p.sure])), [["pyromycin", "mycoplasma", true]]);
  await page.tap("[data-chg]"); await page.waitForTimeout(150);
  await page.locator(".fixrow [data-g]").first().tap(); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "added puromycin to the wells");
  assert.deepEqual(await page.evaluate(() => window.__store.config.voice.pairs.map(p => [p.heard, p.said, p.sure])), [["pyromycin", "puromycin", true]]);
  await page.tap(".fixnote [data-undo]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), LINE);
  assert.deepEqual(await voiceOf(page), []);
  assert.deepEqual(errors, []);
});

test("a correction is refused, with a message, when the term stands in the line more than once", async () => {
  const line = "hygromycin B in plate 1, pyromycin in plate 2";
  const { page, errors } = await fixLast({ glossary: ["hygromycin B", "puromycin"], sampleScript: script({ swap1: { from: "pyromycin", to: "hygromycin B" } }) }, IPHONE, line);
  assert.equal(await lineOf(page), "hygromycin B in plate 1, hygromycin B in plate 2");
  await page.tap("[data-chg]"); await page.tap(".fixrow [data-g]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "hygromycin B in plate 1, hygromycin B in plate 2", "nothing is changed blindly");
  assert.match(await page.locator(".toast").textContent(), /2 times/);
  await page.tap(".fixnote [data-undo]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), line);
  assert.deepEqual(errors, []);
});

test("an answer to a question changes the word itself, never the same letters inside another word", async () => {
  const sampleScript = `
    const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
    return { text: JSON.stringify({ text: line, changes: [], unsure: prompt.includes("second, context check") ? [{ words: "Ann", guesses: ["Anne"] }] : [] }), modelApplied: "claude-sonnet-5-5" };`;
  const { page, errors } = await fixLast({ glossary: ["annealing"], sampleScript }, IPHONE, "Ann set up the annealing, then ann checked the channel");
  await page.tap(".unsure [data-g]"); await page.waitForTimeout(250);
  assert.equal(await lineOf(page), "Anne set up the annealing, then Anne checked the channel");
  assert.deepEqual(errors, []);
});

test("a fix made before the learned list has loaded does not overwrite it: it is added once the list arrives", async () => {
  const at = "2026-01-01T00:00:00.000Z", SLOW_MS = 2500;
  const voice = { pairs: [{ heard: "cough", said: "KOLF", n: 4, at }, { heard: "new cliff fiction", said: "nucleofection", n: 2, at, sure: true }] };
  const { page, errors } = await fixLast({ glossary: ["puromycin"], voice, sampleScript: script({ swap1: RIGHT }), snapshotDelayMs: { "config/voice": SLOW_MS } });
  assert.equal(await lineOf(page), "added puromycin to the wells", "fixing itself does not wait");
  assert.deepEqual(await voiceOf(page), [["cough", "KOLF", 4], ["new cliff fiction", "nucleofection", 2]], "nothing is written before the stored list arrived");
  await page.waitForTimeout(SLOW_MS);
  assert.deepEqual(await voiceOf(page), [["cough", "KOLF", 4], ["new cliff fiction", "nucleofection", 2], ["pyromycin", "puromycin", 1]]);
  assert.equal(await page.evaluate(() => window.__store.config.voice.pairs[1].sure), true, "what was stored is kept as it was");
  await page.tap(".fixnote [data-undo]"); await page.waitForTimeout(250);
  assert.deepEqual(await voiceOf(page), [["cough", "KOLF", 4], ["new cliff fiction", "nucleofection", 2]]);
  assert.deepEqual(errors, []);
});

test("Undo before the learned list has loaded leaves the stored list as it was", async () => {
  const at = "2026-01-01T00:00:00.000Z", SLOW_MS = 2500;
  const voice = { pairs: [{ heard: "pyromycin", said: "puromycin", n: 3, at }] };
  const { page, errors } = await fixLast({ glossary: ["puromycin"], voice, sampleScript: script({ swap1: RIGHT }), snapshotDelayMs: { "config/voice": SLOW_MS } });
  await page.tap(".fixnote [data-undo]"); await page.waitForTimeout(SLOW_MS + 200);
  assert.deepEqual(await voiceOf(page), [["pyromycin", "puromycin", 3]]);
  assert.deepEqual(errors, []);
});
