// The transcription tool's own logic (tools/transcribe): joining and checking stored chunks, choosing prompt terms, tidying the transcript.
// These tests do not run whisper.cpp or need its model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinChunks, verifyRecording, pickTerms, promptFor, transcriptFrom, languageFor, audioFormat, sha256, PROMPT_BUDGET_CHARS, isZip, unzipRecording } from "../tools/transcribe/lib.mjs";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeZip, ZIP_STORED, ZIP_ENCRYPTED } from "./zip-fixtures.mjs";

const TOOL = fileURLToPath(new URL("../tools/transcribe/transcribe.mjs", import.meta.url));
/* made-up bytes behind a WAV header, so they count as a recording */
const bytes = n => Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE", "latin1"), Buffer.from(Array.from({ length: n - 12 }, (_, i) => (i * 37 + 11) % 256))]);
const split = (buf, size) => { const out = []; for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size).toString("base64")); return out; };

test("chunks join back into the recording, and its size and SHA-256 are checked", () => {
  const audio = bytes(10000), chunks = split(audio, 3000);
  const back = joinChunks(chunks);
  assert.ok(back.equals(audio));
  assert.deepEqual(verifyRecording(back, { bytes: audio.length, sha256: sha256(audio) }), { bytes: 10000, sha256: sha256(audio) });
  assert.ok(joinChunks(chunks.map(c => c + "\n")).equals(audio), "a trailing newline from a download is ignored");
});

test("a missing, reordered or damaged chunk is refused", () => {
  const audio = bytes(10000), chunks = split(audio, 3000), want = { bytes: audio.length, sha256: sha256(audio) };
  assert.throws(() => verifyRecording(joinChunks(chunks.slice(0, 3)), want), /size differs/);
  assert.throws(() => verifyRecording(joinChunks([chunks[1], chunks[0], chunks[2], chunks[3]]), want), /SHA-256 differs/);
  assert.throws(() => joinChunks([chunks[0], "<html>not found</html>"]), /chunk 2 is not base64/);
  assert.throws(() => joinChunks([]), /no chunks/);
  assert.throws(() => verifyRecording(audio, { bytes: audio.length, sha256: "" }), /no valid SHA-256/);
  const list = Buffer.from("ffconcat version 1.0\nfile /etc/hosts\n");
  assert.throws(() => verifyRecording(list, { bytes: list.length, sha256: sha256(list) }), /do not rebuild into an audio file/, "a playlist that names other files is never passed on");
});

test("prompt terms: what the speaker is known to say first, then vocabulary found near the recording, within Whisper's small budget", () => {
  const glossary = ["Matrigel", "Accutase", "nucleofector (Lonza 4D)", "KOLF2.1J-NGN2", ...Array.from({ length: 400 }, (_, i) => "filler-term-" + i)];
  const voice = [{ heard: "a cute ace", said: "Accutase", n: 5 }, { heard: "piggy back", said: "PiggyBac", n: 9 }, { heard: "x", said: "ignored", n: 0 }];
  const terms = pickTerms({ glossary, voice, context: "seeded KOLF2.1J-NGN2 after the nucleofector run" });
  assert.deepEqual(terms.slice(0, 5), ["PiggyBac", "Accutase", "nucleofector", "KOLF2.1J-NGN2", "Matrigel"]);
  assert.equal(new Set(terms.map(t => t.toLowerCase())).size, terms.length, "no term twice");
  assert.ok(promptFor(terms).length <= PROMPT_BUDGET_CHARS, "prompt is " + promptFor(terms).length + " characters");
  assert.ok(terms.length < glossary.length, "the whole vocabulary can't fit and isn't sent");
  assert.equal(promptFor([]), "");
  assert.deepEqual(pickTerms({ glossary: ["ok", "bad\nterm", 7, "x".repeat(50)] }), ["ok"], "odd entries are left out");
});

test("the transcript drops silence markers and a looping sentence, and starts a new line after a pause", () => {
  const seg = (text, from, to) => ({ text, offsets: { from, to } });
  const text = transcriptFrom([seg(" Counted the cells.", 0, 1500), seg("[BLANK_AUDIO]", 1500, 2000), seg(" Viability was 94 percent.", 2000, 4000),
    seg(" Thank you.", 7000, 7500), seg(" Thank you.", 7500, 8000), seg(" Thank you.", 8000, 8500), seg(" Thank you.", 8500, 9000), seg(" Seeded the plate.", 9200, 10000)]);
  assert.equal(text, "Counted the cells. Viability was 94 percent.\nThank you. Thank you. Seeded the plate.");
  assert.equal(transcriptFrom([]), ""); assert.equal(transcriptFrom(undefined), "");
});

test("the app's language setting becomes the transcriber's language code", () => {
  assert.equal(languageFor("en-US"), "en"); assert.equal(languageFor("tr-TR"), "tr"); assert.equal(languageFor(""), "auto"); assert.equal(languageFor("; rm -rf"), "auto");
});

test("the join command writes the recording only when it matches the line", () => {
  const dir = mkdtempSync(join(tmpdir(), "atg-eln-test-"));
  try {
    const audio = bytes(7000), parts = split(audio, 3000).map((t, i) => { const p = join(dir, `c${i + 1}.txt`); writeFileSync(p, t); return p; });
    const out = join(dir, "recording.m4a");
    const res = JSON.parse(execFileSync(process.execPath, [TOOL, "join", "--out", out, "--bytes", String(audio.length), "--sha256", sha256(audio), ...parts], { encoding: "utf8" }));
    assert.equal(res.verified, true); assert.ok(readFileSync(out).equals(audio));
    const bad = join(dir, "bad.m4a");
    assert.throws(() => execFileSync(process.execPath, [TOOL, "join", "--out", bad, "--bytes", String(audio.length), "--sha256", sha256(Buffer.from("other")), ...parts], { encoding: "utf8", stdio: "pipe" }), /SHA-256 differs/);
    assert.throws(() => readFileSync(bad), /ENOENT/, "nothing is written when the check fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rebuilt file is recognised by its first bytes, and anything else is refused before ffmpeg sees it", () => {
  assert.equal(audioFormat(Buffer.from("\0\0\0\x1cftypM4A \0\0\0\0", "latin1")), "mov");
  assert.equal(audioFormat(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1")), "wav");
  assert.equal(audioFormat(Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1")), "mp3");
  assert.equal(audioFormat(Buffer.from("#EXTM3U\nhttp://example.invalid/x\n")), "");
  assert.equal(audioFormat(Buffer.from("ffconcat version 1.0\n")), "");
  assert.equal(audioFormat(Buffer.alloc(0)), "");
  const dir = mkdtempSync(join(tmpdir(), "atg-eln-test-"));
  try {
    const fake = join(dir, "memo.m4a"); writeFileSync(fake, "ffconcat version 1.0\nfile /etc/hosts\n");
    assert.throws(() => execFileSync(process.execPath, [TOOL, "run", "--audio", fake, "--out", join(dir, "r.json")], { encoding: "utf8", stdio: "pipe" }), /not a recording|Not set up/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---- a stored recording that is a zip archive (the app unpacks a zip when it is attached, so this is the exception) ---- */
test("a zip with one recording unpacks to that recording; macOS extras and folders are ignored", () => {
  const audio = bytes(9000);
  assert.equal(isZip(makeZip([{ name: "memo.wav", data: audio }])), true); assert.equal(isZip(audio), false); assert.equal(isZip(Buffer.alloc(0)), false);
  assert.ok(unzipRecording(makeZip([{ name: "memo.wav", data: audio }])).equals(audio));
  assert.ok(unzipRecording(makeZip([{ name: "memo.wav", data: audio, method: ZIP_STORED }])).equals(audio));
  assert.ok(unzipRecording(makeZip([{ name: "memo.wav", data: audio, descriptor: true, localExtra: 32, centralExtra: 24 }])).equals(audio), "as macOS and iOS write it: sizes only in the list at the end, extra fields of different lengths");
  assert.ok(unzipRecording(makeZip([{ name: "first/", data: "", localExtra: 16 }, { name: "first/memo.wav", data: audio, method: ZIP_STORED, descriptor: true, localExtra: 9 }])).equals(audio));
  assert.ok(unzipRecording(makeZip([{ name: "a/", data: "" }, { name: "__MACOSX/a/._memo.wav", data: "x" }, { name: "a/.DS_Store", data: "x" }, { name: "../../a/memo.wav", data: audio }], { comment: "made on a Mac" })).equals(audio));
});

test("a zip that should not be opened is refused with the reason", () => {
  const audio = bytes(9000), good = makeZip([{ name: "memo.wav", data: audio }]), silence = Buffer.concat([bytes(12), Buffer.alloc(4 * 1024 * 1024)]);
  assert.throws(() => unzipRecording(makeZip([{ name: "one.wav", data: audio }, { name: "two.wav", data: audio }])), /more than one file/);
  assert.throws(() => unzipRecording(makeZip([{ name: "memo.wav", data: audio }, { name: "run.sh", data: "#!/bin/sh\n" }])), /more than one file/);
  assert.throws(() => unzipRecording(makeZip([{ name: "run.sh", data: "#!/bin/sh\necho hi\n" }])), /not a recording/);
  assert.throws(() => unzipRecording(makeZip([{ name: "inner.zip", data: good }])), /not a recording/);
  assert.throws(() => unzipRecording(makeZip([{ name: ".DS_Store", data: "x" }])), /no recording/);
  assert.throws(() => unzipRecording(makeZip([{ name: "memo.wav", data: audio, flags: ZIP_ENCRYPTED }])), /password/);
  assert.throws(() => unzipRecording(makeZip([{ name: "memo.wav", data: audio, lie: { size: 201 * 1024 * 1024 } }])), /larger than/);
  assert.throws(() => unzipRecording(makeZip([{ name: "silence.wav", data: silence }])), /far more than its size/);
  assert.throws(() => unzipRecording(makeZip([{ name: "silence.wav", data: silence, lie: { size: 100000 } }])), /damaged/);
  assert.throws(() => unzipRecording(makeZip([{ name: "memo.wav", data: audio, method: ZIP_STORED, lie: { method: 14 } }])), /compression/);
  assert.throws(() => unzipRecording(makeZip([{ name: "memo.wav", data: audio, lie: { crc: 12345 } }])), /damaged/);
  assert.throws(() => unzipRecording(good.subarray(0, good.length - 40)), /damaged/);
  assert.throws(() => unzipRecording(makeZip(Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.wav`, data: "x" })))), /more than one file/);
});

test("the join command unpacks a stored zip into a new folder, under the name it was given, never one from the archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "atg-eln-test-"));
  try {
    const audio = bytes(7000), zip = makeZip([{ name: "../../../evil.sh", data: audio }]);
    const parts = split(zip, 3000).map((t, i) => { const p = join(dir, `c${i + 1}.txt`); writeFileSync(p, t); return p; });
    const res = JSON.parse(execFileSync(process.execPath, [TOOL, "join", "--out", join(dir, "memo.m4a"), "--bytes", String(zip.length), "--sha256", sha256(zip), ...parts], { encoding: "utf8" }));
    assert.equal(res.verified, true); assert.equal(res.archive, true); assert.equal(res.bytes, audio.length); assert.equal(res.sha256, sha256(audio));
    assert.notEqual(dirname(res.out), dir, "a folder of its own"); assert.equal(dirname(dirname(res.out)), dir); assert.match(res.out, /memo\.m4a$/);
    assert.deepEqual(readdirSync(dirname(res.out)), ["memo.m4a"]); assert.ok(readFileSync(res.out).equals(audio));
    assert.ok(!existsSync(join(dir, "memo.m4a")) && !existsSync(join(dir, "..", "evil.sh")));
    const two = makeZip([{ name: "a.wav", data: audio }, { name: "b.wav", data: audio }]), p2 = join(dir, "two.txt"); writeFileSync(p2, two.toString("base64"));
    assert.throws(() => execFileSync(process.execPath, [TOOL, "join", "--out", join(dir, "two.m4a"), "--bytes", String(two.length), "--sha256", sha256(two), p2], { encoding: "utf8", stdio: "pipe" }), /more than one file/);
    assert.deepEqual(readdirSync(dir).filter(n => n.startsWith("unpacked-")).length, 1, "nothing is left behind by the refused archive");
    assert.throws(() => execFileSync(process.execPath, [TOOL, "join", "--out", dir + "/sub/..", "--bytes", String(zip.length), "--sha256", sha256(zip), ...parts], { encoding: "utf8", stdio: "pipe" }), /must name a file/);
    assert.deepEqual(readdirSync(dir).filter(n => n.startsWith("unpacked-")).length, 1, "no folder is made when the name to write is not a file name");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
