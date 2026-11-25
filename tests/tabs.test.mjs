// The five tabs: Daily, Notebooks, Meetings, To-do, Docs. Each test names the behaviour it protects.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, close, tab, openBook, keyboard, IPHONE, IPAD_LANDSCAPE, IPAD_PORTRAIT, VIEWPORTS } from "./helpers.mjs";

after(close);

const daysAgo = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const lineAt = (id, text, at) => ({ id, type: "text", text, at });
const book = (title, blocks = [], extra = {}) => ({ title, createdAt: blocks[0]?.at || new Date().toISOString(), updatedAt: new Date().toISOString(), protocols: [], blocks, ...extra });
const store = (page, path) => page.evaluate(p => p.split("/").reduce((o, k) => o && o[k], window.__store), path);
const headers = page => page.locator("#lines .day b").allTextContents();
const shownLines = page => page.locator("#lines textarea.ta:not(.cap)").evaluateAll(n => n.map(x => x.value));
async function addLine(page, text) { await page.locator("#tText").click(); await page.fill("#compTa", text); await page.locator("#compAdd").click(); await page.waitForTimeout(150); }

test("Daily is the home view: a line can be added straight away and is stored in logs/daily", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE);
  assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), "Daily");
  await addLine(page, "thawed a vial"); await addLine(page, "changed media");
  assert.deepEqual((await store(page, "logs/daily")).blocks.map(b => b.text), ["thawed a vial", "changed media"]);
  assert.equal(Object.keys(await store(page, "entries")).length, 0, "no titled entry was created");
  assert.deepEqual(errors, []);
});

test("Daily spans days under Day headers and shows no Benchling flags", async () => {
  const blocks = [lineAt("a", "first day", daysAgo(3)), lineAt("b", "next day", daysAgo(2)), lineAt("c", "today", daysAgo(0))];
  const { page, errors } = await open(IPHONE, { logs: { daily: { blocks, protocols: [] } } });
  assert.deepEqual(await headers(page), ["Day 1", "Day 2", "Day 3"]);
  assert.equal(await page.locator(".chip").count(), 0);
  assert.ok(!/Benchling|transfer/i.test(await page.locator("#editor").innerText()), "nothing about transfer state on the page");
  await addLine(page, "one more");
  assert.deepEqual((await store(page, "logs/daily")).blocks.map(b => b.id).slice(0, 3), ["a", "b", "c"], "earlier lines are kept");
  assert.equal(await page.locator('[data-act="move"]').count(), 0, "lines can't be moved by hand out of Daily");
  assert.deepEqual(errors, []);
});

test("a transfer moves lines from Daily to a notebook: Daily shows only what is left", async () => {
  const blocks = [lineAt("a", "nucleofected KOLF", daysAgo(1)), lineAt("b", "imaged plate 2", daysAgo(0))];
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks, protocols: [] } }, entries: { n1: book("261120_Demo_KOLF_Nucleofection") } });
  await page.evaluate(() => window.__remote(s => {   // what the session's one batch does
    const moved = s.logs.daily.blocks.filter(b => b.id === "a");
    s.entries.n1.blocks = [...s.entries.n1.blocks, ...moved];
    s.logs.daily = { ...s.logs.daily, blocks: s.logs.daily.blocks.filter(b => b.id !== "a"), moved: { a: { to: "n1", at: new Date().toISOString() } } };
  }));
  await page.waitForTimeout(150);
  assert.deepEqual(await shownLines(page), ["imaged plate 2"]);
  await openBook(page, "n1");
  assert.deepEqual(await shownLines(page), ["nucleofected KOLF"], "the moved line is in the notebook, word for word");
  assert.deepEqual(errors, []);
});

test("a moved line never comes back, even when this device saves an older copy of Daily afterwards", async () => {
  const blocks = [lineAt("a", "line being edited", daysAgo(0, 9)), lineAt("b", "line the session moves", daysAgo(0, 10))];
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks, protocols: [] } }, entries: { n1: book("261120_Demo") } });
  await page.locator('[data-key="b:a"] textarea.ta').click(); await page.keyboard.press("End"); await page.keyboard.type(" more");   // unsaved change: this device now holds its own copy
  await page.evaluate(() => window.__remote(s => {
    s.entries.n1.blocks = [...s.entries.n1.blocks, ...s.logs.daily.blocks.filter(b => b.id === "b")];
    s.logs.daily = { ...s.logs.daily, blocks: s.logs.daily.blocks.filter(b => b.id !== "b"), moved: { b: { to: "n1", at: new Date().toISOString() } } };
  }));
  await page.waitForTimeout(1500);   // the device's save lands after the session's write
  const daily = await store(page, "logs/daily");
  assert.deepEqual(daily.blocks.map(b => b.id), ["a"], "the stored log has no moved line");
  assert.ok(daily.blocks[0].text.endsWith(" more"), "the edit was saved");
  assert.ok(daily.moved.b, "the moved list is untouched by the device's save");
  assert.deepEqual((await store(page, "entries/n1")).blocks.map(b => b.id), ["b"], "exactly once in the notebook");
  assert.deepEqual(await shownLines(page), ["line being edited more"]);
  assert.deepEqual(errors, []);
});

test("a stored Daily log that still holds a moved line is cleaned, once", async () => {
  const blocks = [lineAt("a", "left", daysAgo(0, 9)), lineAt("b", "already moved", daysAgo(0, 10))];
  const { page, errors } = await open(IPHONE, { logs: { daily: { blocks, protocols: [], moved: { b: { to: "n1", at: daysAgo(0, 11) } } } } });
  await page.waitForTimeout(300);
  assert.deepEqual(await shownLines(page), ["left"]);
  assert.deepEqual((await store(page, "logs/daily")).blocks.map(b => b.id), ["a"]);
  assert.deepEqual(errors, []);
});

test("lines a session adds to a notebook survive this device's unsaved edit of the same notebook", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: { n1: book("261120_Demo", [lineAt("x", "old line", daysAgo(1))]) } });
  await openBook(page, "n1");
  await page.locator('[data-key="b:x"] textarea.ta').click(); await page.keyboard.press("End"); await page.keyboard.type("!");
  await page.evaluate(at => window.__remote(s => { s.entries.n1.blocks = [...s.entries.n1.blocks, { id: "moved1", type: "text", text: "arrived from Daily", at }]; }), daysAgo(0));
  await page.waitForTimeout(1500);
  const n1 = await store(page, "entries/n1");
  assert.deepEqual(n1.blocks.map(b => b.id).sort(), ["moved1", "x"]);
  assert.equal(n1.blocks.find(b => b.id === "x").text, "old line!");
  assert.deepEqual(errors, []);
});

test("a save reads the stored notebook first: a line and a rename that arrived without a snapshot are kept", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: { n1: book("short name", [lineAt("x", "old line", daysAgo(1))]) } });
  await openBook(page, "n1");
  await page.evaluate(at => window.__remoteQuiet(s => { s.entries.n1 = { ...s.entries.n1, title: "261120_Benchling_Name", blocks: [...s.entries.n1.blocks, { id: "moved1", type: "text", text: "arrived from Daily", at }] }; }), daysAgo(0));
  await page.locator('[data-key="b:x"] textarea.ta').click(); await page.keyboard.press("End"); await page.keyboard.type("!"); await page.waitForTimeout(1300);
  const n1 = await store(page, "entries/n1");
  assert.deepEqual(n1.blocks.map(b => b.id).sort(), ["moved1", "x"], "the device's save did not drop the moved line");
  assert.equal(n1.title, "261120_Benchling_Name", "the session's rename was not undone");
  assert.equal(n1.blocks.find(b => b.id === "x").text, "old line!");
  assert.deepEqual(errors, []);
});

test("text typed but not yet added is still in the box after switching tabs and coming back", async () => {
  const { page, errors } = await open(IPHONE, { entries: { n1: book("261120_Demo") } });
  await page.locator("#tText").click(); await page.fill("#compTa", "half a thought");
  await tab(page, "notebooks"); await page.locator('[data-open="n1"]').click();
  assert.ok(!(await page.isVisible("#compTa")), "another place has its own empty box");
  await page.locator("#back").click(); await tab(page, "daily");
  assert.equal(await page.inputValue("#compTa"), "half a thought");
  await page.locator("#compAdd").click(); await page.waitForTimeout(150); await tab(page, "todo"); await tab(page, "daily");
  assert.ok(!(await page.isVisible("#compTa")), "once added, the draft is gone");
  assert.deepEqual((await store(page, "logs/daily")).blocks.map(b => b.text), ["half a thought"]);
  assert.deepEqual(errors, []);
});

test("notebook headers count days, then weeks, from the first line", async () => {
  const blocks = [lineAt("a", "start", daysAgo(15)), lineAt("b", "7th day", daysAgo(9)), lineAt("c", "8th day", daysAgo(8)), lineAt("d", "15 days after the first", daysAgo(0))];
  const { page, errors } = await open(IPAD_PORTRAIT, { entries: { n1: book("261110_Demo", blocks) } });
  await openBook(page, "n1");
  assert.deepEqual(await headers(page), ["Day 1", "Day 7", "Week 1, Day 1", "Week 2, Day 2"]);
  assert.deepEqual(errors, []);
});

test("a notebook line can be moved to another notebook, or copied with the switch on", async () => {
  const entries = { n1: book("A_source", [lineAt("a", "goes away", daysAgo(1)), lineAt("b", "gets copied", daysAgo(0))]), n2: book("B_target"), m1: book("C_meeting", [], { kind: "meeting" }) };
  const { page, errors } = await open(IPHONE, { entries });
  await openBook(page, "n1");
  await page.locator('[data-key="b:a"] textarea.ta').click(); await page.locator('[data-key="b:a"] [data-act="move"]').click();
  await page.locator('[data-dest="n2"]').click(); await page.waitForTimeout(300);
  assert.deepEqual((await store(page, "entries/n1")).blocks.map(b => b.id), ["b"]);
  assert.deepEqual((await store(page, "entries/n2")).blocks.map(b => [b.id, b.text, b.at]), [["a", "goes away", entries.n1.blocks[0].at]], "moved verbatim, same time");
  await page.locator('[data-key="b:b"] textarea.ta').click(); await page.locator('[data-key="b:b"] [data-act="move"]').click();
  await page.locator("#keepCopy").click(); await page.locator('[data-dest="n2"]').click(); await page.waitForTimeout(300);
  assert.deepEqual((await store(page, "entries/n1")).blocks.map(b => b.text), ["gets copied"], "the original stays");
  const n2 = (await store(page, "entries/n2")).blocks;
  assert.deepEqual(n2.map(b => b.text).sort(), ["gets copied", "goes away"]);
  assert.notEqual(n2.find(b => b.text === "gets copied").id, "b", "the copy has its own id");
  assert.deepEqual(errors, []);
});

test("a move whose destination can't be saved leaves the line where it was", async () => {
  const entries = { n1: book("A_source", [lineAt("a", "must not be lost", daysAgo(0))]), n2: book("B_target") };
  const { page, errors } = await open(IPHONE, { entries, failFirstUpdate: true });
  await openBook(page, "n1");
  await page.locator('[data-key="b:a"] textarea.ta').click(); await page.locator('[data-act="move"]').click();
  await page.locator('[data-dest="n2"]').click(); await page.waitForTimeout(400);
  assert.deepEqual(await shownLines(page), ["must not be lost"]);
  assert.ok(await page.isVisible("#saveBanner"), "the problem is shown at the top");
  await page.waitForTimeout(5600);   // the retry must not move it after all
  assert.deepEqual((await store(page, "entries/n1")).blocks.map(b => b.id), ["a"]);
  assert.deepEqual((await store(page, "entries/n2")).blocks, []);
  assert.deepEqual(errors, []);
});

test("Meetings is a list of meetings: pick one to see its lines; notebooks and meetings stay apart", async () => {
  const entries = { n1: book("261120_Notebook", [lineAt("a", "bench line", daysAgo(0))]), m1: book("261116_TechMeeting", [lineAt("b", "meeting note", daysAgo(0))], { kind: "meeting" }) };
  const { page, errors } = await open(IPHONE, { entries });
  await tab(page, "meetings");
  assert.deepEqual(await page.locator("#list .item .t").allTextContents(), ["261116_TechMeeting"]);
  assert.ok(!(await page.isVisible("#lines")), "no lines until a meeting is picked");
  await page.locator('[data-open="m1"]').click();
  assert.deepEqual(await shownLines(page), ["meeting note"]);
  await page.locator("#back").click(); await page.locator("#newEntry").click(); await page.fill("#newTitle", "261125_LabMeeting"); await page.locator("#newCreate").click(); await page.waitForTimeout(200);
  const made = Object.values(await store(page, "entries")).find(e => e.title === "261125_LabMeeting");
  assert.equal(made.kind, "meeting");
  await tab(page, "notebooks");
  assert.deepEqual(await page.locator("#list .item .t").allTextContents(), ["261120_Notebook"]);
  assert.deepEqual(errors, []);
});

test("a meeting can be moved to Notebooks from its details", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: { m1: book("261116_TechMeeting", [lineAt("b", "note", daysAgo(0))], { kind: "meeting" }) } });
  await openBook(page, "m1", "meetings"); await page.locator("#moreBtn").click(); await page.locator("#swapKind").click(); await page.waitForTimeout(200);
  assert.equal((await store(page, "entries/m1")).kind, "notebook");
  assert.equal(await page.locator("#list .item").count(), 0);
  await tab(page, "notebooks");
  assert.equal(await page.locator("#list .item").count(), 1);
  assert.deepEqual(errors, []);
});

test("To-do: add, tick, and done items fold into a section ordered by when they were ticked", async () => {
  const { page, errors } = await open(IPHONE);
  await tab(page, "todo");
  for (const t of ["order primers", "book the confocal", "thaw WTC11"]) { await page.fill("#todoNew", t); await page.keyboard.press("Enter"); await page.waitForTimeout(60); }
  const tick = text => page.locator(".todo", { hasText: text }).locator(".ck").click();
  await tick("thaw WTC11"); await page.waitForTimeout(30); await tick("order primers"); await page.waitForTimeout(100);
  assert.deepEqual(await page.locator(".todo:not(.done) .tx").allTextContents(), ["book the confocal"]);
  assert.equal(await page.locator(".todo.done").count(), 0, "done items are folded away");
  assert.equal((await page.locator("#doneHead").textContent()).trim(), "Done (2)");
  await page.locator("#doneHead").click();
  assert.deepEqual(await page.locator(".todo.done .tx").allTextContents(), ["thaw WTC11", "order primers"], "earliest ticked first");
  assert.ok(await page.locator(".todo .when").first().isVisible(), "each item has a timestamp");
  await tick("thaw WTC11"); await page.waitForTimeout(100);
  assert.deepEqual(await page.locator(".todo:not(.done) .tx").allTextContents(), ["book the confocal", "thaw WTC11"], "unticking puts it back");
  const saved = (await store(page, "logs/todo")).items;
  assert.deepEqual(saved.map(i => [i.text, !!i.doneAt]), [["order primers", true], ["book the confocal", false], ["thaw WTC11", false]]);
  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  assert.deepEqual(errors, []);
});

test("To-do: stored (frozen) items load, and a failed save is shown and retried", async () => {
  const items = [{ id: "t1", text: "existing item", at: daysAgo(1), doneAt: null }];
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { todo: { items } }, failSetOnce: "logs/todo" });
  await tab(page, "todo");
  await page.locator(".todo .ck").click(); await page.waitForTimeout(200);
  assert.ok(await page.isVisible("#todoBanner"), "warning shown");
  await page.waitForTimeout(5500);
  assert.ok(!(await page.isVisible("#todoBanner")), "warning cleared");
  assert.ok((await store(page, "logs/todo")).items[0].doneAt, "the tick was saved by the retry");
  assert.deepEqual(errors, []);
});

test("Docs lists the protocol library and opens a protocol to read", async () => {
  const protocols = { p1: { title: "Passaging iPSCs", category: "Culture", kind: "protocol", text: "1. Aspirate media." } };
  const { page, errors } = await open(IPHONE, { protocols });
  await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; });
  await tab(page, "docs");
  await page.locator('[data-doc="p1"]').click();
  assert.ok((await page.locator(".sheet .doc").innerText()).includes("Aspirate media"));
  assert.deepEqual(errors, []);
});

test("each place has its own Ask chat: Daily, a notebook and a meeting", async () => {
  const entries = { n1: book("261120_Notebook", [lineAt("a", "counted 1.2e6 per ml", daysAgo(0))]), m1: book("261116_Meeting", [lineAt("b", "agreed to repeat", daysAgo(0))], { kind: "meeting" }) };
  const logs = { daily: { blocks: [lineAt("d", "daily line about Accutase", daysAgo(0))], protocols: [] } };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries, logs, sampleScript: `return { text: "answer", modelTierApplied: "default" };` });
  const ask = async q => { await page.locator("#askBtn").click(); await page.fill("#askQ", q); await page.locator("#askGo").click(); await page.waitForTimeout(250); await page.locator(".sheet [data-close]").first().click(); };
  await ask("from daily"); await openBook(page, "n1"); await ask("from notebook"); await openBook(page, "m1", "meetings"); await ask("from meeting");
  const prompts = await page.evaluate(() => window.__prompts);
  assert.ok(prompts[0].includes("daily line about Accutase") && !prompts[0].includes("from notebook"));
  assert.ok(prompts[1].includes("counted 1.2e6 per ml") && !prompts[1].includes("from daily"), "the notebook chat starts fresh and sees the notebook");
  assert.ok(prompts[2].includes("agreed to repeat") && !prompts[2].includes("from notebook"));
  await tab(page, "daily"); await page.locator("#askBtn").click();
  assert.deepEqual(await page.locator(".msg.user").allTextContents(), ["from daily"], "Daily's chat is still there");
  assert.deepEqual(errors, []);
});

/* ---------- custom tabs and editing ---------- */
async function addTab(page, name, type) {
  await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; n.scrollTop = n.scrollHeight; });
  await page.locator("#addTab").click(); await page.fill("#tabName", name); await page.locator(`[data-type="${type}"]`).click(); await page.locator("#tabCreate").click(); await page.waitForTimeout(200);
  return (await store(page, "config/tabs")).tabs.find(t => t.name === name).id;
}

test("the plus button after Docs offers five kinds of tab", async () => {
  const { page, errors } = await open(IPHONE);
  const order = await page.locator("#tabs > *").evaluateAll(n => n.map(x => x.id || x.dataset.tab));
  assert.deepEqual(order, ["daily", "notebooks", "meetings", "todo", "docs", "addTab"]);
  await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; });
  await page.locator("#addTab").click();
  assert.deepEqual(await page.locator(".ttype b").allTextContents(), ["Running log", "Collection", "Sessions", "Checklist", "Library"]);
  await page.locator("#tabCreate").click(); await page.waitForTimeout(100);
  assert.equal(await store(page, "config/tabs"), undefined, "nothing is created without a name and a kind");
  assert.deepEqual(errors, []);
});

test("a custom Checklist tab keeps its own items, apart from To-do", async () => {
  const { page, errors } = await open(IPHONE, { logs: { todo: { items: [{ id: "t", text: "in to-do", at: daysAgo(0), doneAt: null }] } } });
  const id = await addTab(page, "Orders", "checklist");
  assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), "Orders", "the new tab opens");
  assert.equal(await page.locator(".pane-head h2").textContent(), "Orders");
  await page.fill("#todoNew", "StemFlex"); await page.keyboard.press("Enter"); await page.waitForTimeout(150);
  assert.deepEqual((await store(page, "logs/" + id)).items.map(i => i.text), ["StemFlex"]);
  assert.deepEqual((await store(page, "logs/todo")).items.map(i => i.text), ["in to-do"]);
  await tab(page, "todo");
  assert.deepEqual(await page.locator(".todo .tx").allTextContents(), ["in to-do"]);
  assert.deepEqual(errors, []);
});

test("a custom Running log tab stores its lines in its own log, and Daily is untouched", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks: [lineAt("d", "daily line", daysAgo(0))], protocols: [] } } });
  const id = await addTab(page, "Imaging", "log");
  assert.equal(await page.inputValue("#title"), "Imaging");
  await addLine(page, "confocal, 63x oil");
  assert.deepEqual((await store(page, "logs/" + id)).blocks.map(b => b.text), ["confocal, 63x oil"]);
  assert.deepEqual((await store(page, "logs/daily")).blocks.map(b => b.text), ["daily line"]);
  assert.deepEqual(await headers(page), ["Day 1"]);
  await page.locator("#lines textarea.ta").first().click();
  assert.equal(await page.locator('[data-act="move"]').count(), 0);
  await tab(page, "daily"); assert.deepEqual(await shownLines(page), ["daily line"]);
  assert.deepEqual(errors, []);
});

test("a custom Collection tab has its own pages, which Notebooks and Meetings do not show", async () => {
  const { page, errors } = await open(IPHONE, { entries: { n1: book("261120_Notebook") } });
  const id = await addTab(page, "Reagents", "pages");
  await page.locator("#newEntry").click(); await page.fill("#newTitle", "Antibodies"); await page.locator("#newCreate").click(); await page.waitForTimeout(200);
  await addLine(page, "anti-GFP, 1:500");
  const made = Object.values(await store(page, "entries")).find(e => e.title === "Antibodies");
  assert.equal(made.kind, id); assert.deepEqual(made.blocks.map(b => b.text), ["anti-GFP, 1:500"]);
  await tab(page, "notebooks"); assert.deepEqual(await page.locator("#list .item .t").allTextContents(), ["261120_Notebook"]);
  await tab(page, "meetings"); assert.equal(await page.locator("#list .item").count(), 0);
  await tab(page, id); assert.deepEqual(await page.locator("#list .item .t").allTextContents(), ["Antibodies"]);
  assert.deepEqual(errors, []);
});

test("stored custom tabs load (frozen data); removing one hides it and keeps its data", async () => {
  const tabs = [{ id: "tab-abcd1234", name: "Orders", type: "checklist" }, { id: "tab-wxyz5678", name: "Papers", type: "library" }];
  const { page, errors } = await open(IPAD_LANDSCAPE, { tabs, logs: { "tab-abcd1234": { items: [{ id: "o1", text: "primers", at: daysAgo(0), doneAt: null }] } }, protocols: PROTOCOLS });
  assert.deepEqual(await page.locator("#tabs .tab[data-tab]").allTextContents(), ["Daily", "Notebooks", "Meetings", "To-do", "Docs", "Orders", "Papers"]);
  await tab(page, "tab-wxyz5678"); assert.equal(await page.locator("[data-doc]").count(), 1);
  await tab(page, "tab-abcd1234"); assert.deepEqual(await page.locator(".todo .tx").allTextContents(), ["primers"]);
  await page.locator("#addTab").click();
  const rm = page.locator('[data-rmtab="tab-abcd1234"]'); await rm.click(); await rm.click(); await page.waitForTimeout(200);
  assert.deepEqual((await store(page, "config/tabs")).tabs.map(t => t.name), ["Papers"]);
  assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), "Daily", "the removed tab was showing, so Daily shows");
  assert.deepEqual((await store(page, "logs/tab-abcd1234")).items.map(i => i.text), ["primers"], "its items are kept");
  assert.deepEqual(errors, []);
});

test("a to-do item's text can be edited: Enter saves, Escape puts it back, an emptied box keeps the old text", async () => {
  const items = [{ id: "a", text: "order primmers", at: daysAgo(1), doneAt: null }, { id: "b", text: "done thing", at: daysAgo(1), doneAt: daysAgo(0) }];
  const { page, errors } = await open(IPHONE, { logs: { todo: { items } } });
  await tab(page, "todo");
  const text = id => store(page, "logs/todo").then(d => d.items.find(i => i.id === id).text);
  await page.locator('[data-todo="a"] .tx').click(); await page.fill(".tx-edit", "order primers for the knock-in"); await page.keyboard.press("Enter"); await page.waitForTimeout(150);
  assert.equal(await text("a"), "order primers for the knock-in");
  assert.equal(await page.locator('[data-todo="a"] span.tx').textContent(), "order primers for the knock-in");
  await page.locator('[data-todo="a"] .tx').click(); await page.fill(".tx-edit", "something else"); await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  assert.equal(await text("a"), "order primers for the knock-in", "Escape keeps the old text");
  await page.locator('[data-todo="a"] .tx').click(); await page.fill(".tx-edit", "   "); await page.locator(".pane-head h2").click(); await page.waitForTimeout(150);
  assert.equal(await text("a"), "order primers for the knock-in", "an emptied box changes nothing");
  await page.locator('[data-todo="a"] .tx').click(); await page.fill(".tx-edit", "saved by tapping away"); await page.locator(".pane-head h2").click(); await page.waitForTimeout(150);
  assert.equal(await text("a"), "saved by tapping away");
  await page.locator("#doneHead").click(); await page.locator('[data-todo="b"] .tx').click(); await page.fill(".tx-edit", "done thing, edited"); await page.keyboard.press("Enter"); await page.waitForTimeout(150);
  const b = (await store(page, "logs/todo")).items.find(i => i.id === "b");
  assert.equal(b.text, "done thing, edited"); assert.ok(b.doneAt, "editing a done item leaves it done");
  assert.equal((await store(page, "logs/todo")).items.find(i => i.id === "a").at, items[0].at, "the timestamp is unchanged");
  assert.deepEqual(errors, []);
});

test("adding a tab keeps tabs stored by another device, and entries this version doesn't know", async () => {
  const { page, errors } = await open(IPHONE);
  await page.evaluate(() => window.__remoteQuiet(s => { s.config.tabs = { tabs: [{ id: "tab-other123", name: "Elsewhere", type: "log" }, { id: "tab-future99", name: "Future", type: "kanban" }] }; }));
  await addTab(page, "Mine", "checklist");
  const stored = (await store(page, "config/tabs")).tabs;
  assert.deepEqual(stored.map(t => t.name).sort(), ["Elsewhere", "Future", "Mine"]);
  assert.deepEqual(await page.locator("#tabs .tab[data-shade]").allTextContents(), ["Elsewhere", "Mine"], "an unknown kind of tab is kept but not shown");
  assert.deepEqual(errors, []);
});

test("a tab that could not be saved does not stay in the bar", async () => {
  const { page, errors } = await open(IPHONE, { failSetOnce: "config/tabs" });
  await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; });
  await page.locator("#addTab").click(); await page.fill("#tabName", "Ghost"); await page.locator('[data-type="log"]').click(); await page.locator("#tabCreate").click(); await page.waitForTimeout(200);
  assert.equal(await page.locator("#tabs .tab[data-shade]").count(), 0);
  assert.ok(await page.isVisible(".toast"), "the problem is shown");
  assert.deepEqual(errors, []);
});

test("ticking another item while one is being edited saves the edit and ticks, in one tap", async () => {
  const items = [{ id: "a", text: "first", at: daysAgo(1, 9), doneAt: null }, { id: "b", text: "second", at: daysAgo(1, 10), doneAt: null }];
  const { page, errors } = await open(IPHONE, { logs: { todo: { items } } });
  await tab(page, "todo");
  await page.locator('[data-todo="a"] .tx').click(); await page.fill(".tx-edit", "first, edited");
  await page.locator('[data-todo="b"] .ck').click(); await page.waitForTimeout(200);
  const saved = (await store(page, "logs/todo")).items;
  assert.equal(saved.find(i => i.id === "a").text, "first, edited");
  assert.ok(saved.find(i => i.id === "b").doneAt, "the tick landed");
  assert.deepEqual(errors, []);
});

/* ---------- themes ---------- */
const lum = rgb => { const c = rgb.match(/[\d.]+/g).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const SKINS = ["default", "tide", "bloom", "saffron", "meadow"];
const MIN_CONTRAST = 4.5;

test("a theme picked in Settings is applied and saved in config/settings", async () => {
  const { page, errors } = await open(IPHONE);
  const before = await page.locator('.tab[data-tab="daily"]').evaluate(n => getComputedStyle(n).backgroundColor);
  await page.locator("#openSettings").click();
  assert.deepEqual(await page.locator("#sSkins .skin").evaluateAll(n => n.map(x => x.dataset.skin)), SKINS);
  await page.locator('.skin[data-skin="bloom"]').click(); await page.waitForTimeout(150);
  assert.equal((await store(page, "config/settings")).theme, "bloom");
  assert.notEqual(await page.locator('.tab[data-tab="daily"]').evaluate(n => getComputedStyle(n).backgroundColor), before);
  assert.equal(await page.locator('.skin[data-skin="bloom"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
});

for (const scheme of ["light", "dark"]) {
  test(`every theme is legible in ${scheme} mode: tabs are four distinct shades and text contrast is at least ${MIN_CONTRAST}`, async () => {
    for (const theme of SKINS) {
      const { page, errors } = await open(IPAD_LANDSCAPE, { settings: { theme } });
      await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), theme);
      const tabs = await page.locator("#tabs .tab").evaluateAll(n => n.map(x => { const c = getComputedStyle(x); return [c.backgroundColor, c.color]; }));
      assert.equal(new Set(tabs.slice(0, 4).map(t => t[0])).size, 4, `${theme}: four different shades`);
      tabs.forEach(([bg, fg], i) => assert.ok(ratio(bg, fg) >= MIN_CONTRAST, `${theme} ${scheme} tab ${i + 1}: ${ratio(bg, fg).toFixed(2)}`));
      await addLine(page, "a line to read");
      const pairs = await page.evaluate(() => {
        const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
        return { line: [css("#lines textarea.ta", "color"), css(".editor", "backgroundColor")], time: [css("#lines .tm", "color"), css(".editor", "backgroundColor")],
          primary: [css("#compAdd", "color"), css("#compAdd", "backgroundColor")], tool: [css("#tText", "color"), css("#tText", "backgroundColor")] };
      });
      for (const [name, [fg, bg]] of Object.entries(pairs)) assert.ok(ratio(fg, bg) >= MIN_CONTRAST, `${theme} ${scheme} ${name}: ${ratio(fg, bg).toFixed(2)}`);
      assert.deepEqual(errors, []);
      await page.context().close();
    }
  });
}

/* ---------- layout on the three sizes ---------- */
const PROTOCOLS = { p1: { title: "Passaging iPSCs feeder-free", category: "Culture", kind: "protocol", text: "1. Aspirate." } };
const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
const overflowing = page => page.evaluate(() => [...document.querySelectorAll("button")].filter(b => b.offsetParent && b.getClientRects().length)
  .filter(b => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1).map(b => (b.id || b.className) + ":" + b.textContent.trim().slice(0, 24)));

for (const [name, vp] of VIEWPORTS) {
  test(`${name}: all five tabs work, four are in view, and no label overflows its button`, async () => {
    const entries = { n1: book("261120_ProjectX_KOLF2.1J-NGN2_Nucleofection", [lineAt("a", "bench line", daysAgo(1)), { id: "i", type: "ink", assetId: "as1", url: PIXEL, caption: "", transcript: "", at: daysAgo(0) }]), n2: book("261121_Other"),
      m1: book("261116_TechMeeting", [lineAt("b", "note", daysAgo(0))], { kind: "meeting" }) };
    const { page, errors } = await open(vp, { entries, protocols: PROTOCOLS, logs: { daily: { blocks: [lineAt("d", "daily line", daysAgo(0))], protocols: [] }, todo: { items: [{ id: "t", text: "one thing", at: daysAgo(0), doneAt: daysAgo(0) }] } } });
    const wide = vp.width >= 900;
    const inView = await page.locator("#tabs .tab").evaluateAll(n => { const box = document.querySelector("#tabs").getBoundingClientRect(); return n.map(x => { const r = x.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; }); });
    assert.deepEqual(inView.slice(0, 4), [true, true, true, true], "the first four tabs are visible");
    if (!wide) assert.equal(inView[4], false, "Docs is reached by sliding the row");
    const sizes = await page.locator("#tabs .tab").evaluateAll(n => n.map(x => { const r = x.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    assert.ok(sizes.every(s => s >= 48), `tab tap targets ${sizes.map(Math.round)}`);
    const check = async where => { assert.deepEqual(await overflowing(page), [], `${where}: labels fit`); assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${where}: no sideways page scroll`); };

    await check("Daily"); await page.locator('[data-key="b:d"] textarea.ta').click(); await check("Daily, line selected");
    await page.locator("#tText").click(); await check("Daily, typing"); await page.locator("#compCancel").click();
    await tab(page, "notebooks"); await check("Notebooks list");
    await page.locator('[data-open="n1"]').click(); await page.locator('[data-key="b:a"] textarea.ta').click(); await check("notebook, text line selected");
    await page.locator('[data-key="b:i"] .tm').click(); await check("notebook, handwriting selected");
    await page.locator('[data-key="b:i"] [data-act="del"]').click(); await check("delete armed");
    await page.locator('[data-key="b:a"] textarea.ta').click(); await page.locator('[data-key="b:a"] [data-act="move"]').click(); await check("move sheet"); await page.locator(".sheet [data-close]").click();
    await page.locator("#moreBtn").click(); await check("details"); await page.locator(".sheet [data-close]").click();
    if (!wide) await page.locator("#back").click();
    await page.locator("#newEntry").click(); await check("new notebook form"); await page.locator("#newCancel").click();
    await tab(page, "meetings"); assert.equal(await page.locator("#list .item").count(), 1); await check("Meetings");
    await tab(page, "todo"); await page.locator("#doneHead").click(); await check("To-do"); assert.equal(await page.locator(".todo").count(), 1);
    await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; n.scrollTop = n.scrollHeight; });
    await tab(page, "docs"); assert.equal(await page.locator("[data-doc]").count(), 1); await check("Docs");
    await page.locator("#openSettings").click(); await check("Settings"); await page.locator(".sheet [data-close]").click();
    await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; n.scrollTop = n.scrollHeight; });
    await page.locator("#addTab").click(); await check("Add a tab"); await page.fill("#tabName", "Reagents 2"); await page.locator('[data-type="checklist"]').click(); await page.locator("#tabCreate").click(); await page.waitForTimeout(200);
    await check("custom tab"); await page.locator("#addTab").click(); await check("Add a tab, with one to remove"); await page.locator(".sheet [data-close]").click();
    await page.locator("#tabs").evaluate(n => { n.scrollLeft = 0; n.scrollTop = 0; });
    await tab(page, "daily"); assert.deepEqual(await shownLines(page), ["daily line"]);
    assert.deepEqual(errors, []);
  });

  test(`${name}: keyboard open in Daily keeps Add line on screen`, async () => {
    const { page, errors } = await open(vp, { logs: { daily: { blocks: [lineAt("d", "daily line", daysAgo(0))], protocols: [] } } });
    await page.locator("#tText").click(); await keyboard(page);
    const m = await page.evaluate(() => ({ vh: visualViewport.height, add: document.querySelector("#compAdd").getBoundingClientRect().bottom, box: document.querySelector("#compTa").getBoundingClientRect().height }));
    assert.ok(m.add <= m.vh + 1, `Add line at ${m.add} within ${m.vh}`);
    assert.ok(m.box >= 40, "the text box is still usable");
    assert.deepEqual(errors, []);
  });
}

/* ---------- existing data ---------- */
test("existing entries open as notebooks without loss; fields the app no longer shows are left in place", async () => {
  const old = { title: "demo knock-in", createdAt: daysAgo(14), updatedAt: daysAgo(6), protocols: ["p1"], lastTransfer: { at: daysAgo(1), benchlingUrl: "https://benchling.com/x/entry" },
    blocks: [lineAt("a", "picked clones", daysAgo(14)), { id: "p", type: "photo", assetId: "as9", url: PIXEL, caption: "gel", at: daysAgo(13) }, { id: "k", type: "ink", assetId: "as8", url: PIXEL, caption: "", transcript: "seeded 2e5", at: daysAgo(6) }] };
  const never = { title: "demo never transferred", createdAt: daysAgo(3), updatedAt: daysAgo(0), protocols: [], lastTransfer: null, blocks: [lineAt("z", "not transferred yet", daysAgo(3))] };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: { o1: old, o2: never }, protocols: PROTOCOLS });
  assert.deepEqual(await shownLines(page), [], "Daily starts empty");
  await tab(page, "notebooks");
  assert.deepEqual(await page.locator("#list .item .t").allTextContents(), ["demo knock-in", "demo never transferred"]);
  assert.equal(await page.locator(".chip").count(), 0, "no transfer chips");
  await page.locator('[data-open="o1"]').click();
  assert.equal(await page.locator("#lines .line").count(), 3);
  assert.deepEqual(await store(page, "entries/o1"), JSON.parse(JSON.stringify(old)), "opening changes nothing in the store");
  await page.locator('[data-key="b:a"] textarea.ta').click(); await page.keyboard.press("End"); await page.keyboard.type("!"); await page.waitForTimeout(1200);
  const saved = await store(page, "entries/o1");
  assert.deepEqual(saved.lastTransfer, old.lastTransfer, "lastTransfer survives an edit");
  assert.deepEqual(saved.blocks.slice(1), JSON.parse(JSON.stringify(old.blocks.slice(1))), "other lines are untouched");
  assert.equal(saved.blocks[0].text, "picked clones!");
  assert.equal(saved.kind, undefined, "a notebook is not given a kind it didn't have");
  assert.deepEqual(errors, []);
});

test("an image shared by a copied line is kept until its last line is deleted", async () => {
  const photo = { id: "p", type: "photo", assetId: "as9", url: PIXEL, caption: "gel", at: daysAgo(0) };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries: { n1: book("A", [photo]), n2: book("B", [{ ...photo, id: "p2" }]) } });
  await openBook(page, "n1");
  const del = () => page.locator('[data-key="b:p"] [data-act="del"]').click();
  await page.locator('[data-key="b:p"] .tm').click(); await del(); await del(); await page.waitForTimeout(200);
  assert.deepEqual((await store(page, "entries/n1")).blocks, []);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), [], "the image is still used by the other notebook");
  await openBook(page, "n2");
  const del2 = () => page.locator('[data-key="b:p2"] [data-act="del"]').click();
  await page.locator('[data-key="b:p2"] .tm').click(); await del2(); await del2(); await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), ["as9"], "deleted with its last line");
  assert.deepEqual(errors, []);
});
