// Stand-in for the claude.ai runtime (window.claude), injected before the page runs.
// It behaves like the real store in the ways that have bitten us:
//   - data handed to the page is DEEP-FROZEN, like the real db (see docs/decisions.md, "Frozen data")
//   - snapshots arrive asynchronously and replace the page's copies
// Options (all optional):
//   entries, glossary, protocols  initial data
//   failFirstUpdate               make the first entry update reject once (tests save retry)
//   sample(prompt) -> {text, ...} what "Claude" answers; default: echo the line back unchanged
//   voice                         initial config/voice doc ({pairs: [...]})
//   logs                          initial logs collection, e.g. { daily: { blocks: [...] }, todo: { items: [...] } }
//   tabs                          custom tabs already stored in config/tabs: [{ id: "tab-abcd1234", name, type }]
//   failSetOnce                   a document path whose first set() rejects once (tests the To-do save retry); "protocols/*" matches any id
//   noDb                          no store at all, as when the page is opened signed out
//   dictation                     true, or {rejectStart: "not_granted"}: offer the dictation capability (default: null, like Safari)
//   assets                        text assets already stored: { id: "<text>" } (voice memo chunks are base64 text)
//   fileAssets                    ids of stored files that are not text (a protocol's PDF, a photo), e.g. ["pdf1"]
//   assetUsage                    { bytes, files, maxBytes, maxFiles }: storage already used and the quota (default 1 GiB, 5000 files)
//   assetFailCalls                which upload calls reject once with store_unavailable, counted from 1, e.g. [2]
//   assetDelayMs                  make each upload take this long
//                                 tests drive it with window.__dict.emit("partial"|"final"|"state", payload); window.__dict.calls lists start/stop
export function installMock(opts) {
  const freeze = o => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const clone = d => freeze(JSON.parse(JSON.stringify(d)));
  const store = {
    entries: opts.entries || {},
    protocols: opts.protocols || {},
    logs: opts.logs || {},
    config: { ...(opts.voice ? { voice: opts.voice } : {}), ...(opts.tabs ? { tabs: { tabs: opts.tabs } } : {}), glossary: { terms: opts.glossary || [] }, settings: { fixModel: "claude-sonnet-5-5", askModel: "default", autoFix: true, lang: "en-US", ...(opts.settings || {}) } }
  };
  const L = {}, D = {};
  const fire = c => setTimeout(() => {
    (L[c] || []).forEach(f => f({ docs: Object.entries(store[c]).map(([id, d]) => ({ id, exists: true, data: () => clone(d) })) }));
    Object.entries(D).forEach(([p, fns]) => { const [cc, id] = p.split("/"); if (cc === c) fns.forEach(f => f({ exists: !!store[cc][id], data: () => clone(store[cc][id] || {}) })); });
  }, 5);
  let failed = false, failedSet = false;
  const db = {
    collection: c => ({ onSnapshot: f => { (L[c] = L[c] || []).push(f); fire(c); return () => {}; } }),
    doc: p => { const [c, id] = p.split("/"); return {
      get: async () => ({ id, exists: !!store[c][id], data: () => (store[c][id] ? clone(store[c][id]) : undefined) }),
      onSnapshot: f => { (D[p] = D[p] || []).push(f); fire(c); return () => {}; },
      set: async d => {
        if (!failedSet && (opts.failSetOnce === p || (opts.failSetOnce || "").endsWith("/*") && p.startsWith(opts.failSetOnce.slice(0, -1)))) { failedSet = true; throw { code: "unavailable", message: "offline" }; }
        store[c][id] = JSON.parse(JSON.stringify(d)); fire(c);
      },
      update: async d => {
        if (opts.failFirstUpdate && !failed) { failed = true; throw { code: "unavailable", message: "offline" }; }
        if (!store[c][id]) throw { code: "invalid_argument", message: "update needs an existing document" };   // like the real store
        Object.assign(store[c][id], JSON.parse(JSON.stringify(d))); fire(c);
      },
      delete: async () => { delete store[c][id]; fire(c); }
    }; }
  };
  window.__store = store; window.__prompts = [];
  // what a Claude session does from outside the page: change stored documents, then every listener hears it
  window.__remote = fn => { fn(store); Object.keys(store).forEach(fire); };
  window.__remoteQuiet = fn => fn(store);   // the same, but no snapshot has reached this device yet
  // sampleScript sees: prompt (all turns joined as text), input (string or turn list, as passed), opts (tools, images…)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const answer = opts.sampleScript ? new AsyncFunction("prompt", "input", "opts", opts.sampleScript) : (prompt => {
    const line = (prompt.match(/<<<([\s\S]*)>>>/) || [])[1] || "";
    return { text: JSON.stringify({ text: line, changes: [], unsure: [] }), modelApplied: "claude-sonnet-5-5" };
  });
  window.__calls = [];
  const sample = Object.assign(async (input, o = {}) => {
    // like the real runtime: a turn list must start and end on a user turn
    if (Array.isArray(input) && (!input.length || input[0].role !== "user" || input.at(-1).role !== "user")) throw { code: "invalid_request", message: "turns must start and end on user" };
    const prompt = Array.isArray(input) ? input.map(t => t.content).join("\n\n") : input;
    window.__prompts.push(prompt);
    window.__calls.push({ input: JSON.parse(JSON.stringify(input)), images: [].concat(o.images || []).length, tools: (o.tools || []).map(t => t.name), model: o.model, modelTier: o.modelTier, effort: o.effort });
    const r = await answer(prompt, input, o);
    await new Promise(res => setTimeout(res, 5));   // answers never arrive synchronously
    if (o.signal && o.signal.aborted) throw { code: "cancelled", message: "cancelled" };
    if (o.onText && r && r.text) o.onText({ text: r.text, delta: r.text });
    return r;
  }, { limits: async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 2e7, mediaTypes: ["image/jpeg", "image/png"] }, tools: { maxCount: 8 } }) });
  let n = 0;
  window.__assetDeletes = [];   // ids the page asked to delete for good
  window.__assetUploads = [];   // what the page uploaded: type and size of each file
  /* assets behave like the store as measured on the iPad (scratch/audio-test): a closed list of types, so audio is refused under any
     label; text is kept byte for byte; 20 MiB per file; a quota of bytes and files. Text assets are served back at /_blob/<id>. */
  const ASSET_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "video/mp4", "video/webm", "application/pdf", "font/woff2", "font/woff", "font/ttf", "font/otf", "text/csv", "text/markdown", "application/json", "text/plain", "text/css", "text/javascript"];
  const ASSET_MAX = 20 * 1024 * 1024, usage0 = opts.assetUsage || {};
  const kept = new Map(Object.entries(opts.assets || {}).map(([id, text]) => [id, { text, contentType: "text/plain", sizeBytes: text.length, createdAt: new Date().toISOString() }]));
  (opts.fileAssets || []).forEach(id => kept.set(id, { text: null, contentType: "application/pdf", sizeBytes: 16, createdAt: new Date().toISOString() }));
  window.__assets = kept;
  const usage = () => ({ files: (usage0.files || 0) + kept.size, bytes: (usage0.bytes || 0) + [...kept.values()].reduce((t, a) => t + a.sizeBytes, 0), maxFiles: usage0.maxFiles || 5000, maxBytes: usage0.maxBytes || 1024 * 1024 * 1024 });
  let uploads = 0;
  const assets = {
    upload: async (blob, o = {}) => {
      const type = o.type || blob.type, call = ++uploads;
      if (!(blob instanceof Blob) || !blob.size) throw { code: "invalid_request", message: "empty or not a blob" };
      if (!ASSET_TYPES.includes(type)) throw { code: "unsupported_type", message: "unsupported type " + type };
      if (blob.size > ASSET_MAX) throw { code: "too_large", message: "over 20 MiB" };
      if ((opts.assetFailCalls || []).includes(call)) throw { code: "store_unavailable", message: "offline" };
      const u = usage(); if (u.bytes + blob.size > u.maxBytes || u.files + 1 > u.maxFiles) throw { code: "quota_or_state", message: "quota" };
      const id = "asset" + (++n), text = type.startsWith("text/") ? await blob.text() : null;
      if (opts.assetDelayMs) await new Promise(r => setTimeout(r, opts.assetDelayMs));
      kept.set(id, { text, contentType: type, sizeBytes: blob.size, createdAt: new Date().toISOString() });
      window.__assetUploads.push({ type, size: blob.size });
      return { id, url: text === null ? "data:image/png;base64,iVBORw0KGgo=" : "/_blob/" + id, sizeBytes: blob.size, contentType: type };
    },
    list: async () => ({ assets: [...kept.entries()].map(([id, a]) => ({ id, url: "/_blob/" + id, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt })), usage: usage() }),
    delete: async id => { window.__assetDeletes.push(id); return { deleted: kept.delete(id) }; }
  };
  /* the page reads a stored text asset back with fetch("/_blob/<id>"); a deleted or unknown id is a 404 */
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    const m = typeof url === "string" && url.match(/^\/_blob\/([A-Za-z0-9_-]+)$/);
    if (!m) return realFetch(url, init);
    const a = kept.get(m[1]);
    return Promise.resolve(a && a.text !== null ? new Response(a.text, { status: 200, headers: { "content-type": a.contentType } }) : new Response("not found", { status: 404 }));
  };
  // dictation: like the runtime's namespace; events are emitted by the test, start() must be called inside the click
  const H = { partial: [], final: [], state: [] };
  const emit = (kind, payload) => H[kind].forEach(f => f(payload));
  const sub = kind => f => { H[kind].push(f); return () => { H[kind] = H[kind].filter(x => x !== f); }; };
  const reject = opts.dictation && opts.dictation.rejectStart;
  window.__dict = { calls: [], emit };
  const dictation = {
    start: opts => {
      window.__dict.calls.push({ fn: "start", language: opts && opts.language });
      emit("state", { state: "starting" });
      if (reject) { const err = { code: reject, message: reject }; setTimeout(() => emit("state", { state: "idle", reason: reject }), 1); return Promise.reject(err); }
      return new Promise(res => setTimeout(() => { emit("state", { state: "listening" }); res(); }, 5));
    },
    stop: async () => { window.__dict.calls.push({ fn: "stop" }); emit("state", { state: "finishing" }); emit("state", { state: "idle", reason: "stopped" }); },
    active: () => false, onPartial: sub("partial"), onFinal: sub("final"), onState: sub("state")
  };
  window.claude = { use: async name => ({ db: opts.noDb ? null : db, sample, assets, user: null, dictation: opts.dictation ? dictation : null })[name] ?? null };
}
