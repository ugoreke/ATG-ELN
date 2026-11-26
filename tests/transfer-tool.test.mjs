// The transfer tool (tools/transfer): planning the move of lines from Daily into a notebook, checking it afterwards, and the audit.
// Everything runs on made-up documents and a stand-in store; no account, no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planMove, verifyMove, docRefFromPath, collectLines, MAX_DOC_BYTES, MOVED_KEEP_DAYS } from "../tools/transfer/lib.mjs";
import { audit, formatAudit } from "../tools/transfer/audit.mjs";
import { NOW, NOTEBOOK_ID, OTHER_NOTEBOOK_ID, MEETING_ID, NEW_NOTEBOOK_ID, BENCHLING_URL, daysBefore, deepFreeze, textLine, photoLine, inkLine, voiceMemo,
  dailyDoc, notebookDoc, makeStore } from "./transfer-fixtures.mjs";

const TOOL = fileURLToPath(new URL("../tools/transfer/transfer.mjs", import.meta.url));
const LATER = "2026-03-10T18:05:00.000Z";
const T = h => `2026-03-10T${String(h).padStart(2, "0")}:00:00.000Z`;
const ids = doc => doc.blocks.map(b => b.id);

/* a Daily log with four kinds of line and a notebook that already has two lines */
const startStore = (extra = {}) => makeStore({
  "logs/daily": dailyDoc([textLine("d1", T(9)), photoLine("d2", T(11)), inkLine("d3", T(13)), voiceMemo("d4", T(15)), textLine("stays", T(16))]),
  ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("n1", T(10)), textLine("n2", T(14))]),
  ...extra,
});
const planFor = (store, lineIds, more = {}) => planMove({ daily: store.read("logs", "daily"), notebook: store.read("entries", NOTEBOOK_ID), lineIds, benchlingUrl: BENCHLING_URL, now: NOW, ...more });
const verifyFor = (store, lineIds, copies, more = {}) => verifyMove({ daily: store.read("logs", "daily"), notebook: store.read("entries", NOTEBOOK_ID), lineIds, copies, now: LATER, ...more });

/* ---- planning a move ---- */

test("a plain move: the lines leave Daily and land in the notebook, in one batch with both documents pinned", () => {
  const store = startStore(), plan = planFor(store, ["d1", "d2"]);
  assert.equal(plan.writes.length, 2);
  const [toNotebook, toDaily] = plan.writes;
  assert.deepEqual([toNotebook.op, toNotebook.collection, toNotebook.doc_id, toNotebook.if_version], ["set", "entries", NOTEBOOK_ID, 1], "the notebook is written first");
  assert.deepEqual([toDaily.op, toDaily.collection, toDaily.doc_id, toDaily.if_version], ["set", "logs", "daily", 1]);
  assert.deepEqual(ids(toNotebook.data), ["d1", "n1", "d2", "n2"]);
  assert.equal(toNotebook.data.benchlingUrl, BENCHLING_URL); assert.equal(toNotebook.data.updatedAt, NOW);
  assert.equal(toNotebook.data.title, "260310_Made-up_Line_Test"); assert.deepEqual(toNotebook.data.protocols, ["made-up-protocol"]);
  assert.equal(toNotebook.data.createdAt, "2026-03-01T08:00:00.000Z", "fields the tool does not set are kept");
  assert.deepEqual(ids(toDaily.data), ["d3", "d4", "stays"]);
  assert.deepEqual(toDaily.data.moved, { d1: { to: NOTEBOOK_ID, at: NOW }, d2: { to: NOTEBOOK_ID, at: NOW } });
  assert.equal(toDaily.data.updatedAt, NOW); assert.deepEqual(toDaily.data.protocols, []);
  assert.deepEqual(plan.moved, ["d1", "d2"]); assert.deepEqual(plan.alreadyInNotebook, []);
  assert.deepEqual(plan.lines, [textLine("d1", T(9)), photoLine("d2", T(11))], "the copies to keep for the check afterwards");
});

test("every kind of line is copied with every field exactly as stored, a voice memo included", () => {
  const store = startStore(), plan = planFor(store, ["d2", "d3", "d4"]), blocks = plan.writes[0].data.blocks;
  const memo = blocks.find(b => b.id === "d4");
  assert.deepEqual(memo, voiceMemo("d4", T(15)));
  assert.deepEqual(Object.keys(memo).sort(), ["at", "attachedAt", "audioRemovedAt", "bytes", "caption", "chunks", "duration", "fileName", "id", "mime", "sha256", "transcribedAt", "transcriber", "transcript", "type"]);
  assert.deepEqual(blocks.find(b => b.id === "d2"), photoLine("d2", T(11)));
  assert.deepEqual(blocks.find(b => b.id === "d3"), inkLine("d3", T(13)));
  const odd = makeStore({ "logs/daily": dailyDoc([{ ...textLine("x1", T(9)), somethingNew: { kept: [1, 2] } }]), ["entries/" + NOTEBOOK_ID]: notebookDoc([]) });
  assert.deepEqual(planFor(odd, ["x1"]).writes[0].data.blocks[0], { ...textLine("x1", T(9)), somethingNew: { kept: [1, 2] } }, "a field this tool has never heard of is kept too");
});

test("a line that is already in the notebook is skipped there, not duplicated, and still taken out of Daily", () => {
  const store = startStore({ ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("n1", T(10)), textLine("d1", T(9))]) });
  const plan = planFor(store, ["d1", "d2"]), [toNotebook, toDaily] = plan.writes;
  assert.deepEqual(ids(toNotebook.data), ["d1", "n1", "d2"]);
  assert.deepEqual(ids(toDaily.data), ["d3", "d4", "stays"]);
  assert.deepEqual(Object.keys(toDaily.data.moved), ["d1", "d2"]);
  assert.deepEqual(plan.alreadyInNotebook, ["d1"]); assert.deepEqual(plan.moved, ["d2"]);
  const edited = startStore({ ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("d1", T(9), "older wording")]) }), second = planFor(edited, ["d1"]);
  assert.equal(second.writes[0].data.blocks[0].text, "older wording", "the notebook's copy is left as it is");
  assert.match(second.warnings.join("\n"), /d1.*differs/);
});

test("the notebook's lines are sorted by time, and lines with the same time keep their order", () => {
  const store = makeStore({
    "logs/daily": dailyDoc([textLine("late", T(20)), textLine("same-b", T(12)), textLine("early", T(7)), textLine("same-c", T(12))]),
    ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("n-noon", T(12)), textLine("n-morning", T(8))]),
  });
  assert.deepEqual(ids(planFor(store, ["late", "same-b", "early", "same-c"]).writes[0].data), ["early", "n-morning", "n-noon", "same-b", "same-c", "late"]);
});

test("a notebook that does not exist yet is created in the same batch, without a pin of its own", () => {
  const store = startStore();
  const plan = planMove({ daily: store.read("logs", "daily"), notebook: { collection: "entries", id: NEW_NOTEBOOK_ID, create: { title: "260310_Made-up_New" } }, lineIds: ["d2", "d1"], benchlingUrl: BENCHLING_URL, now: NOW });
  const [toNotebook, toDaily] = plan.writes;
  assert.equal("if_version" in toNotebook, false); assert.equal(toDaily.if_version, 1);
  assert.deepEqual(toNotebook.data, { title: "260310_Made-up_New", createdAt: NOW, updatedAt: NOW, protocols: [], blocks: [textLine("d1", T(9)), photoLine("d2", T(11))], benchlingUrl: BENCHLING_URL });
  assert.deepEqual(toDaily.data.moved.d1, { to: NEW_NOTEBOOK_ID, at: NOW });
  store.batch(plan.writes);
  assert.deepEqual(ids(store.read("entries", NEW_NOTEBOOK_ID).doc), ["d1", "d2"]);
  const again = { daily: store.read("logs", "daily"), lineIds: ["d3"], benchlingUrl: BENCHLING_URL, now: NOW };
  assert.throws(() => planMove({ ...again, notebook: { collection: "entries", id: "not-a-uuid", create: { title: "x" } } }), /new notebook needs a UUID/);
  assert.throws(() => planMove({ ...again, notebook: { collection: "entries", id: OTHER_NOTEBOOK_ID, create: { title: "  " } } }), /needs a title/);
});

test("a notebook is never created over one that already exists", () => {
  const store = startStore(), create = { collection: "entries", id: NEW_NOTEBOOK_ID, create: { title: "260310_Made-up_New" } };
  const first = planMove({ daily: store.read("logs", "daily"), notebook: create, lineIds: ["d1"], benchlingUrl: BENCHLING_URL, now: NOW });
  store.batch(first.writes);
  assert.throws(() => planMove({ daily: store.read("logs", "daily"), notebook: create, lineIds: ["d2"], benchlingUrl: BENCHLING_URL, now: NOW }), /44444444.* already exists.*plan against it/);
  assert.throws(() => store.batch([{ ...first.writes[0] }]), /refused/, "and the store refuses a write without a pin over a document that exists, as the data tool does");
  assert.deepEqual(ids(store.read("entries", NEW_NOTEBOOK_ID).doc), ["d1"]);
});

test("an older or shorter name is replaced by the Benchling name in the same batch", () => {
  const store = startStore(), plan = planFor(store, ["d1"], { title: "260310_Made-up_Line_Test_Nucleofection" });
  assert.equal(plan.writes[0].data.title, "260310_Made-up_Line_Test_Nucleofection"); assert.equal(plan.renamedFrom, "260310_Made-up_Line_Test");
  assert.equal(planFor(store, ["d1"]).renamedFrom, undefined);
});

test(`entries in moved older than ${MOVED_KEEP_DAYS} days are removed, unless their line is back in Daily`, () => {
  const moved = {
    old: { to: OTHER_NOTEBOOK_ID, at: daysBefore(NOW, 31) }, recent: { to: OTHER_NOTEBOOK_ID, at: daysBefore(NOW, 29) },
    "old-but-back": { to: OTHER_NOTEBOOK_ID, at: daysBefore(NOW, 90) }, undated: { to: OTHER_NOTEBOOK_ID },
  };
  const store = makeStore({ "logs/daily": dailyDoc([textLine("d1", T(9)), textLine("old-but-back", T(8))], moved), ["entries/" + NOTEBOOK_ID]: notebookDoc([]) });
  const plan = planFor(store, ["d1"]);
  assert.deepEqual(Object.keys(plan.writes[1].data.moved).sort(), ["d1", "old-but-back", "recent", "undated"]);
  assert.deepEqual(plan.pruned, ["old"]);
});

test("the documents given to the tool are never changed", () => {
  const store = startStore(), daily = store.read("logs", "daily"), notebook = store.read("entries", NOTEBOOK_ID);
  const before = JSON.stringify([daily, notebook]);
  assert.ok(Object.isFrozen(daily.doc.blocks[0]), "the stand-in hands out frozen documents");
  const plan = planFor(store, ["d1", "d4"]);
  assert.equal(JSON.stringify([daily, notebook]), before);
  plan.writes[0].data.blocks[0].text = "changed in the plan";
  assert.equal(daily.doc.blocks[0].text, "made-up note d1", "the plan holds copies, not the same objects");
  const copies = deepFreeze(structuredClone(plan.lines));
  store.batch(planFor(store, ["d1", "d4"]).writes);
  assert.equal(verifyFor(store, ["d1", "d4"], copies).clean, true);
  const report = audit({ documents: [store.read("logs", "daily"), store.read("entries", NOTEBOOK_ID)] });
  assert.equal(report.clean, true);
});

/* ---- refusals ---- */

test("what the rules forbid is refused with the reason", () => {
  const store = startStore({
    ["entries/" + MEETING_ID]: notebookDoc([], { kind: "meeting" }), ["entries/" + OTHER_NOTEBOOK_ID]: notebookDoc([], { kind: "tab-abc12345" }),
    "logs/todo": { items: [], updatedAt: NOW }, "logs/tab-abc12345": dailyDoc([textLine("t1", T(9))]),
  });
  const daily = store.read("logs", "daily"), notebook = store.read("entries", NOTEBOOK_ID), base = { daily, notebook, lineIds: ["d1"], benchlingUrl: BENCHLING_URL, now: NOW };
  assert.throws(() => planMove({ ...base, lineIds: ["d1", "nope"] }), /nope is not in Daily/);
  assert.throws(() => planMove({ ...base, lineIds: ["n1"] }), /n1 is not in Daily/, "a line that is only in the notebook is not a Daily line");
  assert.throws(() => planMove({ ...base, notebook: store.read("entries", MEETING_ID) }), /is a meeting/);
  assert.throws(() => planMove({ ...base, notebook: store.read("entries", OTHER_NOTEBOOK_ID) }), /belongs to another tab/);
  assert.throws(() => planMove({ ...base, daily: store.read("logs", "todo") }), /only moved out of logs\/daily, not out of logs\/todo/);
  assert.throws(() => planMove({ ...base, daily: store.read("logs", "tab-abc12345"), lineIds: ["t1"] }), /not out of logs\/tab-abc12345/);
  assert.throws(() => planMove({ ...base, notebook: { ...notebook, collection: "config", id: "tabs" } }), /only moved into a notebook in entries, not into config\/tabs/);
  assert.throws(() => planMove({ ...base, notebook: { ...daily } }), /not into logs\/daily/);
  assert.throws(() => planMove({ ...base, lineIds: [] }), /no line ids/);
  assert.throws(() => planMove({ ...base, benchlingUrl: "" }), /Benchling URL/);
  assert.throws(() => planMove({ ...base, benchlingUrl: "https://example.invalid/entry" }), /Benchling URL/);
  assert.throws(() => planMove({ ...base, benchlingUrl: "http://benchling.com/x" }), /Benchling URL/);
  assert.throws(() => planMove({ ...base, now: "yesterday" }), /time/);
  assert.throws(() => planMove({ ...base, daily: { ...daily, version: undefined } }), /version of logs\/daily/);
  assert.throws(() => planMove({ ...base, notebook: { ...notebook, version: 0 } }), /version of entries/);
  assert.throws(() => planMove({ ...base, daily: { ...daily, doc: { updatedAt: NOW } } }), /logs\/daily has no list of lines/);
  assert.throws(() => planMove({ ...base, notebook: { ...notebook, doc: null } }), /entries\/.* is not a document/);
});

test("a line is never moved a second time into another notebook, and a voice memo without a transcript stays in Daily", () => {
  const elsewhere = makeStore({
    "logs/daily": dailyDoc([textLine("back", T(9)), voiceMemo("waiting", T(10), { transcript: "", transcribedAt: "", transcriber: "" })], { back: { to: OTHER_NOTEBOOK_ID, at: daysBefore(NOW, 1) }, gone: { to: NOTEBOOK_ID, at: daysBefore(NOW, 1) } }),
    ["entries/" + NOTEBOOK_ID]: notebookDoc([]),
  });
  assert.throws(() => planFor(elsewhere, ["back"]), /back was already moved to notebook 22222222/);
  assert.throws(() => planFor(elsewhere, ["gone"]), /gone was moved into this notebook earlier and is no longer there.*verify/);
  assert.throws(() => planFor(elsewhere, ["waiting"]), /waiting is a voice memo without a transcript/);
  const twice = makeStore({ "logs/daily": dailyDoc([textLine("dup", T(9), "one wording"), textLine("dup", T(9), "another wording")]), ["entries/" + NOTEBOOK_ID]: notebookDoc([]) });
  assert.throws(() => planFor(twice, ["dup"]), /dup is in Daily twice with different content/);
});

test(`a notebook that would grow past ${MAX_DOC_BYTES} bytes is refused`, () => {
  const store = makeStore({ "logs/daily": dailyDoc([textLine("big", T(9), "x".repeat(120000))]), ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("n1", T(8), "y".repeat(120000))]) });
  assert.throws(() => planFor(store, ["big"]), /larger than 230000 bytes/);
});

/* ---- a session that stops half-way, and a device that saves an older copy ---- */

test("a session that stopped right after the batch: the next one checks the move and finds it complete", () => {
  const store = startStore(), plan = planFor(store, ["d1", "d2", "d4"]);
  store.batch(plan.writes);
  const check = verifyFor(store, ["d1", "d2", "d4"], plan.lines);
  assert.equal(check.clean, true); assert.equal(check.repair, null);
  assert.deepEqual(check.lines.map(l => [l.id, l.status]), [["d1", "ok"], ["d2", "ok"], ["d4", "ok"]]);
});

test("a device saves an older notebook over the move: the check gives a repair, and after it the check is clean", () => {
  const store = startStore(), staleNotebook = structuredClone(store.read("entries", NOTEBOOK_ID).doc), plan = planFor(store, ["d1", "d2", "d4"]);
  store.batch(plan.writes);
  store.overwrite("entries", NOTEBOOK_ID, { ...staleNotebook, blocks: [...staleNotebook.blocks, textLine("typed-late", T(17))] });
  const check = verifyFor(store, ["d1", "d2", "d4"], plan.lines);
  assert.equal(check.clean, false);
  assert.deepEqual(check.lines.map(l => l.status), ["missing", "missing", "missing"]);
  assert.deepEqual(check.repair.restored, ["d1", "d2", "d4"]);
  const [fix] = check.repair.writes;
  assert.equal(check.repair.writes.length, 1);
  assert.deepEqual([fix.op, fix.collection, fix.doc_id, fix.if_version], ["set", "entries", NOTEBOOK_ID, 3]);
  assert.deepEqual(ids(fix.data), ["d1", "n1", "d2", "n2", "d4", "typed-late"], "the line typed on that device is kept");
  assert.deepEqual(fix.data.blocks.find(b => b.id === "d4"), voiceMemo("d4", T(15)));
  assert.throws(() => store.batch([{ ...fix, if_version: 2 }]), /refused/, "a write pinned to an older version is refused");
  store.batch(check.repair.writes);
  const after = verifyFor(store, ["d1", "d2", "d4"], plan.lines);
  assert.equal(after.clean, true); assert.equal(after.repair, null);
});

test("a device saves an older Daily over the move: the lines are back in Daily but listed in moved, which is fine", () => {
  const store = startStore(), staleDaily = structuredClone(store.read("logs", "daily").doc), plan = planFor(store, ["d1"]);
  store.batch(plan.writes);
  store.overwrite("logs", "daily", { ...staleDaily, moved: store.read("logs", "daily").doc.moved });   /* the app never writes moved, so it survives */
  const check = verifyFor(store, ["d1"], plan.lines);
  assert.equal(check.clean, true);
  assert.deepEqual(check.lines[0], { id: "d1", status: "ok", inNotebook: 1, inDaily: true, movedTo: NOTEBOOK_ID, differs: [], copy: "saved" });
});

test("planning the same move twice changes nothing more", () => {
  const store = startStore(), plan = planFor(store, ["d1", "d2"]);
  store.batch(plan.writes);
  assert.throws(() => store.batch(plan.writes), /refused/, "the same batch a second time is refused by its pins");
  const again = planFor(store, ["d1", "d2"]);
  assert.deepEqual(again.writes, []); assert.deepEqual(again.alreadyDone, ["d1", "d2"]); assert.deepEqual(again.moved, []);
});

test("a batch that reached the notebook but not Daily is finished by planning again, without a second copy", () => {
  const store = startStore(), plan = planFor(store, ["d1", "d2"]);
  store.batch([plan.writes[0]]);
  const half = verifyFor(store, ["d1", "d2"], plan.lines);
  assert.equal(half.clean, false); assert.deepEqual(half.lines.map(l => l.status), ["still-in-daily", "still-in-daily"]); assert.equal(half.repair, null);
  const again = planFor(store, ["d1", "d2"]);
  assert.deepEqual(again.alreadyInNotebook, ["d1", "d2"]);
  store.batch(again.writes);
  assert.deepEqual(ids(store.read("entries", NOTEBOOK_ID).doc), ["d1", "n1", "d2", "n2"]);
  assert.equal(verifyFor(store, ["d1", "d2"], plan.lines).clean, true);
});

test("the check tells apart every way a move can have gone wrong", () => {
  const copies = [textLine("a", T(9)), textLine("b", T(10)), textLine("c", T(11)), textLine("e", T(13))];
  const store = makeStore({
    "logs/daily": dailyDoc([textLine("c", T(11)), textLine("f", T(14))], { a: { to: NOTEBOOK_ID, at: NOW }, b: { to: NOTEBOOK_ID, at: NOW }, d: { to: NOTEBOOK_ID, at: NOW }, e: { to: NOTEBOOK_ID, at: NOW }, f: { to: NOTEBOOK_ID, at: NOW } }),
    ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("a", T(9), "edited in the notebook"), textLine("b", T(10)), textLine("b", T(10))]),
  });
  const check = verifyFor(store, ["a", "b", "c", "d", "e", "f"], copies), by = Object.fromEntries(check.lines.map(l => [l.id, l]));
  assert.equal(check.clean, false);
  assert.equal(by.a.status, "changed"); assert.deepEqual(by.a.differs, ["text"]);
  assert.equal(by.b.status, "duplicate"); assert.equal(by.b.inNotebook, 2);
  assert.equal(by.c.status, "not-moved", "still in Daily and not listed in moved: plan the move again");
  assert.equal(by.d.status, "lost", "missing everywhere and no saved copy: only Benchling has it");
  assert.equal(by.e.status, "missing"); assert.equal(by.e.copy, "saved");
  assert.equal(by.f.status, "missing"); assert.equal(by.f.copy, "daily", "Daily still holds the line although the app hides it, so it serves as the copy");
  assert.deepEqual(check.repair.restored, ["e", "f"]);
  assert.deepEqual(ids(check.repair.writes[0].data), ["a", "b", "b", "e", "f"], "the repair only adds; it removes nothing");
  assert.throws(() => verifyFor(store, ["e"], [textLine("e", T(13)), textLine("e", T(13), "another wording")]), /saved copies of line e differ/);
  assert.throws(() => verifyFor(store, [], copies), /no line ids/);
  assert.throws(() => verifyMove({ daily: store.read("logs", "daily"), notebook: { ...store.read("logs", "daily") }, lineIds: ["a"], copies, now: LATER }), /not into logs\/daily/);
});

test("saved copies are read from a saved document or from a list of lines", () => {
  assert.deepEqual(collectLines(dailyDoc([textLine("a", T(9))])), [textLine("a", T(9))]);
  assert.deepEqual(collectLines({ to: NOTEBOOK_ID, lines: [textLine("b", T(9))] }), [textLine("b", T(9))]);
  assert.deepEqual(collectLines([textLine("c", T(9)), "junk", { noId: true }]), [textLine("c", T(9))]);
  assert.deepEqual(collectLines({ terms: ["x"] }), []); assert.deepEqual(collectLines(null), []);
});

test("a saved file's path names its document, as the data tool lays files out", () => {
  assert.deepEqual(docRefFromPath("/some/run/logs/daily.json"), { collection: "logs", id: "daily" });
  assert.deepEqual(docRefFromPath(`backup/entries/${NOTEBOOK_ID}.json`), { collection: "entries", id: NOTEBOOK_ID });
  assert.throws(() => docRefFromPath("daily.json"), /cannot tell which document/);
  assert.throws(() => docRefFromPath("/run/logs/daily.txt"), /cannot tell which document/);
});

/* ---- audit ---- */

const auditStore = () => {
  const waitingMemo = voiceMemo("m-waiting", T(12), { transcript: "", transcribedAt: "", transcriber: "" });
  return [
    { collection: "logs", id: "daily", doc: dailyDoc([waitingMemo, textLine("stale", T(8))], {
      "moved-ok": { to: NOTEBOOK_ID, at: NOW }, "moved-lost": { to: NOTEBOOK_ID, at: NOW }, "moved-nowhere": { to: NEW_NOTEBOOK_ID, at: NOW }, stale: { to: NOTEBOOK_ID, at: NOW } }) },
    { collection: "entries", id: NOTEBOOK_ID, doc: notebookDoc([textLine("moved-ok", T(9)), textLine("stale", T(8)), textLine("twice", T(10)), textLine("twice", T(10)), textLine("shared", T(11)), voiceMemo("memo-copy", T(13))], { benchlingUrl: BENCHLING_URL }) },
    { collection: "entries", id: OTHER_NOTEBOOK_ID, doc: notebookDoc([textLine("shared", T(11)), voiceMemo("memo-copy", T(13)), textLine("before", "2026-02-01T10:00:00.000Z"), textLine("after", "2026-02-03T10:00:00.000Z")], { lastTransfer: { at: "2026-02-02T10:00:00.000Z", benchlingUrl: BENCHLING_URL } }) },
    { collection: "entries", id: MEETING_ID, doc: notebookDoc([textLine("meeting-line", T(9))], { kind: "meeting" }) },
    { collection: "logs", id: "todo", doc: { items: [{ id: "t1", text: "made-up task", at: NOW, doneAt: null }], updatedAt: NOW } },
    { collection: "protocols", id: "up-abcd1234", doc: { title: "Made-up protocol", text: "", assetId: "protocol-text", source: "upload" } },
  ];
};

test("the audit finds a moved line that is missing from its notebook, and says whether a saved copy has it", () => {
  const copies = [{ file: "backup/logs/daily.json", lines: [textLine("moved-lost", T(9))] }, { file: "other/lines.json", lines: [textLine("moved-lost", T(9))] }];
  const report = audit({ documents: auditStore(), copies });
  assert.equal(report.clean, false);
  assert.deepEqual(report.movedMissing, [
    { id: "moved-lost", to: NOTEBOOK_ID, movedAt: NOW, notebookExists: true, inDaily: false, copies: ["backup/logs/daily.json", "other/lines.json"], copiesAgree: true },
    { id: "moved-nowhere", to: NEW_NOTEBOOK_ID, movedAt: NOW, notebookExists: false, inDaily: false, copies: [], copiesAgree: true },
  ]);
  assert.deepEqual(audit({ documents: auditStore() }).movedMissing[0].copies, [], "no copies given, none found");
  assert.deepEqual(report.staleInDaily, ["stale"], "a moved line that a device saved back into Daily is only noted");
});

test("the audit finds an id that appears twice, in one document or in two, but not voice memo copies of one recording", () => {
  const report = audit({ documents: auditStore() });
  assert.deepEqual(report.duplicates, [
    { id: "twice", places: [`entries/${NOTEBOOK_ID}`, `entries/${NOTEBOOK_ID}`] },
    { id: "shared", places: [`entries/${NOTEBOOK_ID}`, `entries/${OTHER_NOTEBOOK_ID}`] },
  ]);
  assert.deepEqual(report.voiceMemoCopies, [{ id: "memo-copy", places: [`entries/${NOTEBOOK_ID}`, `entries/${OTHER_NOTEBOOK_ID}`] }]);
  const differing = auditStore(); differing[2] = { ...differing[2], doc: notebookDoc([voiceMemo("memo-copy", T(13), { sha256: "b".repeat(64) })]) };
  assert.deepEqual(audit({ documents: differing }).duplicates.map(d => d.id), ["twice", "memo-copy"], "the same id on two different recordings is a duplicate");
});

test("the audit finds documents near the size limit, voice memos waiting, and lines that were never transferred", () => {
  const documents = [...auditStore(), { collection: "entries", id: NEW_NOTEBOOK_ID, doc: notebookDoc([textLine("huge", T(9), "z".repeat(MAX_DOC_BYTES))], { lastTransfer: { at: NOW } }) }];
  const report = audit({ documents });
  assert.equal(report.largeDocuments.length, 1); assert.equal(report.largeDocuments[0].document, `entries/${NEW_NOTEBOOK_ID}`); assert.ok(report.largeDocuments[0].bytes > MAX_DOC_BYTES);
  assert.deepEqual(report.waitingTranscription, [{ document: "logs/daily", id: "m-waiting", at: T(12), duration: 42.5 }]);
  assert.deepEqual(report.neverTransferred, [
    { notebook: NOTEBOOK_ID, title: "260310_Made-up_Line_Test", reason: "no lastTransfer", lines: ["twice", "twice", "shared", "memo-copy"] },
    { notebook: OTHER_NOTEBOOK_ID, title: "260310_Made-up_Line_Test", reason: "lines later than lastTransfer", lines: ["shared", "memo-copy", "after"] },
  ], "lines listed in moved are known to be in Benchling; meetings are not looked at");
});

test("the audit lists stored text assets that no line and no protocol points to, only when it is given the asset list", () => {
  const assets = [{ id: "chunk-m-waiting-1", contentType: "text/plain" }, { id: "chunk-m-waiting-2", contentType: "text/plain; charset=utf-8" }, { id: "chunk-memo-copy-1", contentType: "text/plain" },
    { id: "chunk-memo-copy-2", contentType: "text/plain" }, { id: "protocol-text", contentType: "text/plain" }, { id: "orphan-chunk", contentType: "text/plain" }, { id: "orphan-photo", contentType: "image/jpeg" }];
  assert.deepEqual(audit({ documents: auditStore(), assets }).orphanAssets, ["orphan-chunk"]);
  assert.equal(audit({ documents: auditStore() }).orphanAssets, null);
  const noProtocols = audit({ documents: auditStore().filter(d => d.collection !== "protocols"), assets });
  assert.deepEqual(noProtocols.orphanAssets, ["protocol-text", "orphan-chunk"]); assert.match(noProtocols.notes.join("\n"), /protocols were not given/);
  assert.throws(() => audit({ documents: auditStore(), assets: [{ contentType: "text/plain" }] }), /asset without an id/);
  assert.throws(() => audit({ documents: [{ collection: "entries", id: NOTEBOOK_ID, doc: notebookDoc([]) }] }), /logs\/daily was not given/);
});

test("the audit's report is short, readable, and says that nothing was changed", () => {
  const text = formatAudit(audit({ documents: auditStore(), copies: [{ file: "backup/logs/daily.json", lines: [textLine("moved-lost", T(9))] }], assets: [{ id: "orphan-chunk", contentType: "text/plain" }] }));
  assert.match(text, /2 moved lines are missing from their notebook/); assert.match(text, /moved-lost.*saved copy in backup\/logs\/daily\.json/); assert.match(text, /moved-nowhere.*notebook no longer exists.*no saved copy/);
  assert.match(text, /2 line ids appear more than once/); assert.match(text, /1 voice memo waits for transcription/); assert.match(text, /2 notebooks hold lines that may never have been transferred/);
  assert.match(text, /1 stored text asset that nothing points to/); assert.match(text, /Nothing was changed\./);
  const clean = formatAudit(audit({ documents: [{ collection: "logs", id: "daily", doc: dailyDoc([]) }] }));
  assert.match(clean, /Nothing needs attention/); assert.ok(clean.split("\n").length < 8);
});

/* ---- the command line: files in, files out ---- */

const run = args => JSON.parse(execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf8", stdio: "pipe" }));
const fails = args => { const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" }); assert.equal(r.status, 1, "exit code"); return r; };
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
/* documents saved the way the data tool saves them: <folder>/<collection>/<id>.json */
function saveDocs(folder, docs) {
  return Object.fromEntries(Object.entries(docs).map(([path, doc]) => {
    const file = join(folder, path + ".json");
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(doc, null, 2));
    return [path, file];
  }));
}
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "atg-eln-transfer-test-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("plan writes the batch for the data tool, the two documents and the copies of the moved lines", () => inTempDir(dir => {
  const files = saveDocs(join(dir, "read"), { "logs/daily": dailyDoc([textLine("d1", T(9)), voiceMemo("d4", T(15))]), ["entries/" + NOTEBOOK_ID]: notebookDoc([textLine("n1", T(10))]) });
  const out = join(dir, "plan"), given = ["--daily", files["logs/daily"], "--daily-version", "12", "--notebook", files["entries/" + NOTEBOOK_ID], "--notebook-version", "7", "--benchling-url", BENCHLING_URL];
  const res = run(["plan", ...given, "--now", NOW, "--out", out, "d1", "d4"]);
  assert.deepEqual(res.moved, ["d1", "d4"]); assert.equal(res.batch, join(out, "batch.json")); assert.equal(res.lines, join(out, "lines.json"));
  const batch = readJson(res.batch);
  assert.deepEqual(batch.writes, [
    { op: "set", collection: "entries", doc_id: NOTEBOOK_ID, file_path: join(out, "entries", NOTEBOOK_ID + ".json"), if_version: 7 },
    { op: "set", collection: "logs", doc_id: "daily", file_path: join(out, "logs", "daily.json"), if_version: 12 },
  ]);
  assert.deepEqual(readJson(batch.writes[0].file_path).blocks.map(b => b.id), ["d1", "n1", "d4"]);
  assert.deepEqual(readJson(batch.writes[1].file_path).moved, { d1: { to: NOTEBOOK_ID, at: NOW }, d4: { to: NOTEBOOK_ID, at: NOW } });
  assert.deepEqual(readJson(res.lines), { to: NOTEBOOK_ID, lines: [textLine("d1", T(9)), voiceMemo("d4", T(15))] });
  assert.deepEqual(readJson(files["logs/daily"]).blocks.length, 2, "the files that were read are left as they were");
  assert.match(fails(["plan", ...given, "--out", join(dir, "read"), "d1"]).stderr, /would overwrite a file it read/);
  assert.match(fails(["plan", ...given, "--out", out, "d1"]).stderr, /already holds a plan/, "the saved copies of an earlier plan are never replaced");
  assert.deepEqual(readJson(res.lines).lines.length, 2);
  assert.match(fails(["plan", ...given, "--new-notebook", NEW_NOTEBOOK_ID, "--title", "x", "--out", join(dir, "both"), "d1"]).stderr, /not both/);
  assert.match(fails(["plan", ...given.slice(0, 4), "--new-notebook", NOTEBOOK_ID, "--title", "x", "--benchling-url", BENCHLING_URL, "--out", join(dir, "exists"), "d1"]).stderr, /already exists.*--notebook/, "a notebook that was read is not created again");
  assert.match(fails(["plan", ...given.slice(0, 3), "twelve", ...given.slice(4), "--out", join(dir, "nan"), "d1"]).stderr, /--daily-version must be a whole number/);
  assert.match(fails(["plan", ...given.filter(a => a !== "--daily-version" && a !== "12"), "--out", out, "d1"]).stderr, /--daily-version is required/);
  assert.match(fails(["plan", ...given.slice(2), "--daily", files["entries/" + NOTEBOOK_ID], "--out", out, "d1"]).stderr, /only moved out of logs\/daily/);
  assert.match(fails(["plan", ...given, "--out", join(dir, "refused"), "nope"]).stderr, /nope is not in Daily/);
  assert.equal(existsSync(join(dir, "refused")), false, "a refused plan writes nothing");
  assert.match(fails(["nothing"]).stderr, /Usage/);
}));

test("plan for a new notebook, then verify: clean after the batch, a repair after an older copy was saved over it", () => inTempDir(dir => {
  const daily = dailyDoc([textLine("d1", T(9)), textLine("d2", T(10))]);
  const files = saveDocs(join(dir, "read"), { "logs/daily": daily }), out = join(dir, "plan");
  const res = run(["plan", "--daily", files["logs/daily"], "--daily-version", "3", "--new-notebook", NEW_NOTEBOOK_ID, "--title", "260310_Made-up_New", "--benchling-url", BENCHLING_URL, "--now", NOW, "--out", out, "d1", "d2"]);
  const batch = readJson(res.batch);
  assert.equal("if_version" in batch.writes[0], false); assert.equal(res.notebook.isNew, true);
  /* what the store holds after the batch, re-read into a new folder */
  const after = saveDocs(join(dir, "after"), { "logs/daily": readJson(batch.writes[1].file_path), ["entries/" + NEW_NOTEBOOK_ID]: readJson(batch.writes[0].file_path) });
  const check = ["verify", "--daily", after["logs/daily"], "--notebook", after["entries/" + NEW_NOTEBOOK_ID], "--notebook-version", "1", "--copies", res.lines, "--now", LATER, "--out", join(dir, "check")];
  const ok = run(check);
  assert.equal(ok.clean, true); assert.equal(ok.repair, null); assert.deepEqual(ok.lines.map(l => l.id), ["d1", "d2"], "with no ids given, the lines of the copies file are checked");
  const again = run(["plan", "--daily", after["logs/daily"], "--daily-version", "4", "--notebook", after["entries/" + NEW_NOTEBOOK_ID], "--notebook-version", "1", "--benchling-url", BENCHLING_URL, "--now", LATER, "--out", join(dir, "again"), "d1", "d2"]);
  assert.equal(again.nothingToDo, true); assert.equal(again.batch, null); assert.deepEqual(again.alreadyDone, ["d1", "d2"]);
  assert.equal(existsSync(join(dir, "again")), false, "a plan with nothing to do writes nothing");
  assert.match(fails(["verify", "--daily", after["logs/daily"], "--notebook", after["entries/" + NEW_NOTEBOOK_ID], "--notebook-version", "1", "--copies", join(dir, "no-such"), "--out", join(dir, "check0")]).stderr, /no such file or folder/);
  /* a device saves the notebook as it had it, with only its own line */
  writeFileSync(after["entries/" + NEW_NOTEBOOK_ID], JSON.stringify({ ...readJson(batch.writes[0].file_path), blocks: [textLine("typed-late", T(12))] }));
  const bad = fails(check), report = JSON.parse(bad.stdout);
  assert.equal(report.clean, false); assert.deepEqual(report.repair.restored, ["d1", "d2"]);
  const repair = readJson(report.repair.batch);
  assert.deepEqual(repair.writes, [{ op: "set", collection: "entries", doc_id: NEW_NOTEBOOK_ID, file_path: join(dir, "check", "repair", "entries", NEW_NOTEBOOK_ID + ".json"), if_version: 1 }]);
  assert.deepEqual(readJson(repair.writes[0].file_path).blocks.map(b => b.id), ["d1", "d2", "typed-late"]);
  assert.match(fails(["verify", "--daily", after["logs/daily"], "--notebook", after["entries/" + NEW_NOTEBOOK_ID], "--notebook-version", "1", "--copies", files["logs/daily"], "--out", join(dir, "check2")]).stderr, /give the line ids/);
}));

test("audit reads a folder of saved documents, writes its findings and a readable report, and changes nothing", () => inTempDir(dir => {
  const read = join(dir, "read");
  saveDocs(read, Object.fromEntries(auditStore().map(d => [d.collection + "/" + d.id, d.doc])));
  saveDocs(read, { "config/glossary": { terms: ["made-up term"] } });
  const backup = saveDocs(join(dir, "backup"), { "logs/daily": dailyDoc([textLine("moved-lost", T(9))]) });
  const assetsFile = join(dir, "assets.json"); writeFileSync(assetsFile, JSON.stringify({ assets: [{ id: "orphan-chunk", contentType: "text/plain" }] }));
  const before = readFileSync(join(read, "logs", "daily.json"), "utf8"), out = join(dir, "audit");
  const r = spawnSync(process.execPath, [TOOL, "audit", "--dir", read, "--copies", join(dir, "backup"), "--assets", assetsFile, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 1, "something needs attention, so the exit code says so");
  assert.match(r.stdout, /2 moved lines are missing from their notebook/); assert.match(r.stdout, /Nothing was changed\./);
  const found = readJson(join(out, "audit.json"));
  assert.deepEqual(found.movedMissing[0].copies, [backup["logs/daily"]]); assert.deepEqual(found.orphanAssets, ["orphan-chunk"]); assert.equal(found.clean, false);
  assert.equal(readFileSync(join(out, "audit.txt"), "utf8"), r.stdout);
  assert.equal(readFileSync(join(read, "logs", "daily.json"), "utf8"), before);
  writeFileSync(join(read, "entries", "broken.json"), "{ not json");
  assert.match(fails(["audit", "--dir", read, "--out", out]).stderr, /broken\.json is not valid JSON/);
  assert.match(fails(["audit", "--dir", join(dir, "nowhere"), "--out", out]).stderr, /no such folder/);
}));
