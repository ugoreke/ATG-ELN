// The Claude Code hooks (tools/hooks): the guard on commits and pushes, and the pair that runs the tests after app changes.
// Every git case runs in a throwaway repository in a temporary folder, with made-up files and invented private terms; nothing here
// reads this repository's index, and the Stop hook is always given a stand-in for the test command, so the suite never runs inside itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCommands } from "../tools/hooks/shell.mjs";
import { parseHookInput, classifyCommand, commitBlockers, privatePathReason, judgeStagedPaths, parseTerms, fold, matchTerms, addedLines, judgeAddedLines,
  isAppPath, markerName, failingTests, tailLines, cannotRun, PRIVATE_BRANCH } from "../tools/hooks/lib.mjs";

const HOOKS = fileURLToPath(new URL("../tools/hooks/", import.meta.url)), ROOT = fileURLToPath(new URL("../", import.meta.url));
const GUARD = join(HOOKS, "guard-commit.mjs"), MARK = join(HOOKS, "mark-tests-owed.mjs"), STOP = join(HOOKS, "run-owed-tests.mjs");
/* git in the throwaway repositories ignores this machine's own git settings */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test Person", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test Person", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const TERMS = "zorblax\nQuibbleton Labs\n# a comment\n\nab\n";   // invented words; entry 5 is too short to be used
const words = seg => seg.words.map(w => w.text);

const tempDirs = [];
const tempDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "eln-hooks-"))); tempDirs.push(dir); return dir; };
test.after(() => tempDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (dir, path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };

/* a repository with one commit on main, and a terms file kept outside it */
function makeRepo({ archive = false } = {}) {
  const dir = tempDir(), terms = join(tempDir(), "terms.txt");
  writeFileSync(terms, TERMS);
  git(dir, "init", "-q", "-b", "main");
  put(dir, "README.md", "# Made-up project\n\nline three\n"); put(dir, "src/app.txt", "one\n");
  git(dir, "add", "README.md", "src/app.txt"); git(dir, "commit", "-q", "-m", "first");
  if (archive) git(dir, "branch", PRIVATE_BRANCH);
  return { dir, terms };
}
const runHook = (script, args, input, projectDir) => spawnSync(process.execPath, [script, ...args],
  { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: projectDir }, encoding: "utf8" });
const guard = (repo, command, { terms = repo.terms, cwd = repo.dir, project = repo.dir } = {}) =>
  runHook(GUARD, terms ? ["--terms", terms] : [], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd, session_id: "s1" }, project);
const passes = (result, note) => { assert.equal(result.status, 0, note || result.stderr); assert.equal(result.stderr, ""); };
const blocks = (result, pattern) => { assert.equal(result.status, 2, `expected a block; stdout: ${result.stdout} stderr: ${result.stderr}`); assert.match(result.stderr, pattern); };

/* ---- reading a shell command ---- */

test("the scanner splits on && ; | and newlines and keeps quoted text as one word", () => {
  const segs = scanCommands(`cd "my dir" && git commit -m 'fix: a; b && c' ; echo done | cat\nls`);
  assert.deepEqual(segs.map(words), [["cd", "my dir"], ["git", "commit", "-m", "fix: a; b && c"], ["echo", "done"], ["cat"], ["ls"]]);
  assert.ok(segs.every(s => s.depth === 0));
});

test("the scanner reads $( ) and backticks as commands, heredoc bodies as text, and drops redirection targets", () => {
  const heredoc = scanCommands(`git commit -m "$(cat <<'EOF'\nfix: handle ) and "quotes"; git add . && git commit -a\nEOF\n)" && echo ok`);
  assert.deepEqual(heredoc.map(s => words(s)[0]), ["cat", "git", "echo"], "the body of the heredoc is never read as a command");
  assert.equal(heredoc[0].depth, 1); assert.match(heredoc[0].heredocs[0], /git add \./);
  assert.match(words(heredoc[1])[3], /handle \) and "quotes"/, "the message word keeps the text it was built from");
  assert.deepEqual(scanCommands("git commit -m x > out.txt 2>&1").map(words), [["git", "commit", "-m", "x"]]);
  assert.deepEqual(scanCommands("echo `git add .` # git commit -a").map(words).sort(), [["echo", "`git add .`"], ["git", "add", "."]].sort());
  const stdin = scanCommands("git commit -F - <<EOF\nmade-up message\nEOF\necho after");
  assert.deepEqual(stdin.map(words), [["git", "commit", "-F", "-"], ["echo", "after"]]); assert.deepEqual(stdin[0].heredocs, ["made-up message\n"]);
  assert.equal(scanCommands('cd "$HOME/x"')[0].words[1].dynamic, true); assert.equal(scanCommands("cd '$HOME/x'")[0].words[1].dynamic, false);
});

test("a command is a commit only when git commit is really run", () => {
  const commits = cmd => classifyCommand(cmd).commits.length;
  for (const cmd of ["git commit -m x", "git  commit", "cd /tmp && git commit -m x", "ls; git commit -m x", "ls\ngit commit -m x", "git -C sub commit -m x",
    "git -c user.name=x commit -m y", "/usr/bin/git commit", "GIT_AUTHOR_DATE=now git commit -m x", "env A=1 git commit", "(git commit -m x)", "echo \"$(git commit -m x)\"",
    "if true; then git commit -m x; fi", "git --no-pager commit -m x"]) assert.equal(commits(cmd), 1, cmd);
  for (const cmd of ["ls -la", "echo git commit", "echo 'git commit -am x'", "git log --grep commit", "git status", "grep -r \"git commit\" .", "git config alias.ci commit",
    "git commit-tree abc", "gitk commit", "git show commit"]) assert.equal(commits(cmd), 0, cmd);
  assert.equal(classifyCommand('git commit -m "docs: say git add first, then git commit -a is refused"').staging.length, 0, "words inside the message are not commands");
});

test("where a commit runs is worked out from cd and -C, or left unknown", () => {
  const dirs = cmd => classifyCommand(cmd).commits[0].dirs;
  assert.deepEqual(dirs("git commit -m x"), []);
  assert.deepEqual(dirs("cd a/b && git -C ../c commit -m x"), ["a/b", "../c"]);
  assert.deepEqual(dirs("cd ~ ; git commit"), ["~"]);
  assert.equal(dirs('cd "$SOMEWHERE" && git commit'), null); assert.equal(dirs("git -C $(pwd) commit"), null);
  assert.equal(dirs("(cd x && git commit -m y)"), null, "inside a subshell the folder is not followed");
  assert.equal(dirs("cd - && git commit"), null); assert.equal(dirs("pushd x && git commit"), null);
  assert.deepEqual(dirs("(cd elsewhere && ls); git commit -m x"), [], "a cd inside a subshell does not move the commands after it");
});

test("a commit that stages as it runs is refused: -a, a path, --patch, another git command beside it", () => {
  const why = cmd => commitBlockers(classifyCommand(cmd));
  for (const cmd of ["git commit -a -m x", "git commit -am x", "git commit --all", "git commit -sam x", "git commit --al -m x", "git commit README.md -m x",
    "git commit -m x -- a.txt", "git commit -p", "git commit --interactive", "git commit -o a.txt", "git commit --include a.txt", "git add a.txt && git commit -m x",
    "git commit -m x; git add .", "git rm old.txt && git commit -m x", "git stash pop; git commit -m x", "git add -A\ngit commit -m x", "git --git-dir=/x/.git commit -m x",
    "GIT_INDEX_FILE=/tmp/i git commit -m x", "git reset HEAD~1 && git commit -m x", "git $SUB && git commit -m x", "git commit -m x \"$(git add .)\""]) assert.ok(why(cmd).length > 0, cmd);
  for (const cmd of ["git commit -m x", "git commit -ma", "git commit -m 'a b' --amend", "git commit --message=x -q", "git status && git commit -m x", "git commit -m x && git push",
    "git diff --cached --stat; git commit -F msg.txt", "git commit -m x && git log --oneline -1", "git commit -S -m x", "git commit --author 'A B <a@example.invalid>' -m x",
    "git commit -m x 2>&1 | tail -3", "ls -la"]) assert.deepEqual(why(cmd), [], cmd);
  assert.match(why("git commit -am x").join("\n"), /-a/); assert.match(why("git add a && git commit -m x").join("\n"), /git add/);
});

test("the message of a commit is read from -m, --message and a heredoc; --amend is seen", () => {
  const one = cmd => classifyCommand(cmd).commits[0];
  assert.deepEqual(one("git commit -m first -m 'second part' --message=third").messages, ["first", "second part", "third"]);
  assert.deepEqual(one("git commit -qmjoined").messages, ["joined"]);
  assert.match(one("git commit -m \"$(cat <<'EOF'\nmade-up body\nEOF\n)\"").messages.join("\n"), /made-up body/);
  assert.match(one("git commit -F - <<EOF\nfrom stdin\nEOF").messages.join("\n"), /from stdin/);
  assert.deepEqual(one("git commit -F notes/msg.txt").messageFiles, ["notes/msg.txt"]);
  assert.equal(one("git commit --amend --no-edit").amend, true); assert.equal(one("git commit -m x").amend, false);
});

test("a push is read for --all, --mirror and what each refspec sends", () => {
  const push = cmd => classifyCommand(cmd).pushes[0];
  assert.deepEqual(classifyCommand("git status").pushes, []);
  assert.equal(push("git push --all origin").everything, true); assert.equal(push("git push origin --mirror").everything, true); assert.equal(push("git push --branches").everything, true);
  assert.deepEqual([push("git push").everything, push("git push").sources, push("git push").named], [false, ["HEAD"], []]);
  assert.deepEqual(push("git push -u origin main").sources, ["main"]);
  assert.deepEqual(push("git push origin +feature:refs/heads/other HEAD:main").sources, ["feature", "HEAD"]);
  assert.deepEqual(push(`git push origin ${PRIVATE_BRANCH}`).named, [PRIVATE_BRANCH]);
  assert.deepEqual(push(`git push origin refs/heads/${PRIVATE_BRANCH}:refs/heads/backup`).named, [`refs/heads/${PRIVATE_BRANCH}:refs/heads/backup`]);
  assert.deepEqual(push(`git push -o ci.skip origin main:${PRIVATE_BRANCH}`).named, [`main:${PRIVATE_BRANCH}`]);
  assert.deepEqual(push(`git push origin --delete ${PRIVATE_BRANCH}`), { dirs: [], everything: false, sources: [], named: [], unclear: [] }, "deleting a remote branch sends nothing");
  assert.equal(push('git push origin "refs/heads/*:refs/heads/*"').everything, true, "a pattern sends every branch it matches");
  assert.deepEqual(push("git push origin $(git branch --show-current)").unclear, ["$(git branch --show-current)"]);
  assert.deepEqual(push('git push origin "$BRANCH" main').sources, ["main"]);
  assert.deepEqual(push(`git push origin :${PRIVATE_BRANCH}`).sources, []);
  assert.deepEqual(push("git push origin not-private-archive-notes").named, [], "only the branch itself, not a name that contains it");
  assert.deepEqual(push("git -C ../other push origin main").dirs, ["../other"]);
});

test("commands written to slip past a quick look are still read for what they run", () => {
  const why = cmd => commitBlockers(classifyCommand(cmd)), one = cmd => classifyCommand(cmd).commits[0];
  assert.ok(why('git com""mit -a -m x').length > 0); assert.ok(why("GIT commit -am x").length > 0, "git is found whatever its case");
  assert.equal(classifyCommand("git pu''sh --all").pushes[0].everything, true);
  assert.ok(why("x=$((1<<2))\ngit commit -a -m x").length > 0, "<< in arithmetic is not a heredoc that swallows the next lines");
  assert.ok(why("echo $((1<<2))\ngit add -A && git commit -m x").length > 0);
  assert.ok(why("export GIT_DIR=/x/.git; git commit -m x").length > 0); assert.ok(why("GIT_INDEX_FILE=/tmp/i\ngit commit -m x").length > 0);
  assert.deepEqual(one("git commit --mess=abc --trailer 'k: v' --fil notes.txt").messages, ["abc", "k: v"]); assert.deepEqual(one("git commit --fil notes.txt").messageFiles, ["notes.txt"]);
  assert.deepEqual(why("git commit -m x && git ls-remote origin"), []); assert.deepEqual(why("git commit --allow-empty --no-edit -m x"), []);
  assert.throws(() => scanCommands("(".repeat(5000) + "git commit"), /nests deeper/);
  assert.equal(scanCommands("echo " + "word ".repeat(50000)).length, 1, "a very long command is read in good time");
  assert.deepEqual(failingTests("not ok 3 - later # TODO not yet\nnot ok 4 - skipped # SKIP\nnot ok 5 - real\n"), ["real"]);
});

test("guard: what it cannot read it stops, when the command mentions a commit or a push", () => {
  const repo = makeRepo({ archive: true });
  blocks(guard(repo, 'git com""mit -am x'), /Stage first/); blocks(guard(repo, "git pu''sh --all"), new RegExp(PRIVATE_BRANCH));
  blocks(guard(repo, "(".repeat(20000) + "git commit -m x"), /guard itself failed/);
  passes(guard(repo, "(".repeat(20000) + "ls"), "a command it cannot read that names no commit or push is not held up");
  blocks(guard(repo, "cd no-such-folder; git commit -am x"), /Stage first/);
  blocks(guard(repo, 'git push origin "refs/heads/*:refs/heads/*"'), /every branch/);
  blocks(guard(repo, "git push origin $(git branch --show-current)"), /cannot tell what this push sends/);
  const plain = makeRepo();
  passes(guard(plain, "git push origin $(git branch --show-current)"), "without the private branch there is nothing to protect");
  put(repo.dir, "data/entries/zorblax.json", "{}\n"); git(repo.dir, "add", "-f", "data/entries/zorblax.json");
  const result = guard(repo, "git commit -m x");
  blocks(result, /private path staged: file 1 of/); assert.doesNotMatch(result.stderr, /zorblax/i, "a private path that holds a term is not printed either");
  git(repo.dir, "config", "core.fsmonitor", "touch fsmonitor-ran; false");
  blocks(guard(repo, "git commit -m x"), /private path staged/); assert.equal(existsSync(join(repo.dir, "fsmonitor-ran")), false, "a program named in the repository's own git settings is not run");
});

/* ---- private paths ---- */

const PRIVATE_SAMPLES = ["data/protocols/x.md", "data/protocols/sub/y.json", "data/entries/abc.json", "data/voice.json", "data/mine.private.json", "docs/decisions.md", "tools/docs/x.md",
  "CLAUDE.local.md", "sub/CLAUDE.local.md", ".claude/settings.local.json", ".claude/local/private-terms.txt", ".claude/worktrees/x/a.txt", "scratch/260310_photos/a.jpg", "scratch/note.txt",
  "photo.png", "tests/fixtures/x.png", "demo/sub/x.png", "rec/memo.m4a", "a.mp3", "a.wav", "a.caf", "a.aac", "a.ogg", "a.flac", "a.webm", "models/ggml-base.bin", "m.gguf",
  "backups/260310-1800/manifest.json", "backups/260310-1800/documents/logs/daily.json", "backups/assets/made-up-asset.jpg", "sub/backups/listing.json",
  "outputs/260310_master-mix.xlsx", "outputs/260310_gel/lane-1.jpg", "outputs/sub/README.md", "references/index.csv"];
const PUBLIC_SAMPLES = ["README.md", "CLAUDE.md", "src/index.html", "data/glossary.json", "data/settings.json", "data/private.json", ".claude/settings.json", ".claude/skills/eln-audit/SKILL.md",
  ".claude/agents/photo-reader.md", "scratch/README.md", "demo/entry.png", "tests/fixtures/transfer-run/a.jpg", "tools/hooks/lib.mjs", "package.json", ".gitignore", "mydocs/x.md", "docs.md",
  "tools/backup/backup.mjs", "tests/backup-tool.test.mjs", ".claude/skills/eln-backup/SKILL.md", "mybackups/x.json", "backups.md", "outputs/README.md", "myoutputs/x.txt", "sub/outputs/x.txt", "tools/references/x.md"];

test("private paths are named with a reason; paths that belong in the repository are not", () => {
  for (const path of PRIVATE_SAMPLES) assert.equal(typeof privatePathReason(path), "string", path);
  for (const path of PUBLIC_SAMPLES) assert.equal(privatePathReason(path), null, path);
  assert.equal(typeof privatePathReason("Docs/Notes.md"), "string", "a different case does not slip through");
  assert.equal(typeof privatePathReason("./docs/x.md"), "string");
  assert.deepEqual(judgeStagedPaths(["README.md", "docs/a.md", "src/x", "data/voice.json"]).map(f => f.path), ["docs/a.md", "data/voice.json"]);
});

test("the list of private paths agrees with this repository's .gitignore", () => {
  const dir = tempDir();
  git(dir, "init", "-q"); writeFileSync(join(dir, ".gitignore"), readFileSync(join(ROOT, ".gitignore")));
  const ignored = path => spawnSync("git", ["-C", dir, "check-ignore", "-q", "--no-index", path], { env: GIT_ENV }).status === 0;
  for (const path of [...PRIVATE_SAMPLES, ...PUBLIC_SAMPLES]) assert.equal(privatePathReason(path) !== null, ignored(path), `${path}: the guard and .gitignore disagree`);
});

/* ---- private terms ---- */

test("terms are read one per line; blank lines, comments and very short entries are left out", () => {
  const { terms, ignored } = parseTerms(TERMS);
  assert.deepEqual(terms, [{ entry: 1, folded: "zorblax" }, { entry: 2, folded: "quibbleton labs" }]); assert.equal(ignored, 1);
  assert.deepEqual(parseTerms("").terms, []); assert.deepEqual(parseTerms("  Zörblax  \r\n").terms, [{ entry: 1, folded: "zorblax" }]);
  assert.equal(fold("ZÖRBLAX İstanbul"), "zorblax istanbul");
  assert.deepEqual(matchTerms("made by Zorblax at QUIBBLETON labs", terms), [1, 2]); assert.deepEqual(matchTerms("nothing here", terms), []);
});

test("a line starting with ! is a public string a term may be part of: the term is not a finding inside it, and still is anywhere else", () => {
  const { terms, allowed, ignored } = parseTerms("zorblax\n!ZorblaxHub\nzorblaxhub@example.invalid\n!ab\n");
  assert.deepEqual(allowed, ["zorblaxhub"]); assert.equal(ignored, 1); assert.deepEqual(terms.map(t => t.entry), [1, 3]);
  assert.deepEqual(matchTerms("see https://hub.example/ZorblaxHub/project", terms, allowed), []);
  assert.deepEqual(matchTerms("zorblaxhub wrote it, says Zorblax", terms, allowed), [1], "a second, bare occurrence still counts");
  assert.deepEqual(matchTerms("write to zorblaxhub@example.invalid", terms, allowed), [3], "a longer term around the public string still counts");
  assert.deepEqual(matchTerms("see zorblaxhub", terms), [1], "without the ! line it is a finding");
  assert.deepEqual(judgeAddedLines([{ path: "a.md", line: 1, text: "hub.example/zorblaxhub" }, { path: "a.md", line: 2, text: "zorblax" }], terms, allowed), [{ path: "a.md", line: 2, entry: 1 }]);
  const repo = makeRepo(), file = join(tempDir(), "terms.txt"); writeFileSync(file, "zorblax\n!zorblaxhub\n");
  put(repo.dir, "README.md", "# Made-up project\n\nline three\nsee https://hub.example/zorblaxhub/project\n"); git(repo.dir, "add", "README.md");
  passes(guard(repo, "git commit -m 'docs: link to zorblaxhub'", { terms: file }));
  put(repo.dir, "README.md", "# Made-up project\n\nline three\nsee https://hub.example/zorblaxhub/project\nby zorblax\n"); git(repo.dir, "add", "README.md");
  blocks(guard(repo, "git commit -m x", { terms: file }), /README\.md:5/);
});

test("added lines are taken from a diff with their file and line number, and only added lines", () => {
  const diff = ["diff --git a/README.md b/README.md", "index 111..222 100644", "--- a/README.md", "+++ b/README.md", "@@ -2,0 +3,2 @@ heading", "+first added", "+++ b/not-a-header.txt",
    "@@ -9 +11 @@", "-old zorblax line", "+new line", "diff --git a/my file.txt b/my file.txt", "new file mode 100644", "--- /dev/null", "+++ b/my file.txt\t", "@@ -0,0 +1 @@", "+only", "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-zorblax was here", ""].join("\n");
  assert.deepEqual(addedLines(diff), [{ path: "README.md", line: 3, text: "first added" }, { path: "README.md", line: 4, text: "++ b/not-a-header.txt" },
    { path: "README.md", line: 11, text: "new line" }, { path: "my file.txt", line: 1, text: "only" }]);
  const { terms } = parseTerms(TERMS);
  assert.deepEqual(judgeAddedLines(addedLines(diff), terms), [], "a removed line that held a term is not a finding");
  assert.deepEqual(judgeAddedLines([{ path: "a.md", line: 7, text: "thanks, ZORBLAX" }, { path: "a.md", line: 8, text: "fine" }], terms), [{ path: "a.md", line: 7, entry: 1 }]);
});

/* ---- the guard, end to end, in a throwaway repository ---- */

test("guard: a clean commit passes, silently", () => {
  const repo = makeRepo();
  put(repo.dir, "src/app.txt", "one\ntwo\n"); git(repo.dir, "add", "src/app.txt");
  const terms = join(tempDir(), "terms.txt"); writeFileSync(terms, "zorblax\nQuibbleton Labs\n");
  const result = guard(repo, 'git commit -m "feat: a second line"', { terms });
  passes(result); assert.equal(result.stdout, "");
  passes(guard(repo, "git commit -m \"$(cat <<'EOF'\nfeat: a second line\n\nwith a body; and (parens\nEOF\n)\"", { terms }));
  const withShortEntry = guard(repo, "git commit -m x");
  passes(withShortEntry); assert.match(JSON.parse(withShortEntry.stdout).systemMessage, /1 entry .* shorter than 3 characters was not used/, "an entry too short to use is said, not dropped in silence");
});

test("guard: a forced add of a private path blocks and names the path", () => {
  const repo = makeRepo();
  put(repo.dir, "docs/notes.md", "made-up notes\n"); put(repo.dir, "data/entries/e1.json", "{}\n"); put(repo.dir, ".claude/settings.local.json", "{}\n");
  git(repo.dir, "add", "-f", "docs/notes.md", "data/entries/e1.json", ".claude/settings.local.json");
  const result = guard(repo, "git commit -m x");
  blocks(result, /docs\/notes\.md/); assert.match(result.stderr, /data\/entries\/e1\.json/); assert.match(result.stderr, /\.claude\/settings\.local\.json/);
  passes(guard(repo, "ls -la"), "other commands are not held up by what is staged");
});

test("guard: an added line with a private term blocks, naming file and line but never the term", () => {
  const repo = makeRepo();
  put(repo.dir, "README.md", "# Made-up project\n\nline three\nthanks to ZÖRBLAX for the idea\n"); git(repo.dir, "add", "README.md");
  const result = guard(repo, "git commit -m x");
  blocks(result, /README\.md:4/); assert.match(result.stderr, /entry 1\b/); assert.doesNotMatch(result.stderr, /z[oö]rblax/i);
  put(repo.dir, "README.md", "# Made-up project\n\nline three\n"); git(repo.dir, "add", "README.md");
  put(repo.dir, "README.md", "unstaged: zorblax\n");
  passes(guard(repo, "git commit --allow-empty -m x"), "a term in a change that is not staged is not this commit's");
});

test("guard: a term in a staged file's name or in the commit message blocks", () => {
  const repo = makeRepo();
  put(repo.dir, "notes/zorblax-plan.txt", "fine\n"); git(repo.dir, "add", "notes/zorblax-plan.txt");
  const named = guard(repo, "git commit -m x");
  blocks(named, /name of a staged file/); assert.doesNotMatch(named.stderr, /zorblax/i);
  git(repo.dir, "rm", "-q", "--cached", "notes/zorblax-plan.txt");
  blocks(guard(repo, "git commit --allow-empty -m 'for Quibbleton Labs'"), /commit message/);
  blocks(guard(repo, "git commit --allow-empty -m \"$(cat <<'EOF'\nfix: x\n\nasked by zorblax\nEOF\n)\""), /commit message/);
  put(repo.dir, "msg.txt", "from a file, for Zorblax\n");
  blocks(guard(repo, "git commit --allow-empty -F msg.txt"), /commit message/);
});

test("guard: with no terms file the paths are still checked, and one line says terms were not", () => {
  const repo = makeRepo();
  put(repo.dir, "README.md", "# Made-up project\n\nzorblax\n"); git(repo.dir, "add", "README.md");
  const result = guard(repo, "git commit -m x", { terms: join(repo.dir, "no-such-file.txt") });
  passes(result); assert.match(JSON.parse(result.stdout).systemMessage, /terms were not checked/);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const byDefault = guard(repo, "git commit -m x", { terms: null });
  passes(byDefault); assert.match(JSON.parse(byDefault.stdout).systemMessage, /\.claude\/local\/private-terms\.txt/, "the default place is named");
  put(repo.dir, ".claude/local/private-terms.txt", TERMS);
  blocks(guard(repo, "git commit -m x", { terms: null }), /README\.md:3/);
  put(repo.dir, "docs/a.md", "x\n"); git(repo.dir, "add", "-f", "docs/a.md");
  blocks(guard(repo, "git commit -m x", { terms: join(repo.dir, "no-such-file.txt") }), /docs\/a\.md/);
});

test("guard: staging and committing in one command blocks, with the way to do it instead", () => {
  const repo = makeRepo();
  for (const cmd of ["git commit -am x", "git commit -a -m x", "git add README.md && git commit -m x", "git commit README.md -m x"]) {
    const result = guard(repo, cmd);
    blocks(result, /Stage first, by name, in its own command/); assert.match(result.stderr, /commit in the next/);
  }
  passes(guard(repo, 'git commit --allow-empty -m "docs: git add first, then git commit -a is refused"'));
});

test("guard: a staged deletion of a private file passes, and an amend is checked as a whole", () => {
  const repo = makeRepo();
  put(repo.dir, "docs/old.md", "x\n"); git(repo.dir, "add", "-f", "docs/old.md"); git(repo.dir, "commit", "-q", "-m", "by hand");
  git(repo.dir, "rm", "-q", "--cached", "docs/old.md");
  passes(guard(repo, "git commit -m 'chore: take a private file out'"));
  git(repo.dir, "reset", "-q");
  blocks(guard(repo, "git commit --amend -m again"), /docs\/old\.md/);
  const other = makeRepo();
  put(other.dir, "README.md", "zorblax\n"); git(other.dir, "add", "README.md"); git(other.dir, "commit", "-q", "-m", "by hand");
  passes(guard(other, "git commit --allow-empty -m next"), "what is already committed is not this commit's");
  blocks(guard(other, "git commit --amend --no-edit"), /README\.md:1/);
});

test("guard: only this project's repository is guarded, wherever the command is run from", () => {
  const repo = makeRepo(), foreign = makeRepo(), elsewhere = tempDir();
  put(repo.dir, "docs/a.md", "x\n"); git(repo.dir, "add", "-f", "docs/a.md");
  passes(guard(repo, `git -C ${foreign.dir} commit -am x`), "another repository is none of the guard's business");
  passes(guard(repo, `cd ${foreign.dir} && git commit -am x`));
  blocks(guard(repo, `git -C ${repo.dir} commit -m x`, { cwd: elsewhere }), /docs\/a\.md/);
  blocks(guard(repo, `cd ${repo.dir} && git commit -m x`, { cwd: elsewhere }), /docs\/a\.md/);
  blocks(guard(repo, 'cd "$SOMEWHERE" && git commit -m x', { cwd: elsewhere }), /docs\/a\.md/);
  mkdirSync(join(repo.dir, "src/deep"), { recursive: true });
  blocks(guard(repo, "git commit -m x", { cwd: join(repo.dir, "src/deep") }), /docs\/a\.md/);
});

test("guard: a push of the private branch blocks, by name, through --all or --mirror, or under another name", () => {
  const repo = makeRepo({ archive: true });
  for (const cmd of [`git push origin ${PRIVATE_BRANCH}`, "git push --all", "git push --mirror origin", `git push origin ${PRIVATE_BRANCH}:refs/heads/backup`, `git push -u origin HEAD:${PRIVATE_BRANCH}`])
    blocks(guard(repo, cmd), new RegExp(PRIVATE_BRANCH));
  git(repo.dir, "checkout", "-q", "--orphan", "public"); git(repo.dir, "commit", "-q", "--allow-empty", "-m", "public start");
  passes(guard(repo, "git push origin public")); passes(guard(repo, "git push")); passes(guard(repo, "git push -u origin HEAD"));
  passes(guard(repo, "git commit --allow-empty -m x && git push origin public"));
  git(repo.dir, "branch", "copy", PRIVATE_BRANCH);
  blocks(guard(repo, "git push origin copy"), /copy/);
  git(repo.dir, "checkout", "-q", PRIVATE_BRANCH);
  blocks(guard(repo, "git push"), new RegExp(PRIVATE_BRANCH)); blocks(guard(repo, "git push origin HEAD"), new RegExp(PRIVATE_BRANCH));
  const plain = makeRepo();
  passes(guard(plain, "git push --all"), "a copy without the private branch is not held up");
});

test("guard: commands that are not a commit or a push pass at once, and input it cannot read is handled", () => {
  const repo = makeRepo();
  for (const cmd of ["ls -la", "npm test", "git status", "echo 'git commit -am x'", "git log --oneline | grep push"]) { const r = guard(repo, cmd); passes(r, cmd); assert.equal(r.stdout, ""); }
  passes(runHook(GUARD, [], "not json at all", repo.dir));
  blocks(runHook(GUARD, [], "{ broken json: git commit -am x", repo.dir), /could not read/);
  passes(runHook(GUARD, [], { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/x/commit.txt", content: "git commit -am x" }, cwd: repo.dir }, repo.dir));
  const notRepo = tempDir();
  passes(guard(repo, "git commit -am x", { cwd: notRepo, project: notRepo }), "a folder that is not a repository has nothing to guard");
});

/* ---- tests owed ---- */

test("hook input is read into the fields the hooks use, and bad input is refused clearly", () => {
  assert.deepEqual(parseHookInput(JSON.stringify({ hook_event_name: "Stop", session_id: "abc", cwd: "/x", stop_hook_active: true })),
    { event: "Stop", sessionId: "abc", cwd: "/x", toolName: "", command: "", filePath: "", stopHookActive: true });
  assert.equal(parseHookInput(JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/x/a.ipynb" } })).filePath, "/x/a.ipynb");
  assert.equal(parseHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })).command, "ls");
  assert.equal(parseHookInput(JSON.stringify({ stop_hook_active: "yes" })).stopHookActive, false, "only a real true counts");
  assert.throws(() => parseHookInput("nope"), /not valid JSON/); assert.throws(() => parseHookInput("[1]"), /not an object/); assert.throws(() => parseHookInput(""), /empty/);
});

test("app paths and marker names", () => {
  for (const p of ["src/index.html", "tests/app.test.mjs", "tools/hooks/lib.mjs"]) assert.equal(isAppPath(p), true, p);
  for (const p of ["README.md", "CLAUDE.md", "data/glossary.json", "../src/x", "/abs/src/x", "srcx/a", ".claude/settings.json", "scratch/tests/x", ""]) assert.equal(isAppPath(p), false, p);
  assert.equal(markerName("ad88b349-b538-47ea"), "ad88b349-b538-47ea");
  assert.equal(markerName("../../etc/passwd"), "______etc_passwd"); assert.equal(markerName(""), "unknown"); assert.equal(markerName(undefined), "unknown");
  assert.equal(markerName("x".repeat(500)).length, 80);
});

const owedPath = (project, session = "s1") => join(project, ".claude/local/tests-owed", session);
const edit = (project, tool, toolInput, session = "s1") => runHook(MARK, [], { hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, cwd: project, session_id: session }, project);

test("after an edit under src/, tests/ or tools/ the tests are owed, per session; other edits owe nothing", () => {
  const project = tempDir();
  passes(edit(project, "Write", { file_path: join(project, "README.md"), content: "x" })); assert.equal(existsSync(owedPath(project)), false);
  passes(edit(project, "Edit", { file_path: join(tempDir(), "src/elsewhere.txt") })); assert.equal(existsSync(owedPath(project)), false, "a file outside the project owes nothing");
  passes(edit(project, "Edit", { file_path: join(project, "src/index.html"), old_string: "a", new_string: "b" }));
  assert.equal(readFileSync(owedPath(project), "utf8"), "src/index.html\n");
  passes(edit(project, "MultiEdit", { file_path: "tests/app.test.mjs" })); passes(edit(project, "NotebookEdit", { notebook_path: join(project, "tools/x.ipynb") }));
  assert.equal(readFileSync(owedPath(project), "utf8"), "src/index.html\ntests/app.test.mjs\ntools/x.ipynb\n");
  passes(edit(project, "Write", { file_path: join(project, "tools/a.mjs") }, "../../outside")); assert.equal(existsSync(owedPath(project, "______outside")), true);
  assert.equal(existsSync(join(project, ".claude/outside")), false, "a session id cannot place the marker elsewhere");
  passes(runHook(MARK, [], "not json", project), "bad input never stops an edit");
});

/* stand-ins for `npm test`: each is a tiny script the Stop hook is told to run instead */
function fakeCommand(body) { const file = join(tempDir(), "fake.mjs"); writeFileSync(file, body); return [process.execPath, file]; }
const FAIL_OUTPUT = "✔ a passing case (1.2ms)\n✖ a made-up failing case: with (parens) (0.37ms)\n▶ outer\n  ✖ inner fails (0.04ms)\n✖ outer (0.14ms)\nℹ tests 4\nℹ pass 1\nℹ fail 3\n\n✖ failing tests:\n\n" +
  "test at a.test.mjs:4:1\n✖ a made-up failing case: with (parens) (0.37ms)\n  AssertionError: 1 !== 2\n      at made-up (file:///x/a.test.mjs:4:75)\nLAST LINE OF OUTPUT\n";
const stop = (project, command, { active = false, session = "s1", limit } = {}) => runHook(STOP, [...(limit ? ["--time-limit", String(limit)] : []), "--test-command", ...command],
  { hook_event_name: "Stop", session_id: session, cwd: project, stop_hook_active: active }, project);
const owe = (project, session = "s1") => { mkdirSync(dirname(owedPath(project, session)), { recursive: true }); writeFileSync(owedPath(project, session), "src/index.html\n"); };

test("failing test names, the tail and the cannot-run signs are read from the output", () => {
  assert.deepEqual(failingTests(FAIL_OUTPUT), ["a made-up failing case: with (parens)", "inner fails", "outer"]);
  assert.deepEqual(failingTests("ok 1 - fine\nnot ok 2 - a tap failure\n  not ok 1 - nested tap # comment\n"), ["a tap failure", "nested tap"]);
  assert.deepEqual(failingTests("all good\n"), []);
  assert.equal(tailLines("a\nb\nc\nd\n", 2), "c\nd"); assert.equal(tailLines("\u001b[31mred\u001b[0m\n", 5), "red"); assert.ok(tailLines("x".repeat(9000), 5).length <= 3000);
  assert.equal(cannotRun("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from /x/tests/helpers.mjs"), true);
  assert.equal(cannotRun("browserType.launch: Executable doesn't exist at /x/chromium\nplease run: npx playwright install"), true);
  assert.equal(cannotRun("sh: node: command not found"), true); assert.equal(cannotRun(FAIL_OUTPUT), false);
});

test("stop: nothing owed means nothing runs", () => {
  const project = tempDir(), witness = join(project, "ran.txt");
  const result = stop(project, fakeCommand(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(witness)}, "ran");`));
  passes(result); assert.equal(result.stdout, ""); assert.equal(existsSync(witness), false);
  owe(project, "another-session");
  passes(stop(project, fakeCommand(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(witness)}, "ran");`)));
  assert.equal(existsSync(witness), false, "another session's edits are not this session's to test");
});

test("stop: tests owed and passing clears the marker and says nothing", () => {
  const project = tempDir(); owe(project);
  const result = stop(project, fakeCommand(`console.log("✔ fine (1ms)"); console.log(process.cwd());`));
  passes(result); assert.equal(result.stdout, ""); assert.equal(existsSync(owedPath(project)), false);
});

test("stop: the tests run in the project folder, and an edit made while they ran keeps them owed", () => {
  const project = tempDir(); owe(project);
  const out = join(project, "cwd.txt");
  passes(stop(project, fakeCommand(`import { appendFileSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, process.cwd()); appendFileSync(${JSON.stringify(owedPath(project))}, "tests/later.mjs\\n");`)));
  assert.equal(realpathSync(readFileSync(out, "utf8")), project);
  assert.equal(readFileSync(owedPath(project), "utf8"), "src/index.html\ntests/later.mjs\n");
});

test("stop: failing tests block the stop once, with the failing names and the end of the output", () => {
  const project = tempDir(); owe(project);
  const failing = fakeCommand(`process.stdout.write(${JSON.stringify(FAIL_OUTPUT)}); process.stderr.write("on stderr\\n"); process.exit(1);`);
  const result = stop(project, failing);
  blocks(result, /a made-up failing case: with \(parens\)/); assert.match(result.stderr, /inner fails/); assert.match(result.stderr, /LAST LINE OF OUTPUT/); assert.match(result.stderr, /3 failing/);
  assert.equal(result.stdout, ""); assert.equal(existsSync(owedPath(project)), true, "the tests stay owed");
  const again = stop(project, failing, { active: true });
  passes(again, "when the stop was already held once it is let through"); assert.match(JSON.parse(again.stdout).systemMessage, /still failing/);
  assert.match(JSON.parse(again.stdout).systemMessage, /inner fails/); assert.equal(existsSync(owedPath(project)), true);
  const fixed = stop(project, fakeCommand(`console.log("ok");`), { active: true });
  passes(fixed); assert.equal(fixed.stdout, ""); assert.equal(existsSync(owedPath(project)), false, "a fix on the second try clears the marker");
});

test("stop: a suite that cannot run says so in one line, points to npm run setup, and does not block", () => {
  const project = tempDir(); owe(project);
  for (const command of [[join(project, "no-such-program")], fakeCommand(`console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from x"); process.exit(1);`)]) {
    const result = stop(project, command);
    passes(result); const message = JSON.parse(result.stdout).systemMessage;
    assert.match(message, /npm run setup/); assert.equal(message.includes("\n"), false); assert.equal(existsSync(owedPath(project)), true);
  }
  const slow = stop(project, fakeCommand(`setTimeout(() => {}, 60000);`), { limit: 1 });
  passes(slow); assert.match(JSON.parse(slow.stdout).systemMessage, /did not finish/); assert.equal(existsSync(owedPath(project)), true);
});

/* ---- the registration ---- */

test(".claude/settings.json registers the three hooks with scripts that exist", () => {
  const { hooks } = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const only = event => { assert.equal(hooks[event].length, 1, event); assert.equal(hooks[event][0].hooks.length, 1, event); return { matcher: hooks[event][0].matcher, ...hooks[event][0].hooks[0] }; };
  const script = entry => { const m = /^node "\$CLAUDE_PROJECT_DIR\/(tools\/hooks\/[a-z-]+\.mjs)"$/.exec(entry.command); assert.ok(m, entry.command); assert.ok(existsSync(join(ROOT, m[1])), m[1]); return m[1]; };
  const pre = only("PreToolUse"), post = only("PostToolUse"), stopEntry = only("Stop");
  assert.deepEqual([pre.matcher, pre.type, script(pre)], ["Bash", "command", "tools/hooks/guard-commit.mjs"]);
  assert.deepEqual([post.matcher, post.type, script(post)], ["Edit|Write|MultiEdit|NotebookEdit", "command", "tools/hooks/mark-tests-owed.mjs"]);
  assert.deepEqual([stopEntry.matcher, stopEntry.type, script(stopEntry)], [undefined, "command", "tools/hooks/run-owed-tests.mjs"]);
  assert.ok(stopEntry.timeout >= 600, "the full suite takes about 220 s; the Stop hook needs room to spare");
});
