// Pure helpers for the transfer tool: planning the move of lines from Daily into a notebook, and checking it afterwards.
// No files, no network, no clock: documents and the time come in, a plan comes out. Nothing given to a function is ever changed.
// The rules these functions enforce are stated in .claude/skills/eln-transfer/moving-lines.md.
import { isDeepStrictEqual } from "node:util";

export const MAX_DOC_BYTES = 230000;   /* a stored document may be 256 KiB; nothing is planned past this */
export const MOVED_KEEP_DAYS = 30;     /* how long Daily remembers where a line went */
export const DAILY_REF = Object.freeze({ collection: "logs", id: "daily" });
export const NOTEBOOK_COLLECTION = "entries";
export const STATUS = Object.freeze({ OK: "ok", CHANGED: "changed", DUPLICATE: "duplicate", MISSING: "missing", LOST: "lost", NOT_MOVED: "not-moved", STILL_IN_DAILY: "still-in-daily" });

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOC_ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const BENCHLING_HOST = /(^|\.)benchling\.com$/;

export const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const isLine = b => isObject(b) && typeof b.id === "string" && b.id !== "";
export const linesOf = doc => (isObject(doc) && Array.isArray(doc.blocks) ? doc.blocks.filter(isLine) : []);
export const docPath = ref => `${ref && ref.collection}/${ref && ref.id}`;
export const jsonBytes = doc => Buffer.byteLength(JSON.stringify(doc), "utf8");
export const isNotebookKind = kind => kind === undefined || kind === "notebook";
/* where Daily says a line went, or undefined */
export const movedEntry = (dailyDoc, id) => (isObject(dailyDoc.moved) && Object.hasOwn(dailyDoc.moved, id) && isObject(dailyDoc.moved[id]) ? dailyDoc.moved[id] : undefined);

const copy = value => structuredClone(value);
const byAt = (a, b) => String((a && a.at) || "").localeCompare(String((b && b.at) || ""));   /* the app's own order */
const sortedByAt = lines => [...lines].sort(byAt);                                             /* stable: equal times keep their order */
const hasId = id => b => isLine(b) && b.id === id;

/* <folder>/<collection>/<id>.json, as the data tool saves a document, names the document */
export function docRefFromPath(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean), file = parts.at(-1) || "", collection = parts.at(-2) || "", id = file.replace(/\.json$/, "");
  if (!file.endsWith(".json") || !DOC_ID.test(collection) || !DOC_ID.test(id)) throw new Error(`cannot tell which document ${path} is: it must be saved as <folder>/<collection>/<id>.json, the way the data tool saves it`);
  return { collection, id };
}

/* the lines in a saved document ({ blocks }), in a plan's lines.json ({ lines }) or in a plain list */
export function collectLines(json) {
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.blocks) ? json.blocks : isObject(json) && Array.isArray(json.lines) ? json.lines : [];
  return list.filter(isLine);
}

/* ---- checks on what was given ---- */

function checkTime(now) {
  if (typeof now !== "string" || !ISO_TIME.test(now) || Number.isNaN(Date.parse(now))) throw new Error(`the time must be an ISO time such as 2026-01-31T12:00:00.000Z, not ${JSON.stringify(now)}`);
  return now;
}
function checkBenchlingUrl(url) {
  const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : null;
  if (!parsed || parsed.protocol !== "https:" || !BENCHLING_HOST.test(parsed.hostname)) throw new Error(`the Benchling URL must be the https address of the entry at benchling.com, not ${JSON.stringify(url)}`);
  return url;
}
function checkIds(lineIds) {
  if (!Array.isArray(lineIds) || !lineIds.length) throw new Error("no line ids were given");
  const bad = lineIds.find(id => typeof id !== "string" || !id);
  if (bad !== undefined) throw new Error(`a line id must be text, not ${JSON.stringify(bad)}`);
  return [...new Set(lineIds)];
}
function checkTitle(title) {
  if (typeof title !== "string" || !title.trim()) throw new Error("a notebook needs a title: the name of its Benchling entry");
  return title.trim();
}
function checkVersion(ref) {
  if (!Number.isInteger(ref.version) || ref.version < 1) throw new Error(`the version of ${docPath(ref)} as it was read is needed (a whole number from 1), not ${JSON.stringify(ref.version)}`);
}
function checkDoc(ref) {
  if (!isObject(ref.doc)) throw new Error(`${docPath(ref)} is not a document`);
  if (!Array.isArray(ref.doc.blocks)) throw new Error(`${docPath(ref)} has no list of lines (blocks)`);
}
function checkDailyRef(daily) {
  if (!isObject(daily) || daily.collection !== DAILY_REF.collection || daily.id !== DAILY_REF.id) throw new Error(`lines are only moved out of logs/daily, not out of ${docPath(daily)}`);
}
function checkNotebookRef(notebook) {
  if (!isObject(notebook) || notebook.collection !== NOTEBOOK_COLLECTION || !DOC_ID.test(String(notebook.id || ""))) throw new Error(`lines are only moved into a notebook in entries, not into ${docPath(notebook)}`);
}
/* an existing document in entries that is a notebook: not a meeting, not a page of a tab the user added */
function checkNotebook(notebook) {
  checkDoc(notebook);
  const kind = notebook.doc.kind;
  if (kind === "meeting") throw new Error(`${docPath(notebook)} is a meeting, and lines are not moved into a meeting`);
  if (!isNotebookKind(kind)) throw new Error(`${docPath(notebook)} belongs to another tab (kind ${JSON.stringify(kind)}), not to Notebooks`);
  return notebook.doc;
}
/* A notebook is created only under an id that nothing went to yet: if Daily lists a line as moved to it, it exists already, and creating
   it again would replace it. (The data tool also refuses a write without a pin over a document that exists.) */
function newNotebook(notebook, dailyDoc, benchlingUrl, now) {
  if (!UUID.test(notebook.id)) throw new Error(`a new notebook needs a UUID as its id, not ${JSON.stringify(notebook.id)}`);
  const sentThere = isObject(dailyDoc.moved) && Object.keys(dailyDoc.moved).some(id => (movedEntry(dailyDoc, id) || {}).to === notebook.id);
  if (sentThere) throw new Error(`notebook ${notebook.id} already exists (Daily lists lines moved to it); read it and plan against it instead of creating it`);
  return { title: checkTitle(notebook.create.title), createdAt: now, updatedAt: now, protocols: [], blocks: [], benchlingUrl };
}

/* ---- planning a move ---- */

/* Where one line stands before the move. Throws for anything that must not be moved. */
function lineState(id, dailyDoc, target, notebookId) {
  const inDaily = dailyDoc.blocks.filter(hasId(id)), inNotebook = target.blocks.filter(hasId(id)), entry = movedEntry(dailyDoc, id);
  if (inDaily.length > 1 && !inDaily.every(b => isDeepStrictEqual(b, inDaily[0]))) throw new Error(`line ${id} is in Daily twice with different content; it was not moved`);
  if (entry && entry.to !== notebookId) throw new Error(`line ${id} was already moved to notebook ${entry.to}; a line is not moved a second time`);
  if (!inDaily.length && entry && inNotebook.length) return { id, done: true };
  if (!inDaily.length && entry) throw new Error(`line ${id} was moved into this notebook earlier and is no longer there; put it back from its saved copy with the verify command`);
  if (!inDaily.length) throw new Error(`line ${id} is not in Daily`);
  const line = inDaily[0];
  if (line.type === "audio" && !String(line.transcript || "").trim()) throw new Error(`line ${id} is a voice memo without a transcript; it stays in Daily until it is transcribed`);
  return { id, line, inNotebook: inNotebook.length > 0, differs: inNotebook.length > 0 && !isDeepStrictEqual(inNotebook[0], line) };
}

/* entries older than MOVED_KEEP_DAYS whose line is not in Daily are dropped; one that cannot be dated is kept */
function tidyMoved(moved, idsInDaily, now) {
  const cutoff = Date.parse(now) - MOVED_KEEP_DAYS * DAY_MS;
  const pruned = Object.keys(moved).filter(id => isObject(moved[id]) && Date.parse(moved[id].at) < cutoff && !idsInDaily.has(id));
  return { kept: Object.fromEntries(Object.entries(moved).filter(([id]) => !pruned.includes(id))), pruned };
}

function nextDaily(dailyDoc, leaving, notebookId, now) {
  const base = copy(dailyDoc), gone = new Set(leaving.map(s => s.id));
  const blocks = base.blocks.filter(b => !(isLine(b) && gone.has(b.id)));
  const moved = { ...(isObject(base.moved) ? base.moved : {}), ...Object.fromEntries(leaving.map(s => [s.id, { to: notebookId, at: now }])) };
  const { kept, pruned } = tidyMoved(moved, new Set(blocks.filter(isLine).map(b => b.id)), now);
  return { doc: { ...base, blocks, moved: kept, updatedAt: now }, pruned };
}

function nextNotebook(target, added, { benchlingUrl, now, title }) {
  const base = copy(target);
  return { ...base, ...(title === undefined ? {} : { title }), blocks: sortedByAt([...base.blocks, ...added.map(s => copy(s.line))]), benchlingUrl, updatedAt: now };
}

function planWarnings(target, states, benchlingUrl) {
  const other = typeof target.benchlingUrl === "string" && target.benchlingUrl && target.benchlingUrl !== benchlingUrl
    ? [`the notebook pointed at another Benchling entry (${target.benchlingUrl}); check that this is the right notebook`] : [];
  return [...other, ...states.filter(s => s.differs).map(s => `line ${s.id} is already in the notebook and differs from Daily's copy; the notebook's copy was kept`)];
}

const setWrite = (ref, data, pinned) => ({ op: "set", collection: ref.collection, doc_id: ref.id, data, ...(pinned ? { if_version: ref.version } : {}) });

/* The batch that moves lines from Daily into one notebook: the notebook first, then Daily, each pinned to the version that was read.
   daily = { collection, id, version, doc }; notebook = the same, or { collection, id, create: { title } } for one that does not exist yet. */
export function planMove({ daily, notebook, lineIds, benchlingUrl, now, title } = {}) {
  checkDailyRef(daily); checkNotebookRef(notebook); checkVersion(daily);
  const isNew = isObject(notebook.create);
  if (!isNew) checkVersion(notebook);
  checkDoc(daily);
  const ids = checkIds(lineIds), url = checkBenchlingUrl(benchlingUrl), time = checkTime(now);
  const target = isNew ? newNotebook(notebook, daily.doc, url, time) : checkNotebook(notebook);
  const states = ids.map(id => lineState(id, daily.doc, target, notebook.id));
  const leaving = states.filter(s => s.line), added = leaving.filter(s => !s.inNotebook);
  const newTitle = !isNew && title !== undefined && checkTitle(title) !== target.title ? checkTitle(title) : undefined;
  const notebookDoc = nextNotebook(target, added, { benchlingUrl: url, now: time, title: newTitle });
  const { doc: dailyDoc, pruned } = nextDaily(daily.doc, leaving, notebook.id, time);
  if (added.length && jsonBytes(notebookDoc) > MAX_DOC_BYTES) throw new Error(`the notebook would be ${jsonBytes(notebookDoc)} bytes, larger than ${MAX_DOC_BYTES} bytes (a stored document may be 256 KiB); move fewer lines or use another notebook`);
  const notebookChanges = isNew || added.length > 0 || target.benchlingUrl !== url || newTitle !== undefined;
  const dailyWrite = setWrite(daily, dailyDoc, true);
  const writes = leaving.length || notebookChanges ? [setWrite(notebook, notebookDoc, !isNew), dailyWrite] : pruned.length ? [dailyWrite] : [];
  return {
    writes, lines: leaving.map(s => copy(s.line)), notebook: { id: notebook.id, isNew },
    moved: added.map(s => s.id), alreadyInNotebook: leaving.filter(s => s.inNotebook).map(s => s.id), alreadyDone: states.filter(s => s.done).map(s => s.id),
    pruned, renamedFrom: newTitle === undefined ? undefined : target.title, warnings: planWarnings(target, states, url),
  };
}

/* ---- checking a move afterwards ---- */

/* one saved copy per wanted line; two copies of a line that differ are refused rather than guessed between */
function savedCopies(copies, ids) {
  const wanted = new Set(ids), saved = new Map();
  for (const line of collectLines(Array.isArray(copies) ? copies : [])) {
    if (!wanted.has(line.id)) continue;
    if (saved.has(line.id) && !isDeepStrictEqual(saved.get(line.id), line)) throw new Error(`the saved copies of line ${line.id} differ; give only the copy to use`);
    saved.set(line.id, line);
  }
  return saved;
}
const differingFields = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !isDeepStrictEqual(a[key], b[key]));

function statusOf({ count, inDaily, listed, differs, hasCopy }) {
  if (count > 1) return STATUS.DUPLICATE;
  if (inDaily && !listed) return count ? STATUS.STILL_IN_DAILY : STATUS.NOT_MOVED;   /* the batch did not reach Daily: plan the move again */
  if (count === 1) return differs.length ? STATUS.CHANGED : STATUS.OK;
  return hasCopy ? STATUS.MISSING : STATUS.LOST;
}

/* Where one line stands after the move, and the copy a repair would use: the saved one, else Daily's own if Daily still holds the line. */
function lineCheck(id, dailyDoc, notebook, saved) {
  const found = notebook.doc.blocks.filter(hasId(id)), dailyBlock = dailyDoc.blocks.find(hasId(id)), entry = movedEntry(dailyDoc, id);
  if (entry && entry.to !== notebook.id) throw new Error(`line ${id} was moved to notebook ${entry.to}, not to this one; check it against that notebook`);
  const restoreFrom = saved.get(id) ?? (entry ? dailyBlock : undefined);
  const differs = found.length === 1 && saved.has(id) ? differingFields(found[0], saved.get(id)) : [];
  const status = statusOf({ count: found.length, inDaily: !!dailyBlock, listed: !!entry, differs, hasCopy: !!restoreFrom });
  const result = { id, status, inNotebook: found.length, inDaily: !!dailyBlock, movedTo: entry ? entry.to : null, differs, copy: saved.has(id) ? "saved" : restoreFrom ? "daily" : "none" };
  return { result, restoreFrom };
}

function repairPlan(notebook, lines, now) {
  const base = copy(notebook.doc), data = { ...base, blocks: sortedByAt([...base.blocks, ...lines.map(copy)]), updatedAt: now };
  if (jsonBytes(data) > MAX_DOC_BYTES) throw new Error(`the repaired notebook would be ${jsonBytes(data)} bytes, larger than ${MAX_DOC_BYTES} bytes; it was not planned`);
  return { writes: [setWrite(notebook, data, true)], restored: lines.map(l => l.id) };
}

/* Checks both documents as re-read after a move. A line is fine when it is in the notebook exactly once, equal to its saved copy, and
   either gone from Daily or listed in Daily's moved (the app then removes it by itself). A line missing from the notebook gets a repair:
   one pinned write that adds it back. The repair only adds; a changed or doubled line is reported and left alone. */
export function verifyMove({ daily, notebook, lineIds, copies, now } = {}) {
  checkDailyRef(daily); checkNotebookRef(notebook); checkVersion(notebook); checkDoc(daily); checkNotebook(notebook);
  const ids = checkIds(lineIds), time = checkTime(now), saved = savedCopies(copies, ids);
  const checks = ids.map(id => lineCheck(id, daily.doc, notebook, saved));
  const missing = checks.filter(c => c.result.status === STATUS.MISSING);
  return {
    clean: checks.every(c => c.result.status === STATUS.OK),
    lines: checks.map(c => c.result),
    repair: missing.length ? repairPlan(notebook, missing.map(c => c.restoreFrom), time) : null,
  };
}
