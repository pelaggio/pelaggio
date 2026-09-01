import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_EXAMPLE_FINDINGS } from "../review/findings.js";
import type { RoadmapSource } from "../roadmap/types.js";
import { buildStepArgs, expandSkill, reviewFindingsPreamble } from "../skills.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

describe("buildStepArgs (#103, #115)", () => {
	const mk = (getItem: RoadmapSource["getItem"]) => ({ getItem }) as unknown as RoadmapSource;

	it("injects title + body + the do-not-fetch gate for an item with a body", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "45", title: "Do the thing", deps: "—", sourceRef: "o/r#45", status: "open", body: "## Requirements\nthe full spec" })),
			"45",
		);
		assert.match(args, /^pelaggio\n/);
		assert.match(args, /do NOT run `roadmap get`/);
		assert.match(args, /Title: Do the thing/);
		assert.match(args, /the full spec/);
		assert.match(args, /sourceRef: o\/r#45/);
	});

	it("carries the mode into the gate line (shakedown code-review)", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "7", title: "t", deps: "—", sourceRef: "o/r#7", status: "open", body: "spec" })),
			"7",
			"code-review",
		);
		assert.match(args, /^pelaggio code-review\n/);
		assert.match(args, /Title: t/);
	});

	it("emits a read-the-sourceRef note when the adapter gives no body (markdown)", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "T-1", title: "x", deps: "—", sourceRef: "docs/roadmap-x.md", status: "open" })),
			"T-1",
		);
		assert.match(args, /sourceRef: docs\/roadmap-x\.md/);
		assert.match(args, /read it for the full spec/);
	});

	it("degrades to the bare gate (with mode) when getItem throws (e.g. no network)", async () => {
		const args = await buildStepArgs(
			mk(async () => {
				throw new Error("no network");
			}),
			"9",
			"plan-review",
		);
		assert.equal(args, "pelaggio plan-review");
	});
});

describe("reviewFindingsPreamble (issue #60)", () => {
	it('empty / whitespace input returns ""', () => {
		assert.equal(reviewFindingsPreamble(""), "");
		assert.equal(reviewFindingsPreamble("   \n\t "), "");
	});

	it("non-empty input returns a block with the header and the findings", () => {
		const out = reviewFindingsPreamble("- bug: null deref at foo.ts:12");
		assert.match(out, /Revision pass/);
		assert.match(out, /primary task/);
		assert.match(out, /approved plan is historical context only/);
		assert.match(out, /### Review findings/);
		assert.match(out, /null deref at foo\.ts:12/);
	});

	it("over-cap input is truncated with an explicit marker", () => {
		const big = "x".repeat(7000);
		const out = reviewFindingsPreamble(big);
		assert.match(out, /\.\.\.\(truncated\)/);
		// under-cap input is not truncated
		assert.doesNotMatch(reviewFindingsPreamble("x".repeat(100)), /\(truncated\)/);
	});

	it("carries the AC-binding / re-charter rule for a mechanism-widening finding", () => {
		const out = reviewFindingsPreamble("- bug: null deref at foo.ts:12");
		assert.match(out, /introducing or widening a mechanism/);
		assert.match(out, /acceptance\s+criterion it serves/i);
		assert.match(out, /needs re-chartering/);
	});
});

describe("shakedown skill contract", () => {
	it("shakedown rubric names the guarantee-authority question", () => {
		const rubric = readFileSync(resolve(repoRoot, ".claude/skills/_rubric.md"), "utf8");
		assert.match(rubric, /Guarantee authority/);
		assert.match(rubric, /enumerate the inputs each new or widened mechanism asserts a guarantee over/);
		assert.match(rubric, /Do \*\*not\*\* flag a plan or diff whose every asserted input is owned/);
		assert.match(rubric, /otherwise it is a re-charter, not a revision/);

		const expanded = expandSkill("shakedown");
		assert.doesNotMatch(expanded, /^---/);
		assert.match(expanded, /!`cat \.claude\/skills\/_rubric\.md`/);
	});
});

describe("finding closure mode prompt contract (#756)", () => {
	function assertClosureRubric(body: string): void {
		for (const mode of ["patch", "construction", "authority", "policy"]) assert.match(body, new RegExp(`\`${mode}\``));
		assert.match(body, /a localized fix retires the finding and should converge/);
		assert.match(body, /completeness surface/);
		assert.match(body, /chokepoint, extract-and-require, or default-deny/);
		assert.match(body, /instance patch predicts recurrence/);
		assert.match(body, /not this item's to make/);
		assert.match(body, /chartering\/re-chartering/);
		assert.match(body, /trades against a stated design constraint/);
		assert.match(body, /routed decision/);
		assert.match(body, /N instances of one class/);
		assert.match(body, /one class finding/);
		assert.match(body, /sweeps that class's surface/);
		assert.match(body, /taxonomy `class` \/ `classHint`/);
		assert.match(body, /second, optional axis/);
	}

	it("teaches pr-review, pr-verify, and shakedown the same four-mode rubric", () => {
		assertClosureRubric(expandSkill("pr-review"));
		assertClosureRubric(expandSkill("pr-verify"));
		assertClosureRubric(expandSkill("shakedown"));
	});

	it("keeps v1/v3 example (message, path, line) tuples aligned with SCHEMA_EXAMPLE_FINDINGS", () => {
		const body = expandSkill("pr-review");
		const v3 = body.match(/AUTHORING_REVIEW_FINDINGS\n(\{.*\})\nEND_AUTHORING_REVIEW_FINDINGS/);
		const v1 = body.match(/REVIEW_FINDINGS\n(\{.*\})\nEND_REVIEW_FINDINGS/);
		assert.ok(v3?.[1], "v3 example block");
		assert.ok(v1?.[1], "v1 example block");
		const v3Finding = (JSON.parse(v3[1]) as { findings: Array<{ message: string; path: string; line: number }> }).findings[0];
		const v1Finding = (JSON.parse(v1[1]) as { findings: Array<{ message: string; path: string; line: number }> }).findings[0];
		assert.deepEqual({ message: v3Finding?.message, path: v3Finding?.path, line: v3Finding?.line }, SCHEMA_EXAMPLE_FINDINGS[0]);
		assert.deepEqual({ message: v1Finding?.message, path: v1Finding?.path, line: v1Finding?.line }, SCHEMA_EXAMPLE_FINDINGS[1]);
	});
});
