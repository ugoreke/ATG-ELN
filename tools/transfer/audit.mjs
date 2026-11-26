// The audit: reads saved copies of the notebook documents and reports what looks wrong. It plans no write and changes nothing.
// Pure, like lib.mjs: documents come in, findings come out.
import { isDeepStrictEqual } from "node:util";
import { MAX_DOC_BYTES, DAILY_REF, NOTEBOOK_COLLECTION, isObject, isLine, isNotebookKind, linesOf, docPath, jsonBytes, movedEntry, collectLines } from "./lib.mjs";

const TEXT_ASSET = /^text\/plain\b/;
const PROTOCOLS = "protocols";
const REPORT_MAX_ITEMS = 10;   /* the readable report stays short; audit.json has everything */

const hasChunks = line => Array.isArray(line.chunks) && line.chunks.length > 0;
const waitsForTranscript = line => line.type === "audio" && hasChunks(line) && !String(line.transcript || "").trim() && !line.audioRemovedAt;
const sameRecording = (a, b) => a.type === "audio" && b.type === "audio" && !!a.sha256 && a.sha256 === b.sha256 && isDeepStrictEqual(a.chunks, b.chunks);
const isLater = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? x > y : String(a || "") > String(b || ""); };

function checkDocuments(documents) {
  if (!Array.isArray(documents)) throw new Error("no documents were given to audit");
  const bad = documents.find(d => !isObject(d) || typeof d.collection !== "string" || typeof d.id !== "string" || !isObject(d.doc));
  if (bad !== undefined) throw new Error(`${docPath(bad)} is not a document`);
  return documents;
}

/* every place a line id occurs; a Daily line listed in moved is set aside, since the app hides it and removes it by itself */
function linePlaces(documents, daily) {
  const byId = new Map(), staleInDaily = [];
  for (const d of documents) for (const line of linesOf(d.doc)) {
    if (d === daily && movedEntry(daily.doc, line.id)) { staleInDaily.push(line.id); continue; }
    byId.set(line.id, [...(byId.get(line.id) || []), { document: docPath(d), line }]);
  }
  return { byId, staleInDaily };
}

/* an id in more than one place is a duplicate, unless every place holds a voice memo of the same recording (a copy made in the app) */
function repeatedIds(byId) {
  const repeated = [...byId].filter(([, places]) => places.length > 1).map(([id, places]) => ({ id, places: places.map(p => p.document), copy: places.every(p => sameRecording(p.line, places[0].line)) }));
  const plain = ({ id, places }) => ({ id, places });
  return { duplicates: repeated.filter(r => !r.copy).map(plain), voiceMemoCopies: repeated.filter(r => r.copy).map(plain) };
}

/* every id in Daily's moved must be in the notebook named by its `to` */
function findMovedMissing(documents, daily, copies) {
  const moved = isObject(daily.doc.moved) ? daily.doc.moved : {};
  return Object.keys(moved).flatMap(id => {
    const entry = movedEntry(daily.doc, id) || {};
    const notebook = documents.find(d => d.collection === NOTEBOOK_COLLECTION && d.id === entry.to);
    if (notebook && linesOf(notebook.doc).some(l => l.id === id)) return [];
    const found = copies.flatMap(c => collectLines(c.lines).filter(l => l.id === id).map(line => ({ file: c.file, line })));
    return [{ id, to: entry.to ?? null, movedAt: entry.at ?? null, notebookExists: !!notebook, inDaily: linesOf(daily.doc).some(l => l.id === id),
      copies: [...new Set(found.map(f => f.file))], copiesAgree: found.every(f => isDeepStrictEqual(f.line, found[0].line)) }];
  });
}

/* A notebook from before Daily existed can hold lines that never reached Benchling: it has no lastTransfer, or lines later than it.
   Lines Daily lists as moved into the notebook are known to be in Benchling and are left out. */
function findNeverTransferred(documents, daily) {
  return documents.filter(d => d.collection === NOTEBOOK_COLLECTION && isNotebookKind(d.doc.kind)).flatMap(d => {
    const last = isObject(d.doc.lastTransfer) ? d.doc.lastTransfer.at : undefined;
    const open = linesOf(d.doc).filter(l => (movedEntry(daily.doc, l.id) || {}).to !== d.id).filter(l => !last || isLater(l.at, last));
    return open.length ? [{ notebook: d.id, title: String(d.doc.title || ""), reason: last ? "lines later than lastTransfer" : "no lastTransfer", lines: open.map(l => l.id) }] : [];
  });
}

function assetList(assets) {
  const list = Array.isArray(assets) ? assets : isObject(assets) && Array.isArray(assets.assets) ? assets.assets : null;
  if (!list) throw new Error("the asset list must be a list of { id, contentType }");
  return list.map(a => {
    const id = isObject(a) ? a.id ?? a.assetId : undefined;
    if (typeof id !== "string" || !id) throw new Error("the asset list has an asset without an id");
    return { id, contentType: String(a.contentType ?? a.content_type ?? a.type ?? a.mime ?? "") };
  });
}
/* stored text assets (the chunks of recordings) that no line and no protocol points to */
function findOrphanAssets(documents, assets) {
  const lines = documents.flatMap(d => linesOf(d.doc));
  const used = new Set([...lines.flatMap(l => [l.assetId, ...(Array.isArray(l.chunks) ? l.chunks : [])]), ...documents.map(d => d.doc.assetId)].filter(Boolean));
  return assetList(assets).filter(a => TEXT_ASSET.test(a.contentType) && !used.has(a.id)).map(a => a.id);
}

/* documents = [{ collection, id, doc }] (logs/daily is required); copies = [{ file, lines }]; assets = [{ id, contentType }] or nothing */
export function audit({ documents, copies = [], assets } = {}) {
  const docs = checkDocuments(documents), daily = docs.find(d => d.collection === DAILY_REF.collection && d.id === DAILY_REF.id);
  if (!daily) throw new Error("logs/daily was not given, so moved lines cannot be checked");
  const { byId, staleInDaily } = linePlaces(docs, daily), { duplicates, voiceMemoCopies } = repeatedIds(byId);
  const movedMissing = findMovedMissing(docs, daily, copies);
  const largeDocuments = docs.map(d => ({ document: docPath(d), bytes: jsonBytes(d.doc) })).filter(d => d.bytes > MAX_DOC_BYTES);
  const hasProtocols = docs.some(d => d.collection === PROTOCOLS);
  const entries = docs.filter(d => d.collection === NOTEBOOK_COLLECTION);
  return {
    clean: !movedMissing.length && !duplicates.length && !largeDocuments.length,
    summary: { dailyLines: linesOf(daily.doc).length, notebooks: entries.filter(d => isNotebookKind(d.doc.kind)).length, meetings: entries.filter(d => d.doc.kind === "meeting").length, documents: docs.length },
    movedMissing, duplicates, largeDocuments, voiceMemoCopies, staleInDaily,
    waitingTranscription: docs.flatMap(d => linesOf(d.doc).filter(waitsForTranscript).map(l => ({ document: docPath(d), id: l.id, at: l.at, duration: l.duration }))),
    neverTransferred: findNeverTransferred(docs, daily),
    orphanAssets: assets === undefined ? null : findOrphanAssets(docs, assets),
    notes: assets !== undefined && !hasProtocols ? ["protocols were not given, so an asset that only a protocol points to is listed as pointed to by nothing"] : [],
  };
}

/* ---- the readable report ---- */

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const some = items => (items.length > REPORT_MAX_ITEMS ? [...items.slice(0, REPORT_MAX_ITEMS), `… and ${items.length - REPORT_MAX_ITEMS} more (see audit.json)`] : items);
const section = (head, items) => (items.length ? [`- ${head}:`, ...some(items).map(i => `    ${i}`)] : []);

function missingLine(m) {
  const where = m.notebookExists ? `notebook ${m.to}` : `notebook ${m.to}: the notebook no longer exists`;
  const copy = m.copies.length ? `saved copy in ${m.copies.join(", ")}${m.copiesAgree ? "" : " (the copies differ)"}` : m.inDaily ? "no saved copy, but Daily still holds the line" : "no saved copy";
  return `${m.id} → ${where}; ${copy}`;
}

export function formatAudit(r) {
  const attention = [
    ...section(count(r.movedMissing.length, "moved line is missing from its notebook", "moved lines are missing from their notebook"), r.movedMissing.map(missingLine)),
    ...section(count(r.duplicates.length, "line id appears more than once", "line ids appear more than once"), r.duplicates.map(d => `${d.id} in ${d.places.join(", ")}`)),
    ...section(count(r.largeDocuments.length, `document is larger than ${MAX_DOC_BYTES} bytes`, `documents are larger than ${MAX_DOC_BYTES} bytes`), r.largeDocuments.map(d => `${d.document} (${d.bytes} bytes; the limit is 256 KiB)`)),
  ];
  const info = [
    ...section(count(r.waitingTranscription.length, "voice memo waits for transcription", "voice memos wait for transcription"), r.waitingTranscription.map(w => `${w.id} in ${w.document}`)),
    ...section(count(r.neverTransferred.length, "notebook holds lines that may never have been transferred", "notebooks hold lines that may never have been transferred"), r.neverTransferred.map(n => `${JSON.stringify(n.title)} (${n.notebook}): ${count(n.lines.length, "line", "lines")}, ${n.reason}`)),
    ...section(count((r.orphanAssets || []).length, "stored text asset that nothing points to", "stored text assets that nothing points to"), r.orphanAssets || []),
    ...(r.staleInDaily.length ? [`- ${count(r.staleInDaily.length, "moved line is", "moved lines are")} back in Daily; the app removes them by itself`] : []),
    ...(r.voiceMemoCopies.length ? [`- ${count(r.voiceMemoCopies.length, "voice memo is", "voice memos are")} in two places as a copy of one recording, which is expected`] : []),
    ...r.notes.map(n => `- Note: ${n}`),
  ];
  return [
    `ATG ELN audit: Daily has ${count(r.summary.dailyLines, "line", "lines")}; ${count(r.summary.notebooks, "notebook", "notebooks")}, ${count(r.summary.meetings, "meeting", "meetings")}.`,
    ...(attention.length ? ["Needs attention:", ...attention] : ["Nothing needs attention."]),
    ...(info.length ? ["For information:", ...info] : []),
    "Nothing was changed.",
  ].join("\n");
}
