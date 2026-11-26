#!/usr/bin/env node
// Moves lines from Daily into a notebook of ATG ELN, checks the move, and audits the notebook. Files in, files out: this tool never talks
// to the database. A session reads the documents with the data tool (each saved as <folder>/<collection>/<id>.json, which is how the tool
// knows which document a file is), runs a command here, and sends the batch this wrote back through the data tool.
//
//   node tools/transfer/transfer.mjs plan   --daily <logs/daily.json> --daily-version <n> --notebook <entries/<id>.json> --notebook-version <n>
//                                           --benchling-url <url> --out <new folder> [--title <Benchling name>] [--now <ISO time>] <line id> ...
//       for a notebook that does not exist yet, instead of --notebook and --notebook-version:  --new-notebook <new UUID> --title <Benchling name>
//       writes <out>/batch.json (the `writes` for the data tool's batch action), the two documents it points to, and <out>/lines.json
//       (the moved lines exactly as stored: the saved copies for verify)
//   node tools/transfer/transfer.mjs verify --daily <logs/daily.json> --notebook <entries/<id>.json> --notebook-version <n> --copies <file or folder>
//                                           --out <folder> [--now <ISO time>] [<line id> ...]
//       both documents as re-read after the move; with no ids, the lines in --copies (a plan's lines.json) are checked;
//       a line missing from the notebook gives <out>/repair/batch.json. Exit code 1 when anything is not as it should be.
//   node tools/transfer/transfer.mjs audit  --dir <folder of saved documents> --out <folder> [--copies <file or folder>] [--assets <assets.json>]
//       prints a short report and writes <out>/audit.json and <out>/audit.txt. It plans no write. Exit code 1 when something needs attention.
//
// --copies may be given more than once. Notebook documents are private: keep every file this reads and writes in scratch/.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planMove, verifyMove, docRefFromPath, collectLines, isObject, NOTEBOOK_COLLECTION } from "./lib.mjs";
import { audit, formatAudit } from "./audit.mjs";

const PRIVATE_FILE = { mode: 0o600 }, PRIVATE_DIR = { recursive: true, mode: 0o700 };
const REPEATABLE = new Set(["copies"]);
const BATCH_FILE = "batch.json", LINES_FILE = "lines.json";

function parseArgs(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    const name = a.slice(2), value = argv[++i];
    opts[name] = REPEATABLE.has(name) ? [...(opts[name] || []), value] : value;
  }
  return { opts, rest };
}
const need = (opts, name) => { if (!opts[name]) throw new Error(`--${name} is required`); return opts[name]; };
const wholeNumber = (opts, name) => { const v = need(opts, name); if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a whole number, not ${v}`); return Number(v); };
const isFolder = path => existsSync(path) && statSync(path).isDirectory();

function readJson(path) {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch (err) { throw new Error(`${path} is not valid JSON (${err.message})`); }
}
const readDoc = (path, version) => ({ ...docRefFromPath(path), version, doc: readJson(path) });
const jsonFilesIn = folder => readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(e => (e.isDirectory() ? jsonFilesIn(join(folder, e.name)) : e.isFile() && e.name.endsWith(".json") ? [join(folder, e.name)] : []));

/* saved copies: each path is a JSON file or a folder searched for JSON files; a file holds a saved document or a plan's lines.json */
function readCopies(paths) {
  return paths.flatMap(path => {
    if (!existsSync(path)) throw new Error(`no such file or folder: ${path}`);
    return isFolder(path) ? jsonFilesIn(path) : [path];
  }).map(file => { const json = readJson(file); return { file, lines: collectLines(json), isDocument: isObject(json) && Array.isArray(json.blocks) }; });
}

/* a file is written fresh and readable only by its owner */
function writePrivate(path, text) {
  mkdirSync(dirname(path), PRIVATE_DIR);
  rmSync(path, { force: true });
  writeFileSync(path, text, { ...PRIVATE_FILE, flag: "wx" });
}
const writeJson = (path, value) => writePrivate(path, JSON.stringify(value, null, 2) + "\n");
const refuseOverwrite = (paths, readPaths) => {
  const clash = paths.find(p => readPaths.some(r => resolve(r) === resolve(p)));
  if (clash) throw new Error(`--out would overwrite a file it read (${clash}); give it a folder of its own`);
};

/* Writes each planned document as <folder>/<collection>/<id>.json and the batch that points to them, in the shape the data tool's
   `batch` action takes: { op, collection, doc_id, file_path, if_version }. A document that is created carries no if_version. */
function writeBatch(folder, writes, readPaths) {
  const planned = writes.map(w => ({ w, path: join(folder, w.collection, w.doc_id + ".json") })), batchPath = join(folder, BATCH_FILE);
  refuseOverwrite([batchPath, ...planned.map(p => p.path)], readPaths);
  planned.forEach(({ w, path }) => writeJson(path, w.data));
  writeJson(batchPath, { writes: planned.map(({ w, path }) => ({ op: w.op, collection: w.collection, doc_id: w.doc_id, file_path: path, ...(w.if_version === undefined ? {} : { if_version: w.if_version }) })) });
  return batchPath;
}

function cmdPlan({ opts, rest }) {
  const out = resolve(need(opts, "out")), dailyPath = need(opts, "daily"), isNew = !!opts["new-notebook"];
  if (isNew && opts.notebook) throw new Error("give --notebook or --new-notebook, not both");
  const daily = readDoc(dailyPath, wholeNumber(opts, "daily-version"));
  /* a notebook saved beside the Daily file in the same read exists, so it is never created a second time */
  const readBeside = isNew ? join(dirname(dirname(dailyPath)), NOTEBOOK_COLLECTION, opts["new-notebook"] + ".json") : "";
  if (isNew && existsSync(readBeside)) throw new Error(`notebook ${opts["new-notebook"]} already exists (${readBeside} was read); give that file as --notebook`);
  const notebook = isNew ? { collection: NOTEBOOK_COLLECTION, id: opts["new-notebook"], create: { title: need(opts, "title") } } : readDoc(need(opts, "notebook"), wholeNumber(opts, "notebook-version"));
  const plan = planMove({ daily, notebook, lineIds: rest, benchlingUrl: need(opts, "benchling-url"), now: opts.now || new Date().toISOString(), title: isNew ? undefined : opts.title });
  const { writes, lines, ...summary } = plan;
  if (!writes.length) return { out, batch: null, lines: null, writes: 0, ...summary, nothingToDo: true };
  const linesPath = join(out, LINES_FILE), readPaths = [dailyPath, opts.notebook].filter(Boolean);
  /* the copies of an earlier plan are what a repair is made from, so they are never replaced */
  if (existsSync(linesPath) || existsSync(join(out, BATCH_FILE))) throw new Error(`${out} already holds a plan; give --out a new folder`);
  refuseOverwrite([linesPath], readPaths);
  const batch = writeBatch(out, writes, readPaths);
  writeJson(linesPath, { to: notebook.id, lines });
  return { out, batch, lines: linesPath, writes: writes.length, ...summary };
}

function cmdVerify({ opts, rest }) {
  const out = resolve(need(opts, "out")), dailyPath = need(opts, "daily"), notebookPath = need(opts, "notebook");
  const daily = { ...docRefFromPath(dailyPath), doc: readJson(dailyPath) }, notebook = readDoc(notebookPath, wholeNumber(opts, "notebook-version"));
  const copies = readCopies(need(opts, "copies"));
  if (!rest.length && copies.some(c => c.isDocument)) throw new Error("give the line ids: --copies holds whole documents, so the tool cannot tell which of their lines were moved");
  const lineIds = rest.length ? rest : copies.flatMap(c => c.lines.map(l => l.id));
  const check = verifyMove({ daily, notebook, lineIds, copies: copies.flatMap(c => c.lines), now: opts.now || new Date().toISOString() });
  const repair = check.repair ? { batch: writeBatch(join(out, "repair"), check.repair.writes, [dailyPath, notebookPath, ...copies.map(c => c.file)]), restored: check.repair.restored } : null;
  return { ...check, repair };
}

/* every document saved under <dir>/<collection>/<id>.json */
function readDocuments(dir) {
  if (!isFolder(dir)) throw new Error(`no such folder: ${dir}`);
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(c => readdirSync(join(dir, c.name)).filter(n => n.endsWith(".json")).sort().map(n => ({ collection: c.name, id: n.replace(/\.json$/, ""), doc: readJson(join(dir, c.name, n)) })));
}

function cmdAudit({ opts }) {
  const out = resolve(need(opts, "out")), documents = readDocuments(need(opts, "dir"));
  const copies = opts.copies ? readCopies(opts.copies).map(({ file, lines }) => ({ file, lines })) : [];
  const result = audit({ documents, copies, assets: opts.assets ? readJson(opts.assets) : undefined }), report = formatAudit(result) + "\n";
  writeJson(join(out, "audit.json"), result);
  writePrivate(join(out, "audit.txt"), report);
  return { clean: result.clean, text: report };
}

const COMMANDS = { plan: cmdPlan, verify: cmdVerify, audit: cmdAudit };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [name, ...argv] = process.argv.slice(2);
    if (!COMMANDS[name]) throw new Error("Usage: transfer.mjs <plan|verify|audit> … (see the top of this file)");
    const result = COMMANDS[name](parseArgs(argv));
    process.stdout.write(name === "audit" ? result.text : JSON.stringify(result, null, 2) + "\n");
    if (result.clean === false) process.exitCode = 1;
  } catch (err) {
    process.stderr.write("transfer: " + err.message + "\n");
    process.exitCode = 1;
  }
}
