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
//   failSetOnce                   a document path whose first set() rejects once (tests the To-do save retry)
//   dictation                     true, or {rejectStart: "not_granted"}: offer the dictation capability (default: null, like Safari)
//                                 tests drive it with window.__dict.emit("partial"|"final"|"state", payload); window.__dict.calls lists start/stop
export function installMock(opts) {
  const freeze = o => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const clone = d => freeze(JSON.parse(JSON.stringify(d)));
  const store = {
    entries: opts.entries || {},
    protocols: opts.protocols || {},
    logs: opts.logs || {},
    config: { ...(opts.voice ? { voice: opts.voice } : {}), glossary: { terms: opts.glossary || [] }, settings: { fixModel: "claude-sonnet-5-5", askModel: "default", autoFix: true, lang: "en-US", ...(opts.settings || {}) } }
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
        if (opts.failSetOnce === p && !failedSet) { failedSet = true; throw { code: "unavailable", message: "offline" }; }
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
  const assets = { upload: async () => ({ id: "asset" + (++n), url: "data:image/png;base64,iVBORw0KGgo=" }), delete: async id => { window.__assetDeletes.push(id); return {}; } };
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
  window.claude = { use: async name => ({ db, sample, assets, user: null, dictation: opts.dictation ? dictation : null })[name] ?? null };
}
