#!/usr/bin/env node
// hook-validate.mjs — PostToolUse hook adapter for Write|Edit.
//
// Deliberately dependency-free (no unified/remark/marked) so it never
// blocks on a missing `npm install` — the segmentation/assembly path is
// heavy and only runs when the skill deliberately invokes it; this path
// runs on every Write/Edit and must be fast and always available.
//
// Reads the standard PostToolUse stdin JSON, extracts tool_input.file_path,
// no-ops on anything that isn't a .md file, then validates in-process
// (imports validate.mjs directly — see its header for why this avoids a
// second ${CLAUDE_PLUGIN_ROOT}-dependent path resolution).
//
// Exit code contract (Claude Code hooks reference, PostToolUse):
//   0 — fine, or not our concern (no marker / not a .md file)
//   2 — blocking error: stderr is fed back to Claude as an error message.
//       The write already happened (PostToolUse can't undo it), but Claude
//       sees exactly what's wrong and can fix it in the same turn instead
//       of the drift going unnoticed until the app fails to load the file.

import { readFileSync } from 'node:fs';
import { validate } from './validate.mjs';

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no stdin available — fail open, never block on our own plumbing
}

let event;
try {
  event = JSON.parse(stdin);
} catch {
  process.exit(0); // malformed hook input isn't this script's problem to escalate
}

const filePath = event?.tool_input?.file_path;
if (!filePath || !filePath.endsWith('.md')) process.exit(0);

let raw;
try {
  raw = readFileSync(filePath, 'utf8');
} catch {
  process.exit(0); // file gone/unreadable — nothing to validate
}

const result = validate(raw);
if (result.ok) process.exit(0);

console.error(
  `semantic-zoom payload in ${filePath} failed validation ` +
  `(${result.errors.length} issue(s)) — fix by re-running assemble.mjs ` +
  `with corrected layers.json, never by hand-editing the embedded JSON:\n` +
  result.errors.map((e) => `  - ${e}`).join('\n')
);
process.exit(2);
