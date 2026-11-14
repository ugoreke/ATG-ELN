// Ask Claude: a per-entry chat. Run with: npm test
// Protects what the owner asked for: questions instead of assumptions, to-the-point answers,
// full context, follow-ups, and a thread that is still there after looking at the entry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, keyboard, textBlock, IPHONE, IPAD_LANDSCAPE } from "./helpers.mjs";

after(close);

const PROTOCOLS = {
  "tc-passaging": { title: "TC: Passaging", category: "TC", kind: "protocol", text: "Passage at 80% confluence.\n" + "Wash with DPBS. ".repeat(900) + "\nEND-OF-PASSAGING-PROTOCOL" },
  "clo-digest": { title: "CLO: Restriction digest", category: "CLO", kind: "protocol", text: "Digest 1 ug DNA for 60 min at 37 C. DIGEST-ONLY-DETAIL" }
};
const linked = (blocks, protocols = ["tc-passaging"]) => ({ e1: { title: "261114_PAPA_Dilution", createdAt: new Date().toISOString(), protocols, blocks } });
const ask = async (page, q) => { await page.fill("#askQ", q); await page.click("#askGo"); await page.waitForTimeout(250); };
const calls = page => page.evaluate(() => window.__calls);

test("Ask tells Claude to ask before assuming and sends the whole entry and linked protocols in full", async () => {
  const blocks = Array.from({ length: 95 }, (_, i) => textBlock("b" + i, "line number " + i));
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: linked(blocks), protocols: PROTOCOLS, sampleScript: `return { text: "Which construct: pTG825 or pTG1313?", modelTierApplied: "default" };` });
  await page.click('[data-open="e1"]'); await page.click("#askBtn");
  await ask(page, "Tabulate the serial dilution amounts to have 200 cells per plate");
  const [c] = await calls(page);
  assert.ok(Array.isArray(c.input), "sent as a conversation");
  const rules = c.input[0].content;
  assert.match(rules, /ask/i); assert.match(rules, /assum/i, "rules cover assumptions");
  assert.match(rules, /line number 0\b/, "oldest line is included (was cut at 80)");
  assert.match(rules, /END-OF-PASSAGING-PROTOCOL/, "linked protocol is sent in full");
  assert.match(rules, /clo-digest/, "library lists protocols that are not linked");
  assert.ok(!rules.includes("DIGEST-ONLY-DETAIL"), "unlinked protocol text is fetched on demand, not sent every time");
  assert.equal(c.input.at(-1).content, "Tabulate the serial dilution amounts to have 200 cells per plate");
  assert.deepEqual(c.tools.sort(), ["read_entry", "read_protocol", "search_entries"]);
  assert.match(await page.textContent(".msg.claude"), /pTG825 or pTG1313/);
  assert.deepEqual(errors, []);
});

test("a follow-up carries the earlier turns, and the thread is still there after closing the sheet", async () => {
  const { page, errors } = await open(IPHONE, { entries: linked([textBlock("a", "pTG825 at 1.2e6 cells/ml")], []), sampleScript: `return { text: "answer " + input.filter(t => t.role === "user").length, modelTierApplied: "default" };` });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn");
  await ask(page, "first question"); await ask(page, "pTG825, 5 ml");
  const c = (await calls(page))[1];
  assert.deepEqual(c.input.slice(1).map(t => t.role), ["user", "assistant", "user"]);
  assert.equal(c.input[2].content, "answer 2");
  await page.tap(".sheet [data-close]"); await page.waitForTimeout(100);
  assert.equal(await page.locator(".sheet").count(), 0);
  await page.tap("#askBtn"); await page.waitForTimeout(100);
  assert.equal(await page.locator(".msg.user").count(), 2, "both questions are back");
  assert.equal(await page.locator(".msg.claude").count(), 2);
  await page.tap("#askNew"); await page.waitForTimeout(100);
  assert.equal(await page.locator(".msg").count(), 0, "New chat clears it");
  await ask(page, "fresh");
  assert.equal((await calls(page))[2].input.length, 2, "new chat starts without old turns");
  assert.deepEqual(errors, []);
});

test("an answer still being written when the sheet is closed is in the thread on return", async () => {
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript: `await new Promise(r => setTimeout(r, 400)); return { text: "late answer", modelTierApplied: "default" };` });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn");
  await page.fill("#askQ", "slow one"); await page.tap("#askGo"); await page.waitForTimeout(80);
  await page.tap(".sheet [data-close]"); await page.waitForTimeout(600);
  await page.tap("#askBtn"); await page.waitForTimeout(100);
  assert.match(await page.textContent(".msg.claude"), /late answer/);
  assert.deepEqual(errors, []);
});

test("tables render as tables and HTML in an answer stays text", async () => {
  const text = "Step 3 is the final tube.\n\n| Step | Take | Add media |\n|---|---|---|\n| 1 | 10 ul | 990 ul |\n\n<img src=x onerror='window.__xss=1'><script>window.__xss=1</script>";
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript: `return { text: ${JSON.stringify(text)}, modelTierApplied: "default" };` });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn"); await ask(page, "table please");
  assert.equal(await page.locator(".msg.claude table tr").count(), 2);
  assert.equal(await page.locator(".msg.claude img, .msg.claude script").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "wide table scrolls inside its box");
  assert.deepEqual(errors, []);
});

test("Claude can read an unlinked protocol and search other entries through tools", async () => {
  const entries = { ...linked([textBlock("a", "today")], []), e2: { title: "261101_Old", createdAt: "2026-11-01T10:00:00Z", protocols: [], blocks: [textBlock("z", "pTG825 counted at 1.2e6 cells/ml")] } };
  const sampleScript = `
    const tool = n => opts.tools.find(t => t.name === n);
    const p = await tool("read_protocol").execute({ id: "clo-digest" }, {});
    const s = await tool("search_entries").execute({ query: "pTG825" }, {});
    const e = await tool("read_entry").execute({ id: "e2" }, {});
    let bad = ""; try { await tool("read_protocol").execute({ id: "nope" }, {}); } catch (err) { bad = String(err.message); }
    return { text: JSON.stringify({ p, s, e, bad }), modelTierApplied: "default" };`;
  const { page, errors } = await open(IPHONE, { entries, protocols: PROTOCOLS, sampleScript });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn"); await ask(page, "look it up");
  const out = await page.textContent(".msg.claude");
  assert.match(out, /DIGEST-ONLY-DETAIL/); assert.match(out, /261101_Old/); assert.match(out, /1\.2e6/);
  assert.match(out, /No protocol/i, "an unknown id is reported back to Claude, not thrown at the page");
  assert.deepEqual(errors, []);
});

test("photos are not sent unless the Settings switch is on", async () => {
  const img = "data:image/png;base64,iVBORw0KGgo=";
  const blocks = [{ id: "p", type: "photo", url: img, caption: "gel", at: new Date().toISOString() }, { id: "i", type: "ink", url: img, caption: "", transcript: "", at: new Date().toISOString() }];
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: linked(blocks, []), sampleScript: `return { text: "ok", modelTierApplied: "default" };` });
  await page.click("#openSettings"); await page.waitForTimeout(100);
  assert.equal(await page.getAttribute("#sAskPhotos", "aria-checked"), "false", "off by default");
  await page.click(".sheet [data-close]");
  await page.click('[data-open="e1"]'); await page.click("#askBtn"); await ask(page, "what is on the gel?");
  assert.equal((await calls(page))[0].images, 0);
  await page.click(".sheet [data-close]"); await page.click("#openSettings"); await page.click("#sAskPhotos"); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__store.config.settings.askPhotos), true, "switch is saved");
  await page.click(".sheet [data-close]");
  await page.click("#askBtn"); await ask(page, "and now?");
  assert.equal((await calls(page))[1].images, 2);
  assert.deepEqual(errors, []);
});

test("Claude's questions are answered by tapping: one tap each, sent when all are answered", async () => {
  const sampleScript = `const n = input.filter(t => t.role === "user").length;
    return { text: n === 2 ? "Before I tabulate:\\n1. Which sample? [pTG825] [pTG1313] [both]\\n2. Final volume? [5 ml] [10 ml]" : n === 3 ? "1. Steps? [2] [3]" : "done", modelTierApplied: "default" };`;
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn"); await ask(page, "tabulate the dilution");
  assert.match((await calls(page))[0].input[0].content, /\[/, "rules tell Claude to offer options in square brackets");
  assert.equal(await page.locator(".msg.claude [data-opt]").count(), 5);
  assert.ok(!(await page.textContent(".msg.claude")).includes("["), "brackets become buttons");
  await page.tap('[data-opt]:text-is("pTG1313")'); await page.waitForTimeout(200);
  assert.equal((await calls(page)).length, 1, "waits for the second answer");
  assert.equal(await page.getAttribute('[data-opt]:text-is("pTG1313")', "aria-pressed"), "true");
  await page.tap('[data-opt]:text-is("10 ml")'); await page.waitForTimeout(300);
  assert.equal((await calls(page))[1].input.at(-1).content, "1. pTG1313\n2. 10 ml");
  await page.tap('[data-opt]:text-is("3")'); await page.waitForTimeout(300);
  assert.equal((await calls(page))[2].input.at(-1).content, "3", "a single question sends on one tap");
  assert.equal(await page.locator("[data-opt]").count(), 0, "answered questions are no longer tappable");
  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  assert.deepEqual(errors, []);
});

test("a failed answer is shown in the thread and Try again resends the question", async () => {
  const sampleScript = `if (!window.__failed) { window.__failed = 1; throw { code: "upstream_error", message: "boom" }; } return { text: "second time lucky", modelTierApplied: "default" };`;
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn"); await ask(page, "will this fail?");
  assert.ok(await page.isVisible(".msg.err"), "error is visible");
  assert.equal(await page.inputValue("#askQ"), "", "question is in the thread, not lost");
  await page.tap("[data-retry]"); await page.waitForTimeout(250);
  assert.match(await page.textContent(".msg.claude"), /second time lucky/);
  assert.equal(await page.locator(".msg.err").count(), 0);
  assert.deepEqual((await calls(page))[1].input.slice(1).map(t => t.content), ["will this fail?"], "the question is sent once");
  assert.deepEqual(errors, []);
});

test("an answer that breaks off part-way can be retried (the partial is not kept as a turn)", async () => {
  const sampleScript = `if (!window.__failed) { window.__failed = 1; throw { code: "upstream_error", message: "dropped", text: "Half an ans" }; } return { text: "whole answer", modelTierApplied: "default" };`;
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn"); await ask(page, "question");
  assert.ok(await page.isVisible(".msg.err"));
  await page.tap("[data-retry]"); await page.waitForTimeout(250);
  assert.equal((await calls(page))[1].input.at(-1).role, "user", "retry still ends on the question");
  assert.match(await page.textContent(".msg.claude"), /whole answer/);
  assert.equal(await page.locator(".msg.claude").count(), 1);
  assert.deepEqual(errors, []);
});

test("Opus thinks at high effort; Add as line saves the answer to the entry", async () => {
  const { page, errors } = await open(IPHONE, { entries: linked([], []), sampleScript: `return { text: "Use 833 ul.", modelApplied: "claude-opus-5-5", modelTierApplied: "complex" };` });
  await page.tap('[data-open="e1"]'); await page.tap("#askBtn");
  await page.selectOption("#askModel", "claude-opus-5-5"); await ask(page, "how much?");
  const [c] = await calls(page);
  assert.equal(c.model, "claude-opus-5-5"); assert.equal(c.effort, "high");
  assert.match(await page.textContent(".msg.claude .byline"), /Claude Opus 5\.5/);
  await page.tap(".msg.claude [data-add]"); await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => window.__store.entries.e1.blocks)).at(-1).text, "Claude: Use 833 ul.");
  assert.deepEqual(errors, []);
});

for (const [name, vp] of [["iPad landscape", IPAD_LANDSCAPE], ["iPhone", IPHONE]]) {
  test(`keyboard open on ${name}: the Ask box and Send stay on screen`, async () => {
    const { page, errors } = await open(vp, { entries: linked([], []) });
    await page.click('[data-open="e1"]'); await page.click("#askBtn"); await page.click("#askQ"); await keyboard(page);
    const m = await page.evaluate(() => ({ vh: visualViewport.height, go: document.querySelector("#askGo").getBoundingClientRect().bottom, q: document.querySelector("#askQ").getBoundingClientRect().top }));
    assert.ok(m.go <= m.vh + 1, `Send at ${m.go} within ${m.vh}`); assert.ok(m.q >= 0);
    assert.deepEqual(errors, []);
  });
}
