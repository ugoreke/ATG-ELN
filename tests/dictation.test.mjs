// Dictation: the page learns how Apple's dictation mishears the owner (config/voice), and uses Claude's own
// dictation where the platform offers it. Run with: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, openBook, tab, entry, textBlock, IPHONE, IPAD_LANDSCAPE } from "./helpers.mjs";

after(close);

const LINE = "doing new cliff fiction for the plates";
const fixScript = (changes, unsure = []) => `
  const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1] || "";
  if (!prompt.includes("second, context check"))
    return { text: JSON.stringify({ text: line.replace("new cliff fiction", "nucleofection"), changes: ${JSON.stringify(changes)} }), modelApplied: "claude-sonnet-5-5" };
  return { text: JSON.stringify({ text: line, changes: [], unsure: ${JSON.stringify(unsure)} }), modelApplied: "claude-sonnet-5-5" };`;
const NUCLEO = { from: "new cliff fiction", to: "nucleofection" };
const voiceOf = page => page.evaluate(() => window.__store.config.voice);
const openFix = async (opts, vp = IPHONE) => {
  const r = await open(vp, { entries: entry([textBlock("a", LINE)]), glossary: ["nucleofection"], ...opts });
  await openBook(r.page); await r.page.tap("#tText");
  return r;
};
const fixOnce = async page => { await page.tap("#compFixBtn"); await page.waitForTimeout(350); };

test("a fix's changes are stored in config/voice with a count, and a repeat adds one", async () => {
  const { page, errors } = await openFix({ sampleScript: fixScript([NUCLEO]) });
  await fixOnce(page);
  let v = await voiceOf(page);
  assert.equal(v.pairs.length, 1);
  assert.equal(v.pairs[0].heard, "new cliff fiction"); assert.equal(v.pairs[0].said, "nucleofection"); assert.equal(v.pairs[0].n, 1);
  assert.ok(!Number.isNaN(Date.parse(v.pairs[0].at)), "at is an ISO time");
  await fixOnce(page);
  v = await voiceOf(page);
  assert.equal(v.pairs.length, 1); assert.equal(v.pairs[0].n, 2);
  assert.deepEqual(errors, []);
});

test("heard is lower-cased and trimmed", async () => {
  const { page, errors } = await openFix({ sampleScript: fixScript([{ from: "  New Cliff Fiction ", to: "nucleofection" }]) });
  await fixOnce(page);
  assert.equal((await voiceOf(page)).pairs[0].heard, "new cliff fiction");
  assert.deepEqual(errors, []);
});

test("case, spacing, punctuation and unit-tidy-only differences are not stored; real corrections are", async () => {
  const changes = [{ from: "Accutase", to: "accutase" }, { from: "PAS 16", to: "PAS16" }, { from: "37 C", to: "37 °C" }, { from: "200 G", to: "200 × g" }, { from: "micro liters", to: "µl" }];
  const { page, errors } = await openFix({ sampleScript: fixScript(changes) });
  await fixOnce(page);
  assert.deepEqual((await voiceOf(page)).pairs.map(p => [p.heard, p.said]), [["micro liters", "µl"]]);
  assert.deepEqual(errors, []);
});

test("nothing is written when no change is worth learning", async () => {
  const { page, errors } = await openFix({ sampleScript: fixScript([{ from: "Accutase", to: "accutase" }]) });
  await fixOnce(page);
  assert.equal(await voiceOf(page), undefined);
  assert.deepEqual(errors, []);
});

test("the answer picked or typed for an unsure word is learned", async () => {
  const unsure = [{ words: "seed dance", guesses: ["Seahorse"] }];
  const { page, errors } = await openFix({ sampleScript: fixScript([], unsure), entries: entry([textBlock("a", "run the seed dance plates")]) });
  await fixOnce(page);
  await page.tap(".unsure [data-g]"); await page.waitForTimeout(250);
  assert.deepEqual((await voiceOf(page)).pairs.map(p => [p.heard, p.said, p.n]), [["seed dance", "Seahorse", 1]]);
  assert.deepEqual(errors, []);
});

test("undo of a fixed line decrements the pair; at zero it is removed", async () => {
  const seed = { pairs: [{ heard: "new cliff fiction", said: "nucleofection", n: 2, at: "2026-01-01T00:00:00.000Z" }] };
  const { page, errors } = await openFix({ sampleScript: fixScript([NUCLEO]), voice: seed });
  await fixOnce(page);
  assert.equal((await voiceOf(page)).pairs[0].n, 3);
  await page.tap(".fixnote [data-undo], #compFix [data-undo]"); await page.waitForTimeout(250);
  assert.equal((await voiceOf(page)).pairs[0].n, 2);

  const b = await openFix({ sampleScript: fixScript([NUCLEO]) });
  await fixOnce(b.page);
  await b.page.tap(".fixnote [data-undo], #compFix [data-undo]"); await b.page.waitForTimeout(250);
  assert.deepEqual((await voiceOf(b.page)).pairs, []);
  assert.deepEqual([...errors, ...b.errors], []);
});

test("Undo all in the entry menu takes the pairs back out", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry([textBlock("a", LINE)]), glossary: ["nucleofection"], sampleScript: fixScript([NUCLEO]) });
  await openBook(page); await page.click("#moreBtn"); await page.click("#fixAll"); await page.waitForTimeout(500);
  assert.equal((await voiceOf(page)).pairs[0].n, 1);
  await page.click("#fixUndo"); await page.waitForTimeout(250);
  assert.deepEqual((await voiceOf(page)).pairs, []);
  assert.deepEqual(errors, []);
});

test("the next term pass tells Claude what dictation has misheard, after the vocabulary, as evidence", async () => {
  const seed = { pairs: [{ heard: "cough", said: "KOLF", n: 4, at: "2026-01-01T00:00:00.000Z" }] };
  const { page, errors } = await openFix({ sampleScript: fixScript([]), voice: seed });
  await fixOnce(page);
  const p = (await page.evaluate(() => window.__prompts))[0];
  assert.match(p, /How dictation has misheard this speaker before \(heard → what he said, times seen\)/);
  assert.match(p, /cough → KOLF \(4\)/);
  assert.ok(p.indexOf("cough → KOLF") > p.indexOf("LAB VOCABULARY"), "after the vocabulary");
  assert.match(p, /not a replacement table/i);
  assert.deepEqual(errors, []);
});

test("the prompt lists at most 60 pairs, most seen first", async () => {
  const pairs = Array.from({ length: 80 }, (_, i) => ({ heard: "h" + String(i).padStart(2, "0"), said: "s" + i, n: i + 1, at: "2026-01-01T00:00:00.000Z" }));
  const { page, errors } = await openFix({ sampleScript: fixScript([]), voice: { pairs } });
  await fixOnce(page);
  const p = (await page.evaluate(() => window.__prompts))[0];
  assert.equal((p.match(/^h\d\d → s\d+ \(\d+\)$/gm) || []).length, 60);
  assert.match(p, /h79 → s79 \(80\)/); assert.ok(!p.includes("h19 →"));
  assert.deepEqual(errors, []);
});

test("config/voice is capped at 300 pairs, dropping the least seen and oldest", async () => {
  const pairs = Array.from({ length: 300 }, (_, i) => ({ heard: "old" + i, said: "x", n: 1, at: new Date(2020, 0, 1, 0, 0, i).toISOString() }));
  const { page, errors } = await openFix({ sampleScript: fixScript([NUCLEO]), voice: { pairs } });
  await fixOnce(page);
  const v = await voiceOf(page);
  assert.equal(v.pairs.length, 300);
  assert.ok(v.pairs.some(p => p.heard === "new cliff fiction"), "the new pair stays");
  assert.ok(!v.pairs.some(p => p.heard === "old0"), "the oldest least-seen pair went");
  assert.deepEqual(errors, []);
});

test("a failed write to config/voice does not break fixing", async () => {
  const { page, errors } = await openFix({ sampleScript: fixScript([NUCLEO]) });
  await page.evaluate(() => { window.claude.use = (u => async n => { const r = await u(n); if (n !== "db") return r; return { ...r, doc: p => { const d = r.doc(p); return p === "config/voice" ? { ...d, set: async () => { throw { code: "unavailable", message: "offline" }; } } : d; } }; })(window.claude.use); });
  await page.reload(); await page.waitForTimeout(300);
  await openBook(page); await page.tap("#tText"); await fixOnce(page);
  assert.equal((await page.evaluate(() => window.__store.entries.e1.blocks[0].text)), "doing nucleofection for the plates");
  assert.deepEqual(errors, []);
});

test("Settings shows what was learned and Forget (tap twice) clears it", async () => {
  const seed = { pairs: [{ heard: "a", said: "b", n: 2, at: "2026-01-01T00:00:00.000Z" }, { heard: "c", said: "d", n: 1, at: "2026-01-01T00:00:00.000Z" }] };
  const { page, errors } = await open(IPHONE, { voice: seed });
  await page.tap("#openSettings");
  assert.match(await page.textContent("#vLearned"), /Learned from 3 corrections/);
  await page.tap("#vForget"); await page.waitForTimeout(100);
  assert.equal((await voiceOf(page)).pairs.length, 2, "first tap only arms it");
  await page.tap("#vForget"); await page.waitForTimeout(250);
  assert.deepEqual((await voiceOf(page)).pairs, []);
  assert.match(await page.textContent("#vLearned"), /Learned from 0 corrections/);
  assert.deepEqual(errors, []);
});

/* ---- Claude's own dictation (Chrome, Claude desktop); null on Safari/iPad ---- */
const emit = (page, kind, payload) => page.evaluate(([k, p]) => window.__dict.emit(k, p), [kind, payload]);
const dictCalls = async page => (await page.evaluate(() => window.__dict.calls));

test("with Claude's dictation: Dictate starts it, partial shows, finals append, Stop runs Fix terms", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry([textBlock("a", "x")]), glossary: ["nucleofection"], dictation: true, settings: { lang: "tr-TR" } });
  await openBook(page); await page.click("#tDict"); await page.waitForTimeout(50);
  assert.deepEqual(await dictCalls(page), [{ fn: "start", language: "tr" }]);
  await emit(page, "partial", { text: "new cliff" });
  assert.equal(await page.textContent("#interim"), "new cliff"); assert.ok(await page.isVisible("#interim"));
  await emit(page, "final", { text: " new cliff fiction" });
  assert.equal(await page.inputValue("#compTa"), "new cliff fiction", "leading space trimmed on an empty box");
  await emit(page, "partial", { text: "" });
  assert.ok(!(await page.isVisible("#interim")));
  await emit(page, "final", { text: " for the plates" });
  assert.equal(await page.inputValue("#compTa"), "new cliff fiction for the plates");
  assert.match(await page.textContent("#tDictLabel"), /Stop/);
  await page.click("#tDict"); await page.waitForTimeout(400);
  assert.equal((await dictCalls(page)).at(-1).fn, "stop");
  assert.equal(await page.evaluate(() => window.__prompts.length), 2, "Fix terms ran after stopping");
  assert.match(await page.textContent("#tDictLabel"), /Dictate/);
  assert.deepEqual(errors, []);
});

test("with Claude's dictation: stopping with no words does not run Fix terms; the viewer's own Stop ends it", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry(), dictation: true });
  await openBook(page); await page.click("#tDict"); await page.waitForTimeout(50);
  await page.click("#tDict"); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__prompts.length), 0);
  await page.click("#tDict"); await page.waitForTimeout(50);
  await emit(page, "final", { text: " lysis buffer" });
  await emit(page, "state", { state: "idle", reason: "viewer_stopped" }); await page.waitForTimeout(400);
  assert.match(await page.textContent("#tDictLabel"), /Dictate/);
  assert.equal(await page.evaluate(() => window.__prompts.length), 2, "Fix terms ran after the platform's Stop");
  assert.deepEqual(errors, []);
});

test("not_granted: falls back to the old path and is not asked again in this page load", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry(), dictation: { rejectStart: "not_granted" } });
  await openBook(page); await page.click("#tDict"); await page.waitForTimeout(300);
  assert.equal((await dictCalls(page)).filter(c => c.fn === "start").length, 1);
  if (await page.locator("#tDict.rec").count()) { await page.click("#tDict"); await page.waitForTimeout(200); }
  await page.click("#tDict"); await page.waitForTimeout(300);
  assert.equal((await dictCalls(page)).filter(c => c.fn === "start").length, 1, "start was not called again");
  assert.deepEqual(errors, []);
});

test("without the dictation capability the page behaves as before", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: entry() });
  assert.equal(await page.evaluate(() => window.__dict.calls.length), 0);
  await openBook(page); await page.click("#tDict"); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__dict.calls.length), 0, "no Claude dictation call");
  assert.deepEqual(errors, []);
});
