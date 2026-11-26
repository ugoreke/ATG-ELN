// Pure helpers for the transcription tool: no files, no programs, so they can be tested on their own.
import { createHash } from "node:crypto";

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
export function verifyRecording(buf, { bytes, sha256: want }) {
  if (!/^[0-9a-f]{64}$/.test(String(want || ""))) throw new Error("the line has no valid SHA-256 to check against");
  if (buf.length > MAX_RECORDING_BYTES) throw new Error("the chunks give more than the largest recording the app stores");
  if (Number(bytes) !== buf.length) throw new Error(`size differs: the line says ${bytes} bytes, the chunks give ${buf.length}`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`SHA-256 differs: the line says ${want}, the chunks give ${got}`);
  if (!audioFormat(buf)) throw new Error("the chunks do not rebuild into an audio file");
  return { bytes: buf.length, sha256: got };
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
