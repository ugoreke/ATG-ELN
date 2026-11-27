// The backup tool (tools/backup): the manifest and its completeness check, the comparison of two backups, the restore plan and its check.
// Everything runs on made-up documents, made-up files and a stand-in store; no account, no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../tools/transcribe/lib.mjs";
import { MAX_DOC_BYTES } from "../tools/transfer/lib.mjs";
import { COLLECTIONS, docHash, parseListing, parseAssetListing, assetRefs, buildManifest, chooseBase } from "../tools/backup/lib.mjs";
import { diffBackups, formatDiff } from "../tools/backup/diff.mjs";
import { planRestore, verifyRestore } from "../tools/backup/restore.mjs";
import { NOW, NOTEBOOK_ID, OTHER_NOTEBOOK_ID, deepFreeze, textLine, photoLine, inkLine, voiceMemo, dailyDoc, notebookDoc, makeStore } from "./transfer-fixtures.mjs";

const TOOL = fileURLToPath(new URL("../tools/backup/backup.mjs", import.meta.url));
const LATER = "2026-03-11T18:00:00.000Z";
const T = h => `2026-03-10T${String(h).padStart(2, "0")}:00:00.000Z`;
const ids = doc => doc.blocks.map(b => b.id);
const NOTEBOOK = "entries/" + NOTEBOOK_ID, OTHER = "entries/" + OTHER_NOTEBOOK_ID;

/* ---- a made-up notebook: documents with versions, and the stored files their lines point to ---- */

const AUDIO = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7 + 3) % 256));   /* stands in for a recording */
const MEMO = voiceMemo("m1", T(15), { bytes: AUDIO.length, sha256: sha256(AUDIO) });
const text = s => Buffer.from(s, "utf8");
const FILES = () => ({
  "asset-d2": { type: "image/jpeg", buf: text("made-up photo bytes") },
  "ink-n2": { type: "image/png", buf: text("made-up handwriting bytes") },
  "chunk-m1-1": { type: "text/plain", buf: text(AUDIO.subarray(0, 300).toString("base64")) },
  "chunk-m1-2": { type: "text/plain", buf: text(AUDIO.subarray(300).toString("base64")) },
  "asset-pdf": { type: "application/pdf", buf: text("made-up protocol file") },
});
const DOCS = () => ({
  "config/settings": { version: 1, doc: { lang: "en-US", theme: "tide" } },
  [NOTEBOOK]: { version: 3, doc: notebookDoc([textLine("n1", T(10)), inkLine("n2", T(12)), MEMO]) },
  "logs/daily": { version: 4, doc: dailyDoc([textLine("d1", T(9)), photoLine("d2", T(11)), textLine("d3", T(16))]) },
  "logs/todo": { version: 2, doc: { items: [{ id: "t1", text: "made-up task", at: T(8), doneAt: null }], updatedAt: T(8) } },
  "protocols/up-madeup01": { version: 1, doc: { title: "Made-up protocol", category: "My protocols", kind: "protocol", benchlingId: "", text: "", source: "upload", assetId: "asset-pdf", fileName: "made-up.pdf", fileType: "application/pdf" } },
});
const split = path => ({ collection: path.split("/")[0], id: path.split("/")[1] });
const refsOf = docs => Object.keys(docs).sort().map(path => ({ ...split(path), version: docs[path].version }));
const documentsOf = docs => Object.keys(docs).sort().map(path => deepFreeze({ ...split(path), version: docs[path].version, doc: structuredClone(docs[path].doc) }));
const listedOf = files => ({ files: Object.keys(files).length, bytes: Object.values(files).reduce((n, f) => n + f.buf.length, 0),
  assets: Object.entries(files).map(([id, f]) => ({ id, contentType: f.type, bytes: f.buf.length, sha256: sha256(f.buf) })) });
const heldOf = files => new Map(Object.entries(files).map(([id, f]) => [id, { file: id + ".bin", bytes: f.buf.length, sha256: sha256(f.buf) }]));
const chunkTextOf = files => id => (files[id] ? files[id].buf.toString("utf8") : null);
/* the manifest of a backup that read `docs`, was told of `listed` files and holds `held` of them */
const manifestOf = ({ docs = DOCS(), listed = FILES(), held = listed, ...over } = {}) => buildManifest({
  takenAt: NOW, listing: refsOf(docs), documents: documentsOf(docs), assetListing: listedOf(listed), held: heldOf(held), chunkText: chunkTextOf(held), base: null, ...over });
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([k]) => !keys.includes(k)));

/* ---- the two listings ---- */

test("the document listing names every collection, and each document with the version that was read", () => {
  const refs = parseListing({ config: { settings: 19 }, entries: { [NOTEBOOK_ID]: 3 }, logs: { daily: 4, todo: 2 }, protocols: {} });
  assert.deepEqual(refs, [{ collection: "config", id: "settings", version: 19 }, { collection: "entries", id: NOTEBOOK_ID, version: 3 },
    { collection: "logs", id: "daily", version: 4 }, { collection: "logs", id: "todo", version: 2 }]);
  assert.deepEqual([...COLLECTIONS], ["config", "entries", "logs", "protocols"]);
  assert.throws(() => parseListing({ config: {}, entries: {}, logs: {} }), /does not name protocols/, "a collection that was not listed is never taken as empty");
  assert.throws(() => parseListing({ config: { settings: "19" }, entries: {}, logs: {}, protocols: {} }), /version/);
  assert.throws(() => parseListing({ config: { settings: 0 }, entries: {}, logs: {}, protocols: {} }), /version/);
  assert.throws(() => parseListing({ config: { "../x": 1 }, entries: {}, logs: {}, protocols: {} }), /document id/);
  assert.throws(() => parseListing({ config: { "..": 1 }, entries: {}, logs: {}, protocols: {} }), /document id/);
  assert.throws(() => parseListing([]), /listing/);
});

const assetListingText = (files, head) => [
  head ?? `Assets of https://claude.ai/artifact/made-up: ${Object.keys(files).length} files, ${Object.values(files).reduce((n, f) => n + f.buf.length, 0)} of 1073741824 bytes used (limit 5000 files).`,
  "Oldest first; reference one from the page by its url verbatim, read or delete it by the id after \"_blob/\":",
  ...Object.entries(files).map(([id, f]) => `- /_blob/${id}  ${f.type}  ${f.buf.length} bytes  2026-03-10T04:07:04.802872Z  sha256 ${sha256(f.buf)}`),
].join("\n") + "\n";

test("the asset listing is read as the artifact tool prints it, and one that was cut short is refused", () => {
  const files = FILES(), parsed = parseAssetListing(assetListingText(files));
  assert.equal(parsed.files, 5);
  assert.deepEqual(parsed.assets[0], { id: "asset-d2", contentType: "image/jpeg", bytes: files["asset-d2"].buf.length, sha256: sha256(files["asset-d2"].buf) });
  assert.deepEqual(parsed, listedOf(files));
  const cut = assetListingText(files).split("\n").filter(l => !l.includes("chunk-m1-2")).join("\n");
  assert.throws(() => parseAssetListing(cut), /5 files.*4/s, "the count in the first line is held against the lines");
  assert.throws(() => parseAssetListing(assetListingText(files).replace(/sha256 [0-9a-f]{64}/, "sha256 zz")), /cannot read/);
  assert.throws(() => parseAssetListing("- /_blob/x  text/plain  3 bytes  2026-03-10T04:07:04Z  sha256 " + "a".repeat(64)), /first line/);
  assert.deepEqual(parseAssetListing("Assets of https://claude.ai/artifact/made-up: 0 files, 0 of 1073741824 bytes used (limit 5000 files).\n"), { files: 0, bytes: 0, assets: [] });
  const twoPages = assetListingText(without(files, "asset-pdf")).replace("4 files", "5 files").replace(/, \d+ of/, `, ${listedOf(files).bytes} of`) + assetListingText({ "asset-pdf": files["asset-pdf"] }, "");
  assert.equal(parseAssetListing(twoPages).assets.length, 5, "a listing that came in two pages is one listing");
});

test("every stored file a document points to is found: photos, handwriting, the chunks of a recording, a protocol's file", () => {
  const refs = assetRefs(documentsOf(DOCS()));
  assert.deepEqual(refs.map(r => r.asset).sort(), ["asset-d2", "asset-pdf", "chunk-m1-1", "chunk-m1-2", "ink-n2"]);
  assert.deepEqual(refs.find(r => r.asset === "chunk-m1-2"), { asset: "chunk-m1-2", document: NOTEBOOK, line: "m1" });
  assert.deepEqual(refs.find(r => r.asset === "asset-pdf"), { asset: "asset-pdf", document: "protocols/up-madeup01", line: null });
});

/* ---- the manifest and its completeness check ---- */

test("a whole backup gives a complete manifest: every document with version, size and SHA-256, every file with size and hash", () => {
  const docs = DOCS(), files = FILES(), m = manifestOf();
  assert.equal(m.complete, true); assert.equal(m.takenAt, NOW); assert.equal(m.base, null);
  assert.deepEqual(m.missing, { documents: [], assets: [], recordings: [] });
  assert.equal(m.documents.length, 5);
  const daily = m.documents.find(d => d.collection === "logs" && d.id === "daily");
  assert.deepEqual(daily, { collection: "logs", id: "daily", version: 4, bytes: Buffer.byteLength(JSON.stringify(docs["logs/daily"].doc)), sha256: docHash(docs["logs/daily"].doc), sameAsBase: false });
  assert.match(daily.sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.assets.length, 5);
  assert.deepEqual(m.assets.find(a => a.id === "asset-d2"), { id: "asset-d2", contentType: "image/jpeg", bytes: files["asset-d2"].buf.length, sha256: sha256(files["asset-d2"].buf), file: "asset-d2.bin", status: "held", usedBy: ["logs/daily#d2"] });
  assert.deepEqual(m.recordings, [{ document: NOTEBOOK, line: "m1", chunks: ["chunk-m1-1", "chunk-m1-2"], bytes: AUDIO.length, sha256: sha256(AUDIO), status: "ok" }]);
  assert.deepEqual(m.totals, { documents: 5, documentBytes: m.documents.reduce((n, d) => n + d.bytes, 0), assets: 5, assetBytes: listedOf(files).bytes });
  assert.deepEqual(m.warnings, []);
});

test("the SHA-256 of a document does not depend on the order of its fields, and changes with any value", () => {
  assert.equal(docHash({ a: 1, b: { c: [1, { x: 1, y: 2 }], d: "é" } }), docHash({ b: { d: "é", c: [1, { y: 2, x: 1 }] }, a: 1 }));
  assert.notEqual(docHash({ a: 1, b: [1, 2] }), docHash({ a: 1, b: [2, 1] }), "the order of a list is content");
  assert.notEqual(docHash({ a: 1 }), docHash({ a: "1" }));
});

test("a document the listing named and that was not saved makes the backup incomplete, and is named", () => {
  const docs = DOCS(), m = manifestOf({ documents: documentsOf(without(docs, NOTEBOOK)) });
  assert.equal(m.complete, false);
  assert.deepEqual(m.missing.documents, [{ document: NOTEBOOK, why: "listed but not saved" }]);
  assert.equal(m.documents.length, 4, "what was saved is still described");
  const broken = manifestOf({ documents: documentsOf(without(docs, "logs/todo")), unreadable: [{ collection: "logs", id: "todo", why: "not valid JSON" }] });
  assert.deepEqual(broken.missing.documents, [{ document: "logs/todo", why: "not valid JSON" }]);
});

test("a saved document the listing does not name makes the backup incomplete: the listing is what completeness is judged by", () => {
  const m = manifestOf({ listing: refsOf(without(DOCS(), "logs/todo")) });
  assert.equal(m.complete, false);
  assert.deepEqual(m.missing.documents, [{ document: "logs/todo", why: "saved but not named in the listing" }]);
});

test("a stored file that was not fetched, or whose bytes differ from the listing, makes the backup incomplete", () => {
  const files = FILES(), notFetched = manifestOf({ held: without(files, "asset-d2") });
  assert.equal(notFetched.complete, false);
  assert.deepEqual(notFetched.missing.assets, [{ id: "asset-d2", why: "not fetched yet", bytes: files["asset-d2"].buf.length, usedBy: ["logs/daily#d2"] }]);
  assert.equal(notFetched.assets.find(a => a.id === "asset-d2").status, "missing");
  const wrong = manifestOf({ held: { ...files, "ink-n2": { type: "image/png", buf: text("other bytes entirely, same id") } } });
  assert.equal(wrong.complete, false);
  assert.match(wrong.missing.assets[0].why, /differs/); assert.equal(wrong.missing.assets[0].id, "ink-n2");
});

test("a recording must have every chunk and rebuild to the size and SHA-256 its line states", () => {
  const files = FILES(), noChunk = manifestOf({ held: without(files, "chunk-m1-2") });
  assert.equal(noChunk.complete, false);
  assert.deepEqual(noChunk.missing.recordings, [{ document: NOTEBOOK, line: "m1", why: "chunk 2 of 2 is not held (chunk-m1-2)" }]);
  assert.equal(noChunk.recordings[0].status, "missing");
  const swapped = { ...files, "chunk-m1-2": { type: "text/plain", buf: text(Buffer.from("not the second half").toString("base64")) } };
  const bad = manifestOf({ listed: swapped, held: swapped });
  assert.equal(bad.complete, false, "every file matches its listing, and the recording still does not rebuild");
  assert.deepEqual(bad.missing.assets, []);
  assert.match(bad.missing.recordings[0].why, /size differs|SHA-256 differs/);
});

test("a copy of a voice memo in a second document is one recording, checked once", () => {
  const docs = DOCS(), copy = { ...docs, [OTHER]: { version: 1, doc: notebookDoc([{ ...MEMO, id: "m1-copy" }]) } };
  const m = manifestOf({ docs: copy });
  assert.equal(m.recordings.length, 1); assert.equal(m.complete, true);
  assert.deepEqual(m.assets.find(a => a.id === "chunk-m1-1").usedBy, [NOTEBOOK + "#m1", OTHER + "#m1-copy"]);
});

test("a line that points to a file the app no longer stores is a warning, not a gap in the backup; a copy from an earlier backup is kept", () => {
  const files = FILES(), gone = manifestOf({ listed: without(files, "asset-d2") });
  assert.equal(gone.complete, true, "the backup copied everything that exists");
  assert.deepEqual(gone.assets.find(a => a.id === "asset-d2"), { id: "asset-d2", contentType: "", bytes: 0, sha256: "", file: null, status: "gone", usedBy: ["logs/daily#d2"] });
  assert.equal(gone.warnings.length, 1); assert.match(gone.warnings[0], /asset-d2.*logs\/daily#d2/);
  const kept = manifestOf({ listed: without(files, "asset-d2"), held: files });
  assert.equal(kept.assets.find(a => a.id === "asset-d2").status, "kept");
  assert.equal(kept.assets.find(a => a.id === "asset-d2").sha256, sha256(files["asset-d2"].buf));
  assert.match(kept.warnings[0], /earlier backup/);
});

test("a voice memo whose audio the app removed has no recording to check", () => {
  const docs = DOCS(), removed = voiceMemo("m1", T(15), { chunks: [], audioRemovedAt: T(17) });
  const m = manifestOf({ docs: { ...docs, [NOTEBOOK]: { version: 3, doc: notebookDoc([removed]) } }, listed: without(FILES(), "chunk-m1-1", "chunk-m1-2", "ink-n2") });
  assert.deepEqual(m.recordings, []); assert.equal(m.complete, true);
  /* a clean-up that was interrupted: the line still lists chunks the store no longer has */
  const interrupted = voiceMemo("m1", T(15), { bytes: AUDIO.length, sha256: sha256(AUDIO), audioRemovedAt: T(17) });
  const half = manifestOf({ docs: { ...docs, [NOTEBOOK]: { version: 3, doc: notebookDoc([interrupted]) } }, listed: without(FILES(), "chunk-m1-1", "chunk-m1-2", "ink-n2") });
  assert.equal(half.complete, true); assert.equal(half.recordings[0].status, "gone");
  assert.match(half.warnings.join("\n"), new RegExp("the recording of " + NOTEBOOK + "#m1 cannot be rebuilt"), "the backup says which recording it does not hold");
});

test("a collection with exactly a page of documents is flagged: the listing may have been cut at the page", () => {
  const hundred = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["protocols/p" + i, { version: 1, doc: { title: "made-up " + i } }]));
  const m = manifestOf({ docs: { ...without(DOCS(), "protocols/up-madeup01"), ...hundred }, listed: without(FILES(), "asset-pdf") });
  assert.equal(m.complete, true);
  assert.match(m.warnings.join("\n"), /protocols has exactly 100 documents/);
});

test("a read that names no document at all is never a complete backup", () => {
  const m = manifestOf({ docs: {}, listed: {} });
  assert.equal(m.complete, false);
  assert.match(m.missing.documents[0].why, /no document at all/);
});

test("a backup that lost half or more of the documents of the one before says so", () => {
  const base = manifestOf(), docs = DOCS();
  const m = manifestOf({ docs: { "config/settings": docs["config/settings"], "logs/daily": docs["logs/daily"] }, listed: without(FILES(), "ink-n2", "chunk-m1-1", "chunk-m1-2", "asset-pdf"), base: { name: "260310-1800", manifest: base }, takenAt: LATER });
  assert.equal(m.complete, true);
  assert.match(m.warnings.join("\n"), /3 of the 5 documents in 260310-1800 are gone/);
});

/* ---- the incremental rule ---- */

test("against the previous complete backup, a document with the same version and content is marked as carried, a changed one is not", () => {
  const base = manifestOf(), docs = DOCS();
  const next = { ...docs, "logs/daily": { version: 5, doc: dailyDoc([textLine("d1", T(9)), textLine("d9", T(17))]) }, [OTHER]: { version: 1, doc: notebookDoc([]) } };
  const m = manifestOf({ docs: without(next, "logs/todo"), base: { name: "260310-1800", manifest: base }, takenAt: LATER });
  assert.equal(m.base, "260310-1800");
  assert.equal(m.documents.find(d => d.id === "settings").sameAsBase, true);
  assert.equal(m.documents.find(d => d.id === "daily").sameAsBase, false);
  assert.equal(m.documents.find(d => d.id === OTHER_NOTEBOOK_ID).sameAsBase, false);
  assert.deepEqual(m.sinceBase, { added: [OTHER], removed: ["logs/todo"], changed: ["logs/daily"], same: 3 });
  assert.deepEqual(m.warnings, []);
});

test("a document whose content changed under the same version is never carried, and is reported", () => {
  const base = manifestOf(), docs = DOCS();
  const m = manifestOf({ docs: { ...docs, "config/settings": { version: 1, doc: { lang: "en-GB", theme: "tide" } } }, base: { name: "260310-1800", manifest: base }, takenAt: LATER });
  assert.equal(m.documents.find(d => d.id === "settings").sameAsBase, false);
  assert.deepEqual(m.sinceBase.changed, ["config/settings"]);
  assert.match(m.warnings.join("\n"), /config\/settings changed without a new version/);
});

test("the base of a backup is the latest complete backup before it; an incomplete one is never used", () => {
  const complete = manifestOf(), incomplete = manifestOf({ held: without(FILES(), "asset-d2"), takenAt: "2026-03-11T08:00:00.000Z" });
  assert.equal(incomplete.complete, false);
  const older = { name: "260309-1800", manifest: { ...complete, takenAt: "2026-03-09T18:00:00.000Z" } }, good = { name: "260310-1800", manifest: complete };
  const picked = chooseBase([older, { name: "260311-0800", manifest: incomplete }, good, { name: "260312-0900", manifest: { ...complete, takenAt: "2026-03-12T09:00:00.000Z" } }], LATER);
  assert.equal(picked.name, "260310-1800");
  assert.equal(chooseBase([{ name: "260311-0800", manifest: incomplete }], LATER), null);
  assert.equal(chooseBase([{ name: "x", manifest: { ...complete, format: 99 } }], LATER), null, "a manifest of another format is not trusted");
  assert.equal(chooseBase([], LATER), null);
});

/* ---- comparing two backups ---- */

const sideOf = docs => ({ documents: documentsOf(docs) });

test("the comparison lists documents added, removed and changed, and inside a document the lines added, removed and changed", () => {
  const before = DOCS();
  const after = { ...without(before, "logs/todo"),
    "logs/daily": { version: 6, doc: dailyDoc([{ ...textLine("d1", T(9)), text: "made-up note, edited" }, textLine("d9", T(17))], { d2: { to: NOTEBOOK_ID, at: T(18) } }) },
    [NOTEBOOK]: { version: 4, doc: notebookDoc([textLine("n1", T(10)), inkLine("n2", T(12)), MEMO, photoLine("d2", T(11))]) },
    [OTHER]: { version: 1, doc: notebookDoc([textLine("o1", T(12))]) } };
  const diff = diffBackups(sideOf(before), sideOf(after));
  assert.deepEqual(diff.added, [OTHER]); assert.deepEqual(diff.removed, ["logs/todo"]);
  assert.deepEqual(diff.changed.map(c => c.document), [NOTEBOOK, "logs/daily"]);
  const daily = diff.changed.find(c => c.document === "logs/daily");
  assert.deepEqual(daily.lines, { added: ["d9"], removed: ["d2", "d3"], changed: ["d1"] });
  assert.deepEqual(daily.fields, ["blocks", "moved"]); assert.deepEqual([daily.versionFrom, daily.versionTo], [4, 6]);
  assert.deepEqual(diff.changed.find(c => c.document === NOTEBOOK).lines, { added: ["d2"], removed: [], changed: [] });
  assert.deepEqual(diff.moved, [{ id: "d2", from: "logs/daily", to: NOTEBOOK }], "a line that left one document and is in another was moved, not lost");
  assert.deepEqual(diff.lost, [{ id: "d3", document: "logs/daily" }, { id: "t1", document: "logs/todo" }], "lines that are in no document any more");
  assert.equal(diff.same, 2);
  const report = formatDiff(diff);
  assert.match(report, /2 lines are in no document any more/); assert.match(report, /d3/);
  assert.ok(!report.includes("made-up note"), "the report names ids, never what a line says");
});

test("a to-do list is compared item by item, and a document without lines field by field", () => {
  const before = DOCS(), after = { ...before,
    "logs/todo": { version: 3, doc: { items: [{ id: "t2", text: "another made-up task", at: T(9), doneAt: null }], updatedAt: T(9) } },
    "config/settings": { version: 2, doc: { lang: "en-US", theme: "bloom", autoFix: true } } };
  const diff = diffBackups(sideOf(before), sideOf(after));
  assert.deepEqual(diff.changed.find(c => c.document === "logs/todo").lines, { added: ["t2"], removed: ["t1"], changed: [] });
  const settings = diff.changed.find(c => c.document === "config/settings");
  assert.equal(settings.lines, null); assert.deepEqual(settings.fields, ["autoFix", "theme"]);
  assert.deepEqual(diff.lost, [{ id: "t1", document: "logs/todo" }]);
});

test("a line that is only left as a hidden copy in Daily counts as lost, as it does for a restore", () => {
  const before = { ...DOCS(), [NOTEBOOK]: { version: 3, doc: notebookDoc([textLine("n1", T(10)), textLine("d1", T(9))]) }, "logs/daily": { version: 4, doc: dailyDoc([], { d1: { to: NOTEBOOK_ID, at: T(18) } }) } };
  const after = { ...before, [NOTEBOOK]: { version: 4, doc: notebookDoc([textLine("n1", T(10))]) }, "logs/daily": { version: 5, doc: dailyDoc([textLine("d1", T(9))], { d1: { to: NOTEBOOK_ID, at: T(18) } }) } };
  const diff = diffBackups(sideOf(before), sideOf(after));
  assert.deepEqual(diff.lost, [{ id: "d1", document: NOTEBOOK }], "Daily lists it as moved, so the app hides the copy there");
  assert.deepEqual(diff.moved, []);
});

test("two backups of the same notebook differ in nothing", () => {
  const diff = diffBackups(sideOf(DOCS()), sideOf(DOCS()));
  assert.deepEqual([diff.added, diff.removed, diff.changed, diff.moved, diff.lost], [[], [], [], [], []]); assert.equal(diff.same, 5);
  assert.match(formatDiff(diff), /No difference/);
});

/* ---- planning a restore ---- */

/* the backup holds DOCS(); live is what the database looks like now */
const backupOf = (docs = DOCS(), complete = true) => ({ complete, takenAt: NOW, documents: documentsOf(docs) });
const liveOf = (docs, assets = new Set(Object.keys(FILES()))) => ({ documents: documentsOf(docs), assets });
const planFor = (liveDocs, target, lineIds, more = {}) => planRestore({ backup: backupOf(), live: liveOf(liveDocs), target: split(target), lineIds, now: LATER, ...more });
/* since the backup: d1 and d3 were lost from Daily, a line was added, and the version moved on */
const DAILY_NOW = { version: 9, doc: dailyDoc([photoLine("d2", T(11)), textLine("d5", T(12)), textLine("d8", T(17))]) };

test("a lost line is put back into the document it came from, at its place by time, exactly as stored, pinned to the fresh version", () => {
  const live = { ...DOCS(), "logs/daily": DAILY_NOW }, plan = planFor(live, "logs/daily", ["d3", "d1"]);
  assert.equal(plan.writes.length, 1);
  const [write] = plan.writes;
  assert.deepEqual([write.op, write.collection, write.doc_id, write.if_version], ["set", "logs", "daily", 9], "pinned to the version of the fresh read, not the backup's");
  assert.deepEqual(ids(write.data), ["d1", "d2", "d5", "d3", "d8"]);
  assert.deepEqual(write.data.blocks.find(b => b.id === "d1"), textLine("d1", T(9)));
  assert.equal(write.data.updatedAt, LATER); assert.deepEqual(write.data.protocols, []);
  assert.deepEqual(write.data.blocks.find(b => b.id === "d5"), textLine("d5", T(12)), "what is live now is left exactly as it is");
  assert.deepEqual(plan.lines, [textLine("d3", T(16)), textLine("d1", T(9))]); assert.equal(plan.kind, "lines");
  assert.deepEqual(plan.warnings, []);
});

test("a voice memo and a photo come back with every field they were stored with", () => {
  const live = { ...DOCS(), [NOTEBOOK]: { version: 7, doc: notebookDoc([textLine("n1", T(10))]) } };
  const plan = planFor(live, NOTEBOOK, ["m1", "n2"]), blocks = plan.writes[0].data.blocks;
  assert.deepEqual(blocks.find(b => b.id === "m1"), MEMO); assert.deepEqual(blocks.find(b => b.id === "n2"), inkLine("n2", T(12)));
  assert.deepEqual(ids(plan.writes[0].data), ["n1", "n2", "m1"]);
  assert.equal(plan.writes[0].data.title, "260310_Made-up_Line_Test");
});

test("the live lines are never re-ordered by a restore: the line is slotted in before the first later one", () => {
  const odd = notebookDoc([textLine("late", T(14)), textLine("early", T(11)), textLine("n1", T(10))]);
  const plan = planFor({ ...DOCS(), [NOTEBOOK]: { version: 7, doc: odd } }, NOTEBOOK, ["n2"]);
  assert.deepEqual(ids(plan.writes[0].data), ["n2", "late", "early", "n1"]);
});

test("nothing is planned from a backup that is marked incomplete", () => {
  const live = { ...DOCS(), "logs/daily": DAILY_NOW };
  assert.throws(() => planRestore({ backup: backupOf(DOCS(), false), live: liveOf(live), target: split("logs/daily"), lineIds: ["d1"], now: LATER }), /incomplete/);
  assert.throws(() => planRestore({ backup: { documents: documentsOf(DOCS()) }, live: liveOf(live), target: split("logs/daily"), lineIds: ["d1"], now: LATER }), /incomplete/);
});

test("a write that cannot be pinned to the fresh read's version is refused", () => {
  const live = liveOf({ ...DOCS(), "logs/daily": DAILY_NOW });
  const noVersion = { ...live, documents: live.documents.map(d => (d.id === "daily" ? { collection: d.collection, id: d.id, doc: d.doc } : d)) };
  assert.throws(() => planRestore({ backup: backupOf(), live: noVersion, target: split("logs/daily"), lineIds: ["d1"], now: LATER }), /version of logs\/daily/);
  assert.throws(() => planFor({ ...DOCS(), "logs/daily": { ...DAILY_NOW, version: 0 } }, "logs/daily", ["d1"]), /version of logs\/daily/);
});

test("a line that is live anywhere is never restored: not in its own document, not in a notebook it was moved to", () => {
  const sameDoc = { ...DOCS(), "logs/daily": DAILY_NOW };
  assert.throws(() => planFor(sameDoc, "logs/daily", ["d1", "d2"]), /line d2 is already in logs\/daily/);
  const movedOn = { ...DOCS(), "logs/daily": { version: 9, doc: dailyDoc([], { d1: { to: NOTEBOOK_ID, at: T(18) } }) },
    [NOTEBOOK]: { version: 5, doc: notebookDoc([textLine("d1", T(9)), textLine("n1", T(10))]) } };
  assert.throws(() => planFor(movedOn, "logs/daily", ["d1"]), new RegExp("line d1 is already in " + NOTEBOOK));
  const elsewhere = { ...DOCS(), "logs/daily": DAILY_NOW, [OTHER]: { version: 1, doc: notebookDoc([textLine("d3", T(16))]) } };
  assert.throws(() => planFor(elsewhere, "logs/daily", ["d3"]), new RegExp("line d3 is already in " + OTHER));
});

test("the moved marks are respected: a line Daily lists as moved is not put back into Daily, where the app would hide it", () => {
  /* the line was moved to the notebook and then lost there; Daily still lists it as moved */
  const live = { ...DOCS(), "logs/daily": { version: 9, doc: dailyDoc([textLine("d3", T(16))], { d1: { to: NOTEBOOK_ID, at: T(18) } }) } };
  assert.throws(() => planFor(live, "logs/daily", ["d1"]), /Daily lists line d1 as moved to notebook 11111111.*transfer\.mjs verify/s);
  /* a hidden copy that a device saved back into Daily does not count as live, and does not make Daily the place for it */
  const stale = { ...live, "logs/daily": { version: 9, doc: dailyDoc([textLine("d1", T(9))], { d1: { to: NOTEBOOK_ID, at: T(18) } }) } };
  assert.throws(() => planFor(stale, "logs/daily", ["d1"]), /moved to notebook/);
});

test("a line is restored into the notebook the moved mark names, and into no other", () => {
  const moved = { n2: { to: NOTEBOOK_ID, at: T(18) }, m1: { to: OTHER_NOTEBOOK_ID, at: T(18) } };
  const live = { ...DOCS(), "logs/daily": { version: 9, doc: dailyDoc([], moved) }, [NOTEBOOK]: { version: 7, doc: notebookDoc([textLine("n1", T(10))]) } };
  assert.deepEqual(ids(planFor(live, NOTEBOOK, ["n2"]).writes[0].data), ["n1", "n2"]);
  assert.throws(() => planFor(live, NOTEBOOK, ["m1"]), /line m1 was moved to notebook 22222222/);
});

test("a document that would pass 230,000 bytes is not planned", () => {
  const big = notebookDoc([textLine("n1", T(10)), { ...textLine("filler", T(11)), text: "x".repeat(MAX_DOC_BYTES - 400) }]);
  assert.throws(() => planFor({ ...DOCS(), [NOTEBOOK]: { version: 7, doc: big } }, NOTEBOOK, ["m1"]), /larger than 230000 bytes/);
});

test("what cannot be found is refused with the reason: a line the backup does not hold, a document that is gone, a document without lines", () => {
  const live = { ...DOCS(), "logs/daily": DAILY_NOW };
  assert.throws(() => planFor(live, "logs/daily", ["nope"]), /line nope is not in the backup's copy of logs\/daily/);
  assert.throws(() => planFor(live, "logs/daily", []), /no line ids/);
  assert.throws(() => planFor(without(live, NOTEBOOK), NOTEBOOK, ["n1"]), /no longer exists.*whole/s);
  assert.throws(() => planFor(live, "entries/55555555-5555-4555-8555-555555555555", ["n1"]), /backup holds no document/);
  assert.throws(() => planFor(live, "config/settings", ["x"]), /has no list of lines/);
  const twice = { ...DOCS(), "logs/daily": { version: 4, doc: dailyDoc([textLine("d1", T(9)), { ...textLine("d1", T(9)), text: "another made-up wording" }]) } };
  assert.throws(() => planRestore({ backup: backupOf(twice), live: liveOf(live), target: split("logs/daily"), lineIds: ["d1"], now: LATER }), /twice.*different/s);
});

test("a restored line whose photo or recording the app no longer stores comes back with a warning that names the file", () => {
  const live = { ...DOCS(), [NOTEBOOK]: { version: 7, doc: notebookDoc([textLine("n1", T(10))]) } };
  const plan = planRestore({ backup: backupOf(), live: liveOf(live, new Set(["asset-d2", "chunk-m1-1"])), target: split(NOTEBOOK), lineIds: ["n2", "m1"], now: LATER });
  assert.deepEqual(plan.assetsGone, [{ line: "n2", asset: "ink-n2" }, { line: "m1", asset: "chunk-m1-2" }]);
  assert.equal(plan.warnings.length, 2); assert.match(plan.warnings[0], /n2.*ink-n2/);
  const unknown = planRestore({ backup: backupOf(), live: liveOf(live, null), target: split(NOTEBOOK), lineIds: ["n2"], now: LATER });
  assert.deepEqual(unknown.assetsGone, []); assert.match(unknown.warnings[0], /not checked/);
});

test("a whole document that no longer exists live is created exactly as it was, without a pin", () => {
  const live = without({ ...DOCS(), "logs/daily": DAILY_NOW }, NOTEBOOK);
  const plan = planRestore({ backup: backupOf(), live: liveOf(live), target: split(NOTEBOOK), whole: true, now: LATER });
  assert.equal(plan.kind, "document"); assert.equal(plan.created, true);
  assert.deepEqual(plan.writes, [{ op: "set", collection: "entries", doc_id: NOTEBOOK_ID, data: DOCS()[NOTEBOOK].doc }]);
  assert.equal("if_version" in plan.writes[0], false, "only a document that does not exist is written without a pin");
  const todo = planRestore({ backup: backupOf(), live: liveOf(without(live, "logs/todo")), target: split("logs/todo"), whole: true, now: LATER });
  assert.deepEqual(todo.writes[0].data, DOCS()["logs/todo"].doc);
});

test("a whole document is not created while one of its lines is live somewhere else", () => {
  const live = { ...without(DOCS(), NOTEBOOK), [OTHER]: { version: 2, doc: notebookDoc([textLine("n1", T(10))]) } };
  assert.throws(() => planRestore({ backup: backupOf(), live: liveOf(live), target: split(NOTEBOOK), whole: true, now: LATER }), new RegExp("line n1 is already in " + OTHER));
});

test("a whole document is not restored while Daily says one of its lines was moved to another notebook", () => {
  const live = { ...without(DOCS(), NOTEBOOK), "logs/daily": { version: 9, doc: dailyDoc([], { n1: { to: OTHER_NOTEBOOK_ID, at: T(18) } }) } };
  assert.throws(() => planRestore({ backup: backupOf(), live: liveOf(live), target: split(NOTEBOOK), whole: true, now: LATER }), /line n1 was moved to notebook 22222222/);
});

test("a document that exists live is replaced whole only when named, pinned, and the plan says which live lines that drops", () => {
  const live = { ...DOCS(), [NOTEBOOK]: { version: 7, doc: notebookDoc([textLine("n1", T(10)), textLine("newer", T(17))]) } };
  const plan = planRestore({ backup: backupOf(), live: liveOf(live), target: split(NOTEBOOK), whole: true, now: LATER });
  assert.equal(plan.created, false); assert.equal(plan.writes[0].if_version, 7);
  assert.deepEqual(plan.writes[0].data, DOCS()[NOTEBOOK].doc);
  assert.deepEqual(plan.dropped, ["newer"]); assert.match(plan.warnings.join("\n"), /1 line that is live now is not in the backup/);
  assert.throws(() => planRestore({ backup: backupOf(), live: liveOf({ ...DOCS(), "logs/daily": DAILY_NOW }), target: split("logs/daily"), whole: true, now: LATER }), /Daily is never replaced whole/);
  assert.throws(() => planRestore({ backup: backupOf(), live: liveOf(live), target: split(NOTEBOOK), whole: true, lineIds: ["n2"], now: LATER }), /either .* or line ids/);
});

/* ---- a restore against the stand-in store, and the check afterwards ---- */

const storeOf = docs => makeStore(Object.fromEntries(Object.entries(docs).map(([path, d]) => [path, d.doc])));
/* a fresh read of the stand-in store, in the shape the tool reads */
const readStore = (store, paths) => ({ documents: paths.filter(p => store.has(...p.split("/"))).map(p => { const r = store.read(...p.split("/")); return { collection: r.collection, id: r.id, version: r.version, doc: r.doc }; }), assets: null });
const PATHS = [...Object.keys(DOCS()), OTHER];

test("a planned restore applies to the store in one pinned batch, and the check afterwards is clean", () => {
  const store = storeOf({ ...DOCS(), "logs/daily": DAILY_NOW });
  const plan = planRestore({ backup: backupOf(), live: readStore(store, PATHS), target: split("logs/daily"), lineIds: ["d1", "d3"], now: LATER });
  store.batch(plan.writes);
  assert.deepEqual(ids(store.read("logs", "daily").doc), ["d1", "d2", "d5", "d3", "d8"]);
  const check = verifyRestore({ plan, live: readStore(store, PATHS) });
  assert.equal(check.clean, true); assert.deepEqual(check.lines.map(l => [l.id, l.status]), [["d1", "ok"], ["d3", "ok"]]);
  assert.throws(() => planRestore({ backup: backupOf(), live: readStore(store, PATHS), target: split("logs/daily"), lineIds: ["d1"], now: LATER }), /already in logs\/daily/, "planning the same restore twice never doubles a line");
});

test("a plan made from an older read is refused by the store, and nothing is written", () => {
  const store = storeOf({ ...DOCS(), "logs/daily": DAILY_NOW });
  const plan = planRestore({ backup: backupOf(), live: readStore(store, PATHS), target: split("logs/daily"), lineIds: ["d1"], now: LATER });
  store.overwrite("logs", "daily", dailyDoc([textLine("typed-meanwhile", T(18))]));   /* a device saved in between */
  assert.throws(() => store.batch(plan.writes), /refused/);
  assert.deepEqual(ids(store.read("logs", "daily").doc), ["typed-meanwhile"]);
});

test("the check afterwards finds a restored line that a device overwrote, changed or doubled", () => {
  const store = storeOf({ ...DOCS(), "logs/daily": DAILY_NOW, [OTHER]: { version: 1, doc: notebookDoc([]) } });
  const plan = planRestore({ backup: backupOf(), live: readStore(store, PATHS), target: split("logs/daily"), lineIds: ["d1", "d3"], now: LATER });
  store.batch(plan.writes);
  store.overwrite("logs", "daily", dailyDoc([{ ...textLine("d1", T(9)), text: "made-up note, edited" }, photoLine("d2", T(11))]));
  const check = verifyRestore({ plan, live: readStore(store, PATHS) });
  assert.equal(check.clean, false);
  assert.deepEqual(check.lines, [{ id: "d1", status: "changed", places: ["logs/daily"], differs: ["text"] }, { id: "d3", status: "missing", places: [], differs: [] }]);
  store.overwrite("entries", OTHER_NOTEBOOK_ID, notebookDoc([textLine("d1", T(9))]));
  assert.equal(verifyRestore({ plan, live: readStore(store, PATHS) }).lines[0].status, "duplicate");
});

test("a restored whole document is checked field by field", () => {
  const store = storeOf(without(DOCS(), NOTEBOOK));
  const plan = planRestore({ backup: backupOf(), live: readStore(store, PATHS), target: split(NOTEBOOK), whole: true, now: LATER });
  assert.deepEqual(verifyRestore({ plan, live: readStore(store, PATHS) }).document, { status: "missing", differs: [] }, "before the batch is sent the document is not there");
  store.batch(plan.writes);
  const check = verifyRestore({ plan, live: readStore(store, PATHS) });
  assert.equal(check.clean, true); assert.deepEqual(check.document, { status: "ok", differs: [] });
  store.overwrite("entries", NOTEBOOK_ID, { ...DOCS()[NOTEBOOK].doc, title: "Renamed on a device" });
  const after = verifyRestore({ plan, live: readStore(store, PATHS) });
  assert.equal(after.clean, false); assert.deepEqual(after.document, { status: "changed", differs: ["title"] });
});

/* ---- the command line: folders in, folders out ---- */

const tmp = () => mkdtempSync(join(tmpdir(), "atg-backup-test-"));
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
const out = result => JSON.parse(result.stdout);
const writeFile = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
/* what a session leaves in a folder after reading: the documents as the data tool saves them, the listing it wrote, and the asset listing */
function writeRead(folder, docs, files) {
  const listing = Object.fromEntries(COLLECTIONS.map(c => [c, {}]));
  for (const [path, d] of Object.entries(docs)) {
    const { collection, id } = split(path);
    listing[collection] = { ...listing[collection], [id]: d.version };
    writeFile(join(folder, "documents", collection, id + ".json"), JSON.stringify(d.doc, null, 2) + "\n");
  }
  writeFile(join(folder, "listing.json"), JSON.stringify(listing));
  if (files) writeFile(join(folder, "assets.txt"), assetListingText(files));
  return folder;
}
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "text/plain": ".txt", "application/pdf": ".pdf" };
const fetchInto = (folder, files) => Object.entries(files).forEach(([id, f]) => writeFile(join(folder, id + EXT[f.type]), f.buf));

test("manifest: fetched files are checked and moved into the shared store, and the backup is complete", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  const before = run("manifest", "--run", first, "--taken-at", NOW);
  assert.equal(before.status, 1, before.stderr);
  assert.equal(out(before).complete, false);
  assert.deepEqual(out(before).toFetch.sort(), Object.keys(FILES()).sort(), "the first run names every file to fetch");
  assert.equal(readJson(join(first, "manifest.json")).complete, false, "a backup that is not whole yet says so in its own manifest");
  fetchInto(join(first, "incoming"), FILES());
  const done = run("manifest", "--run", first, "--taken-at", NOW);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const summary = out(done), manifest = readJson(join(first, "manifest.json"));
  assert.equal(summary.complete, true); assert.equal(manifest.complete, true); assert.equal(manifest.takenAt, NOW);
  assert.deepEqual([summary.documents, summary.assets, summary.fetched], [5, 5, 5]); assert.deepEqual(summary.toFetch, []);
  assert.deepEqual(readdirSync(join(root, "assets")).sort(), ["asset-d2.jpg", "asset-pdf.pdf", "chunk-m1-1.txt", "chunk-m1-2.txt", "ink-n2.png"]);
  assert.deepEqual(readFileSync(join(root, "assets", "asset-d2.jpg")), FILES()["asset-d2"].buf);
  assert.deepEqual(readdirSync(join(first, "incoming")), [], "a checked file is moved, not copied");
  assert.equal(manifest.assets.find(a => a.id === "ink-n2").file, "ink-n2.png");
  assert.deepEqual([statSync(first).mode & 0o077, statSync(join(root, "assets")).mode & 0o077, statSync(join(root, "assets", "asset-d2.jpg")).mode & 0o077], [0, 0, 0], "the dated folder and the store are their owner's only");
  assert.equal(summary.report.length, 3); assert.match(summary.report[2], /complete/i);
  assert.ok(summary.folderBytes > 0);
});

test("manifest: a second backup reads no stored file again, and an unchanged document takes no new space", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  fetchInto(join(first, "incoming"), FILES());
  assert.equal(run("manifest", "--run", first, "--taken-at", NOW).status, 0);
  const newFile = { "asset-d9": { type: "image/jpeg", buf: text("a second made-up photo") } }, files = { ...FILES(), ...newFile };
  const docs = { ...DOCS(), "logs/daily": { version: 5, doc: dailyDoc([textLine("d1", T(9)), photoLine("d2", T(11)), photoLine("d9", T(17))]) } };
  const second = writeRead(join(root, "260311-1800"), docs, files);
  const need = run("manifest", "--run", second, "--taken-at", LATER);
  assert.deepEqual(out(need).toFetch, ["asset-d9"], "only the file that is new has to be fetched");
  fetchInto(join(second, "incoming"), newFile);
  const done = run("manifest", "--run", second, "--taken-at", LATER);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const summary = out(done);
  assert.equal(summary.base, "260310-1800"); assert.equal(summary.fetched, 1);
  assert.deepEqual(summary.sinceBase, { added: 0, removed: 0, changed: 1, same: 4 });
  const sameFile = p => statSync(join(first, "documents", p)).ino === statSync(join(second, "documents", p)).ino;
  assert.equal(sameFile("config/settings.json"), true, "an unchanged document is the same file on disk as in the backup before");
  assert.equal(sameFile("logs/daily.json"), false);
  assert.deepEqual(readJson(join(second, "documents", "config", "settings.json")), DOCS()["config/settings"].doc, "and every dated folder still holds every document");
  assert.equal(summary.carried, 4);
});

test("manifest: an incomplete backup exits 1, names what is missing, and is never the base of the next one", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  fetchInto(join(first, "incoming"), without(FILES(), "chunk-m1-2"));
  rmSync(join(first, "documents", "logs", "todo.json"));
  const result = run("manifest", "--run", first, "--taken-at", NOW);
  assert.equal(result.status, 1);
  const summary = out(result);
  assert.deepEqual(summary.missing, { documents: 1, assets: 1, recordings: 1 }); assert.deepEqual(summary.toFetch, ["chunk-m1-2"]);
  assert.deepEqual(summary.problems, ["logs/todo: listed but not saved"], "the summary names what fetching will not put right; a recording waiting for a chunk is not one of those");
  const written = readJson(join(first, "manifest.json")).missing;
  assert.deepEqual(written.documents, [{ document: "logs/todo", why: "listed but not saved" }]);
  assert.deepEqual(written.assets.map(a => a.id), ["chunk-m1-2"]); assert.equal(written.recordings.length, 1);
  assert.match(summary.report[2], /INCOMPLETE/);
  const second = writeRead(join(root, "260311-1800"), DOCS(), FILES());
  fetchInto(join(second, "incoming"), { "chunk-m1-2": FILES()["chunk-m1-2"] });
  const next = run("manifest", "--run", second, "--taken-at", LATER);
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assert.equal(out(next).base, null); assert.equal(out(next).fetched, 1, "the files the first run did store are not fetched again");
});

test("manifest: a fetched file that is not what the listing says stays out of the store", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  fetchInto(join(first, "incoming"), { ...FILES(), "asset-d2": { type: "image/jpeg", buf: text("cut short") } });
  const result = run("manifest", "--run", first, "--taken-at", NOW);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(root, "assets", "asset-d2.jpg")), false);
  assert.equal(existsSync(join(first, "incoming", "asset-d2.jpg")), true, "it is left where it was, for a second look");
  assert.deepEqual(out(result).rejected.map(r => r.id), ["asset-d2"]); assert.match(out(result).problems[0], /asset-d2 was not taken into the store/);
  assert.deepEqual(out(result).toFetch, ["asset-d2"]);
});

test("manifest: a link in the incoming folder is never moved into the store, whatever it points to", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  fetchInto(join(first, "incoming"), without(FILES(), "asset-d2"));
  writeFile(join(root, "elsewhere.jpg"), FILES()["asset-d2"].buf);
  symlinkSync(join(root, "elsewhere.jpg"), join(first, "incoming", "asset-d2.jpg"));
  const result = run("manifest", "--run", first, "--taken-at", NOW);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(root, "assets", "asset-d2.jpg")), false);
  assert.match(out(result).problems[0], /asset-d2 was not taken into the store.*not a regular file/);
});

test("manifest: refuses a folder without a listing, a listing without a collection, and a run that is not a folder of its own", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRead(join(root, "260310-1800"), DOCS(), FILES());
  rmSync(join(first, "assets.txt"));
  const noAssets = run("manifest", "--run", first);
  assert.equal(noAssets.status, 1); assert.match(noAssets.stderr, /assets\.txt/);
  writeFile(join(first, "listing.json"), JSON.stringify({ config: {}, entries: {}, logs: {} }));
  assert.match(run("manifest", "--run", first).stderr, /does not name protocols/);
  assert.match(run("manifest", "--run", join(root, "nope")).stderr, /no such folder/);
  assert.equal(existsSync(join(first, "manifest.json")), false, "nothing is written when the folder cannot be read");
});

/* a complete first backup of DOCS() and FILES() under root */
function completeBackup(root, name = "260310-1800") {
  const folder = writeRead(join(root, name), DOCS(), FILES());
  fetchInto(join(folder, "incoming"), FILES());
  const made = run("manifest", "--run", folder, "--taken-at", NOW);
  assert.equal(made.status, 0, made.stderr + made.stdout);
  return folder;
}

test("diff: a backup compared with a fresh read prints what a restore would have to bring back", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = completeBackup(root), fresh = writeRead(join(root, "fresh"), { ...DOCS(), "logs/daily": DAILY_NOW });
  const result = run("diff", "--from", backup, "--to", fresh, "--out", join(root, "diff-1"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /logs\/daily.*version 4 → 9/); assert.match(result.stdout, /2 lines are in no document any more/); assert.match(result.stdout, /d1/);
  assert.ok(!result.stdout.includes("made-up note"));
  assert.deepEqual(readJson(join(root, "diff-1", "diff.json")).lost, [{ id: "d1", document: "logs/daily" }, { id: "d3", document: "logs/daily" }]);
  assert.match(run("diff", "--from", backup, "--to", join(root, "nope")).stderr, /no such folder/);
});

test("restore-plan and verify-restore: a pinned batch and a plain summary in a folder of their own, and a check of the read afterwards", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = completeBackup(root), fresh = writeRead(join(root, "fresh-1"), { ...DOCS(), "logs/daily": DAILY_NOW }, FILES());
  const plan = join(root, "plan-1");
  const result = run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--out", plan, "--now", LATER, "d1", "d3");
  assert.equal(result.status, 0, result.stderr);
  const batch = readJson(join(plan, "batch.json"));
  assert.deepEqual(batch.writes, [{ op: "set", collection: "logs", doc_id: "daily", file_path: join(plan, "logs", "daily.json"), if_version: 9 }]);
  assert.deepEqual(ids(readJson(batch.writes[0].file_path)), ["d1", "d2", "d5", "d3", "d8"]);
  const summary = readFileSync(join(plan, "summary.txt"), "utf8");
  assert.match(summary, /put back 2 lines into logs\/daily/); assert.match(summary, /pinned to version 9/); assert.match(summary, /Nothing has been written/);
  assert.match(summary, /made-up note d1/, "the owner sees the first words of each line that would come back");
  assert.equal(statSync(join(plan, "batch.json")).mode & 0o077, 0, "the plan is readable by its owner only");
  const again = run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--out", plan, "--now", LATER, "d1");
  assert.equal(again.status, 1); assert.match(again.stderr, /already holds files/);
  const before = readFileSync(join(backup, "documents", "logs", "daily.json"), "utf8");
  const intoBackup = run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--out", join(root, "assets"), "--now", LATER, "d1");
  assert.equal(intoBackup.status, 1); assert.match(intoBackup.stderr, /already holds files/, "--out is a new or empty folder, so nothing that exists is ever written over");
  assert.equal(readFileSync(join(backup, "documents", "logs", "daily.json"), "utf8"), before);
  const typo = run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--out", join(root, "plan-2"), "--whole=true", "d1");
  assert.equal(typo.status, 1); assert.match(typo.stderr, /unknown option --whole=true/);
  /* before the batch is sent the check says the lines are missing; after, it is clean */
  const notYet = run("verify-restore", "--plan", plan, "--live", fresh);
  assert.equal(notYet.status, 1); assert.deepEqual(out(notYet).lines.map(l => l.status), ["missing", "missing"]);
  const applied = writeRead(join(root, "fresh-2"), { ...DOCS(), "logs/daily": { version: 10, doc: readJson(batch.writes[0].file_path) } });
  const ok = run("verify-restore", "--plan", plan, "--live", applied);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout); assert.equal(out(ok).clean, true);
});

test("restore-plan: a fresh read with exactly a page of documents in a collection is refused until the session confirms it read to the last page", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = completeBackup(root);
  const more = Object.fromEntries(Array.from({ length: 99 }, (_, i) => ["protocols/p" + i, { version: 1, doc: { title: "made-up " + i } }]));
  const fresh = writeRead(join(root, "fresh-1"), { ...DOCS(), "logs/daily": DAILY_NOW, ...more }, FILES());
  const plan = (...rest) => run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--now", LATER, ...rest);
  const refused = plan("--out", join(root, "p1"), "d1");
  assert.equal(refused.status, 1); assert.match(refused.stderr, /protocols has exactly 100 documents.*--pages-checked/s);
  assert.equal(existsSync(join(root, "p1")), false);
  const confirmed = plan("--out", join(root, "p2"), "--pages-checked", "d1");
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const check = run("verify-restore", "--plan", join(root, "p2"), "--live", fresh);
  assert.equal(check.status, 1); assert.match(check.stderr, /--pages-checked/, "the check afterwards needs a whole read just as much");
});

test("restore-plan: a whole document that is gone is planned as a creation, with no pin in the batch", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = completeBackup(root), fresh = writeRead(join(root, "fresh-1"), without(DOCS(), NOTEBOOK), FILES());
  const plan = join(root, "plan-1");
  const result = run("restore-plan", "--backup", backup, "--live", fresh, "--document", NOTEBOOK, "--whole", "--out", plan, "--now", LATER);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(join(plan, "batch.json")).writes, [{ op: "set", collection: "entries", doc_id: NOTEBOOK_ID, file_path: join(plan, "entries", NOTEBOOK_ID + ".json") }]);
  assert.deepEqual(readJson(join(plan, "entries", NOTEBOOK_ID + ".json")), DOCS()[NOTEBOOK].doc);
  assert.match(readFileSync(join(plan, "summary.txt"), "utf8"), /create entries\/1111.*as it was in the backup/s);
});

test("restore-plan: refuses an incomplete backup, a backup file that no longer matches its manifest, and a fresh read that is not whole", t => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = completeBackup(root), fresh = writeRead(join(root, "fresh-1"), { ...DOCS(), "logs/daily": DAILY_NOW }, FILES());
  const plan = (...more) => run("restore-plan", "--backup", backup, "--live", fresh, "--document", "logs/daily", "--now", LATER, ...more);
  /* a fresh read that lacks a document its listing names cannot show that a line is live nowhere */
  rmSync(join(fresh, "documents", "entries", NOTEBOOK_ID + ".json"));
  const partial = plan("--out", join(root, "p1"), "d1");
  assert.equal(partial.status, 1); assert.match(partial.stderr, /fresh read is not whole.*entries\/1111/s);
  writeRead(fresh, { ...DOCS(), "logs/daily": DAILY_NOW }, FILES());
  /* a document in the backup that was changed after the manifest was written */
  const dailyFile = join(backup, "documents", "logs", "daily.json");
  rmSync(dailyFile); writeFileSync(dailyFile, JSON.stringify(dailyDoc([textLine("d1", T(9), "slipped in later")])));
  const tampered = plan("--out", join(root, "p2"), "d1");
  assert.equal(tampered.status, 1); assert.match(tampered.stderr, /logs\/daily.*no longer matches its manifest/s);
  /* a backup marked incomplete */
  const manifestFile = join(backup, "manifest.json"), manifest = readJson(manifestFile);
  rmSync(manifestFile); writeFileSync(manifestFile, JSON.stringify({ ...manifest, complete: false }));
  const incomplete = plan("--out", join(root, "p3"), "d1");
  assert.equal(incomplete.status, 1); assert.match(incomplete.stderr, /incomplete/);
  rmSync(manifestFile);
  assert.match(plan("--out", join(root, "p4"), "d1").stderr, /no manifest/);
  assert.equal(["p1", "p2", "p3", "p4"].some(p => existsSync(join(root, p))), false, "a refusal writes nothing");
});
