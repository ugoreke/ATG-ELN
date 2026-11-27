// The decisions of the Claude Code hooks in this folder, as pure functions: text in, a verdict out. Nothing here reads a file, runs git
// or looks at the clock; the entry scripts (guard-commit.mjs, mark-tests-owed.mjs, run-owed-tests.mjs) do that and print the result.
import { scanCommands } from "./shell.mjs";

export const PRIVATE_BRANCH = "private-archive";
export const LOCAL_DIR = ".claude/local", TERMS_FILE = "private-terms.txt", OWED_DIR = "tests-owed";
export const MIN_TERM_LENGTH = 3;
const ALLOWED_MARK = "!";
const MAX_MARKER_NAME = 80, MAX_TAIL_CHARS = 3000;

/* ---- the JSON a hook is given on stdin ---- */

const text = value => (typeof value === "string" ? value : "");

export function parseHookInput(raw) {
  if (!String(raw ?? "").trim()) throw new Error("the hook input is empty");
  let json;
  try { json = JSON.parse(raw); } catch (err) { throw new Error(`the hook input is not valid JSON (${err.message})`); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("the hook input is not an object");
  const toolInput = json.tool_input && typeof json.tool_input === "object" ? json.tool_input : {};
  return { event: text(json.hook_event_name), sessionId: text(json.session_id), cwd: text(json.cwd), toolName: text(json.tool_name), command: text(toolInput.command),
    filePath: text(toolInput.file_path) || text(toolInput.notebook_path), stopHookActive: json.stop_hook_active === true };
}

/* ---- what a shell command does with git ---- */

const SHELL_PREFIXES = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time", "command", "exec", "nohup", "builtin", "env", "sudo"]);
const WRAPPERS_WITH_OPTIONS = new Set(["env", "sudo"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CD_COMMANDS = new Set(["cd", "pushd", "popd"]);
const HIDES_THE_INDEX = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
/* git commands that never change what is staged; any other one beside a commit means the guard cannot know what the commit will hold */
const LEAVES_INDEX_ALONE = new Set(["status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "check-ignore", "branch", "describe", "config", "fetch",
  "remote", "tag", "blame", "grep", "cat-file", "merge-base", "symbolic-ref", "for-each-ref", "show-ref", "shortlog", "reflog", "version", "help", "ls-remote", "name-rev", "whatchanged", "count-objects", "var",
  "verify-commit", "diff-tree"]);
const COMMIT_LONG_WITH_VALUE = new Set(["--message", "--file", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--author", "--date", "--template", "--cleanup",
  "--trailer", "--pathspec-from-file"]);
const COMMIT_LONG_THAT_STAGE = ["--all", "--patch", "--interactive", "--include", "--only", "--pathspec-from-file"];
const COMMIT_SHORT_WITH_VALUE = "mFCct", COMMIT_SHORT_WITH_ATTACHED_VALUE = "Su", COMMIT_SHORT_THAT_STAGE = "apio";
const PUSH_OPTIONS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const PUSH_EVERYTHING = new Set(["--all", "--mirror", "--branches"]);
const UNKNOWN_SUBCOMMAND = "?";

const REASON = {
  option: name => `\`git commit ${name}\` chooses what to commit as it runs`,
  path: "`git commit <path>` commits that file's working copy, staged or not",
  hidden: "the commit names its own git folder or index (--git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE)",
  beside: sub => (sub === UNKNOWN_SUBCOMMAND ? "a git command the guard cannot read runs in the same command as the commit" : `\`git ${sub}\` runs in the same command as the commit`),
};

/* leading VAR=value words, shell keywords and wrappers such as env or sudo are not the command */
function stripPrefix(words) {
  let rest = words, env = [], inWrapper = false;
  while (rest.length) {
    const word = rest[0].text;
    if (ASSIGNMENT.test(word)) env = [...env, word.slice(0, word.indexOf("="))];
    else if (SHELL_PREFIXES.has(word)) inWrapper = WRAPPERS_WITH_OPTIONS.has(word);
    else if (!(inWrapper && word.startsWith("-"))) break;
    rest = rest.slice(1);
  }
  return { env, rest };
}
/* lower case: on a file system that ignores case, GIT runs git */
const commandName = word => (word.dynamic ? "" : word.text.split("/").pop().toLowerCase());
const assignedNames = words => words.map(w => w.text).filter(w => ASSIGNMENT.test(w)).map(w => w.slice(0, w.indexOf("=")));

/* the words after `git`: its own options first (-C <dir>, -c <k=v> ...), then the subcommand and its arguments */
function parseGit(words) {
  let i = 0, dirs = [], hidden = false;
  while (i < words.length && words[i].text.startsWith("-")) {
    const option = words[i].text;
    if (option === "-C" && words[i + 1]) dirs = [...dirs, words[i + 1]];
    if (/^--(git-dir|work-tree)(=|$)/.test(option)) hidden = true;
    i += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  return { dirs, hidden, sub: words[i], args: words.slice(i + 1) };
}

/* git accepts a long option cut short (--al for --all, --mess for --message): the full name of one this guard cares about */
const COMMIT_LONG_KNOWN = [...COMMIT_LONG_WITH_VALUE, ...COMMIT_LONG_THAT_STAGE, "--amend"];
const fullLongName = name => (COMMIT_LONG_KNOWN.includes(name) || name.length < 4 ? name : COMMIT_LONG_KNOWN.find(full => full.startsWith(name)) || name);

/* -am x, -qmjoined, -S: the flags of one short cluster, and the value when one of them takes it */
function readShortCluster(token, nextToken) {
  let flags = "";
  for (let k = 1; k < token.length; k++) {
    const flag = token[k];
    if (COMMIT_SHORT_WITH_VALUE.includes(flag)) { const attached = token.slice(k + 1); return { flags, flag, value: attached || nextToken || "", usedNext: !attached }; }
    if (COMMIT_SHORT_WITH_ATTACHED_VALUE.includes(flag)) break;
    flags += flag;
  }
  return { flags, flag: "", value: "", usedNext: false };
}

function parseCommit(args) {
  const tokens = args.map(a => a.text);
  let reasons = [], messages = [], messageFiles = [], amend = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") { if (i + 1 < tokens.length) reasons = [...reasons, REASON.path]; break; }
    if (token.startsWith("--")) {
      const eq = token.indexOf("="), name = fullLongName(eq === -1 ? token : token.slice(0, eq)), takesNext = eq === -1 && COMMIT_LONG_WITH_VALUE.has(name);
      const value = eq === -1 ? (takesNext ? tokens[i + 1] ?? "" : "") : token.slice(eq + 1);
      if (takesNext) i++;
      if (COMMIT_LONG_THAT_STAGE.includes(name)) reasons = [...reasons, REASON.option(name)];
      else if (name === "--amend") amend = true;
      else if (name === "--message" || name === "--trailer") messages = [...messages, value];
      else if (name === "--file") messageFiles = [...messageFiles, value];
    } else if (token.startsWith("-") && token.length > 1) {
      const cluster = readShortCluster(token, tokens[i + 1]);
      if (cluster.usedNext) i++;
      reasons = [...reasons, ...[...cluster.flags].filter(f => COMMIT_SHORT_THAT_STAGE.includes(f)).map(f => REASON.option("-" + f))];
      if (cluster.flag === "m") messages = [...messages, cluster.value];
      if (cluster.flag === "F") messageFiles = [...messageFiles, cluster.value];
    } else reasons = [...reasons, REASON.path];
  }
  return { reasons, amend, messages, messageFiles: messageFiles.filter(f => f && f !== "-") };
}

const REFSPEC_PATTERN = /[*?[]/;   // refs/heads/* and the like: every branch the pattern matches
const namesPrivateBranch = ref => new RegExp(`(^|/)${PRIVATE_BRANCH}$`, "i").test(ref);

/* what a push would send: every branch, or the left side of each refspec (HEAD when none is given) */
function parsePush(args) {
  let everything = false, deleting = false, positional = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i].text;
    if (PUSH_EVERYTHING.has(token)) everything = true;
    else if (token === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(token)) deleting = true;
    else if (PUSH_OPTIONS_WITH_VALUE.has(token)) i++;
    else if (!token.startsWith("-")) positional = [...positional, args[i]];
  }
  if (deleting) return { everything, sources: [], named: [], unclear: [] };
  const given = positional.slice(1), unclear = given.filter(w => w.dynamic).map(w => w.text);   // a refspec the shell works out as it runs
  const refspecs = given.filter(w => !w.dynamic).map(w => w.text.replace(/^\+/, "")).filter(r => !r.startsWith(":"));   // ":branch" deletes and sends nothing
  const sourceOf = refspec => refspec.split(":")[0], isPattern = refspec => REFSPEC_PATTERN.test(sourceOf(refspec));
  const sources = given.length ? refspecs.filter(r => !isPattern(r)).map(sourceOf) : ["HEAD"];
  return { everything: everything || refspecs.some(isPattern), sources, named: refspecs.filter(r => r.split(":").some(namesPrivateBranch)), unclear };
}

/* the folder after a `cd`, as steps from where the command starts; null when it cannot be known from the text */
function cdStep(dirs, name, args) {
  if (dirs === null || name !== "cd") return null;
  const target = args.find(a => !(a.text.startsWith("-") && a.text.length > 1));
  if (!target) return [...dirs, "~"];
  return target.dynamic || target.text === "-" ? null : [...dirs, target.text];
}

/* Every commit and push a command would run, and the other git commands beside them that may change what is staged.
   `dirs` on a commit or push is the list of folders to step through from the starting folder (cd targets, then -C values), or null
   when that cannot be known from the text (a variable, a subshell). */
export function classifyCommand(command) {
  let dirs = [], commits = [], pushes = [], staging = [], isIndexHidden = false;
  for (const segment of scanCommands(command)) {
    const { env, rest } = stripPrefix(segment.words);
    const setForLater = !rest.length ? env : commandName(rest[0]) === "export" ? assignedNames(rest.slice(1)) : [];   // GIT_DIR=/x on its own line, or exported
    if (setForLater.some(n => HIDES_THE_INDEX.has(n))) isIndexHidden = true;
    if (!rest.length) continue;
    const name = commandName(rest[0]);
    if (CD_COMMANDS.has(name)) { if (segment.depth === 0) dirs = cdStep(dirs, name, rest.slice(1)); continue; }
    if (name !== "git") continue;
    const git = parseGit(rest.slice(1));
    if (!git.sub) continue;
    const isKnown = segment.depth === 0 && dirs !== null && !git.dirs.some(d => d.dynamic);
    const where = isKnown ? [...dirs, ...git.dirs.map(d => d.text)] : null;
    const sub = git.sub.dynamic ? UNKNOWN_SUBCOMMAND : git.sub.text;
    if (sub === "commit") {
      const parsed = parseCommit(git.args), isHidden = git.hidden || isIndexHidden || env.some(n => HIDES_THE_INDEX.has(n));
      commits = [...commits, { dirs: where, ...parsed, reasons: [...parsed.reasons, ...(isHidden ? [REASON.hidden] : [])], messages: [...parsed.messages, ...segment.heredocs] }];
    } else if (sub === "push") pushes = [...pushes, { dirs: where, ...parsePush(git.args) }];
    else if (!LEAVES_INDEX_ALONE.has(sub)) staging = [...staging, sub];
  }
  return { commits, pushes, staging };
}

/* why the guard cannot see what the commits of a command would hold; empty when it can */
export function commitBlockers({ commits, staging }) {
  if (!commits.length) return [];
  return [...new Set([...commits.flatMap(c => c.reasons), ...staging.map(REASON.beside)])];
}

/* ---- private paths: the same list as .gitignore (a test holds the two together) ---- */

const RECORDINGS = ["m4a", "mp3", "wav", "caf", "aac", "ogg", "flac", "webm"], MODELS = ["bin", "gguf"];
const hasExtension = (path, extensions) => extensions.some(ext => path.endsWith("." + ext));
/* each rule sees the path in lower case, and as written for the few exceptions that are kept */
const PRIVATE_RULES = [
  { why: "protocols are private to each copy", test: p => p.startsWith("data/protocols/") },
  { why: "notebook entries are never committed", test: p => p.startsWith("data/entries/") },
  { why: "a private data file", test: p => p === "data/voice.json" || /^data\/[^/]*\.private\.json$/.test(p) },
  { why: "docs/ holds local notes", test: p => /(^|\/)docs\//.test(p) },
  { why: "personal settings", test: p => /(^|\/)claude\.local\.md$/.test(p) },
  { why: "local to this machine; under .claude/ only skills/, agents/ and settings.json are shared",
    test: (p, asWritten) => p.startsWith(".claude/") && !asWritten.startsWith(".claude/skills/") && !asWritten.startsWith(".claude/agents/") && asWritten !== ".claude/settings.json" },
  { why: "scratch space is never committed", test: (p, asWritten) => p.startsWith("scratch/") && asWritten !== "scratch/README.md" },
  { why: "a backup holds the whole notebook", test: p => /(^|\/)backups\//.test(p) },
  { why: "images are tracked only in demo/", test: (p, asWritten) => p.endsWith(".png") && !/^demo\/[^/]+\.png$/.test(asWritten) },
  { why: "recordings never belong in the repository", test: p => hasExtension(p, RECORDINGS) },
  { why: "speech models never belong in the repository", test: p => hasExtension(p, MODELS) },
];

export function privatePathReason(path) {
  const asWritten = String(path).replace(/\\/g, "/").replace(/^\.\//, ""), lower = asWritten.toLowerCase();
  const rule = PRIVATE_RULES.find(r => r.test(lower, asWritten));
  return rule ? rule.why : null;
}
export const judgeStagedPaths = paths => paths.map(path => ({ path, why: privatePathReason(path) })).filter(finding => finding.why !== null);

/* ---- private terms ---- */

/* lower case, accents taken off: a term matches however it is capitalised or accented */
export const fold = value => String(value).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");

/* One term per line; blank lines and lines starting with # are skipped; `entry` is the line number, which is what a finding quotes.
   A line starting with ! is not a term but a public string that a term may be part of (a public account name that contains a surname):
   a term found inside it is not a finding. Entries shorter than MIN_TERM_LENGTH would match almost anything and are counted, not used. */
export function parseTerms(fileText) {
  const lines = String(fileText).split(/\r?\n/).map((line, index) => ({ entry: index + 1, folded: fold(line.trim()) })).filter(t => t.folded && !t.folded.startsWith("#"))
    .map(t => (t.folded.startsWith(ALLOWED_MARK) ? { ...t, folded: t.folded.slice(ALLOWED_MARK.length).trim(), isAllowed: true } : { ...t, isAllowed: false }));
  const usable = lines.filter(t => t.folded.length >= MIN_TERM_LENGTH);
  return { terms: usable.filter(t => !t.isAllowed).map(({ entry, folded }) => ({ entry, folded })), allowed: usable.filter(t => t.isAllowed).map(t => t.folded), ignored: lines.length - usable.length };
}

const occurrences = (haystack, needle) => { const at = []; for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i); return at; };

/* the entries of the terms found in a text; an occurrence that lies wholly inside an allowed public string does not count */
export function matchTerms(value, terms, allowed = []) {
  const folded = fold(value);
  const covered = allowed.flatMap(publicString => occurrences(folded, publicString).map(start => ({ from: start, to: start + publicString.length })));
  const counts = (start, length) => !covered.some(span => span.from <= start && start + length <= span.to);
  return terms.filter(term => occurrences(folded, term.folded).some(start => counts(start, term.folded.length))).map(term => term.entry);
}

function headerPath(header) {
  const trimmed = header.replace(/\t$/, "");
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => ({ t: "\t", n: "\n" }[c] ?? c)) : trimmed;
  return unquoted === "/dev/null" ? null : unquoted.replace(/^b\//, "");
}

/* The added lines of a unified diff (as `git diff --dst-prefix=b/` prints it), each with its file and its line number in the new file.
   Lines are counted by the hunk headers, so an added line that itself starts with "++ " is never taken for a file header. */
export function addedLines(diffText) {
  const found = [];   // filled in place: a staged change can be tens of thousands of lines
  let path = null, oldLeft = 0, newLeft = 0, lineNumber = 0;
  for (const line of String(diffText).split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) { found.push({ path, line: lineNumber, text: line.slice(1) }); lineNumber++; newLeft--; }
      else if (line.startsWith("-")) oldLeft--;
      else if (!line.startsWith("\\")) { oldLeft--; newLeft--; lineNumber++; }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { oldLeft = Number(hunk[1] ?? 1); lineNumber = Number(hunk[2]); newLeft = Number(hunk[3] ?? 1); }
    else if (line.startsWith("+++ ")) path = headerPath(line.slice(4));
  }
  return found;
}
export const judgeAddedLines = (lines, terms, allowed = []) => lines.flatMap(({ path, line, text: added }) => matchTerms(added, terms, allowed).map(entry => ({ path, line, entry })));

/* ---- tests owed ---- */

export const isAppPath = relativePath => /^(src|tests|tools)\//.test(String(relativePath).replace(/\\/g, "/"));

/* a session id as a file name: nothing but letters, digits, _ and -, so it can never point outside its folder */
export const markerName = sessionId => String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_MARKER_NAME) || "unknown";

const FAILING_SPEC = /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/, FAILING_TAP = /^\s*not ok \d+ - (.+?)(?: # .*)?$/;
const SPEC_SUMMARY_HEADING = "failing tests:", TAP_NOT_A_FAILURE = /^\s*not ok\b.*#\s*(?:todo|skip)/i;

/* the names of the failing tests in the output of `node --test` (its spec reporter, or TAP), each once, in the order they failed */
export function failingTests(output) {
  const names = String(output).split("\n").filter(line => !TAP_NOT_A_FAILURE.test(line)).map(line => (FAILING_SPEC.exec(line) || FAILING_TAP.exec(line) || [])[1])
    .filter(name => name && name !== SPEC_SUMMARY_HEADING);
  return [...new Set(names)];
}

export function tailLines(output, count) {
  const lines = String(output).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+$/, "").split("\n");
  return lines.slice(-count).join("\n").slice(-MAX_TAIL_CHARS);
}

/* signs that the suite did not fail but could not start: Playwright or its browser is not installed, or node or npm is missing */
export const cannotRun = output => /Cannot find package 'playwright'|Executable doesn't exist|npx playwright install|\b(?:node|npm|npx): command not found|command not found: (?:node|npm|npx)\b/.test(String(output));
