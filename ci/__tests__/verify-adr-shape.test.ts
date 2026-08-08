import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { adrFiles, checkAdr, frontmatter, loadBaseline, REQUIRED_SECTIONS, sections, slug } from "../verify-adr-shape.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const decisions = resolve(root, "docs/decisions");

const CONFORMING = `---
title: "ADR-0099: Example"
status: proposed
date: 2026-01-01
claims: []
construction: none
---

# ADR-0099 — Example

## Context
Why.

## Decision
What must be true.

## Constraints on any implementation
- **Must not X.** Because #1.

## Alternatives not taken
- **Y** — no.

## Consequences
- (+) Good.

## Construction
Nothing built yet.
`;

test("slug matches GitHub heading anchors", () => {
	assert.equal(slug("## Worktree Isolation"), "worktree-isolation");
	assert.equal(slug("`indeterminate` requires a retry actor"), "indeterminate-requires-a-retry-actor");
});

test("frontmatter parses required keys, returns null when absent", () => {
	assert.equal(frontmatter(CONFORMING)?.status, "proposed");
	assert.equal(frontmatter("# no frontmatter\n"), null);
});

test("sections are returned in document order", () => {
	assert.deepEqual(
		sections(CONFORMING).map((s) => s.title),
		[...REQUIRED_SECTIONS],
	);
});

test("a conforming ADR produces no violations", () => {
	assert.deepEqual(checkAdr("x.md", CONFORMING, root), []);
});

test("missing frontmatter key is reported", () => {
	const rules = checkAdr("x.md", CONFORMING.replace("construction: none\n", ""), root).map((v) => v.rule);
	assert.ok(rules.includes("frontmatter"));
});

test("construction path must exist, and its anchor must resolve", () => {
	const bad = CONFORMING.replace("construction: none", "construction: docs/agent-context/nope.md");
	assert.ok(checkAdr("x.md", bad, root).some((v) => v.rule === "construction-path"));
	const badAnchor = CONFORMING.replace("construction: none", "construction: docs/agent-context/pipeline.md#not-a-heading");
	assert.ok(checkAdr("x.md", badAnchor, root).some((v) => v.rule === "construction-anchor"));
	const good = CONFORMING.replace("construction: none", "construction: docs/agent-context/pipeline.md#worktree-isolation");
	assert.deepEqual(checkAdr("x.md", good, root), []);
});

test("out-of-order sections are reported once, without a spurious missing-section", () => {
	const swapped = CONFORMING.replace("## Consequences\n- (+) Good.\n\n## Construction\nNothing built yet.\n", "## Construction\nNothing built yet.\n\n## Consequences\n- (+) Good.\n");
	const violations = checkAdr("x.md", swapped, root);
	assert.deepEqual(
		violations.map((v) => v.rule),
		["section-order"],
	);
});

test("construction leaks are flagged before ## Construction and exempt after it", () => {
	const leak = CONFORMING.replace("What must be true.", "What must be true, via `pipeline.ts`.");
	assert.ok(checkAdr("x.md", leak, root).some((v) => v.rule === "construction-leak"));
	const symbol = CONFORMING.replace("What must be true.", "What must be true, via `parkExit()`.");
	assert.ok(checkAdr("x.md", symbol, root).some((v) => v.rule === "construction-leak"));
	const belowFold = CONFORMING.replace("Nothing built yet.", "See `pipeline.ts` and `parkExit()`.");
	assert.deepEqual(checkAdr("x.md", belowFold, root), []);
});

test("the ratchet baseline only lists ADRs that exist", () => {
	const files = new Set(adrFiles(root, decisions));
	for (const entry of loadBaseline(root).exempt) assert.ok(files.has(entry), `${entry} is baselined but absent`);
});

test("every enforced ADR really conforms", () => {
	const exempt = new Set(loadBaseline(root).exempt);
	for (const file of adrFiles(root, decisions).filter((f) => !exempt.has(f))) {
		assert.deepEqual(checkAdr(file, readFileSync(resolve(root, file), "utf8"), root), [], `${file} is enforced but does not conform`);
	}
});
