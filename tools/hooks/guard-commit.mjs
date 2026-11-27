#!/usr/bin/env node
// Claude Code hook (PreToolUse, matcher Bash): keeps private data out of commits and the private branch out of pushes.
// It reads the hook's JSON on stdin and acts only when the command runs `git commit` or `git push` in this project's repository;
// for anything else it exits 0 at once. Exit 2 stops the command and the text on stderr tells the session why.
//
//   node tools/hooks/guard-commit.mjs [--terms <file>]      (the project is $CLAUDE_PROJECT_DIR, or the folder this script lives in)
//
// A commit is stopped when
//   - a staged path is private (the list in lib.mjs, the same as .gitignore: a forced add of an ignored file);
//   - an added line of the staged change, the name of a staged file, or the commit message (-m, a heredoc, -F <file>) holds a private
//     term. Terms are read from .claude/local/private-terms.txt, one per line, which is git-ignored and exists only on a machine
//     whose owner made it. Without that file only paths are checked and one line says so. A finding names the file, the line and
//     the entry number in the terms file, never the term or the line itself;
//   - the command stages and commits in one go (-a, a path, --patch, or another git command that may change the index beside the
//     commit): the hook runs before the command and cannot see what it would stage.
// With --amend the whole amended commit is checked, not only what was staged since.
// A push is stopped when it would send the branch private-archive: by name, through --all, --mirror, --branches or a pattern
// (refs/heads/*), as a branch or HEAD that contains its history, or when a refspec is worked out only as the command runs ($(...)).
// A copy of the repository without that branch is never held up.
// A command that mentions a commit or a push and that the guard cannot read (nested too deep, too long) is stopped as well.
//
// What it does not catch:
//   - a commit message piped in (`... | git commit -F -`); a message from a heredoc is read;
//   - a commit or push run through eval, sh -c, xargs, a git alias, a script, a Makefile or an npm script, or with `git` or its
//     subcommand held in a variable; commits made by merge, cherry-pick, revert, rebase, am or stash;
//   - a command other than git that stages files in the same command as the commit (a script that runs git add);
//   - binary files (their content is not read), a message typed in an editor, the author name and email git records;
//   - tags that point into private-archive (push --tags), a push set up in git's own config (remote.<name>.push, mirror);
//   - another session staging a file between this check and the commit;
//   - anything committed or pushed from a terminal outside Claude Code: hooks only see the session's own commands.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookInput, classifyCommand, commitBlockers, judgeStagedPaths, parseTerms, matchTerms, addedLines, judgeAddedLines, PRIVATE_BRANCH, LOCAL_DIR, TERMS_FILE,
  MIN_TERM_LENGTH } from "./lib.mjs";

const EXIT_BLOCK = 2, MAX_COMMAND_CHARS = 200000, GIT_TIMEOUT_MS = 20000, MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024, MAX_MESSAGE_FILE_BYTES = 1024 * 1024;
const PRIVATE_REF = `refs/heads/${PRIVATE_BRANCH}`;
const HELP = {
  staging: "The guard runs before the command and cannot see what it would stage. Stage first, by name, in its own command (git add <file> ...), then commit in the next command.",
  content: "Unstage what does not belong (git restore --staged <path>) or change the line or the message, then commit again. If something listed really belongs in the repository, its owner commits it from their own terminal.",
  push: `${PRIVATE_BRANCH} holds the history from before this repository was public and is never pushed. Push the branch you mean by name.`,
};

/* Settings that make git's answers the same on every machine and keep it from running a program named in the repository's own settings. */
const GIT_SETTINGS = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];
/* git's own error text can name staged files, so a failure is reported by subcommand only */
function git(dir, args, options = {}) {
  try { return execFileSync("git", ["-C", dir, ...GIT_SETTINGS, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"], ...options }); }
  catch (err) { throw new Error(`git ${args[0]} did not succeed (${err.code || "exit code " + err.status})`); }
}
/* a yes/no question to git: any failure (no such ref, not a repository, no such folder) is a "no" */
const gitSays = (dir, args) => { try { git(dir, args); return true; } catch { return false; } };
const gitAnswer = (dir, args) => { try { return git(dir, args).trim(); } catch { return null; } };

/* which repository a folder belongs to (worktrees of one repository share this), or null when it is in none */
function repositoryOf(dir) {
  const common = gitAnswer(dir, ["rev-parse", "--git-common-dir"]);
  return common === null ? null : realpathSync(resolve(dir, common));
}
const expandHome = dir => (dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);
/* the folder a command would run in, or null when the text does not say, or names a folder that is not there (a failed cd leaves the shell where it was) */
function folderOf(cwd, dirs) {
  if (dirs === null) return null;
  const folder = dirs.reduce((at, dir) => resolve(at, expandHome(dir)), cwd);
  return existsSync(folder) ? folder : null;
}
/* the words commit and push, however they are quoted: the quick test that lets every other command through at once */
const mentionsCommitOrPush = value => /commit|push/i.test(value.replace(/["'\\]/g, ""));

function readOptions(argv) {
  const at = argv.indexOf("--terms");
  if (at !== -1 && !argv[at + 1]) throw new Error("--terms needs a file");
  return { termsFile: at === -1 ? null : argv[at + 1] };
}

function loadTerms(file, projectDir) {
  const inside = relative(projectDir, file), shown = inside.startsWith("..") ? file : inside;
  if (!existsSync(file)) return { terms: [], allowed: [], notice: `ATG ELN guard: private terms were not checked, because there is no ${shown} on this machine (one term per line; the file is never committed). Private paths were checked.` };
  const { terms, allowed, ignored } = parseTerms(readFileSync(file, "utf8"));
  return { terms, allowed, notice: ignored ? `ATG ELN guard: ${ignored} entr${ignored === 1 ? "y" : "ies"} of ${shown} shorter than ${MIN_TERM_LENGTH} characters ${ignored === 1 ? "was" : "were"} not used.` : null };
}

/* what an amended commit is compared with: the commit before it, or an empty tree when there is none */
function amendBase(dir) {
  if (gitSays(dir, ["rev-parse", "--verify", "--quiet", "HEAD^"])) return "HEAD^";
  return git(dir, ["hash-object", "-t", "tree", "--stdin"], { input: "", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/* the private paths and private terms in what is staged in one working folder */
function staged(dir, amend, { terms, allowed }) {
  const base = amend ? [amendBase(dir)] : [];
  const paths = git(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=d", ...base]).split("\0").filter(Boolean);
  const hasTerm = path => matchTerms(path, terms, allowed).length > 0;
  /* a path that itself holds a term is named by its place in the staged list, not printed */
  const shown = path => (hasTerm(path) ? `file ${paths.indexOf(path) + 1} of \`git diff --cached --name-only\`` : path);
  const privatePaths = judgeStagedPaths(paths).map(f => `private path staged: ${shown(f.path)} (${f.why})`);
  if (!terms.length) return privatePaths;
  const names = paths.flatMap((path, index) => matchTerms(path, terms, allowed).map(entry => `private term in the name of a staged file (file ${index + 1} of \`git diff --cached --name-only\`, entry ${entry} of the terms file)`));
  const diff = git(dir, ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", ...base]);
  const lines = judgeAddedLines(addedLines(diff), terms, allowed).map(f => `private term in ${shown(f.path)}:${f.line} (entry ${f.entry} of the terms file)`);
  return [...privatePaths, ...names, ...lines];
}

function messageProblems(commit, folder, { terms, allowed }) {
  const fromFiles = commit.messageFiles.map(file => resolve(folder, expandHome(file))).filter(file => existsSync(file) && statSync(file).isFile() && statSync(file).size <= MAX_MESSAGE_FILE_BYTES)
    .map(file => readFileSync(file, "utf8"));
  const entries = [...new Set([...commit.messages, ...fromFiles].flatMap(message => matchTerms(message, terms, allowed)))];
  return entries.map(entry => `private term in the commit message (entry ${entry} of the terms file)`);
}

function checkCommits(found, context) {
  const { cwd, projectDir, isOurs, termsFile } = context;
  const commits = found.commits.map(commit => ({ commit, folder: folderOf(cwd, commit.dirs) })).filter(({ folder }) => folder === null || isOurs(folder));
  if (!commits.length) return { problems: [], notices: [], kinds: [] };
  const blockers = commitBlockers({ commits: commits.map(c => c.commit), staging: found.staging }).map(reason => `this command stages and commits in one go: ${reason}`);
  const { notice, ...list } = loadTerms(termsFile, projectDir);
  const isAmend = commits.some(c => c.commit.amend);
  const places = [...new Set(commits.flatMap(({ folder }) => [folder ?? cwd, projectDir]).filter(isOurs).map(dir => git(dir, ["rev-parse", "--show-toplevel"]).trim()))];
  const content = [...places.flatMap(dir => staged(dir, isAmend, list)), ...commits.flatMap(({ commit, folder }) => messageProblems(commit, folder ?? cwd, list))];
  return { problems: [...blockers, ...content], notices: notice ? [notice] : [], kinds: [...(blockers.length ? ["staging"] : []), ...(content.length ? ["content"] : [])] };
}

function checkPushes(found, context) {
  const { cwd, projectDir, isOurs } = context;
  const problems = found.pushes.flatMap(push => {
    const folder = folderOf(cwd, push.dirs);
    if (folder !== null && !isOurs(folder)) return [];
    const dir = [folder ?? cwd, projectDir].find(isOurs);
    if (!gitSays(dir, ["rev-parse", "--verify", "--quiet", PRIVATE_REF])) return [];
    const holdsArchive = source => !source.startsWith("-") && gitSays(dir, ["merge-base", "--is-ancestor", PRIVATE_REF, source]);
    return [...(push.everything ? [`this push sends every branch, ${PRIVATE_BRANCH} included`] : []),
      ...push.named.map(refspec => `this push names ${PRIVATE_BRANCH} (${refspec})`),
      ...push.unclear.map(refspec => `the guard cannot tell what this push sends (${refspec} is worked out only when the command runs)`),
      ...push.sources.filter(holdsArchive).map(source => `this push sends ${source}, which contains the history of ${PRIVATE_BRANCH}`)];
  });
  return { problems: [...new Set(problems)], notices: [], kinds: problems.length ? ["push"] : [] };
}

const pass = (notices = []) => { if (notices.length) process.stdout.write(JSON.stringify({ systemMessage: notices.join(" ") }) + "\n"); };
function block(problems, kinds = []) {
  process.stderr.write(["ATG ELN guard (tools/hooks/guard-commit.mjs): this command was not run.", ...problems.map(p => "- " + p), ...kinds.map(kind => HELP[kind])].join("\n") + "\n");
  process.exitCode = EXIT_BLOCK;
}

function main() {
  const raw = readFileSync(0, "utf8");
  let input;
  try { input = parseHookInput(raw); } catch (err) {
    return mentionsCommitOrPush(raw) ? block([`the guard could not read the hook input (${err.message}), so it cannot tell what this commit or push would do`]) : pass();
  }
  if (input.toolName !== "Bash" || !mentionsCommitOrPush(input.command)) return pass();
  try {
    if (input.command.length > MAX_COMMAND_CHARS) throw new Error(`the command is longer than ${MAX_COMMAND_CHARS} characters`);
    const found = classifyCommand(input.command);
    if (!found.commits.length && !found.pushes.length) return pass();
    const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL("../..", import.meta.url)));
    const repository = repositoryOf(projectDir);
    if (repository === null) return pass();
    const options = readOptions(process.argv.slice(2));
    const context = { cwd: input.cwd || projectDir, projectDir, isOurs: dir => repositoryOf(dir) === repository, termsFile: options.termsFile || join(projectDir, LOCAL_DIR, TERMS_FILE) };
    const results = [checkCommits(found, context), checkPushes(found, context)];
    const problems = results.flatMap(r => r.problems);
    return problems.length ? block(problems, results.flatMap(r => r.kinds)) : pass(results.flatMap(r => r.notices));
  } catch (err) {
    return block([`the guard itself failed (${err.message}), so this command, which mentions a commit or a push, was not checked. Write the command more plainly; if the fault is in tools/hooks/guard-commit.mjs, tell the user, who can commit or push from their own terminal`]);
  }
}

main();
