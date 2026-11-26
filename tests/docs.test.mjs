// Docs: adding your own protocols (typed, pasted or from a file), then reading, linking, editing and deleting them.
// All names and protocol text here are made up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { open, close, tab, openBook, entry, textBlock, IPHONE, IPAD_LANDSCAPE, VIEWPORTS } from "./helpers.mjs";

after(close);

const LIBRARY = { p1: { title: "Passaging cells", category: "Culture", kind: "protocol", benchlingId: "etr_made_up", text: "1. Aspirate media." } };
const MINE = { "up-abcd1234": { title: "Gel recipe", category: "My protocols", kind: "protocol", benchlingId: "", text: "1. Weigh 1 g agarose.", source: "upload", addedAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z" } };
const protocols = page => page.evaluate(() => window.__store.protocols);
const overflowing = page => page.evaluate(() => [...document.querySelectorAll("button, a.btn")].filter(b => b.offsetParent && b.getClientRects().length)
  .filter(b => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1).map(b => (b.id || b.className) + ":" + b.textContent.trim().slice(0, 24)));
const toastText = page => page.evaluate(() => { const t = document.querySelector(".toast"); return t && !t.hidden ? t.textContent : ""; });
async function docs(page, id = "docs") {
  await page.locator("#tabs").evaluate(n => { n.scrollLeft = n.scrollWidth; n.scrollTop = n.scrollHeight; });
  await tab(page, id);
}
async function save(page) { await page.locator("#pSave").click(); await page.waitForTimeout(200); }

/* a minimal .docx: a zip holding word/document.xml, deflated, with sizes in a data descriptor as Word writes them */
function docx(xml) {
  const name = Buffer.from("word/document.xml"), raw = Buffer.from(xml), data = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const desc = Buffer.alloc(16); desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(data.length, 8); desc.writeUInt32LE(raw.length, 12);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length + desc.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, desc, central, name, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const WORD_XML = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Buffer prep</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Mix 5 µl of </w:t></w:r><w:r><w:t>dye &amp; water</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Spin 300 × g</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Reagent</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Volume</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Tris</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10 ml</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

for (const [name, vp] of VIEWPORTS) {
  test(`${name}: a protocol can be added in Docs, read, edited and deleted, and no label overflows`, async () => {
    const { page, errors } = await open(vp, { protocols: LIBRARY });
    const check = async where => { assert.deepEqual(await overflowing(page), [], `${where}: labels fit`); assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${where}: no sideways page scroll`); };
    await docs(page);
    const add = page.locator("#addProto");
    assert.ok((await add.boundingBox()).height >= 48, "Add protocol is a large button");
    await add.click(); await check("add form");
    await page.fill("#pTitle", "Agarose gel, 1%"); await page.fill("#pCat", "Gels");
    await page.fill("#pText", "## Materials\n- 1 g agarose\n- 100 ml TAE\n\n1. Microwave 90 s.");
    await save(page);
    const all = await protocols(page), id = Object.keys(all).find(k => k !== "p1"), doc = all[id];
    assert.ok(id, "a new document was stored in protocols");
    assert.deepEqual({ title: doc.title, category: doc.category, kind: doc.kind, benchlingId: doc.benchlingId, source: doc.source }, { title: "Agarose gel, 1%", category: "Gels", kind: "protocol", benchlingId: "", source: "upload" });
    assert.ok(doc.text.includes("Microwave 90 s") && !Number.isNaN(Date.parse(doc.addedAt)));
    assert.deepEqual(all.p1, LIBRARY.p1, "the library protocol is untouched");
    assert.equal(await page.locator(".sheet").count(), 0, "the form closed");
    assert.ok((await page.locator("#pane").innerText()).toUpperCase().includes("GELS"), "listed under its folder");
    await check("Docs with an added protocol");

    await page.locator(`[data-doc="${id}"]`).click(); await check("reader");
    assert.ok((await page.locator(".sheet .doc").innerText()).includes("Microwave 90 s"));
    await page.locator("#pEdit").click(); await check("edit form");
    assert.equal(await page.inputValue("#pTitle"), "Agarose gel, 1%");
    await page.fill("#pTitle", "Agarose gel, 2%"); await page.fill("#pText", "1. Microwave 120 s."); await save(page);
    const edited = (await protocols(page))[id];
    assert.equal(edited.title, "Agarose gel, 2%"); assert.equal(edited.text, "1. Microwave 120 s."); assert.equal(edited.category, "Gels");
    assert.equal(edited.addedAt, doc.addedAt, "the date it was added is kept");

    await page.locator(`[data-doc="${id}"]`).click();
    await page.locator("#pDelete").click(); await check("delete armed");
    assert.ok((await protocols(page))[id], "one tap does not delete");
    await page.locator("#pDelete").click(); await page.waitForTimeout(200);
    assert.deepEqual(Object.keys(await protocols(page)), ["p1"]);
    assert.equal(await page.locator(`[data-doc="${id}"]`).count(), 0);
    assert.deepEqual(errors, []);
  });
}

test("a Markdown file fills the text box and suggests the title; a second file is added below, not over it", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.setInputFiles("#protoInput", { name: "Lysis buffer v2.md", mimeType: "text/markdown", buffer: Buffer.from("# Lysis buffer\n- 50 mM Tris\n") });
  await page.waitForTimeout(150);
  assert.equal(await page.inputValue("#pTitle"), "Lysis buffer v2");
  assert.ok((await page.inputValue("#pText")).includes("50 mM Tris"));
  await page.setInputFiles("#protoInput", { name: "notes.txt", mimeType: "", buffer: Buffer.from("Keep on ice.") });
  await page.waitForTimeout(150);
  assert.equal(await page.inputValue("#pTitle"), "Lysis buffer v2", "a title already there is kept");
  const text = await page.inputValue("#pText");
  assert.ok(text.includes("50 mM Tris") && text.includes("Keep on ice."));
  await save(page);
  const doc = Object.values(await protocols(page)).find(p => p.source === "upload");
  assert.equal(doc.category, "My protocols", "an empty folder gets a default");
  assert.ok(doc.text.includes("Keep on ice.") && !doc.assetId);
  assert.deepEqual(errors, []);
});

test("a Word .docx file is read into text: headings, list items and tables", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.setInputFiles("#protoInput", { name: "Buffer prep.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx(WORD_XML) });
  await page.waitForTimeout(300);
  const text = await page.inputValue("#pText");
  assert.ok(text.includes("## Buffer prep"), text);
  assert.ok(text.includes("Mix 5 µl of dye & water"), "runs are joined and entities decoded");
  assert.ok(text.includes("- Spin 300 × g"));
  assert.ok(text.includes("| Reagent | Volume |") && text.includes("| Tris | 10 ml |"));
  await save(page);
  const id = Object.keys(await protocols(page)).find(k => k !== "p1");
  await page.locator(`[data-doc="${id}"]`).click();
  assert.equal(await page.locator(".sheet .doc table tr").count(), 2, "the table is drawn as a table");
  assert.deepEqual(errors, []);
});

test("a PDF is kept as a file that can be opened; its text is not read, and deleting the protocol deletes the file", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.setInputFiles("#protoInput", { name: "Kit manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 made up") });
  await page.waitForTimeout(150);
  assert.equal(await page.inputValue("#pText"), "", "no text is invented for a PDF");
  assert.ok((await page.locator("#pFileNote").innerText()).includes("Kit manual.pdf"));
  await save(page);
  const id = Object.keys(await protocols(page)).find(k => k !== "p1"), doc = (await protocols(page))[id];
  assert.equal(doc.assetId, "asset1"); assert.equal(doc.fileName, "Kit manual.pdf"); assert.equal(doc.title, "Kit manual");
  assert.deepEqual(await page.evaluate(() => window.__assetUploads), [{ type: "application/pdf", size: 16 }]);
  await page.locator(`[data-doc="${id}"]`).click();
  const link = page.locator(".sheet a#pOpenFile");
  assert.equal(await link.getAttribute("href"), "/_blob/asset1");
  assert.ok((await page.locator(".sheet").innerText()).includes("paste"), "says plainly that Claude can't read the PDF until its text is pasted");
  await page.locator("#pDelete").click(); await page.locator("#pDelete").click(); await page.waitForTimeout(200);
  assert.deepEqual(Object.keys(await protocols(page)), ["p1"]);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), ["asset1"]);
  assert.deepEqual(errors, []);
});

test("a PDF taken off a protocol while editing is deleted only after the save", async () => {
  const mine = { "up-pdf00001": { ...MINE["up-abcd1234"], title: "Kit manual", text: "", assetId: "old1", fileName: "Kit manual.pdf", fileType: "application/pdf" } };
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: mine });
  await docs(page); await page.locator('[data-doc="up-pdf00001"]').click(); await page.locator("#pEdit").click();
  await page.locator("#pFileRemove").click();
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), [], "nothing is deleted before Save");
  await page.fill("#pText", "Pasted text of the manual."); await save(page);
  const doc = (await protocols(page))["up-pdf00001"];
  assert.ok(!doc.assetId && !doc.fileName); assert.equal(doc.text, "Pasted text of the manual.");
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), ["old1"]);
  assert.deepEqual(errors, []);
});

test("a file that can't be read (old .doc, a photo) is refused with a message and changes nothing", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.fill("#pText", "typed so far");
  await page.setInputFiles("#protoInput", { name: "old.doc", mimeType: "application/msword", buffer: Buffer.from("binary") });
  await page.waitForTimeout(150);
  assert.ok(/\.docx|PDF/.test(await toastText(page)), "says what can be used instead");
  assert.equal(await page.inputValue("#pText"), "typed so far");
  await page.setInputFiles("#protoInput", { name: "broken.docx", mimeType: "", buffer: Buffer.from("not a zip at all, just text pretending") });
  await page.waitForTimeout(150);
  assert.ok(/Word/.test(await toastText(page)));
  assert.equal(await page.inputValue("#pText"), "typed so far");
  assert.equal(Object.keys(await protocols(page)).length, 1);
  assert.deepEqual(errors, []);
});

test("nothing is saved without a title, or with neither text nor a file", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.fill("#pText", "some text"); await save(page);
  assert.equal(await page.locator(".sheet").count(), 1, "the form stays open"); assert.ok(/name/i.test(await toastText(page)));
  await page.fill("#pTitle", "Named"); await page.fill("#pText", "   "); await save(page);
  assert.equal(await page.locator(".sheet").count(), 1);
  assert.equal(Object.keys(await protocols(page)).length, 1);
  await page.locator(".sheet [data-close]").click();
  assert.equal(Object.keys(await protocols(page)).length, 1, "closing the form saves nothing");
  assert.deepEqual(errors, []);
});

test("protocols from the library can't be edited or deleted in the app; your own can", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: { ...LIBRARY, ...MINE } });
  await docs(page);
  await page.locator('[data-doc="p1"]').click();
  assert.equal(await page.locator("#pEdit, #pDelete").count(), 0);
  await page.locator(".sheet [data-close]").click();
  await page.locator('[data-doc="up-abcd1234"]').click();
  assert.equal(await page.locator("#pEdit, #pDelete").count(), 2);
  assert.deepEqual(errors, []);
});

test("an added protocol can be linked to a notebook, and Fix terms then reads it", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY, entries: entry([textBlock("a", "ran the gel")]) });
  await docs(page); await page.locator("#addProto").click();
  await page.fill("#pTitle", "Zymolyase digest"); await page.fill("#pText", "Add 2 µl zymolyase per well."); await save(page);
  const id = Object.keys(await protocols(page)).find(k => k !== "p1");
  await openBook(page);
  await page.locator("#linkProto").click();
  await page.locator(`.sheet [data-pid="${id}"]`).click(); await page.locator(".sheet [data-close]").first().click(); await page.waitForTimeout(200);
  assert.deepEqual((await page.evaluate(() => window.__store.entries.e1)).protocols, [id]);
  assert.ok((await page.locator("#chips").innerText()).includes("Zymolyase digest"));
  await page.locator('[data-key="b:a"] textarea.ta').click(); await page.locator('[data-key="b:a"] [data-act="fix"]').click(); await page.waitForTimeout(400);
  assert.ok((await page.evaluate(() => window.__prompts)).some(p => p.includes("Add 2 µl zymolyase per well")), "the protocol text reached Claude");
  assert.deepEqual(errors, []);
});

test("a protocol deleted from the library is not shown as a raw id on a notebook that linked it", async () => {
  const entries = entry([textBlock("a", "line")]); entries.e1.protocols = ["up-gone0000", "p1"];
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY, entries });
  await openBook(page);
  assert.deepEqual(await page.locator("#chips .pchip:not(.add)").allTextContents(), ["Passaging cells"]);
  assert.deepEqual(errors, []);
});

test("protocol titles and text are shown as text, never run as markup", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  const evil = '<img src=x onerror="window.__pwned=1">';
  await page.fill("#pTitle", evil); await page.fill("#pCat", evil + "cat"); await page.fill("#pText", evil + "\n| " + evil + " |\n## " + evil + "\n<b>bold?</b>"); await save(page);
  const id = Object.keys(await protocols(page)).find(k => k !== "p1");
  assert.equal(await page.locator("#pane img").count(), 0);
  await page.locator(`[data-doc="${id}"]`).click(); await page.waitForTimeout(100);
  assert.equal(await page.locator(".sheet img, .sheet b").count(), 0, "the reader draws no element from the text");
  assert.ok((await page.locator(".sheet .doc").innerText()).includes("<img src=x"), "the reader shows the text literally");
  assert.equal(await page.locator(".sheet .doc td").count(), 1); assert.equal(await page.locator(".sheet .doc h4").count(), 1);
  assert.ok((await page.locator(".sheet h2").innerText()).includes("<img"));
  await page.locator("#pEdit").click(); await page.waitForTimeout(100);
  assert.equal(await page.locator("#pane img, .sheet img").count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.inputValue("#pTitle"), evil);
  assert.deepEqual(errors, []);
});

test("a stored PDF id that isn't a plain asset id never becomes a link", async () => {
  const mine = { "up-bad00001": { ...MINE["up-abcd1234"], assetId: "javascript:alert(1)", fileName: "x.pdf" } };
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: mine });
  await docs(page); await page.locator('[data-doc="up-bad00001"]').click();
  assert.equal(await page.locator(".sheet a").count(), 0);
  assert.deepEqual(errors, []);
});

test("an edit is applied to the stored protocol, so fields added elsewhere are kept", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: MINE });
  await docs(page); await page.locator('[data-doc="up-abcd1234"]').click(); await page.locator("#pEdit").click();
  await page.evaluate(() => window.__remoteQuiet(s => { s.protocols["up-abcd1234"].benchlingId = "etr_added_elsewhere"; s.protocols["up-abcd1234"].extra = { keep: true }; }));
  await page.fill("#pTitle", "Gel recipe, revised"); await save(page);
  const doc = (await protocols(page))["up-abcd1234"];
  assert.equal(doc.title, "Gel recipe, revised"); assert.equal(doc.benchlingId, "etr_added_elsewhere"); assert.deepEqual(doc.extra, { keep: true });
  assert.ok(doc.updatedAt > MINE["up-abcd1234"].updatedAt);
  assert.deepEqual(errors, []);
});

test("editing a protocol that was deleted on another device does not bring it back", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: { ...LIBRARY, ...MINE } });
  await docs(page); await page.locator('[data-doc="up-abcd1234"]').click(); await page.locator("#pEdit").click();
  await page.evaluate(() => window.__remoteQuiet(s => { delete s.protocols["up-abcd1234"]; }));
  await page.fill("#pTitle", "Back from the dead"); await save(page);
  assert.deepEqual(Object.keys(await protocols(page)), ["p1"]);
  assert.ok(/deleted/i.test(await toastText(page)));
  assert.deepEqual(errors, []);
});

test("a protocol that could not be saved keeps the form open with what was typed, and Save works on the next try", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY, failSetOnce: "protocols/*" });
  await docs(page); await page.locator("#addProto").click();
  await page.fill("#pTitle", "Offline protocol"); await page.fill("#pText", "Typed on the train."); await save(page);
  assert.equal(await page.locator(".sheet").count(), 1);
  assert.ok(/Couldn't save/.test(await toastText(page)));
  assert.equal(await page.inputValue("#pText"), "Typed on the train.");
  assert.equal(Object.keys(await protocols(page)).length, 1);
  await save(page);
  assert.equal(await page.locator(".sheet").count(), 0);
  assert.equal(Object.values(await protocols(page)).filter(p => p.title === "Offline protocol").length, 1);
  assert.deepEqual(errors, []);
});

test("a custom Library tab has the same Add protocol button", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY, tabs: [{ id: "tab-lib00001", name: "Manuals", type: "library" }] });
  await docs(page, "tab-lib00001");
  await page.locator("#addProto").click(); await page.fill("#pTitle", "From a custom tab"); await page.fill("#pText", "Text."); await save(page);
  assert.equal(Object.values(await protocols(page)).filter(p => p.source === "upload").length, 1);
  assert.equal(await page.locator("[data-doc]").count(), 2);
  assert.deepEqual(errors, []);
});

test("without the store, Add protocol explains instead of opening a form that can't save", async () => {
  const { page, errors } = await open(IPHONE, { noDb: true });
  await docs(page); await page.locator("#addProto").click();
  assert.equal(await page.locator(".sheet").count(), 0);
  assert.ok((await toastText(page)).length > 10);
  assert.deepEqual(errors, []);
});

test("a PDF whose type the device doesn't report is still stored as a PDF", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.setInputFiles("#protoInput", { name: "Shared.PDF", mimeType: "", buffer: Buffer.from("%PDF-1.4 x") });
  await page.waitForTimeout(150); await save(page);
  assert.deepEqual(await page.evaluate(() => window.__assetUploads), [{ type: "application/pdf", size: 10 }]);
  assert.equal(Object.values(await protocols(page)).find(p => p.source === "upload").fileType, "application/pdf");
  assert.deepEqual(errors, []);
});

test("a PDF uploaded for a protocol that then wasn't saved is deleted when the form is closed", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY, failSetOnce: "protocols/*" });
  await docs(page); await page.locator("#addProto").click();
  await page.setInputFiles("#protoInput", { name: "Manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
  await page.waitForTimeout(150); await save(page);
  assert.equal(await page.locator(".sheet").count(), 1, "the save failed and the form stayed");
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), []);
  await page.locator(".sheet [data-close]").click();
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), ["asset1"]);
  assert.equal(Object.keys(await protocols(page)).length, 1);
  assert.deepEqual(errors, []);
});

test("a form with something typed is not closed by a tap beside it or by Escape; an untouched one is", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.locator(".sheet").click({ position: { x: 10, y: 400 } });
  assert.equal(await page.locator(".sheet").count(), 0, "nothing typed: a tap beside the form closes it");
  await page.locator("#addProto").click(); await page.fill("#pText", "a long pasted protocol");
  await page.locator(".sheet").click({ position: { x: 10, y: 400 } }); await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sheet").count(), 1);
  assert.equal(await page.inputValue("#pText"), "a long pasted protocol");
  await page.locator(".sheet [data-close]").click();
  assert.equal(await page.locator(".sheet").count(), 0, "the close button still discards");
  assert.deepEqual(errors, []);
});

test("an edit is refused when the protocol was changed on another device after the form opened", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { protocols: MINE });
  await docs(page); await page.locator('[data-doc="up-abcd1234"]').click(); await page.locator("#pEdit").click();
  await page.evaluate(() => window.__remoteQuiet(s => { s.protocols["up-abcd1234"].text = "newer text from the other device"; s.protocols["up-abcd1234"].updatedAt = "2026-11-21T09:00:00.000Z"; }));
  await page.fill("#pText", "older text typed here"); await save(page);
  assert.equal((await protocols(page))["up-abcd1234"].text, "newer text from the other device");
  assert.ok(/changed on another device/.test(await toastText(page)));
  assert.equal(await page.inputValue("#pText"), "older text typed here", "what was typed is still there to copy");
  assert.deepEqual(errors, []);
});

test("text too long for one stored document is refused with a message", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  await page.fill("#pTitle", "Huge"); await page.evaluate(() => { document.querySelector("#pText").value = "µ".repeat(100000); }); await save(page);
  assert.ok(/too long/.test(await toastText(page)));
  assert.equal(Object.keys(await protocols(page)).length, 1);
  assert.deepEqual(errors, []);
});

test("a Word file that unpacks to far more than it declares is refused, not read", async () => {
  const { page, errors } = await open(IPHONE, { protocols: LIBRARY });
  await docs(page); await page.locator("#addProto").click();
  const bomb = docx(`<w:document ${W}><w:body><w:p><w:r><w:t>${"A".repeat(11 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`);
  bomb.writeUInt32LE(1, bomb.length - 22 - 17 - 46 + 24);   // the central directory now claims 1 byte unpacked
  await page.setInputFiles("#protoInput", { name: "bomb.docx", mimeType: "", buffer: bomb });
  await page.waitForTimeout(800);
  assert.ok(/Word/.test(await toastText(page)));
  assert.equal(await page.inputValue("#pText"), "");
  assert.deepEqual(errors, []);
});
