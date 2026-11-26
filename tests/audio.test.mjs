// Voice memos: attaching a recording, storing it as base64 text chunks, playback, transcripts, clean-up of old audio and the storage meter.
// The asset stand-in refuses audio types and caps a file at 20 MiB, as measured on the iPad (see tests/mock-claude.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, close, tab, openBook, IPHONE, IPAD_LANDSCAPE, VIEWPORTS } from "./helpers.mjs";

after(close);

const MIB = 1024 * 1024, CHUNK = 6 * MIB, TEXT_CAP = 20 * MIB;
const sha = buf => createHash("sha256").update(buf).digest("hex");
const daysAgo = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const lineAt = (id, text, at) => ({ id, type: "text", text, at });
const book = (title, blocks = [], extra = {}) => ({ title, createdAt: blocks[0]?.at || new Date().toISOString(), updatedAt: new Date().toISOString(), protocols: [], blocks, ...extra });
const store = (page, path) => page.evaluate(p => p.split("/").reduce((o, k) => o && o[k], window.__store), path);
const banner = page => page.locator("#saveBanner").innerText();
const overflowing = page => page.evaluate(() => [...document.querySelectorAll("button")].filter(b => b.offsetParent && b.getClientRects().length)
  .filter(b => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1).map(b => (b.id || b.className) + ":" + b.textContent.trim().slice(0, 24)));

/* ---- made-up recordings (no real audio is kept in the repository) ---- */
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]); };
const MP4_EPOCH = 2082844800;   /* seconds between 1904 and 1970 */
/* an .m4a as an iPad writes it: ftyp "M4A ", then moov with the recording's start time and length, one track of the given kind */
function m4a({ created = new Date(), seconds = 6.4, handler = "soun", payload = 3000 } = {}) {
  const mvhd = box("mvhd", u32(0), u32(Math.floor(created.getTime() / 1000) + MP4_EPOCH), u32(0), u32(1000), u32(Math.round(seconds * 1000)), Buffer.alloc(80));
  const hdlr = box("hdlr", u32(0), u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(13));
  const data = Buffer.alloc(payload); for (let i = 0; i < payload; i++) data[i] = (i * 31 + 7) % 251;
  return Buffer.concat([box("ftyp", Buffer.from("M4A ", "latin1"), u32(0), Buffer.from("M4A mp42isom", "latin1")), box("moov", mvhd, box("trak", box("mdia", hdlr))), box("mdat", data)]);
}
/* a playable WAV of silence: 8 kHz, mono, 8-bit, so its length in seconds is bytes / 8000 */
function wav(bytes) {
  const h = Buffer.alloc(44); h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + bytes, 4); h.write("WAVEfmt ", 8, "latin1"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36, "latin1"); h.writeUInt32LE(bytes, 40);
  return Buffer.concat([h, Buffer.alloc(bytes, 128)]);
}
const pick = (page, name, buffer, mimeType = "audio/x-m4a") => page.setInputFiles("#audioInput", { name, mimeType, buffer });
const memo = (page, sel = "") => page.locator("#lines .line.memo" + (sel ? " " + sel : ""));
const storedAudio = async page => Buffer.concat((await page.evaluate(() => [...window.__assets.values()].filter(a => a.contentType === "text/plain").map(a => a.text))).map(t => Buffer.from(t, "base64")));
/* a stored voice memo line and the text assets that hold its audio */
function storedMemo(id, buf, extra = {}, cut = 3000) {
  const parts = []; for (let i = 0; i < buf.length; i += cut) parts.push(buf.subarray(i, i + cut));
  const chunks = parts.map((_, i) => `${id}c${i + 1}`);
  return { block: { id, type: "audio", at: daysAgo(0), attachedAt: daysAgo(0), fileName: "Recording.m4a", mime: "audio/mp4", bytes: buf.length, duration: 6.4, sha256: sha(buf), chunks, caption: "", transcript: "", ...extra },
    assets: Object.fromEntries(parts.map((p, i) => [chunks[i], p.toString("base64")])) };
}

test("attaching a recording adds a voice memo line at the recording's own time and stores the audio as base64 text", async () => {
  const created = new Date(); created.setHours(10, 5, 0, 0); if (created > new Date()) created.setDate(created.getDate() - 1);
  const file = m4a({ created });
  const { page, errors } = await open(IPAD_LANDSCAPE);
  await pick(page, "Recording 3.m4a", file);
  await page.waitForTimeout(500);
  assert.equal(await memo(page).count(), 1);
  const text = await memo(page).innerText();
  assert.match(text, /Voice memo/); assert.match(text, /Recording 3\.m4a/); assert.match(text, /0:06/); assert.match(text, /KB/);
  assert.match(text, /Waiting for transcription/);
  assert.equal(await memo(page, ".tm").textContent(), "10:05", "the line sits at the time the recording was made");
  const [b] = (await store(page, "logs/daily")).blocks;
  assert.equal(b.type, "audio"); assert.equal(b.fileName, "Recording 3.m4a"); assert.equal(b.mime, "audio/mp4"); assert.equal(b.bytes, file.length);
  assert.equal(b.sha256, sha(file)); assert.equal(Math.round(b.duration * 10), 64); assert.equal(b.chunks.length, 1);
  assert.equal(new Date(b.at).getTime(), created.getTime()); assert.ok(Date.now() - Date.parse(b.attachedAt) < 60000);
  assert.ok(!("pending" in b) && !("failed" in b) && !("localUrl" in b), "nothing device-only is stored");
  assert.deepEqual(await page.evaluate(() => window.__assetUploads), [{ type: "text/plain", size: Math.ceil(file.length / 3) * 4 }]);
  assert.equal(sha(await storedAudio(page)), sha(file), "the stored text decodes to the same bytes");
  assert.deepEqual(errors, []);
});

test("a long recording is split into chunks that each stay under the 20 MiB text cap, and is saved only when all are stored", async () => {
  const file = wav(13 * MIB);
  const { page, errors } = await open(IPAD_LANDSCAPE, { assetDelayMs: 400 });
  await pick(page, "Lab meeting.wav", file, "audio/wav");
  await page.waitForFunction(() => /Uploading \d of 3/.test(document.querySelector("#lines .line.memo")?.innerText || ""), null, { timeout: 15000 });
  assert.match(await memo(page).innerText(), /Lab meeting\.wav/, "the line is there while it uploads");
  assert.ok(!(await store(page, "logs/daily")), "nothing is saved while chunks are missing");
  await page.waitForFunction(() => /Waiting for transcription/.test(document.querySelector("#lines .line.memo")?.innerText || ""), null, { timeout: 30000 });
  await page.waitForTimeout(200);
  const [b] = (await store(page, "logs/daily")).blocks;
  assert.equal(b.chunks.length, 3); assert.equal(b.bytes, file.length); assert.equal(b.sha256, sha(file)); assert.equal(b.mime, "audio/wav");
  const ups = await page.evaluate(() => window.__assetUploads);
  assert.deepEqual(ups.map(u => u.type), ["text/plain", "text/plain", "text/plain"]);
  assert.ok(ups.every(u => u.size <= TEXT_CAP / 2), "chunks are well under the cap: " + ups.map(u => u.size));
  assert.equal(ups[0].size, CHUNK / 3 * 4);
  assert.equal(sha(await storedAudio(page)), sha(file), "the chunks join back into the same file");
  assert.match(await memo(page).innerText(), /28:2\d/, "length is shown");
  assert.deepEqual(errors, []);
});

test("a file that is not a recording is refused with a visible message and nothing is added or uploaded", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE);
  const refused = async (name, buf, type, why) => {
    await pick(page, name, buf, type); await page.waitForTimeout(300);
    assert.equal(await memo(page).count(), 0, name); assert.match(await banner(page), why, name);
  };
  await refused("notes.m4a", Buffer.from("%PDF-1.7 not audio at all, only named like it"), "audio/x-m4a", /isn't a recording/);
  await refused("clip.mp4", m4a({ handler: "vide" }), "video/mp4", /video/);
  await refused("page.html", Buffer.from("<html><script>alert(1)</script></html>"), "text/html", /isn't a recording/);
  await refused("empty.m4a", Buffer.alloc(0), "audio/x-m4a", /empty/);
  assert.deepEqual(await page.evaluate(() => window.__assetUploads), []);
  assert.ok(!(await store(page, "logs/daily")));
  assert.deepEqual(errors, []);
});

test("a failed upload keeps the line with the reason and Retry; retry resumes at the failed chunk", async () => {
  const file = wav(13 * MIB);
  const { page, errors } = await open(IPAD_LANDSCAPE, { assetFailCalls: [2] });
  await pick(page, "Lab meeting.wav", file, "audio/wav");
  await page.waitForFunction(() => !!document.querySelector("#lines .line.memo .memo-err:not([hidden]) [data-act=retry]"), null, { timeout: 30000 });
  const text = await memo(page).innerText();
  assert.match(text, /Lab meeting\.wav/); assert.match(text, /Not uploaded/); assert.match(text, /store_unavailable|offline/);
  assert.ok(!(await store(page, "logs/daily")), "an incomplete recording is not saved");
  await memo(page, "[data-act=retry]").click();
  await page.waitForFunction(() => /Waiting for transcription/.test(document.querySelector("#lines .line.memo")?.innerText || ""), null, { timeout: 30000 });
  await page.waitForTimeout(200);
  const [b] = (await store(page, "logs/daily")).blocks;
  assert.equal(b.chunks.length, 3); assert.equal(b.sha256, sha(file));
  assert.equal((await page.evaluate(() => window.__assetUploads)).length, 3, "the chunk that was already stored is not sent again");
  assert.equal(sha(await storedAudio(page)), sha(file));
  assert.deepEqual(errors, []);
});

test("removing a recording that failed to upload deletes the chunks it had stored", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { assetFailCalls: [2] });
  await pick(page, "Lab meeting.wav", wav(13 * MIB), "audio/wav");
  await page.waitForFunction(() => !!document.querySelector("#lines .line.memo .memo-err:not([hidden]) [data-act=retry]"), null, { timeout: 30000 });
  await memo(page, "[data-act=drop]").click(); await memo(page, "[data-act=drop]").click();
  await page.waitForTimeout(200);
  assert.equal(await memo(page).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), ["asset1"]);
  assert.equal(await page.evaluate(() => window.__assets.size), 0);
  assert.deepEqual(errors, []);
});

test("Attach recording is offered in Daily, a notebook, a meeting and a running-log tab", async () => {
  const entries = { n1: book("261120_ProjectX_LineA_Nucleofection", [lineAt("a", "bench line", daysAgo(0))]), m1: book("261116_TechMeeting", [lineAt("b", "note", daysAgo(0))], { kind: "meeting" }) };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries, tabs: [{ id: "tab-abcd1234", name: "Ideas", type: "log" }] });
  const usable = async where => { const t = page.locator("#tRec"); assert.ok(await t.isVisible(), where); assert.ok(await t.isEnabled(), where); const r = await t.boundingBox(); assert.ok(Math.min(r.width, r.height) >= 48, where + " tap target"); };
  await usable("Daily");
  await openBook(page, "n1"); await usable("notebook");
  await pick(page, "Recording.m4a", m4a()); await page.waitForTimeout(500);
  assert.equal((await store(page, "entries/n1")).blocks.filter(b => b.type === "audio").length, 1, "attached to the open notebook");
  await openBook(page, "m1", "meetings"); await usable("meeting");
  await tab(page, "tab-abcd1234"); await usable("running-log tab");
  assert.deepEqual(errors, []);
});

test("the picker is not limited to audio, because the iPad can grey out the recording", async () => {
  const { page } = await open(IPHONE);
  assert.equal(await page.locator("#audioInput").getAttribute("accept"), null);
});

test("a transcript written by a session shows under the line, and Fix terms and Ask use it", async () => {
  const m = storedMemo("v1", m4a());
  const sampleScript = `
    const line = (prompt.match(/<<<([\\s\\S]*)>>>/) || [])[1];
    if (line === undefined) return { text: "It was coated with Matrigel.", modelApplied: "claude-sonnet-5-5" };
    const hit = line.includes("mature gel");
    return { text: JSON.stringify({ text: line.replace("mature gel", "Matrigel"), changes: hit ? [{ from: "mature gel", to: "Matrigel" }] : [], unsure: [] }), modelApplied: "claude-sonnet-5-5" };`;
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks: [m.block], protocols: [] } }, assets: m.assets, glossary: ["Matrigel"], sampleScript });
  assert.match(await memo(page).innerText(), /Waiting for transcription/);
  assert.ok(await memo(page, ".trans").isHidden());
  await memo(page, ".tm").click();
  assert.ok(await memo(page, "[data-act=fix]").isHidden(), "nothing to fix before there is a transcript");
  await page.evaluate(() => window.__remote(s => { const b = s.logs.daily.blocks[0]; b.transcript = "Coated the plate with mature gel for one hour."; b.transcribedAt = new Date().toISOString(); b.transcriber = "whisper.cpp large-v3-turbo"; }));
  await page.waitForTimeout(200);
  assert.equal(await memo(page, ".trans").innerText(), "Coated the plate with mature gel for one hour.");
  assert.match(await memo(page).innerText(), /Transcribed/); assert.doesNotMatch(await memo(page).innerText(), /Waiting/);
  await memo(page, ".tm").click(); await memo(page, "[data-act=fix]").click(); await page.waitForTimeout(400);
  assert.equal((await store(page, "logs/daily")).blocks[0].transcript, "Coated the plate with Matrigel for one hour.");
  assert.equal(await memo(page, ".trans").innerText(), "Coated the plate with Matrigel for one hour.");
  const kept = (await store(page, "logs/daily")).blocks[0];
  assert.deepEqual([kept.id, kept.at, kept.sha256, kept.chunks], [m.block.id, m.block.at, m.block.sha256, m.block.chunks], "fixing changes only the transcript");
  await memo(page, "[data-undo]").click(); await page.waitForTimeout(200);
  assert.equal((await store(page, "logs/daily")).blocks[0].transcript, "Coated the plate with mature gel for one hour.");
  await page.locator("#askBtn").click(); await page.fill("#askQ", "What was the plate coated with?"); await page.locator("#askGo").click(); await page.waitForTimeout(300);
  const asked = (await page.evaluate(() => window.__prompts)).at(-1);
  assert.match(asked, /voice memo/i); assert.match(asked, /Coated the plate with mature gel for one hour\./);
  assert.deepEqual(errors, []);
});

test("a device holding unsaved changes does not write over a transcript that arrived meanwhile", async () => {
  const m = storedMemo("v1", m4a());
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks: [m.block, lineAt("t", "typed", daysAgo(0))], protocols: [] } }, assets: m.assets });
  await page.locator('[data-key="b:t"] textarea.ta').fill("typed more");   /* unsaved edit: this device's copy is now kept over snapshots */
  await page.evaluate(() => window.__remote(s => { const b = s.logs.daily.blocks[0]; b.transcript = "Counted 1.2 million cells."; b.transcribedAt = new Date().toISOString(); }));
  await page.waitForTimeout(1500);
  const blocks = (await store(page, "logs/daily")).blocks;
  assert.equal(blocks.find(b => b.id === "t").text, "typed more");
  assert.equal(blocks.find(b => b.id === "v1").transcript, "Counted 1.2 million cells.", "the transcript survives this device's save");
  assert.equal(await memo(page, ".trans").innerText(), "Counted 1.2 million cells.");
  assert.deepEqual(errors, []);
});

test("Play rebuilds the recording from its stored chunks; a missing chunk is reported, not silent", async () => {
  const file = wav(8000), m = storedMemo("v1", file, { mime: "audio/wav", fileName: "Recording.wav" }), gone = storedMemo("v2", file, { mime: "audio/wav", at: daysAgo(0, 11) });
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks: [m.block, gone.block], protocols: [] } }, assets: m.assets });
  await page.locator('[data-key="b:v1"] [data-act=play]').click();
  await page.waitForFunction(() => (document.querySelector('[data-key="b:v1"] audio')?.src || "").startsWith("blob:"), null, { timeout: 5000 });
  assert.ok(await page.locator('[data-key="b:v1"] audio').isVisible());
  const back = await page.evaluate(async () => { const a = document.querySelector('[data-key="b:v1"] audio'); const blob = await (await fetch(a.src)).blob(); return { bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type }; });
  assert.equal(sha(Buffer.from(back.bytes)), sha(file)); assert.equal(back.type, "audio/wav");
  await page.locator('[data-key="b:v2"] [data-act=play]').click(); await page.waitForTimeout(400);
  assert.match(await page.locator('[data-key="b:v2"] .memo-err').innerText(), /couldn't be loaded/);
  assert.deepEqual(errors, []);
});

/* ---- clean-up of stored audio ---- */
const CLEAN_WAIT = 2600;
const cleanCase = async (blocks, assets, opts = {}) => {
  const r = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks, protocols: [] } }, assets, ...opts });
  await r.page.waitForTimeout(CLEAN_WAIT);
  return r;
};

test("audio is deleted only for a recording that has a transcript and was attached more than 21 days ago; the line and transcript stay", async () => {
  const old = storedMemo("old", m4a(), { at: daysAgo(22), attachedAt: daysAgo(22), transcript: "Passaged the cells.", transcribedAt: daysAgo(21) });
  const recent = storedMemo("recent", m4a(), { at: daysAgo(20), attachedAt: daysAgo(20), transcript: "Changed media.", transcribedAt: daysAgo(19) });
  const waiting = storedMemo("waiting", m4a(), { at: daysAgo(40), attachedAt: daysAgo(40) });
  const { page, errors } = await cleanCase([old.block, recent.block, waiting.block], { ...old.assets, ...recent.assets, ...waiting.assets });
  const blocks = (await store(page, "logs/daily")).blocks, by = id => blocks.find(b => b.id === id);
  assert.deepEqual((await page.evaluate(() => window.__assetDeletes)).sort(), [...old.block.chunks].sort(), "only the old, transcribed recording's chunks");
  assert.deepEqual(by("old").chunks, []); assert.ok(Date.now() - Date.parse(by("old").audioRemovedAt) < 60000);
  assert.equal(by("old").transcript, "Passaged the cells."); assert.equal(by("old").at, old.block.at); assert.equal(by("old").sha256, old.block.sha256);
  assert.deepEqual(by("recent").chunks, recent.block.chunks); assert.ok(!by("recent").audioRemovedAt);
  assert.deepEqual(by("waiting").chunks, waiting.block.chunks); assert.ok(!by("waiting").audioRemovedAt, "never without a transcript");
  const line = id => page.locator(`[data-key="b:${id}"]`);
  assert.match(await line("old").innerText(), /Audio removed/); assert.match(await line("old").innerText(), /Passaged the cells\./);
  assert.ok(await line("old").locator("[data-act=play]").isHidden(), "nothing left to play");
  assert.match(await line("waiting").innerText(), /Waiting for transcription/); assert.match(await line("waiting").innerText(), /(39|40) days/, "an old recording without a transcript is flagged");
  assert.deepEqual(errors, []);
});

test("a recording transcribed only now keeps its audio for a few days, however old it is, so the transcript can be checked", async () => {
  const m = storedMemo("late", m4a(), { at: daysAgo(40), attachedAt: daysAgo(40), transcript: "Passaged the cells.", transcribedAt: new Date().toISOString() });
  const { page, errors } = await cleanCase([m.block], m.assets);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), []);
  assert.ok(!(await store(page, "logs/daily")).blocks[0].audioRemovedAt);
  assert.ok(await memo(page, "[data-act=play]").isVisible());
  assert.deepEqual(errors, []);
});

test("files chosen together are attached where they were chosen, even if another notebook is opened meanwhile", async () => {
  const entries = { n1: book("261120_A", [lineAt("a", "bench line", daysAgo(0))]), n2: book("261121_B", [lineAt("b", "other", daysAgo(0))]) };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries });
  await openBook(page, "n1");
  await page.setInputFiles("#audioInput", [{ name: "one.wav", mimeType: "audio/wav", buffer: wav(8000) }, { name: "two.wav", mimeType: "audio/wav", buffer: wav(8000) }]);
  await page.locator('[data-open="n2"]').click();
  await page.waitForFunction(() => (window.__store.entries.n1.blocks || []).filter(b => b.type === "audio").length === 2, null, { timeout: 15000 });
  assert.equal((await store(page, "entries/n2")).blocks.filter(b => b.type === "audio").length, 0);
  assert.deepEqual((await store(page, "entries/n1")).blocks.filter(b => b.type === "audio").map(b => b.fileName).sort(), ["one.wav", "two.wav"]);
  assert.deepEqual(errors, []);
});

test("clean-up follows Settings: it can be turned off and the number of days changed", async () => {
  let m = storedMemo("m", m4a(), { at: daysAgo(12), attachedAt: daysAgo(12), transcript: "Thawed a vial.", transcribedAt: daysAgo(11) });
  let r = await cleanCase([m.block], m.assets, { settings: { audioKeepDays: 10 } });
  assert.deepEqual((await store(r.page, "logs/daily")).blocks[0].chunks, [], "12 days old with a 10-day rule");
  m = storedMemo("m", m4a(), { at: daysAgo(60), attachedAt: daysAgo(60), transcript: "Thawed a vial.", transcribedAt: daysAgo(59) });
  r = await cleanCase([m.block], m.assets, { settings: { audioCleanup: false } });
  assert.deepEqual((await store(r.page, "logs/daily")).blocks[0].chunks, m.block.chunks, "kept when clean-up is off");
  assert.deepEqual(await r.page.evaluate(() => window.__assetDeletes), []);
  await r.page.locator("#openSettings").click();
  assert.equal(await r.page.locator("#sAudioClean").getAttribute("aria-checked"), "false");
  await r.page.locator("#sAudioDays").fill("45"); await r.page.locator("#sAudioDays").blur(); await r.page.waitForTimeout(150);
  await r.page.locator("#sAudioClean").click(); await r.page.waitForTimeout(150);
  const s = await store(r.page, "config/settings");
  assert.equal(s.audioKeepDays, 45); assert.equal(s.audioCleanup, true);
  assert.deepEqual(r.errors, []);
});

test("chunks shared with a line that still needs them are not deleted", async () => {
  const m = storedMemo("orig", m4a(), { at: daysAgo(30), attachedAt: daysAgo(30), transcript: "Imaged the wells.", transcribedAt: daysAgo(29) });
  const copy = { ...m.block, id: "copy", transcript: "" };   /* a copy made before the transcript existed */
  const entries = { n1: book("261101_ProjectX", [copy]) };
  const { page, errors } = await cleanCase([m.block], m.assets, { entries });
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), []);
  assert.deepEqual((await store(page, "logs/daily")).blocks[0].chunks, m.block.chunks);
  assert.ok(!(await store(page, "logs/daily")).blocks[0].audioRemovedAt);
  assert.deepEqual(errors, []);
});

test("a damaged line can never make the app delete a protocol's PDF or a photo", async () => {
  const old = { at: daysAgo(30), attachedAt: daysAgo(30), transcript: "Imaged the wells.", transcribedAt: daysAgo(29) };
  const bad = storedMemo("bad", m4a(), old), half = storedMemo("half", m4a(), { ...old, audioRemovedAt: daysAgo(1) });
  bad.block.chunks = ["pdf1"]; half.block.chunks = ["img1"];
  const protocols = { "up-pdf00001": { title: "Kit manual", category: "My protocols", kind: "protocol", benchlingId: "", source: "upload", text: "", assetId: "pdf1", fileName: "Kit manual.pdf", fileType: "application/pdf" } };
  const { page, errors } = await cleanCase([bad.block, half.block], {}, { protocols, fileAssets: ["pdf1", "img1"] });
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), [], "clean-up touches only text chunks");
  assert.ok(!(await store(page, "logs/daily")).blocks[0].audioRemovedAt, "the damaged line is left as it is");
  await page.locator('[data-key="b:bad"] .tm').click();
  await page.locator('[data-key="b:bad"] [data-act=del]').click(); await page.locator('[data-key="b:bad"] [data-act=del]').click(); await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), [], "deleting the line doesn't delete the protocol's file either");
  assert.deepEqual(errors, []);
});

test("clean-up waits for a running-log tab to load, because a copy there may share the chunks", async () => {
  const m = storedMemo("orig", m4a(), { at: daysAgo(30), attachedAt: daysAgo(30), transcript: "Imaged the wells.", transcribedAt: daysAgo(29) });
  const logs = { daily: { blocks: [m.block], protocols: [] }, "tab-abcd1234": { blocks: [{ ...m.block, id: "copy", transcript: "" }], protocols: [] } };
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs, assets: m.assets, tabs: [{ id: "tab-abcd1234", name: "Ideas", type: "log" }] });
  await page.waitForTimeout(CLEAN_WAIT);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), []);
  assert.deepEqual((await store(page, "logs/daily")).blocks[0].chunks, m.block.chunks);
  assert.deepEqual(errors, []);
});

test("a clean-up that was interrupted after marking the line finishes on the next visit", async () => {
  const m = storedMemo("half", m4a(), { at: daysAgo(30), attachedAt: daysAgo(30), transcript: "Imaged the wells.", transcribedAt: daysAgo(29), audioRemovedAt: daysAgo(1) });
  const { page, errors } = await cleanCase([m.block], m.assets);
  assert.deepEqual((await page.evaluate(() => window.__assetDeletes)).sort(), [...m.block.chunks].sort());
  assert.deepEqual((await store(page, "logs/daily")).blocks[0].chunks, []);
  assert.equal((await store(page, "logs/daily")).blocks[0].audioRemovedAt, m.block.audioRemovedAt, "the first removal date is kept");
  assert.deepEqual(errors, []);
});

test("deleting a voice memo line deletes its chunks, but not while a copy still uses them", async () => {
  const m = storedMemo("v1", m4a());
  const entries = { n1: book("261101_A", [m.block]), n2: book("261102_B", [{ ...m.block, id: "v2" }]) };
  const { page, errors } = await open(IPAD_LANDSCAPE, { entries, assets: m.assets });
  await openBook(page, "n1"); await memo(page, ".tm").click();
  await memo(page, "[data-act=del]").click(); await memo(page, "[data-act=del]").click(); await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__assetDeletes), [], "the copy in the other notebook still needs them");
  await openBook(page, "n2"); await memo(page, ".tm").click();
  await memo(page, "[data-act=del]").click(); await memo(page, "[data-act=del]").click(); await page.waitForTimeout(200);
  assert.deepEqual((await page.evaluate(() => window.__assetDeletes)).sort(), [...m.block.chunks].sort());
  assert.deepEqual(errors, []);
});

/* ---- storage ---- */
test("Settings shows storage used against the quota and what is waiting for transcription", async () => {
  const m = storedMemo("v1", m4a(), { at: daysAgo(3), attachedAt: daysAgo(3) });
  const { page, errors } = await open(IPAD_LANDSCAPE, { logs: { daily: { blocks: [m.block], protocols: [] } }, assets: m.assets, assetUsage: { bytes: 200 * MIB, files: 40 } });
  await page.locator("#openSettings").click(); await page.waitForTimeout(200);
  const text = await page.locator("#sStorage").innerText();
  assert.match(text, /200(\.\d)? MB of 1(\.0)? GB/); assert.match(text, /4[0-9] of 5,000 files/);
  assert.match(text, /1 recording waiting for transcription/);
  assert.ok(await page.locator("#sStorageWarn").isHidden(), "no warning at 20%");
  assert.deepEqual(errors, []);
});

test("storage that is nearly full is flagged when the app opens and in Settings; a recording that doesn't fit is not uploaded and says why", async () => {
  const { page, errors } = await open(IPAD_LANDSCAPE, { assetUsage: { bytes: 1020 * MIB, files: 40 } });
  await page.waitForTimeout(CLEAN_WAIT);
  assert.match(await banner(page), /Storage is nearly full/);
  await page.locator("#openSettings").click(); await page.waitForTimeout(200);
  assert.ok(await page.locator("#sStorageWarn").isVisible()); assert.match(await page.locator("#sStorageWarn").innerText(), /nearly full/);
  await page.locator(".sheet [data-close]").click();
  await pick(page, "Lab meeting.wav", wav(6 * MIB), "audio/wav"); await page.waitForTimeout(600);
  assert.match(await memo(page).innerText(), /Not uploaded/); assert.match(await memo(page, ".memo-err").innerText(), /not enough storage/i);
  assert.ok(await memo(page, "[data-act=retry]").isVisible(), "it can be retried once space is freed");
  assert.deepEqual(await page.evaluate(() => window.__assetUploads), []);
  assert.deepEqual(errors, []);
});

test("the file count limit is flagged too", async () => {
  const { page } = await open(IPAD_LANDSCAPE, { assetUsage: { bytes: MIB, files: 4600 } });
  await page.locator("#openSettings").click(); await page.waitForTimeout(200);
  assert.ok(await page.locator("#sStorageWarn").isVisible());
});

for (const [name, vp] of VIEWPORTS) {
  test(`${name}: voice memo lines and the Recording button fit`, async () => {
    const m = storedMemo("v1", m4a(), { fileName: "A very long recording name from the lab meeting on Thursday afternoon.m4a", transcript: "Counted cells. ".repeat(120), transcribedAt: daysAgo(0) });
    const { page, errors } = await open(vp, { logs: { daily: { blocks: [lineAt("d", "daily line", daysAgo(0)), m.block], protocols: [] } }, assets: m.assets });
    const fits = async where => { assert.deepEqual(await overflowing(page), [], where); assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), where + ": no sideways scroll"); };
    await fits("Daily"); await memo(page, ".tm").click(); await fits("memo selected");
    const r = await page.locator("#tRec").boundingBox(); assert.ok(Math.min(r.width, r.height) >= 48, "Recording tap target " + JSON.stringify(r));
    const line = await memo(page).boundingBox(), w = await page.evaluate(() => innerWidth);
    assert.ok(line.x >= 0 && line.x + line.width <= w + 1, "the line stays inside the screen");
    await page.locator("#openSettings").click(); await page.waitForTimeout(200); await fits("Settings");
    assert.deepEqual(errors, []);
  });
}
