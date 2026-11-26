// Pure helpers for the transcription tool: no files, no programs, so they can be tested on their own.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/* A recording is stored by the app as base64 text in one or more chunks, in order. Each chunk decodes on its own. */
export function joinChunks(texts) {
  if (!Array.isArray(texts) || !texts.length) throw new Error("no chunks were given");
  return Buffer.concat(texts.map((t, i) => {
    const clean = String(t).replace(/\s+/g, "");
    if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new Error(`chunk ${i + 1} is not base64 text`);
    return Buffer.from(clean, "base64");
  }));
}

/* What a rebuilt file really is, from its first bytes, and the one ffmpeg reader to use for it. A file that is none of these is not
   handed to ffmpeg at all: left to guess, ffmpeg would also open playlists that point at other files or at the network. */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
export function audioFormat(buf) {
  const s = (a, n) => buf.subarray(a, a + n).toString("latin1");
  if (s(4, 4) === "ftyp") return "mov";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WAVE") return "wav";
  if (s(0, 4) === "caff") return "caf";
  if (s(0, 4) === "OggS") return "ogg";
  if (s(0, 4) === "fLaC") return "flac";
  if (s(0, 4) === "FORM" && s(8, 3) === "AIF") return "aiff";
  if (s(0, 5) === "#!AMR") return "amr";
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "matroska";
  if (s(0, 3) === "ID3") return "mp3";
  if (buf[0] === 0xFF && (buf[1] & 0xF6) === 0xF0) return "aac";
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return "mp3";
  return "";
}

/* The line says how many bytes the recording has and what its SHA-256 is; a rebuilt file that differs must not be transcribed. */
export function verifyBytes(buf, { bytes, sha256: want }) {
  if (!/^[0-9a-f]{64}$/.test(String(want || ""))) throw new Error("the line has no valid SHA-256 to check against");
  if (buf.length > MAX_RECORDING_BYTES) throw new Error("the chunks give more than the largest recording the app stores");
  if (Number(bytes) !== buf.length) throw new Error(`size differs: the line says ${bytes} bytes, the chunks give ${buf.length}`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`SHA-256 differs: the line says ${want}, the chunks give ${got}`);
  return { bytes: buf.length, sha256: got };
}
export function verifyRecording(buf, want) {
  const ok = verifyBytes(buf, want);
  if (!audioFormat(buf)) throw new Error("the chunks do not rebuild into an audio file");
  return ok;
}

/* ---- a recording inside a zip archive ----
   The app unpacks a zip when it is attached and stores the audio itself, so a stored zip is the exception; it is handled here all the same.
   An archive is somebody else's data. It must hold exactly one file apart from what macOS adds (folders, __MACOSX, .DS_Store, ._ files); that
   file must be a recording by its first bytes; nothing in the archive is run; no name or path from inside it is used for anything; and how far
   it may unpack is limited before a byte is unpacked (the size it states, at most ZIP_MAX_RATIO times its packed size) and while it unpacks. */
export const ZIP_MAX_ENTRIES = 64, ZIP_MAX_RATIO = 100;
const ZIP_EOCD = 0x06054b50, ZIP_CENTRAL = 0x02014b50, ZIP_LOCAL = 0x04034b50, EOCD_BYTES = 22, CENTRAL_BYTES = 46, LOCAL_BYTES = 30, ZIP_COMMENT_MAX = 0xFFFF;
const ZIP_STORED = 0, ZIP_DEFLATED = 8, ZIP_ENCRYPTED_FLAGS = 0x41, ZIP64_MARK = 0xFFFFFFFF;
const ZIP_DAMAGED = "the archive is damaged or is not a zip file", ZIP_MANY = "the archive holds more than one file; it must hold one recording";
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export const isZip = buf => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6) || (buf[2] === 7 && buf[3] === 8));
/* what macOS and Finder add to an archive, which is not the user's file */
const zipExtra = e => { const parts = e.name.replace(/\\/g, "/").split("/"), base = parts.at(-1); return (base === "" && e.size === 0) || parts.includes("__MACOSX") || base === ".DS_Store" || base.startsWith("._"); };
/* the archive's own list of what it holds, read from its end; every offset is checked against the bytes that are really there */
function zipEntries(buf) {
  const bad = () => new Error(ZIP_DAMAGED);
  let end = -1;
  for (let i = buf.length - EOCD_BYTES; i >= 0 && i >= buf.length - EOCD_BYTES - ZIP_COMMENT_MAX; i--) if (buf.readUInt32LE(i) === ZIP_EOCD) { end = i; break; }
  if (end < 0) throw bad();
  const count = buf.readUInt16LE(end + 10), size = buf.readUInt32LE(end + 12), start = buf.readUInt32LE(end + 16);
  if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) || buf.readUInt16LE(end + 8) !== count) throw bad();   /* split over several files */
  if (count > ZIP_MAX_ENTRIES) throw new Error(ZIP_MANY);
  if (size === ZIP64_MARK || start === ZIP64_MARK || start + size > end) throw bad();
  const entries = [];
  for (let p = start, i = 0; i < count; i++) {
    if (p + CENTRAL_BYTES > start + size || buf.readUInt32LE(p) !== ZIP_CENTRAL) throw bad();
    const nameLen = buf.readUInt16LE(p + 28), next = p + CENTRAL_BYTES + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > start + size) throw bad();
    entries.push({ flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), packed: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42), name: buf.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nameLen).toString("utf8") });
    p = next;
  }
  return { entries, dirStart: start };
}
/* The one recording in a zip, as bytes. Throws with the reason when the archive is not exactly that. */
export function unzipRecording(buf, { maxBytes = MAX_RECORDING_BYTES } = {}) {
  const { entries, dirStart } = zipEntries(buf), files = entries.filter(e => !zipExtra(e));
  if (!files.length) throw new Error("the archive has no recording in it");
  if (files.length > 1) throw new Error(ZIP_MANY);
  const [e] = files;
  if (e.flags & ZIP_ENCRYPTED_FLAGS) throw new Error("the archive is password-protected, so it was not opened");
  if (e.method !== ZIP_STORED && e.method !== ZIP_DEFLATED) throw new Error("the archive uses a compression this tool does not read");
  if (e.size > maxBytes) throw new Error("the file in the archive is larger than the largest recording the app stores");
  if (!e.size || !e.packed) throw new Error("the archive has no recording in it");
  if (e.size / e.packed > ZIP_MAX_RATIO) throw new Error("the archive unpacks to far more than its size, which a recording never does, so it was not opened");
  if (e.offset + LOCAL_BYTES > dirStart || buf.readUInt32LE(e.offset) !== ZIP_LOCAL) throw new Error(ZIP_DAMAGED);
  const from = e.offset + LOCAL_BYTES + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28), packed = buf.subarray(from, from + e.packed);
  if (from + e.packed > dirStart || (e.method === ZIP_STORED && e.packed !== e.size)) throw new Error(ZIP_DAMAGED);
  let out;
  try { out = e.method === ZIP_STORED ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: e.size }); } catch (_) { throw new Error(ZIP_DAMAGED); }   /* stops as soon as it would pass the stated size */
  if (out.length !== e.size || crc32(out) !== e.crc) throw new Error(ZIP_DAMAGED);
  if (!audioFormat(out)) throw new Error("the file in the archive is not a recording this tool reads");
  return out;
}

/* Whisper reads a prompt of at most about 224 tokens, far less than a lab vocabulary. So the prompt carries the terms most likely to be
   spoken in this recording: first what the app learned the speaker says (config/voice), then vocabulary terms already written near the
   recording (the notebook's other lines), then the vocabulary in its own order (newest first). */
export const PROMPT_BUDGET_CHARS = 560;
const PROMPT_LEAD = "Lab notebook voice memo. Terms: ";
const bare = term => String(term).replace(/\s*\(.*\)\s*$/, "").trim();
export function pickTerms({ glossary = [], voice = [], context = "", budget = PROMPT_BUDGET_CHARS } = {}) {
  const near = String(context).toLowerCase();
  const learned = [...voice].filter(p => p && typeof p.said === "string" && p.n > 0).sort((a, b) => b.n - a.n).map(p => p.said);
  const all = glossary.filter(t => typeof t === "string").map(bare);
  const ranked = [...learned.map(bare), ...all.filter(t => t && near.includes(t.toLowerCase())), ...all];
  const seen = new Set(), picked = [];
  let used = PROMPT_LEAD.length;
  for (const term of ranked) {
    const key = term.toLowerCase();
    if (!term || term.length > 40 || /[\r\n]/.test(term) || seen.has(key)) continue;
    if (used + term.length + 2 > budget) continue;
    seen.add(key); picked.push(term); used += term.length + 2;
  }
  return picked;
}
export const promptFor = terms => (terms.length ? PROMPT_LEAD + terms.join(", ") + "." : "");

/* whisper.cpp's JSON has one item per stretch of speech, with times in milliseconds. Repeats and its markers for silence are dropped;
   a pause starts a new line, so a long recording reads in paragraphs. */
export const PARAGRAPH_PAUSE_MS = 2000, MAX_REPEATS = 2;
const NOISE = /^[\[(][^\])]*[\])]$/;   /* [BLANK_AUDIO], (music), [ Silence ] */
export function transcriptFrom(segments) {
  let out = "", lastEnd = null, last = "", repeats = 0;
  for (const s of Array.isArray(segments) ? segments : []) {
    const text = String(s && s.text || "").replace(/\s+/g, " ").trim();
    if (!text || NOISE.test(text)) continue;
    repeats = text === last ? repeats + 1 : 0; last = text;
    if (repeats >= MAX_REPEATS) continue;   /* the same sentence a third time in a row is the model looping, not speech */
    const from = s.offsets && Number.isFinite(s.offsets.from) ? s.offsets.from : null;
    out += (out ? (lastEnd !== null && from !== null && from - lastEnd >= PARAGRAPH_PAUSE_MS ? "\n" : " ") : "") + text;
    lastEnd = s.offsets && Number.isFinite(s.offsets.to) ? s.offsets.to : lastEnd;
  }
  return out;
}

/* "en-US" in the app's settings is "en" for the transcriber; anything unexpected falls back to detecting the language */
export const languageFor = lang => { const m = String(lang || "").toLowerCase().match(/^[a-z]{2,3}(?=$|[-_])/); return m ? m[0] : "auto"; };
