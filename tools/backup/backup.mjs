#!/usr/bin/env node
// Backs up the whole ATG ELN database to a private folder, compares backups, and plans and checks a restore. Files in, files out: this
// tool never talks to the database. A session reads with the data tool and the artifact tool, this tool checks what was saved, and for a
// restore the session sends the batch this wrote back through the data tool. The procedure is .claude/skills/eln-backup/SKILL.md.
//
// A read is a folder holding: documents/<collection>/<id>.json (the data tool's `out_dir`), listing.json ({ "<collection>": { "<id>":
// <version> } }, written by the session from the listings' results), and assets.txt (the artifact tool's asset listing, as returned).
// A backup is a read plus manifest.json, in a dated folder; the stored files of all backups are kept once, in assets/ beside the dated folders.
//
//   node tools/backup/backup.mjs manifest --run <backups/DATE> [--incoming <folder>]… [--taken-at <ISO time>]
//       moves fetched files (<run>/incoming and every --incoming; named <asset id>.<ext>) into ../assets once they match the listing, then
//       writes <run>/manifest.json and prints a summary with `toFetch`: the asset ids still to fetch. Exit code 1 while anything is missing;
//       the manifest then says `complete: false` and the backup is never the base of a later one. Run it again after fetching.
//   node tools/backup/backup.mjs diff --from <backup or read> --to <backup or read> [--out <folder>]
//       prints which documents and which line ids were added, removed, changed, moved or lost; with --out also diff.json and diff.txt
//   node tools/backup/backup.mjs restore-plan --backup <backups/DATE> --live <fresh read> --document <collection>/<id> --out <new folder>
//                                             [--whole] [--pages-checked] [--now <ISO time>] [<line id> …]
//       writes <out>/batch.json (the `writes` for the data tool's batch action), the document it points to, plan.json and summary.txt.
//       --pages-checked: the session confirms that no listing of the fresh read offered a next page (asked for only when a collection
//       holds exactly a page of documents)
//   node tools/backup/backup.mjs verify-restore --plan <plan folder> --live <fresh read taken after the batch> [--pages-checked]
//       exit code 1 when a restored line or document is not as planned
//   --out is always a folder that is new or empty.
//
// Everything this reads and writes is the owner's notebook: keep it in backups/ or scratch/, never in a tracked folder.
import { chmodSync, copyFileSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../transcribe/lib.mjs";
import { isObject, docPath } from "../transfer/lib.mjs";
import { parseListing, parseAssetListing, assetRefs, buildManifest, chooseBase, pageSuspects, docHash, isAssetId, isSafeName } from "./lib.mjs";
import { diffBackups, formatDiff } from "./diff.mjs";
import { planRestore, verifyRestore, formatPlan } from "./restore.mjs";

const PRIVATE_FILE = { mode: 0o600 }, PRIVATE_DIR = { recursive: true, mode: 0o700 };
const FLAGS = new Set(["whole", "pages-checked"]), REPEATABLE = new Set(["incoming"]);
/* the options each command takes; anything else is a mistake and is refused rather than guessed at */
const OPTIONS = { manifest: ["run", "incoming", "taken-at"], diff: ["from", "to", "out"], "restore-plan": ["backup", "live", "document", "out", "whole", "now", "pages-checked"], "verify-restore": ["plan", "live", "pages-checked"] };
const DOCUMENTS_DIR = "documents", ASSETS_DIR = "assets", INCOMING_DIR = "incoming";
const LISTING_FILE = "listing.json", ASSET_LISTING_FILE = "assets.txt", MANIFEST_FILE = "manifest.json", BATCH_FILE = "batch.json", PLAN_FILE = "plan.json", SUMMARY_FILE = "summary.txt";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/* ---- arguments and files ---- */

function parseArgs(argv, known) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const name = a.slice(2);
    if (!known.includes(name)) throw new Error(`unknown option ${a}; this command takes ${known.map(k => "--" + k).join(", ")}`);
    if (FLAGS.has(name)) { opts[name] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    const value = argv[++i];
    opts[name] = REPEATABLE.has(name) ? [...(opts[name] || []), value] : value;
  }
  return { opts, rest };
}
const need = (opts, name) => { if (!opts[name]) throw new Error(`--${name} is required`); return opts[name]; };
const isFolder = path => existsSync(path) && statSync(path).isDirectory();
const needFolder = path => { if (!isFolder(path)) throw new Error(`no such folder: ${path}`); return resolve(path); };
/* what a command writes goes into a folder that is new or empty, so nothing that exists (an earlier plan, a backup) is ever written over */
function newFolder(path) {
  const out = resolve(path);
  if (existsSync(out) && (!isFolder(out) || readdirSync(out).length)) throw new Error(`${out} already holds files (a plan, a backup or something else); give --out a new folder`);
  return out;
}
const isoTime = (value, name) => { if (!ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`--${name} must be an ISO time such as 2026-01-31T12:00:00.000Z, not ${value}`); return value; };

function readJson(path) {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch (err) { throw new Error(`${path} is not valid JSON (${err.message})`); }
}
/* a file is written fresh and readable only by its owner */
function writePrivate(path, text) {
  mkdirSync(dirname(path), PRIVATE_DIR);
  rmSync(path, { force: true });
  writeFileSync(path, text, { ...PRIVATE_FILE, flag: "wx" });
}
const writeJson = (path, value) => writePrivate(path, JSON.stringify(value, null, 2) + "\n");
const docFile = (folder, ref) => join(folder, DOCUMENTS_DIR, ref.collection, ref.id + ".json");
const megabytes = bytes => (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 0) + " MB";

/* ---- reading a folder a session saved ---- */

/* one document as the data tool saved it: { doc }, or { why } when the file is there and cannot be used, or neither when it is absent */
function loadDocument(folder, ref) {
  const path = docFile(folder, ref);
  if (!existsSync(path)) return { ...ref };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return isObject(doc) ? { ...ref, doc } : { ...ref, why: "the saved file is not a JSON object" };
  } catch {
    return { ...ref, why: "the saved file is not valid JSON" };
  }
}
/* every <collection>/<id>.json under <folder>/documents */
function savedRefs(folder) {
  const dir = join(folder, DOCUMENTS_DIR);
  if (!isFolder(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && isSafeName(e.name)).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(c => readdirSync(join(dir, c.name)).filter(n => n.endsWith(".json") && isSafeName(n.slice(0, -5))).sort().map(n => ({ collection: c.name, id: n.slice(0, -5) })));
}
/* A read: its listing, the documents that were saved (one the listing does not name has no version), those that cannot be used, and the
   asset listing if there is one. */
function readRead(path) {
  const folder = needFolder(path), listing = parseListing(readJson(join(folder, LISTING_FILE))), listed = new Set(listing.map(docPath));
  const loaded = [...listing, ...savedRefs(folder).filter(ref => !listed.has(docPath(ref)))].map(ref => loadDocument(folder, ref));
  const assetsFile = join(folder, ASSET_LISTING_FILE);
  return { folder, listing, documents: loaded.filter(d => d.doc), unreadable: loaded.filter(d => d.why), assetListing: existsSync(assetsFile) ? parseAssetListing(readFileSync(assetsFile, "utf8")) : null };
}
/* what keeps a read from being whole: every listed document must be saved and readable, and every saved one listed */
function gapsOf(read) {
  const saved = new Set(read.documents.map(docPath)), broken = new Map(read.unreadable.map(u => [docPath(u), u.why]));
  return [...read.listing.filter(ref => !saved.has(docPath(ref))).map(ref => `${docPath(ref)} (${broken.get(docPath(ref)) ?? "listed but not saved"})`),
    ...read.documents.filter(d => d.version === undefined).map(d => `${docPath(d)} (saved but not named in the listing)`)];
}

/* ---- the shared asset store ---- */

const assetIdOf = name => name.split(".")[0];
const fileFacts = path => { const buf = readFileSync(path); return { bytes: buf.length, sha256: sha256(buf) }; };
/* asset id -> file name, for every file in the store */
function storeIndex(dir) {
  if (!isFolder(dir)) return new Map();
  return new Map(readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && isAssetId(assetIdOf(e.name))).map(e => [assetIdOf(e.name), e.name]));
}
function moveFile(from, to) {
  try { renameSync(from, to); } catch (err) {
    if (err.code !== "EXDEV") throw err;
    copyFileSync(from, to, constants.COPYFILE_EXCL);   /* another disk: copy, then take the fetched file away */
    rmSync(from);
  }
  chmodSync(to, PRIVATE_FILE.mode);
}
/* A fetched file enters the store only if it is exactly what the listing says, and only once: a file the store holds is never replaced. */
function takeIn(incoming, assetListing, storeDir) {
  const listed = new Map(assetListing.assets.map(a => [a.id, a])), have = new Set(storeIndex(storeDir).keys()), fetched = [], rejected = [];
  for (const dir of incoming.filter(isFolder)) for (const name of readdirSync(dir).sort()) {
    const id = assetIdOf(name), want = listed.get(id), from = join(dir, name);
    if (!want || have.has(id)) continue;
    if (!lstatSync(from).isFile()) { rejected.push({ id, file: from, why: "it is not a regular file (a link or a folder), and only a fetched file goes into the store" }); continue; }
    const got = fileFacts(from);
    if (got.bytes !== want.bytes || got.sha256 !== want.sha256) { rejected.push({ id, file: from, why: `it has ${got.bytes} bytes and SHA-256 ${got.sha256}; the listing says ${want.bytes} bytes and ${want.sha256}` }); continue; }
    mkdirSync(storeDir, PRIVATE_DIR);
    moveFile(from, join(storeDir, id + extname(name)));
    have.add(id); fetched.push(id);
  }
  return { fetched, rejected };
}
/* what the store holds of the files this backup is about: asset id -> { file, bytes, sha256 }, each file read and hashed again */
function heldAssets(storeDir, ids) {
  const index = storeIndex(storeDir);
  return new Map([...new Set(ids)].filter(id => index.has(id)).map(id => [id, { file: index.get(id), ...fileFacts(join(storeDir, index.get(id))) }]));
}

/* ---- manifest ---- */

/* the base among the other dated folders, and the names of those whose manifest cannot be read (never a base, and said so) */
function findBase(run, takenAt) {
  const root = dirname(run), others = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== ASSETS_DIR && join(root, e.name) !== run);
  const candidates = others.filter(e => existsSync(join(root, e.name, MANIFEST_FILE))).map(e => ({ name: e.name, manifest: tryJson(join(root, e.name, MANIFEST_FILE)) }));
  return { base: chooseBase(candidates.filter(c => c.manifest !== null), takenAt), unreadable: candidates.filter(c => c.manifest === null).map(c => c.name) };
}
const tryJson = path => { try { return readJson(path); } catch { return null; } };
/* An unchanged document becomes the same file on disk as in the base backup (a hard link), so a daily backup takes space only for what
   changed, and every dated folder still holds every document. Where the disk cannot link, the fresh copy simply stays. */
function shareUnchanged(run, baseDir, documents) {
  return documents.filter(d => d.sameAsBase).filter(d => {
    const mine = docFile(run, d), theirs = docFile(baseDir, d);
    try {
      if (statSync(mine).ino === statSync(theirs).ino) return true;
      if (docHash(readJson(theirs)) !== d.sha256) return false;
      rmSync(mine + ".link", { force: true });
      linkSync(theirs, mine + ".link");
      renameSync(mine + ".link", mine);
      return true;
    } catch { return false; }
  }).length;
}
/* bytes on disk under a folder, a file that is linked into several dated folders counted once */
function bytesOnDisk(folder, seen = new Set()) {
  return readdirSync(folder, { withFileTypes: true }).reduce((total, e) => {
    const path = join(folder, e.name);
    if (e.isDirectory()) return total + bytesOnDisk(path, seen);
    const stat = statSync(path);
    if (!e.isFile() || seen.has(stat.ino)) return total;
    seen.add(stat.ino);
    return total + stat.size;
  }, 0);
}

function reportLines(manifest, { fetched, carried, folderBytes }) {
  const t = manifest.totals, since = manifest.sinceBase, gaps = manifest.missing;
  const versus = since ? `; since ${manifest.base}: ${since.same} unchanged, ${since.changed.length} changed, ${since.added.length} new, ${since.removed.length} gone` : "; first backup, nothing to compare with";
  const checked = manifest.recordings.filter(r => r.status === "ok").length;
  return [
    `Documents: ${t.documents} (${megabytes(t.documentBytes)})${versus}.`,
    `Stored files: ${t.assets} (${megabytes(t.assetBytes)}), ${fetched} fetched in this run, ${carried} documents shared on disk with the base; recordings rebuilt and checked: ${checked}.`,
    manifest.complete ? `Complete. The backups folder holds ${megabytes(folderBytes)} in all.`
      : `INCOMPLETE: missing ${gaps.documents.length} documents, ${gaps.assets.length} stored files, ${gaps.recordings.length} recordings (see manifest.json). The backups folder holds ${megabytes(folderBytes)}.`,
  ];
}

/* What fetching the files in `toFetch` will not put right, in words; manifest.json has every gap in full. A recording is only named
   once all its chunks are held, since until then its gap is the chunks'. */
function problemsOf(gaps, rejected) {
  const waiting = new Set(gaps.assets.map(a => a.id));
  return [
    ...gaps.documents.map(d => `${d.document}: ${d.why}`),
    ...rejected.map(r => `the fetched file for ${r.id} was not taken into the store: ${r.why}`),
    ...gaps.assets.filter(a => a.why !== "not fetched yet").map(a => `${a.id}: ${a.why}`),
    ...gaps.recordings.filter(r => ![...waiting].some(id => r.why.includes(id))).map(r => `the recording of ${r.document}#${r.line} does not rebuild: ${r.why}`),
  ];
}

function cmdManifest({ opts }) {
  const run = needFolder(need(opts, "run")), storeDir = join(dirname(run), ASSETS_DIR), read = readRead(run);
  if (!read.assetListing) throw new Error(`${join(run, ASSET_LISTING_FILE)} is missing: save the artifact tool's asset listing there, exactly as it was returned`);
  const earlier = existsSync(join(run, MANIFEST_FILE)) ? (tryJson(join(run, MANIFEST_FILE)) || {}).takenAt : undefined;   /* a run that is finished later keeps the time it was read */
  const takenAt = opts["taken-at"] ? isoTime(opts["taken-at"], "taken-at") : typeof earlier === "string" && ISO_TIME.test(earlier) ? earlier : new Date().toISOString();
  chmodSync(run, PRIVATE_DIR.mode);   /* the data tool makes the folder readable by everyone on this computer; a backup is its owner's only */
  const { fetched, rejected } = takeIn([join(run, INCOMING_DIR), ...(opts.incoming || [])], read.assetListing, storeDir);
  const wanted = [...read.assetListing.assets.map(a => a.id), ...assetRefs(read.documents).map(r => r.asset).filter(isAssetId)];
  const held = heldAssets(storeDir, wanted), index = storeIndex(storeDir), { base, unreadable } = findBase(run, takenAt);
  const chunkText = id => (index.has(id) ? readFileSync(join(storeDir, index.get(id)), "utf8") : null);
  const manifest = buildManifest({ takenAt, listing: read.listing, documents: read.documents, unreadable: read.unreadable, assetListing: read.assetListing, held, chunkText, base });
  const carried = manifest.complete && base ? shareUnchanged(run, join(dirname(run), base.name), manifest.documents) : 0;
  writeJson(join(run, MANIFEST_FILE), manifest);
  const folderBytes = bytesOnDisk(dirname(run)), since = manifest.sinceBase, gaps = manifest.missing;
  return {
    run: basename(run), complete: manifest.complete, base: manifest.base, takenAt, documents: manifest.totals.documents, documentBytes: manifest.totals.documentBytes,
    assets: manifest.totals.assets, assetBytes: manifest.totals.assetBytes, fetched: fetched.length, toFetch: gaps.assets.map(a => a.id), rejected,
    missing: { documents: gaps.documents.length, assets: gaps.assets.length, recordings: gaps.recordings.length }, problems: problemsOf(gaps, rejected),
    warnings: [...manifest.warnings, ...unreadable.map(name => `the manifest of ${name} cannot be read, so that backup was not considered as the base`)], sinceBase: since ? { added: since.added.length, removed: since.removed.length, changed: since.changed.length, same: since.same } : null,
    carried, folderBytes, report: reportLines(manifest, { fetched: fetched.length, carried, folderBytes }), clean: manifest.complete,
  };
}

/* ---- diff ---- */

/* one side of a comparison: a backup, a read, or any folder with documents/<collection>/<id>.json in it */
function loadSide(path) {
  const folder = needFolder(path);
  if (!isFolder(join(folder, DOCUMENTS_DIR))) throw new Error(`${folder} has no ${DOCUMENTS_DIR} folder: it is neither a backup nor a read`);
  const versions = existsSync(join(folder, LISTING_FILE)) ? new Map(parseListing(readJson(join(folder, LISTING_FILE))).map(ref => [docPath(ref), ref.version])) : new Map();
  const loaded = savedRefs(folder).map(ref => loadDocument(folder, { ...ref, version: versions.get(docPath(ref)) }));
  const broken = loaded.find(d => !d.doc);
  if (broken) throw new Error(`${docFile(folder, broken)} cannot be compared: ${broken.why}`);
  const manifest = existsSync(join(folder, MANIFEST_FILE)) ? readJson(join(folder, MANIFEST_FILE)) : null;
  const label = manifest ? `the backup ${basename(folder)} (${manifest.takenAt}${manifest.complete === true ? "" : ", INCOMPLETE"})` : `the read ${basename(folder)}`;
  return { documents: loaded, label };
}

function cmdDiff({ opts }) {
  const from = loadSide(need(opts, "from")), to = loadSide(need(opts, "to"));
  const diff = diffBackups(from, to), text = formatDiff(diff, { from: from.label, to: to.label }) + "\n";
  if (opts.out) { const out = newFolder(opts.out); writeJson(join(out, "diff.json"), diff); writePrivate(join(out, "diff.txt"), text); }
  return { text };
}

/* ---- restore ---- */

function targetOf(value) {
  const [collection, id, ...more] = String(value).split("/");
  if (more.length || !isSafeName(collection) || !isSafeName(id)) throw new Error(`--document must be <collection>/<id>, not ${value}`);
  return { collection, id };
}
/* The backup's copy of one document, used only if the backup says it is complete and the file still is what its manifest recorded. */
function loadBackup(path, target) {
  const folder = needFolder(path), manifestPath = join(folder, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`${folder} has no manifest.json, so nothing says it is a complete backup; run the manifest command on it first`);
  const manifest = readJson(manifestPath);
  if (!isObject(manifest) || manifest.complete !== true || !Array.isArray(manifest.documents)) throw new Error(`${folder} is marked incomplete; nothing is restored from an incomplete backup`);
  const entry = manifest.documents.find(d => d.collection === target.collection && d.id === target.id);
  if (!entry) return { name: basename(folder), takenAt: manifest.takenAt, complete: true, documents: [] };
  const held = loadDocument(folder, target);
  if (!held.doc || docHash(held.doc) !== entry.sha256) throw new Error(`${docPath(target)} in ${folder} no longer matches its manifest (the file is missing or was changed after the backup); nothing is restored from it`);
  return { name: basename(folder), takenAt: manifest.takenAt, complete: true, documents: [{ ...target, doc: held.doc }] };
}
/* A fresh read must hold every live document, or it cannot show that a line is live nowhere. The tool can see a document that was
   listed and not saved; it cannot see a listing that stopped at a page, so a collection with exactly a page of documents is refused
   until the session says (--pages-checked) that no listing result offered a next page. */
function loadLive(path, pagesChecked) {
  const read = readRead(path), gaps = gapsOf(read), suspects = pageSuspects(read.listing);
  if (gaps.length) throw new Error(`the fresh read is not whole: ${gaps.join("; ")}. Read every collection again into a new folder`);
  if (suspects.length && !pagesChecked) throw new Error(`${suspects.map(s => `${s.collection} has exactly ${s.documents} documents`).join("; ")}, a whole page of the data tool's listing, so the fresh read may have stopped at a page. `
    + "Check that no listing result gave a next_cursor (list again with it if one did), then give --pages-checked");
  return { folder: read.folder, documents: read.documents, assets: read.assetListing ? new Set(read.assetListing.assets.map(a => a.id)) : null };
}

function cmdRestorePlan({ opts, rest }) {
  const out = newFolder(need(opts, "out")), target = targetOf(need(opts, "document"));
  const backup = loadBackup(need(opts, "backup"), target), live = loadLive(need(opts, "live"), opts["pages-checked"] === true);
  if ([resolve(opts.backup), live.folder].some(folder => out === folder || out.startsWith(folder + "/"))) throw new Error("--out must be a folder of its own, outside the backup and the fresh read");
  const now = opts.now ? isoTime(opts.now, "now") : new Date().toISOString();
  const plan = planRestore({ backup, live, target, lineIds: rest, whole: opts.whole === true, now });
  const [write] = plan.writes, dataPath = join(out, write.collection, write.doc_id + ".json"), { writes, ...described } = plan;
  writeJson(dataPath, write.data);
  writeJson(join(out, BATCH_FILE), { writes: [{ op: write.op, collection: write.collection, doc_id: write.doc_id, file_path: dataPath, ...(write.if_version === undefined ? {} : { if_version: write.if_version }) }] });
  writeJson(join(out, PLAN_FILE), { ...described, pinnedTo: write.if_version ?? null, backup: backup.name, takenAt: backup.takenAt, plannedAt: now });
  writePrivate(join(out, SUMMARY_FILE), formatPlan(plan, { backup: backup.name, takenAt: backup.takenAt }));
  return { out, batch: join(out, BATCH_FILE), summary: join(out, SUMMARY_FILE), kind: plan.kind, document: docPath(target), created: plan.created, restored: plan.lines.map(l => l.id), dropped: plan.dropped, warnings: plan.warnings };
}

function cmdVerifyRestore({ opts }) {
  const folder = needFolder(need(opts, "plan")), plan = readJson(join(folder, PLAN_FILE));
  if (!isObject(plan) || !isObject(plan.target) || !isSafeName(plan.target.collection) || !isSafeName(plan.target.id)) throw new Error(`${join(folder, PLAN_FILE)} is not a restore plan`);
  const data = readJson(join(folder, plan.target.collection, plan.target.id + ".json"));
  return verifyRestore({ plan: { ...plan, writes: [{ data }] }, live: loadLive(need(opts, "live"), opts["pages-checked"] === true) });
}

const COMMANDS = { manifest: cmdManifest, diff: cmdDiff, "restore-plan": cmdRestorePlan, "verify-restore": cmdVerifyRestore };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [name, ...argv] = process.argv.slice(2);
    if (!COMMANDS[name]) throw new Error("Usage: backup.mjs <manifest|diff|restore-plan|verify-restore> … (see the top of this file)");
    const { clean, ...result } = COMMANDS[name](parseArgs(argv, OPTIONS[name]));
    process.stdout.write(name === "diff" ? result.text : JSON.stringify(name === "verify-restore" ? { clean, ...result } : result, null, 2) + "\n");
    if (clean === false) process.exitCode = 1;
  } catch (err) {
    process.stderr.write("backup: " + err.message + "\n");
    process.exitCode = 1;
  }
}
