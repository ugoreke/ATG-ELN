// Comparing two backups, or a backup with a fresh read: which documents were added, removed or changed, and inside a document which
// lines. Pure: documents come in, a list of ids comes out. The report names documents and line ids, never what a line says.
import { isDeepStrictEqual } from "node:util";
import { DAILY_REF, isObject, isLine, docPath, movedEntry } from "../transfer/lib.mjs";

const LIST_FIELDS = ["blocks", "items"];   /* the lines of a log, notebook or meeting; the items of a to-do list */
const REPORT_MAX_IDS = 20;                 /* the readable report stays short; diff.json has everything */

/* the entries of a document that carry an id: its lines, or its to-do items; null for a document that has neither */
function idList(doc) {
  const field = LIST_FIELDS.find(f => isObject(doc) && Array.isArray(doc[f]));
  return field ? doc[field].filter(isLine) : null;
}
const idsOf = doc => (idList(doc) || []).map(entry => entry.id);
const byPath = side => new Map(side.documents.map(d => [docPath(d), d]));
const differingFields = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !isDeepStrictEqual(a[key], b[key])).sort();

function lineChanges(before, after) {
  const was = idList(before), is = idList(after);
  if (was === null && is === null) return null;
  const old = new Map((was || []).map(l => [l.id, l])), now = new Map((is || []).map(l => [l.id, l]));
  return { added: [...now.keys()].filter(id => !old.has(id)), removed: [...old.keys()].filter(id => !now.has(id)), changed: [...old.keys()].filter(id => now.has(id) && !isDeepStrictEqual(old.get(id), now.get(id))) };
}

/* Where every line id is, on one side: id -> [document paths]. A line in Daily that Daily itself lists as moved is not counted there:
   the app hides that copy and removes it, and a restore does not count it as live either. */
function places(side) {
  const map = new Map(), isDaily = d => d.collection === DAILY_REF.collection && d.id === DAILY_REF.id;
  for (const d of side.documents) for (const id of idsOf(d.doc)) {
    if (isDaily(d) && movedEntry(d.doc, id)) continue;
    map.set(id, [...(map.get(id) || []), docPath(d)]);
  }
  return map;
}

/* from, to = { documents: [{ collection, id, version?, doc }] }. A line that left one document and is now in another was moved; a line
   that is in no document of `to` any more is lost, which is what a restore is for. */
export function diffBackups(from, to) {
  const old = byPath(from), now = byPath(to), paths = [...old.keys()].filter(p => now.has(p)).sort();
  const changed = paths.filter(p => !isDeepStrictEqual(old.get(p).doc, now.get(p).doc)).map(p => ({
    document: p, versionFrom: old.get(p).version ?? null, versionTo: now.get(p).version ?? null, fields: differingFields(old.get(p).doc, now.get(p).doc), lines: lineChanges(old.get(p).doc, now.get(p).doc) }));
  const wasAt = places(from), isAt = places(to), gone = [...wasAt].sort(([, a], [, b]) => a[0].localeCompare(b[0]));
  const left = gone.flatMap(([id, docs]) => docs.filter(doc => !(isAt.get(id) || []).includes(doc)).map(doc => ({ id, document: doc })));
  return {
    added: [...now.keys()].filter(p => !old.has(p)).sort(), removed: [...old.keys()].filter(p => !now.has(p)).sort(), changed, same: paths.length - changed.length,
    moved: left.filter(l => isAt.has(l.id)).map(l => ({ id: l.id, from: l.document, to: isAt.get(l.id).find(doc => !(wasAt.get(l.id) || []).includes(doc)) })).filter(m => m.to !== undefined),
    lost: left.filter(l => !isAt.has(l.id)),
  };
}

/* ---- the readable report ---- */

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const some = items => (items.length > REPORT_MAX_IDS ? [...items.slice(0, REPORT_MAX_IDS), `… and ${items.length - REPORT_MAX_IDS} more (see diff.json)`] : items);
const section = (head, items) => (items.length ? [`- ${head}:`, ...some(items).map(i => `    ${i}`)] : []);
const version = v => (v === null ? "?" : v);

function changedLine(c) {
  const lines = c.lines ? `; ${c.lines.added.length} added, ${c.lines.removed.length} removed, ${c.lines.changed.length} changed` : "";
  return `${c.document}: version ${version(c.versionFrom)} → ${version(c.versionTo)}; fields ${c.fields.join(", ")}${lines}`;
}

export function formatDiff(diff, { from = "the first", to = "the second" } = {}) {
  const body = [
    ...section(`${count(diff.lost.length, "line is", "lines are")} in no document any more`, diff.lost.map(l => `${l.id} (was in ${l.document})`)),
    ...section(count(diff.removed.length, "document is gone", "documents are gone"), diff.removed),
    ...section(count(diff.added.length, "document is new", "documents are new"), diff.added),
    ...section(count(diff.changed.length, "document changed", "documents changed"), diff.changed.map(changedLine)),
    ...section(count(diff.moved.length, "line moved to another document", "lines moved to another document"), diff.moved.map(m => `${m.id}: ${m.from} → ${m.to}`)),
  ];
  return [`From ${from} to ${to}: ${count(diff.same, "document is", "documents are")} the same.`, ...(body.length ? body : ["No difference."])].join("\n");
}
