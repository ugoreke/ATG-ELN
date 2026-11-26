// Made-up notebook data and a stand-in for the artifact database, for the tests of tools/transfer and for practice cases.
// Nothing here comes from a real notebook.

export const NOW = "2026-03-10T18:00:00.000Z";
export const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_NOTEBOOK_ID = "22222222-2222-4222-8222-222222222222";
export const MEETING_ID = "33333333-3333-4333-8333-333333333333";
export const NEW_NOTEBOOK_ID = "44444444-4444-4444-8444-444444444444";
export const BENCHLING_URL = "https://benchling.com/example-lab/f/lib_made-up/etr_made-up-entry/edit";
export const SHA = "a".repeat(64);

const DAY_MS = 24 * 60 * 60 * 1000;
export const daysBefore = (iso, days) => new Date(Date.parse(iso) - days * DAY_MS).toISOString();

/* documents from the store arrive deep-frozen, as in the app's stand-in runtime */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export const textLine = (id, at, text = "made-up note " + id) => ({ id, type: "text", text, at });
export const photoLine = (id, at) => ({ id, type: "photo", assetId: "asset-" + id, url: "/_blob/asset-" + id, caption: "made-up caption", at });
export const inkLine = (id, at) => ({ id, type: "ink", assetId: "ink-" + id, url: "/_blob/ink-" + id, caption: "", transcript: "made-up handwriting", at });
/* a transcribed voice memo with every field a stored one can carry */
export const voiceMemo = (id, at, extra = {}) => ({
  id, type: "audio", at, attachedAt: at, fileName: "memo-" + id + ".m4a", mime: "audio/mp4", bytes: 123456, duration: 42.5, sha256: SHA,
  chunks: ["chunk-" + id + "-1", "chunk-" + id + "-2"], caption: "made-up memo", transcript: "Counted the made-up cells.",
  transcribedAt: at, transcriber: "whisper.cpp test", audioRemovedAt: "", ...extra,
});

export const dailyDoc = (blocks, moved = {}, extra = {}) => ({ blocks, protocols: [], moved, updatedAt: "2026-03-10T09:00:00.000Z", ...extra });
export const notebookDoc = (blocks, extra = {}) => ({
  title: "260310_Made-up_Line_Test", createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-09T08:00:00.000Z", protocols: ["made-up-protocol"], blocks, ...extra,
});

/* A stand-in for the artifact database as the data tool sees it: every document has a version; a batch is applied all at once or not at
   all, and a write to an existing document must be pinned to its current version. `overwrite` is what a device does: it saves its own
   copy over whatever is stored, without a pin. */
export function makeStore(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([path, doc]) => [path, { version: 1, doc: deepFreeze(structuredClone(doc)) }]));
  const key = (collection, id) => collection + "/" + id;
  const read = (collection, id) => {
    const held = docs.get(key(collection, id));
    if (!held) throw new Error("no such document: " + key(collection, id));
    return { collection, id, version: held.version, doc: held.doc };
  };
  const batch = writes => {
    for (const w of writes) {
      const held = docs.get(key(w.collection, w.doc_id));
      if (held && w.if_version !== held.version) throw new Error(`refused: ${key(w.collection, w.doc_id)} is at version ${held.version}, not ${w.if_version}`);
      if (!held && w.if_version !== undefined) throw new Error(`refused: ${key(w.collection, w.doc_id)} does not exist`);
      if (w.op !== "set") throw new Error("the stand-in store only takes set");
    }
    for (const w of writes) {
      const held = docs.get(key(w.collection, w.doc_id));
      docs.set(key(w.collection, w.doc_id), { version: held ? held.version + 1 : 1, doc: deepFreeze(structuredClone(w.data)) });
    }
  };
  const overwrite = (collection, id, doc) => {
    const held = docs.get(key(collection, id));
    docs.set(key(collection, id), { version: held ? held.version + 1 : 1, doc: deepFreeze(structuredClone(doc)) });
  };
  const has = (collection, id) => docs.has(key(collection, id));
  return { read, batch, overwrite, has };
}
