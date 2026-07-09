#!/usr/bin/env node
// Falsifiability gate: run each `guarantee` claim's evidence_command and fail on regression.
// Convention: a command containing "expect: none" passes only if it produces NO output;
// otherwise it passes on exit 0. Non-executable evidence (placeholders / planned / GAP)
// is skipped and reported as "needs precise evidence" — an honest to-do, not a pass.
//
// Wire-up (in the repo root package.json):
//   "scripts": { "check:trust": "node ci/verify-claims.mjs" }
// and a CI step that runs it on PRs touching the orchestrator.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');                       // ci/ -> repo root
const require = createRequire(import.meta.url);
const { parse } = require(resolve(repoRoot, 'packages/pelaggio/node_modules/yaml'));

const reg = parse(readFileSync(resolve(repoRoot, 'docs/trust/trust-claims.yml'), 'utf8'));
const NON_EXEC = /(^|\s)(planned|see |n\/a)|GAP|<[a-z]|npm view/i;

let ran = 0, failed = 0, skipped = 0;
const rows = [];
for (const c of reg.claims) {
  if (c.status !== 'guarantee') continue;                   // the gate covers guarantees
  const cmd = (c.evidence_command || '').trim();
  if (!cmd || NON_EXEC.test(cmd)) { rows.push([c.id, 'SKIP', 'needs precise evidence']); skipped++; continue; }
  const expectNone = /expect:\s*none/i.test(cmd);
  let out = '', code = 0;
  try {
    out = execSync(cmd, { cwd: repoRoot, shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString();
  } catch (e) { code = e.status ?? 1; out = (e.stdout?.toString() || ''); }
  // expect-none passes only if the check actually RAN (grep: 0=match,1=no-match,2=error;
  // 127=not found). Empty output from a broken command must FAIL, not pass.
  const pass = expectNone ? (out.trim() === '' && code < 2) : code === 0;
  ran++; if (!pass) failed++;
  rows.push([c.id, pass ? 'PASS' : 'FAIL', expectNone ? '(expect: none)' : `exit ${code}`]);
}

console.log('\n  Pelaggio trust gate — guarantee claims\n  ' + '-'.repeat(42));
for (const [id, res, note] of rows) console.log(`  ${id}  ${res.padEnd(5)} ${note}`);
console.log(`  ${'-'.repeat(42)}\n  ${ran} run · ${failed} failed · ${skipped} skipped\n`);
process.exit(failed ? 1 : 0);
