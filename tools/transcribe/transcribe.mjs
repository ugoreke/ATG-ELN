#!/usr/bin/env node
// Transcribes ATG ELN voice memos on this Mac, offline, with whisper.cpp. Run setup.sh once first.
//
//   node tools/transcribe/transcribe.mjs check
//   node tools/transcribe/transcribe.mjs join  --out <audio file> --bytes <n> --sha256 <hex> <chunk-1.txt> <chunk-2.txt> ...
//   node tools/transcribe/transcribe.mjs terms --glossary <glossary.json> [--voice <voice.json>] [--context <notes.txt>] --out <terms.txt>
//   node tools/transcribe/transcribe.mjs run   --audio <audio file> [--terms <terms.txt>] [--language en-US] --out <result.json>
//
// Recordings, transcripts and vocabulary are private: keep every file this writes in scratch/, never in a tracked folder.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinChunks, verifyRecording, pickTerms, promptFor, transcriptFrom, languageFor, audioFormat } from "./lib.mjs";

export const MODEL_DIR = process.env.ATG_ELN_MODELS || join(homedir(), ".cache", "atg-eln", "models");
export const MODEL_FILE = process.env.ATG_ELN_MODEL || "ggml-large-v3-turbo.bin";
const VAD_FILE = "ggml-silero-v5.1.2.bin", SAMPLE_RATE = 16000, MAX_OUTPUT = 512 * 1024 * 1024;
const PRIVATE_FILE = { mode: 0o600 };
/* a file is written fresh, readable only by its owner, never through a link or over an old file's looser permissions */
const writePrivate = (path, data) => { rmSync(path, { force: true }); writeFileSync(path, data, { ...PRIVATE_FILE, flag: "wx" }); };
const firstBytes = path => { const fd = openSync(path, "r"), buf = Buffer.alloc(16); try { return buf.subarray(0, readSync(fd, buf, 0, 16, 0)); } finally { closeSync(fd); } };

function parseArgs(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    opts[a.slice(2)] = argv[++i];
  }
  return { opts, rest };
}
const need = (opts, name) => { if (!opts[name]) throw new Error(`--${name} is required`); return opts[name]; };
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const which = name => { try { return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim(); } catch (_) { return ""; } };

/* what the tool needs, and what is missing */
export function checkSetup() {
  const model = join(MODEL_DIR, MODEL_FILE), vad = join(MODEL_DIR, VAD_FILE);
  const found = { whisper: which("whisper-cli"), ffmpeg: which("ffmpeg"), model: existsSync(model) ? model : "", vad: existsSync(vad) ? vad : "" };
  const missing = [!found.whisper && "whisper-cli (whisper.cpp)", !found.ffmpeg && "ffmpeg", !found.model && `the model ${MODEL_FILE} in ${MODEL_DIR}`].filter(Boolean);
  return { found, missing };
}

function cmdJoin({ opts, rest }) {
  const out = need(opts, "out");
  const buf = joinChunks(rest.map(p => readFileSync(p, "utf8")));
  const ok = verifyRecording(buf, { bytes: need(opts, "bytes"), sha256: need(opts, "sha256") });
  writePrivate(out, buf);
  return { out, ...ok, verified: true };
}

function cmdTerms({ opts }) {
  const glossary = readJson(need(opts, "glossary")), voice = opts.voice ? readJson(opts.voice) : {};
  const terms = pickTerms({ glossary: Array.isArray(glossary) ? glossary : glossary.terms || [], voice: Array.isArray(voice) ? voice : voice.pairs || [], context: opts.context ? readFileSync(opts.context, "utf8") : "" });
  writePrivate(need(opts, "out"), terms.join("\n") + "\n");
  return { out: opts.out, terms: terms.length };
}

function cmdRun({ opts }) {
  const audio = need(opts, "audio"), out = need(opts, "out"), { found, missing } = checkSetup();
  if (missing.length) throw new Error("Not set up yet. Missing: " + missing.join("; ") + ". Run tools/transcribe/setup.sh.");
  if (!existsSync(audio)) throw new Error("no such audio file: " + audio);
  const format = audioFormat(firstBytes(audio));
  if (!format) throw new Error("that file is not a recording this tool reads, so it was not opened");
  const terms = opts.terms ? readFileSync(opts.terms, "utf8").split("\n").map(t => t.trim()).filter(Boolean) : [];
  const prompt = promptFor(terms), work = mkdtempSync(join(tmpdir(), "atg-eln-")), wav = join(work, "audio.wav"), base = join(work, "out");
  const started = Date.now();
  try {
    /* whisper.cpp wants 16 kHz mono; every program is run directly with its arguments as a list, never through a shell */
    execFileSync(found.ffmpeg, ["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", format, "-i", audio, "-vn", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: ["ignore", "ignore", "pipe"] });
    const args = ["-m", found.model, "-f", wav, "-l", languageFor(opts.language), "-oj", "-of", base, "-np", "-sns"];
    if (prompt) args.push("--prompt", prompt, "--carry-initial-prompt");
    if (found.vad) args.push("--vad", "-vm", found.vad);
    execFileSync(found.whisper, args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: MAX_OUTPUT });
    const raw = readJson(base + ".json"), segments = raw.transcription || [];
    const last = segments.at(-1), audioSeconds = last && last.offsets ? Math.round(last.offsets.to / 100) / 10 : 0;
    const result = { text: transcriptFrom(segments), transcriber: `whisper.cpp ${MODEL_FILE.replace(/^ggml-|\.bin$/g, "")}`, language: (raw.result && raw.result.language) || languageFor(opts.language),
      audioSeconds, tookSeconds: Math.round((Date.now() - started) / 100) / 10, vad: !!found.vad, prompt };
    writePrivate(out, JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const COMMANDS = { join: cmdJoin, terms: cmdTerms, run: cmdRun, check: () => checkSetup() };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [name, ...argv] = process.argv.slice(2);
    if (!COMMANDS[name]) throw new Error("Usage: transcribe.mjs <check|join|terms|run> … (see the top of this file)");
    const result = COMMANDS[name](parseArgs(argv));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (name === "check" && result.missing.length) process.exitCode = 1;
  } catch (err) {
    process.stderr.write("transcribe: " + ((err.stderr && String(err.stderr).trim()) || err.message) + "\n");
    process.exitCode = 1;
  }
}
