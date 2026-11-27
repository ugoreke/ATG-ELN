#!/usr/bin/env node
// Claude Code hook (PostToolUse, matcher Edit|Write|MultiEdit|NotebookEdit): notes that the tests are owed.
// When the edited file is under src/, tests/ or tools/ of this project, its path is added to .claude/local/tests-owed/<session id>,
// a git-ignored file. Nothing else happens here: the tests themselves run when the session stops (run-owed-tests.mjs).
// One marker per session, so a session is only ever held for its own edits.
//
//   node tools/hooks/mark-tests-owed.mjs        (the project is $CLAUDE_PROJECT_DIR, or the folder this script lives in)
//
// It never stops an edit: it always exits 0, and says so in one line if the note could not be written.
// What it does not see: files changed by a shell command (sed, mv, git checkout, a script) or outside Claude Code.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookInput, isAppPath, markerName, LOCAL_DIR, OWED_DIR } from "./lib.mjs";

const PRIVATE_FILE = { mode: 0o600 }, PRIVATE_DIR = { recursive: true, mode: 0o700 };
/* the path with symbolic links resolved, as far as it exists (a file may sit in a folder reached through a link) */
const real = path => { try { return realpathSync(path); } catch { return path; } };

function main() {
  const input = parseHookInput(readFileSync(0, "utf8"));
  if (!input.filePath) return;
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL("../..", import.meta.url)));
  const file = resolve(input.cwd || projectDir, input.filePath);
  const owed = [relative(projectDir, file), relative(real(projectDir), join(real(dirname(file)), relative(dirname(file), file)))].find(isAppPath);
  if (!owed) return;
  const marker = join(projectDir, LOCAL_DIR, OWED_DIR, markerName(input.sessionId));
  mkdirSync(dirname(marker), PRIVATE_DIR);
  appendFileSync(marker, owed + "\n", PRIVATE_FILE);
}

try { main(); } catch (err) {
  process.stdout.write(JSON.stringify({ systemMessage: `ATG ELN: could not note that the tests are owed (${err.message}); run "npm test" yourself after this change.` }) + "\n");
}
