// Planning a restore from a backup, and checking it afterwards. Pure, like lib.mjs: the backup's documents and a fresh read of the live
// ones come in, one pinned write comes out. A restore brings back what is missing and never doubles a line: a line that is live anywhere
// is refused, and so is anything that the moved marks in logs/daily say belongs somewhere else.
import { isDeepStrictEqual } from "node:util";
import { MAX_DOC_BYTES, DAILY_REF, NOTEBOOK_COLLECTION, isObject, isLine, linesOf, docPath, jsonBytes, movedEntry } from "../transfer/lib.mjs";
import { lineAssets } from "./lib.mjs";

export const STATUS = Object.freeze({ OK: "ok", CHANGED: "changed", DUPLICATE: "duplicate", MISSING: "missing", ELSEWHERE: "elsewhere" });
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const copy = value => structuredClone(value);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isDaily = ref => ref.collection === DAILY_REF.collection && ref.id === DAILY_REF.id;
const sameRef = (a, b) => a.collection === b.collection && a.id === b.id;
const find = (documents, ref) => documents.find(d => sameRef(d, ref));
const differingFields = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !isDeepStrictEqual(a[key], b[key])).sort();

/* ---- checks on what was given ---- */

function checkTime(now) {
  if (typeof now !== "string" || !ISO_TIME.test(now) || Number.isNaN(Date.parse(now))) throw new Error(`the time must be an ISO time such as 2026-01-31T12:00:00.000Z, not ${JSON.stringify(now)}`);
  return now;
}
function checkBackup(backup) {
  if (!isObject(backup) || backup.complete !== true) throw new Error("the backup is marked incomplete (or nothing says it is complete); nothing is restored from an incomplete backup");
  if (!Array.isArray(backup.documents)) throw new Error("the backup's documents were not given");
}
function checkLive(live) {
  if (!isObject(live) || !Array.isArray(live.documents)) throw new Error("a fresh read of the live documents is needed");
}
function checkVersion(ref) {
  if (!Number.isInteger(ref.version) || ref.version < 1) throw new Error(`the version of ${docPath(ref)} as the fresh read showed it is needed (a whole number from 1), not ${JSON.stringify(ref.version)}; a write is never planned without a pin`);
}
function checkSize(ref, data) {
  if (jsonBytes(data) > MAX_DOC_BYTES) throw new Error(`${docPath(ref)} would be ${jsonBytes(data)} bytes, larger than ${MAX_DOC_BYTES} bytes (a stored document may be 256 KiB); restore fewer lines`);
}
function uniqueIds(lineIds) {
  if (!Array.isArray(lineIds) || !lineIds.length) throw new Error("no line ids were given: name the lines to bring back, or ask for the whole document");
  const bad = lineIds.find(id => typeof id !== "string" || !id);
  if (bad !== undefined) throw new Error(`a line id must be text, not ${JSON.stringify(bad)}`);
  return [...new Set(lineIds)];
}

/* ---- where lines are now ---- */

const dailyOf = live => (find(live.documents, DAILY_REF) || { doc: {} }).doc;
/* Every place a line id is live: id -> [document paths]. A line in Daily that Daily itself lists as moved does not count: the app hides
   it and removes it by itself. */
function livePlaces(live) {
  const daily = dailyOf(live), map = new Map();
  for (const d of live.documents) for (const line of linesOf(d.doc)) {
    if (isDaily(d) && movedEntry(daily, line.id)) continue;
    map.set(line.id, [...(map.get(line.id) || []), docPath(d)]);
  }
  return map;
}

/* the one copy of a line in the backup's document; two copies that differ are refused rather than guessed between */
function backupLine(source, id) {
  const found = linesOf(source.doc).filter(l => l.id === id);
  if (!found.length) throw new Error(`line ${id} is not in the backup's copy of ${docPath(source)}`);
  if (!found.every(l => isDeepStrictEqual(l, found[0]))) throw new Error(`line ${id} is in the backup's copy of ${docPath(source)} twice with different content; it was not planned`);
  return found[0];
}

/* A line may only go where the moved marks allow: never back into Daily once Daily lists it as moved, and into no notebook but the one named. */
function checkMoved(id, target, daily) {
  const entry = movedEntry(daily, id);
  if (!entry) return;
  if (isDaily(target)) throw new Error(`Daily lists line ${id} as moved to notebook ${entry.to}, so the app would hide it in Daily. Put it back into that notebook instead: `
    + "node tools/transfer/transfer.mjs verify, with the backup's logs/daily.json as --copies, writes that repair");
  if (target.collection !== NOTEBOOK_COLLECTION || target.id !== entry.to) throw new Error(`line ${id} was moved to notebook ${entry.to}, not to ${docPath(target)}; it is restored there or not at all`);
}

/* the restored lines slotted in by time; the lines that are live keep their order and are not touched */
function slotIn(blocks, lines) {
  return [...lines].sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).reduce((list, line) => {
    const later = list.findIndex(b => isLine(b) && String(b.at || "") > String(line.at || ""));
    return later < 0 ? [...list, copy(line)] : [...list.slice(0, later), copy(line), ...list.slice(later)];
  }, blocks);
}

/* which stored files of the restored lines the app no longer has; live.assets is the set of asset ids in the fresh listing, or null */
function assetCheck(lines, docAsset, live) {
  const refs = [...(docAsset ? [{ line: null, asset: docAsset }] : []), ...lines.flatMap(l => lineAssets(l).map(asset => ({ line: l.id, asset })))];
  if (!refs.length) return { assetsGone: [], warnings: [] };
  if (!(live.assets instanceof Set)) return { assetsGone: [], warnings: ["whether the photos and recordings of these lines are still stored in the app was not checked (the fresh read has no asset listing)"] };
  const assetsGone = refs.filter(r => !live.assets.has(r.asset));
  return { assetsGone, warnings: assetsGone.map(r => `${r.line === null ? "the document" : "line " + r.line} comes back, but its stored file ${r.asset} is no longer in the app: the file is in the backup's asset store, to be attached again in the app`) };
}

const pinnedSet = (ref, data, version) => ({ op: "set", collection: ref.collection, doc_id: ref.id, data, ...(version === undefined ? {} : { if_version: version }) });

/* ---- the two kinds of plan ---- */

function planLines({ source, live, target, lineIds, now }) {
  const ids = uniqueIds(lineIds), current = find(live.documents, target);
  if (!Array.isArray(source.doc.blocks)) throw new Error(`${docPath(target)} has no list of lines (blocks) in the backup; it can only be restored whole`);
  const lines = ids.map(id => backupLine(source, id));
  if (!current) throw new Error(`${docPath(target)} no longer exists, so lines cannot be put back into it; restore the whole document instead`);
  checkVersion(current);
  if (!isObject(current.doc) || !Array.isArray(current.doc.blocks)) throw new Error(`${docPath(target)} has no list of lines (blocks) now; nothing was planned`);
  const places = livePlaces(live), daily = dailyOf(live);
  for (const id of ids) {
    if (places.has(id)) throw new Error(`line ${id} is already in ${places.get(id)[0]}; a restore never doubles a line`);
    checkMoved(id, target, daily);
  }
  const data = { ...copy(current.doc), blocks: slotIn(copy(current.doc.blocks), lines), updatedAt: now };
  checkSize(target, data);
  return { kind: "lines", target: { collection: target.collection, id: target.id }, created: false, writes: [pinnedSet(target, data, current.version)], lines: lines.map(copy), dropped: [], ...assetCheck(lines, null, live) };
}

function planDocument({ source, live, target }) {
  const current = find(live.documents, target), here = docPath(target), lines = linesOf(source.doc);
  if (current && isDaily(target)) throw new Error("Daily is never replaced whole: its moved marks would go back in time and moved lines could come back twice. Restore its lines one by one");
  if (current) checkVersion(current);
  const places = livePlaces(live), daily = dailyOf(live);
  for (const line of lines) {
    const other = (places.get(line.id) || []).find(place => place !== here);
    if (other) throw new Error(`line ${line.id} is already in ${other}; a restore never doubles a line. Restore the other lines of ${here} one by one`);
    checkMoved(line.id, target, daily);
  }
  const data = copy(source.doc), kept = new Set(lines.map(l => l.id)), dropped = current ? linesOf(current.doc).map(l => l.id).filter(id => !kept.has(id)) : [];
  checkSize(target, data);
  const assets = assetCheck(lines, typeof data.assetId === "string" && data.assetId ? data.assetId : null, live);
  const dropWarning = dropped.length ? [`${count(dropped.length, "line that is live now is", "lines that are live now are")} not in the backup and would be removed: ${dropped.join(", ")}`] : [];
  return { kind: "document", target: { collection: target.collection, id: target.id }, created: !current, writes: [pinnedSet(target, data, current ? current.version : undefined)],
    lines: lines.map(copy), dropped, assetsGone: assets.assetsGone, warnings: [...dropWarning, ...assets.warnings] };
}

/* The one write that restores from a backup into `target`: the named lines put back into the document they came from (the usual case), or
   the whole document (`whole`: only for a document that no longer exists, or one the owner names).
   backup = { complete, documents: [{ collection, id, doc }] }; live = { documents: [{ collection, id, version, doc }], assets: Set | null },
   a fresh read of every live document. The write is pinned to the fresh read's version; only a document that does not exist is written
   without a pin, and the data tool refuses that write if the document has appeared meanwhile. */
export function planRestore({ backup, live, target, lineIds, whole = false, now } = {}) {
  checkBackup(backup); checkLive(live); checkTime(now);
  if (!isObject(target) || typeof target.collection !== "string" || typeof target.id !== "string") throw new Error("name the document to restore into, as <collection>/<id>");
  if (whole && Array.isArray(lineIds) && lineIds.length) throw new Error("give either the whole document or line ids, not both");
  const source = find(backup.documents, target);
  if (!source || !isObject(source.doc)) throw new Error(`the backup holds no document ${docPath(target)}`);
  return whole ? planDocument({ source, live, target }) : planLines({ source, live, target, lineIds, now });
}

/* ---- the summary the owner reads before saying yes ---- */

const PREVIEW_CHARS = 60;
function preview(line) {
  const words = String(line.text || line.caption || line.transcript || line.fileName || "").replace(/\s+/g, " ").trim();
  return words.length > PREVIEW_CHARS ? words.slice(0, PREVIEW_CHARS) + "…" : words;
}
const lineRow = line => `  - ${line.id}  ${line.type || "?"}  ${line.at || "no time"}  ${JSON.stringify(preview(line))}`;

/* plain language: what the batch would do, to which document, pinned to what; the first words of each line so the owner can recognise it */
export function formatPlan(plan, { backup, takenAt } = {}) {
  const path = docPath(plan.target), write = plan.writes[0], lines = count(plan.lines.length, "line", "lines");
  const pinned = `The write is pinned to version ${write.if_version}: if the document has changed since the fresh read, nothing is written.`;
  const what = plan.kind === "lines" ? [`It would put back ${lines} into ${path}:`, ...plan.lines.map(lineRow), `Nothing else in that document changes. ${pinned}`]
    : plan.created ? [`It would create ${path} as it was in the backup (${lines}, ${jsonBytes(write.data)} bytes). The document does not exist now, so the write has no pin; it is refused if the document has appeared meanwhile.`]
      : [`It would replace ${path} with the backup's copy (${lines}, ${jsonBytes(write.data)} bytes). ${pinned}`];
  return [`Restore plan for ${path}, from the backup ${backup} taken at ${takenAt}.`, ...what, ...(plan.warnings.length ? ["Warnings:", ...plan.warnings.map(w => "  - " + w)] : []),
    "Nothing has been written. Send batch.json only after the owner has said yes for this document."].join("\n") + "\n";
}

/* ---- checking a restore afterwards ---- */

function lineCheck(line, target, places) {
  const found = places.get(line.id) || [], here = found.filter(f => f.document === docPath(target));
  const status = found.length > 1 ? STATUS.DUPLICATE : !found.length ? STATUS.MISSING : !here.length ? STATUS.ELSEWHERE : isDeepStrictEqual(here[0].line, line) ? STATUS.OK : STATUS.CHANGED;
  return { id: line.id, status, places: found.map(f => f.document), differs: status === STATUS.CHANGED ? differingFields(here[0].line, line) : [] };
}

/* A fresh read after the batch was sent, held against the plan. A restored line is fine when it is in its document exactly once, equal
   to the backup's copy, and nowhere else. A restored document is fine when it equals what was planned. Nothing is repaired here: for a
   line that is missing again, plan the restore again from a new read. */
export function verifyRestore({ plan, live } = {}) {
  if (!isObject(plan) || !isObject(plan.target) || !Array.isArray(plan.lines)) throw new Error("the plan to check against was not given");
  checkLive(live);
  const daily = dailyOf(live), places = new Map();
  for (const d of live.documents) for (const line of linesOf(d.doc)) {
    if (isDaily(d) && movedEntry(daily, line.id)) continue;
    places.set(line.id, [...(places.get(line.id) || []), { document: docPath(d), line }]);
  }
  const checks = plan.lines.map(line => lineCheck(line, plan.target, places));
  if (plan.kind !== "document") return { clean: checks.every(c => c.status === STATUS.OK), lines: checks, document: null };
  const current = find(live.documents, plan.target), planned = plan.writes[0].data;
  const differs = current ? differingFields(current.doc, planned) : [];
  const document = { status: !current ? STATUS.MISSING : differs.length ? STATUS.CHANGED : STATUS.OK, differs };
  const doubled = checks.filter(c => c.status === STATUS.DUPLICATE);
  return { clean: document.status === STATUS.OK && !doubled.length, lines: doubled, document };
}
