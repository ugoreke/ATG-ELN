#!/usr/bin/env node
// Claude Code hook (Stop): runs the tests when this session changed app files (see mark-tests-owed.mjs) and has not yet seen them pass.
//
//   node tools/hooks/run-owed-tests.mjs [--time-limit <seconds>] [--test-command <program> [arguments ...]]
//
// Nothing owed: exits 0 at once. Otherwise it runs `npm test` in the project folder and
//   - the tests pass: the marker is removed and nothing is said (if a file was edited while they ran, they stay owed);
//   - the tests fail: exit 2 holds the stop once, with the failing test names and the end of the output, so the session goes on and
//     fixes them. When the stop was already held (stop_hook_active), it is let through: the failure is shown in one line and the
//     tests stay owed, so there is no loop;
//   - the tests cannot run (npm, Playwright or its browser is missing) or do not finish in time: one line says so, pointing to
//     `npm run setup`, and the stop is not held.
// The full suite takes about 220 s on the machine it was timed on. The hook is registered with a timeout of 600 s and stops the
// tests itself after 540 s, so it is never cut off while they run. --test-command is for the tests of this hook, which must not
// run the suite inside itself.
//
// What it does not do: notice changes made by shell commands, or run for a session that was interrupted (Claude Code runs no
// Stop hook then; the tests stay owed until that session next stops).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookInput, markerName, failingTests, tailLines, cannotRun, LOCAL_DIR, OWED_DIR } from "./lib.mjs";

const EXIT_BLOCK = 2, DEFAULT_TIME_LIMIT_S = 540, MAX_OUTPUT_CHARS = 2000000, TAIL_LINES = 30, MAX_NAMES_LISTED = 20, MAX_NAMES_IN_ONE_LINE = 5;
const DEFAULT_COMMAND = [process.platform === "win32" ? "npm.cmd" : "npm", "test"];
const SETUP_HINT = 'run "npm run setup" once, then "npm test"';

function readOptions(argv) {
  const commandAt = argv.indexOf("--test-command"), own = commandAt === -1 ? argv : argv.slice(0, commandAt), limitAt = own.indexOf("--time-limit");
  const command = commandAt === -1 ? DEFAULT_COMMAND : argv.slice(commandAt + 1), limit = limitAt === -1 ? DEFAULT_TIME_LIMIT_S : Number(own[limitAt + 1]);
  if (!command.length) throw new Error("--test-command needs a program");
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--time-limit must be a number of seconds above 0");
  return { command, limitSeconds: limit };
}

/* the tests run in a process group of their own, so that all of it (npm, node, the browser) can be stopped together */
const stopGroup = child => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };

/* runs the command and resolves with { kind: "exit", code } | { kind: "missing", message } | { kind: "timeout" }, each with the output */
function run([program, ...args], cwd, limitMs) {
  return new Promise(done => {
    let output = "", isSettled = false;
    const child = spawn(program, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const settle = result => { if (isSettled) return; isSettled = true; clearTimeout(timer); process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); done({ ...result, output }); };
    const keep = chunk => { output = (output + chunk).slice(-MAX_OUTPUT_CHARS); };
    const giveUp = () => { stopGroup(child); child.stdout.destroy(); child.stderr.destroy(); child.unref(); settle({ kind: "timeout" }); };
    const onSignal = () => { stopGroup(child); process.exit(1); };
    const timer = setTimeout(giveUp, limitMs);
    process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
    child.stdout.setEncoding("utf8").on("data", keep); child.stderr.setEncoding("utf8").on("data", keep);
    child.on("error", err => settle({ kind: "missing", message: err.message }));
    child.on("close", code => settle({ kind: "exit", code }));
  });
}

const say = message => process.stdout.write(JSON.stringify({ systemMessage: "ATG ELN: " + message }) + "\n");
const signature = file => { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; };

function reportFailure(result, isStopHeldAlready) {
  const names = failingTests(result.output), count = names.length ? `${names.length} failing` : `the test command ended with code ${result.code}`;
  if (isStopHeldAlready) {
    const shown = names.slice(0, MAX_NAMES_IN_ONE_LINE).join("; "), more = names.length > MAX_NAMES_IN_ONE_LINE ? ` and ${names.length - MAX_NAMES_IN_ONE_LINE} more` : "";
    return say(`the tests are still failing (${count}${shown ? ": " + shown + more : ""}). The stop was not held a second time; the tests stay owed.`);
  }
  const listed = names.slice(0, MAX_NAMES_LISTED).map(name => "✖ " + name), more = names.length > MAX_NAMES_LISTED ? [`... and ${names.length - MAX_NAMES_LISTED} more`] : [];
  process.stderr.write([`ATG ELN: "npm test" fails after this session changed app files (${count}).`, ...listed, ...more, "The end of the output:", tailLines(result.output, TAIL_LINES),
    "Fix what fails (the code, or a test that is wrong) and say what you did. The tests stay owed until they pass."].join("\n") + "\n");
  process.exitCode = EXIT_BLOCK;
  return undefined;
}

async function main() {
  const input = parseHookInput(readFileSync(0, "utf8"));
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL("../..", import.meta.url)));
  const marker = join(projectDir, LOCAL_DIR, OWED_DIR, markerName(input.sessionId));
  if (!existsSync(marker)) return undefined;
  const { command, limitSeconds } = readOptions(process.argv.slice(2));
  const before = signature(marker), result = await run(command, projectDir, limitSeconds * 1000);
  if (result.kind === "missing") return say(`the tests are owed but could not run (${result.message}); ${SETUP_HINT}.`);
  if (result.kind === "timeout") return say(`the tests did not finish in ${limitSeconds} s and were stopped; they stay owed, so run "npm test" yourself.`);
  if (result.code === 0) { if (existsSync(marker) && signature(marker) === before) rmSync(marker, { force: true }); return undefined; }
  if (cannotRun(result.output)) return say(`the tests are owed but could not run (Playwright, its browser, node or npm is missing); ${SETUP_HINT}.`);
  return reportFailure(result, input.stopHookActive);
}

main().catch(err => say(`the hook that runs the tests after app changes failed (${err.message}); run "npm test" yourself.`));
