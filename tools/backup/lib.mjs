// Pure helpers for the backup tool: reading the two listings a session saves, and building the manifest of a backup with its completeness
// check. No files, no network, no clock: documents, listings and what the asset store holds come in, a manifest comes out. Nothing given
// to a function is ever changed. The procedure these serve is in .claude/skills/eln-backup/SKILL.md.
import { sha256, joinChunks, verifyBytes } from "../transcribe/lib.mjs";
import { isObject, linesOf, docPath, jsonBytes } from "../transfer/lib.mjs";

export const FORMAT = 1;                                                            /* of manifest.json; another format is never used as a base */
export const COLLECTIONS = Object.freeze(["config", "entries", "logs", "protocols"]);   /* every collection the app keeps documents in */
export const LIST_PAGE = 100;                                                       /* the data tool's default page: a count that is a multiple of it is suspect */
export const ASSET = Object.freeze({ HELD: "held", MISSING: "missing", KEPT: "kept", GONE: "gone" });
export const RECORDING = Object.freeze({ OK: "ok", MISSING: "missing", GONE: "gone" });

const NAME = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;        /* a collection or a document id, as the data tool allows them */
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;           /* becomes a file name in the store, so nothing that could leave the folder */
const ASSET_HEAD = /(\d+) files?, (\d+) of \d+ bytes used/;
const ASSET_LINE = /^- \/_blob\/(\S+)\s{2,}(.+?)\s{2,}(\d+) bytes\s{2,}\S+\s{2,}sha256 ([0-9a-f]{64})\s*$/;

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
/* the SHA-256 of a document is taken over its JSON with the fields in a fixed order, so it does not depend on how a file was written */
export const docHash = doc => sha256(Buffer.from(JSON.stringify(sortKeys(doc)), "utf8"));
export const isSafeName = name => typeof name === "string" && NAME.test(name) && name !== "." && name !== "..";
export const isAssetId = id => typeof id === "string" && ASSET_ID.test(id);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ---- the two listings ---- */

/* listing.json, written by the session from the data tool's results: { "<collection>": { "<document id>": <version> } } */
export function parseListing(json) {
  if (!isObject(json)) throw new Error('the listing must be { "<collection>": { "<document id>": <version> } }');
  const absent = COLLECTIONS.filter(c => !isObject(json[c]));
  if (absent.length) throw new Error(`the listing does not name ${absent.join(", ")}: list every collection (${COLLECTIONS.join(", ")}), with {} for one that is empty`);
  return Object.keys(json).sort().flatMap(collection => {
    if (!isSafeName(collection) || !isObject(json[collection])) throw new Error(`the listing has a collection that cannot be read: ${JSON.stringify(collection)}`);
    return Object.keys(json[collection]).sort().map(id => {
      const version = json[collection][id];
      if (!isSafeName(id)) throw new Error(`the listing has a document id that cannot be a file name: ${JSON.stringify(id)} in ${collection}`);
      if (!Number.isInteger(version) || version < 1) throw new Error(`the version of ${collection}/${id} must be the whole number the data tool showed, not ${JSON.stringify(version)}`);
      return { collection, id, version };
    });
  });
}

function assetLine(line) {
  const m = ASSET_LINE.exec(line);
  if (!m || !isAssetId(m[1])) throw new Error(`cannot read this line of the asset listing: ${JSON.stringify(line.slice(0, 120))}`);
  return { id: m[1], contentType: m[2], bytes: Number(m[3]), sha256: m[4] };
}

/* assets.txt: the artifact tool's asset listing, saved exactly as it was returned (all pages, one after the other). Its first line says
   how many files and bytes the store holds; a listing whose lines do not add up to that was cut short and is refused. */
export function parseAssetListing(text) {
  const head = ASSET_HEAD.exec(String(text));
  if (!head) throw new Error('the asset listing has no first line saying how many files the store holds ("… N files, B of … bytes used")');
  const files = Number(head[1]), bytes = Number(head[2]), byId = new Map();
  for (const asset of String(text).split(/\r?\n/).filter(l => l.startsWith("- ")).map(assetLine)) {
    const seen = byId.get(asset.id);
    if (seen && (seen.bytes !== asset.bytes || seen.sha256 !== asset.sha256)) throw new Error(`the asset listing names ${asset.id} twice with different contents`);
    byId.set(asset.id, asset);
  }
  const assets = [...byId.values()], total = assets.reduce((n, a) => n + a.bytes, 0);
  if (assets.length !== files) throw new Error(`the asset listing says ${count(files, "file", "files")} and holds ${assets.length}: it was cut short, or a page is missing`);
  if (total !== bytes) throw new Error(`the asset listing says ${bytes} bytes and its lines add up to ${total}`);
  return { files, bytes, assets };
}

/* ---- what the documents point to ---- */

const refsOfLine = line => [line.assetId, ...(Array.isArray(line.chunks) ? line.chunks : [])].filter(a => typeof a === "string" && a);
/* every stored file a document points to: a photo or handwriting line's assetId, the chunks of a recording, a protocol's attached file */
export function assetRefs(documents) {
  return documents.flatMap(d => [
    ...(typeof d.doc.assetId === "string" && d.doc.assetId ? [{ asset: d.doc.assetId, document: docPath(d), line: null }] : []),
    ...linesOf(d.doc).flatMap(line => refsOfLine(line).map(asset => ({ asset, document: docPath(d), line: line.id }))),
  ]);
}
export const lineAssets = refsOfLine;

const isRecording = line => line.type === "audio" && Array.isArray(line.chunks) && line.chunks.length > 0;
const recordingKey = line => `${line.sha256}|${line.chunks.join(",")}`;
/* one entry per stored recording; a voice memo copied into a second document is the same recording */
function recordingsOf(documents) {
  const seen = new Map();
  for (const d of documents) for (const line of linesOf(d.doc).filter(isRecording)) {
    if (!seen.has(recordingKey(line))) seen.set(recordingKey(line), { document: docPath(d), line: line.id, chunks: [...line.chunks], bytes: line.bytes, sha256: line.sha256 });
  }
  return [...seen.values()];
}

/* ---- the manifest ---- */

function documentEntries(listing, byPath, baseDocs) {
  return listing.filter(ref => byPath.has(docPath(ref))).map(ref => {
    const doc = byPath.get(docPath(ref)).doc, hash = docHash(doc), was = baseDocs.get(docPath(ref));
    return { collection: ref.collection, id: ref.id, version: ref.version, bytes: jsonBytes(doc), sha256: hash, sameAsBase: !!was && was.version === ref.version && was.sha256 === hash };
  });
}

function missingDocuments(listing, byPath, unreadable) {
  const listed = new Set(listing.map(docPath)), broken = new Map(unreadable.map(u => [docPath(u), u.why]));
  return [
    ...listing.filter(ref => !byPath.has(docPath(ref))).map(ref => ({ document: docPath(ref), why: broken.get(docPath(ref)) ?? "listed but not saved" })),
    ...[...byPath.keys()].filter(path => !listed.has(path)).map(path => ({ document: path, why: "saved but not named in the listing" })),
  ];
}

const usedByOf = refs => refs.map(r => (r.line === null ? r.document : `${r.document}#${r.line}`));
/* a listed file must be held with the size and SHA-256 the listing gives; a file only a line still points to is kept if an earlier backup has it */
function assetEntries(assetListing, held, refs) {
  const users = id => usedByOf(refs.filter(r => r.asset === id)), listedIds = new Set(assetListing.assets.map(a => a.id));
  const listed = assetListing.assets.map(a => {
    const file = held.get(a.id), ok = !!file && file.bytes === a.bytes && file.sha256 === a.sha256;
    return { id: a.id, contentType: a.contentType, bytes: a.bytes, sha256: a.sha256, file: ok ? file.file : null, status: ok ? ASSET.HELD : ASSET.MISSING, usedBy: users(a.id),
      ...(ok ? {} : { why: file ? `the file held (${file.bytes} bytes) differs from the listing (${a.bytes} bytes, SHA-256 ${a.sha256})` : "not fetched yet" }) };
  });
  const unlisted = [...new Set(refs.map(r => r.asset))].filter(id => !listedIds.has(id)).map(id => {
    const file = isAssetId(id) ? held.get(id) : undefined;
    return file ? { id, contentType: "", bytes: file.bytes, sha256: file.sha256, file: file.file, status: ASSET.KEPT, usedBy: users(id) }
      : { id, contentType: "", bytes: 0, sha256: "", file: null, status: ASSET.GONE, usedBy: users(id) };
  });
  return [...listed, ...unlisted];
}

/* a recording is whole when every chunk is held and, joined and decoded, they have the size and SHA-256 the line states */
function checkRecording(recording, statusOf, chunkText) {
  const states = recording.chunks.map(statusOf), away = states.findIndex(s => s !== ASSET.HELD && s !== ASSET.KEPT);
  if (states.some(s => s === ASSET.GONE || s === undefined)) return { ...recording, status: RECORDING.GONE };
  if (away >= 0) return { ...recording, status: RECORDING.MISSING, why: `chunk ${away + 1} of ${states.length} is not held (${recording.chunks[away]})` };
  try {
    verifyBytes(joinChunks(recording.chunks.map(chunkText)), recording);
    return { ...recording, status: RECORDING.OK };
  } catch (err) {
    return { ...recording, status: RECORDING.MISSING, why: err.message };
  }
}

function compareWithBase(documents, baseDocs) {
  const now = new Map(documents.map(d => [docPath(d), d]));
  const changed = documents.filter(d => baseDocs.has(docPath(d)) && !d.sameAsBase);
  return {
    sinceBase: { added: documents.filter(d => !baseDocs.has(docPath(d))).map(docPath), removed: [...baseDocs.keys()].filter(path => !now.has(path)), changed: changed.map(docPath), same: documents.filter(d => d.sameAsBase).length },
    silent: changed.filter(d => baseDocs.get(docPath(d)).version === d.version).map(docPath),
  };
}

/* Collections whose number of documents is a whole number of pages of the data tool's listing: the listing may have stopped at a page. */
export function pageSuspects(listing) {
  const sizes = [...new Set(listing.map(ref => ref.collection))].map(collection => ({ collection, documents: listing.filter(ref => ref.collection === collection).length }));
  return sizes.filter(s => s.documents % LIST_PAGE === 0);
}

function manifestWarnings({ listing, assets, recordings, silent, sinceBase, base }) {
  const before = base ? base.manifest.documents.length : 0, gone = sinceBase ? sinceBase.removed.length : 0;
  return [
    ...pageSuspects(listing).map(s => `${s.collection} has exactly ${s.documents} documents, a whole page of the data tool's listing: check that the listing was read to its last page`),
    ...(gone > 0 && gone * 2 >= before ? [`${gone} of the ${before} documents in ${base.name} are gone: check that every collection was listed, to its last page, before trusting this backup`] : []),
    ...recordings.filter(r => r.status === RECORDING.GONE).map(r => `the recording of ${r.document}#${r.line} cannot be rebuilt: the app no longer stores all its chunks and no backup holds them`),
    ...silent.map(path => `${path} changed without a new version since the base backup; the new content was kept and versions were not trusted for it`),
    ...assets.filter(a => a.status === ASSET.GONE).map(a => `${a.id} is no longer stored in the app and no backup holds it; it is pointed to by ${a.usedBy.join(", ")}`),
    ...assets.filter(a => a.status === ASSET.KEPT).map(a => `${a.id} is no longer stored in the app; the copy from an earlier backup is kept (pointed to by ${a.usedBy.join(", ")})`),
  ];
}

/* The manifest of one backup. listing = [{ collection, id, version }] (what the data tool's listings named); documents = [{ collection,
   id, doc }] (what was saved and could be read); unreadable = [{ collection, id, why }]; assetListing = parseAssetListing's result;
   held = Map of asset id -> { file, bytes, sha256 } for the files in the shared store; chunkText(id) gives a held chunk's text;
   base = { name, manifest } of the previous complete backup, or null. The backup is complete when nothing is missing. */
export function buildManifest({ takenAt, listing, documents, unreadable = [], assetListing, held, chunkText, base = null }) {
  const byPath = new Map(documents.map(d => [docPath(d), d])), baseDocs = new Map((base ? base.manifest.documents : []).map(d => [docPath(d), d]));
  const entries = documentEntries(listing, byPath, baseDocs), saved = listing.filter(ref => byPath.has(docPath(ref))).map(ref => byPath.get(docPath(ref)));
  const assets = assetEntries(assetListing, held, assetRefs(saved)), statusOf = id => (assets.find(a => a.id === id) || {}).status;
  const recordings = recordingsOf(saved).map(r => checkRecording(r, statusOf, chunkText));
  const nothing = listing.length ? [] : [{ document: "*", why: "the listing names no document at all; an empty read is never taken for a backup" }];
  const missing = {
    documents: [...nothing, ...missingDocuments(listing, byPath, unreadable)],
    assets: assets.filter(a => a.status === ASSET.MISSING).map(a => ({ id: a.id, why: a.why, bytes: a.bytes, usedBy: a.usedBy })),
    recordings: recordings.filter(r => r.status === RECORDING.MISSING).map(r => ({ document: r.document, line: r.line, why: r.why })),
  };
  const { sinceBase, silent } = base ? compareWithBase(entries, baseDocs) : { sinceBase: null, silent: [] };
  const stored = assets.filter(a => a.status === ASSET.HELD || a.status === ASSET.KEPT);
  return {
    format: FORMAT, takenAt, complete: !missing.documents.length && !missing.assets.length && !missing.recordings.length, base: base ? base.name : null,
    documents: entries, assets: assets.map(({ why, ...asset }) => asset), recordings: recordings.map(({ why, ...recording }) => recording), missing,
    warnings: manifestWarnings({ listing, assets, recordings, silent, sinceBase, base }), sinceBase,
    totals: { documents: entries.length, documentBytes: entries.reduce((n, d) => n + d.bytes, 0), assets: stored.length, assetBytes: stored.reduce((n, a) => n + a.bytes, 0) },
  };
}

/* The base of a backup is the latest complete backup taken before it. One marked incomplete, or written in another format, is never used. */
export function chooseBase(candidates, takenAt) {
  const usable = candidates.filter(c => isObject(c.manifest) && c.manifest.complete === true && c.manifest.format === FORMAT && Array.isArray(c.manifest.documents)
    && typeof c.manifest.takenAt === "string" && c.manifest.takenAt < takenAt);
  return usable.reduce((best, c) => (best === null || c.manifest.takenAt > best.manifest.takenAt ? c : best), null);
}
