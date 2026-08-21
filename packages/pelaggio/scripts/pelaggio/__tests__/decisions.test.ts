import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
	appendDecisions,
	appendReviewEscalation,
	archiveResolvedDecisions,
	contentFingerprint,
	DECISIONS_HEADER,
	emitDecisionsFromText,
	lookupReviewEscalation,
	migrateDecisions,
	type ReviewEscalationAdjudication,
	type ReviewEscalationWriteInput,
	rebuildDecisionIndex,
	resolveDecision,
	reviewEscalationCommands,
	reviewEscalationId,
	validateOwner,
} from "../decisions.js";
import type { Decision, ReviewEscalation } from "../types.js";

function repo(): string {
	const path = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: path });
	return path;
}

function seed(path: string): void {
	writeFileSync(resolve(path, "seed"), "seed\n");
	execFileSync("git", ["add", "seed"], { cwd: path });
	execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: path });
}

function appendInput(overrides: Partial<Parameters<typeof appendDecisions>[1]> & { decisions?: Parameters<typeof appendDecisions>[1]["decisions"] } = {}) {
	const decision: Decision = { fork: "a | b", chosen: "a", alternatives: "b" };
	const id = overrides.decisions?.[0]?.id ?? "11111111-1111-4111-8111-111111111111";
	const fp = overrides.decisions?.[0]?.contentFingerprint ?? contentFingerprint(decision);
	return {
		itemId: "85",
		runId: "cycle-1",
		step: "implement" as const,
		attempt: 1,
		source: "85",
		now: new Date("2026-01-01T00:00:00Z"),
		decisions: [{ id, contentFingerprint: fp, occurrence: 0, decision }],
		...overrides,
	};
}

describe("decision log authority", () => {
	it("batch appends idempotently, escapes cells, resolves, and archives per-owner", async () => {
		const path = repo();
		seed(path);
		const input = appendInput();
		const first = await appendDecisions(path, input);
		assert.equal(first.status, "written");
		const authority = readFileSync(resolve(path, "docs/decision-log/85.md"), "utf8");
		assert.match(authority, /a \\\| b/);
		assert.match(authority, /decision:11111111-1111-4111-8111-111111111111/);
		assert.equal((await appendDecisions(path, input)).status, "duplicate");
		const id = first.ids[0]!;
		await resolveDecision(path, id, { adr: "ADR-0001", now: new Date("2026-02-01T00:00:00Z") });
		assert.match(readFileSync(resolve(path, "docs/decision-log/85.md"), "utf8"), /resolved→ADR-0001.*2026-02-01/);
		assert.equal(await archiveResolvedDecisions(path, new Date("2026-03-15T00:00:00Z")), 1);
		assert.match(readFileSync(resolve(path, "docs/decision-log/archive/85.md"), "utf8"), /decision:11111111-1111-4111-8111-111111111111/);
		assert.equal(existsSync(resolve(path, "docs/archived/decisions.md")), false);
	});

	it("preserves backticks and apostrophes as distinct authority content", async () => {
		const path = repo();
		seed(path);
		const backticks = { fork: "use `x`" };
		const apostrophes = { fork: "use 'x'" };
		const result = await appendDecisions(path, {
			itemId: "85",
			runId: "cycle-1",
			step: "implement",
			attempt: 1,
			source: "85",
			now: new Date("2026-01-01T00:00:00Z"),
			decisions: [
				{
					id: "22222222-2222-4222-8222-222222222220",
					contentFingerprint: contentFingerprint(backticks),
					occurrence: 0,
					decision: backticks,
				},
				{
					id: "22222222-2222-4222-8222-222222222221",
					contentFingerprint: contentFingerprint(apostrophes),
					occurrence: 1,
					decision: apostrophes,
				},
			],
		});

		assert.equal(result.status, "written");
		assert.notEqual(contentFingerprint(backticks), contentFingerprint(apostrophes));
		const authority = readFileSync(resolve(path, "docs/decision-log/85.md"), "utf8");
		assert.match(authority, /\| use `x` \|/);
		assert.match(authority, /\| use 'x' \|/);
	});

	it("archive-resolved is a no-op when no authority directory exists", async () => {
		assert.equal(await archiveResolvedDecisions(repo(), new Date("2026-03-15T00:00:00Z")), 0);
	});

	it("refuses to archive through a pre-planted archive-directory symlink", async () => {
		const path = repo();
		seed(path);
		const written = await appendDecisions(path, appendInput());
		await resolveDecision(path, written.ids[0]!, { now: new Date("2026-02-01T00:00:00Z") });
		const outside = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-outside-"));
		symlinkSync(outside, resolve(path, "docs/decision-log/archive"), "dir");

		await assert.rejects(archiveResolvedDecisions(path, new Date("2026-03-15T00:00:00Z")), /archive directory escapes the repo/);
		assert.equal(existsSync(resolve(outside, "85.md")), false);
	});

	it("keeps identical occurrences distinct", async () => {
		const path = repo();
		seed(path);
		const decision = { fork: "same" };
		const fp = contentFingerprint(decision);
		const result = await appendDecisions(path, {
			runId: "unclaimed-run",
			step: "pick",
			attempt: 1,
			source: "unclaimed:run",
			decisions: [
				{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0", contentFingerprint: fp, occurrence: 0, decision },
				{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", contentFingerprint: fp, occurrence: 1, decision },
			],
		});
		assert.equal(result.status, "written");
		assert.notEqual(result.ids[0], result.ids[1]);
		assert.match(readFileSync(resolve(path, "docs/decision-log/run-unclaimed-run.md"), "utf8"), /same/);
	});

	it("writes and commits only the item authority file in the feature worktree", async () => {
		const main = repo();
		seed(main);
		const mainHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: main, encoding: "utf8" }).trim();
		const feature = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-worktree-"));
		execFileSync("git", ["worktree", "add", "-q", "-b", "feature", feature], { cwd: main });
		const featureHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim();

		const decision = { fork: "where to commit", chosen: "item worktree" };
		const written = await appendDecisions(feature, {
			itemId: "301",
			runId: "cycle-301",
			step: "implement",
			attempt: 1,
			source: "301",
			decisions: [{ id: "30130130-1301-4301-8301-301301301301", contentFingerprint: contentFingerprint(decision), occurrence: 0, decision }],
		});

		assert.equal(written.status, "written");
		assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim(), featureHead);
		assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: main, encoding: "utf8" }).trim(), mainHead);
		assert.match(readFileSync(resolve(feature, "docs/decision-log/301.md"), "utf8"), /where to commit/);
		assert.equal(existsSync(resolve(main, "docs/decision-log/301.md")), false);
		assert.equal(existsSync(resolve(main, "docs/decisions.md")), false);
	});

	it("rejects unsafe owners before IO", () => {
		assert.throws(() => validateOwner("../etc"), /unsafe/);
		assert.throws(() => validateOwner("a/b"), /unsafe/);
		assert.throws(() => validateOwner(""), /unsafe/);
	});

	it("dedupes retries by run+step+occurrence+fingerprint while ignoring attempt and emission id", async () => {
		const path = repo();
		seed(path);
		const decision = { fork: "retry me", chosen: "once" };
		const fp = contentFingerprint(decision);
		const first = await appendDecisions(path, {
			itemId: "10",
			runId: "r1",
			step: "implement",
			attempt: 1,
			source: "10",
			decisions: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", contentFingerprint: fp, occurrence: 0, decision }],
		});
		assert.equal(first.status, "written");
		const second = await appendDecisions(path, {
			itemId: "10",
			runId: "r1",
			step: "implement",
			attempt: 2,
			source: "10",
			decisions: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", contentFingerprint: fp, occurrence: 0, decision }],
		});
		assert.equal(second.status, "duplicate");
		assert.equal(second.ids[0], first.ids[0]);
	});

	it("fails closed on fingerprint mismatch and ID collision with unequal content", async () => {
		const path = repo();
		seed(path);
		const decision = { fork: "x", chosen: "y" };
		const bad = await appendDecisions(path, {
			itemId: "11",
			runId: "r",
			step: "plan",
			attempt: 1,
			source: "11",
			decisions: [{ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", contentFingerprint: "0".repeat(64), occurrence: 0, decision }],
		});
		assert.equal(bad.status, "failed");
		assert.match(bad.error, /fingerprint mismatch/);

		const ok = await appendDecisions(path, {
			itemId: "11",
			runId: "r",
			step: "plan",
			attempt: 1,
			source: "11",
			decisions: [{ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", contentFingerprint: contentFingerprint(decision), occurrence: 0, decision }],
		});
		assert.equal(ok.status, "written");
		const clash = await appendDecisions(path, {
			itemId: "11",
			runId: "r2",
			step: "plan",
			attempt: 1,
			source: "11",
			decisions: [
				{
					id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
					contentFingerprint: contentFingerprint({ fork: "other" }),
					occurrence: 0,
					decision: { fork: "other" },
				},
			],
		});
		assert.equal(clash.status, "failed");
		assert.match(clash.error, /collision/);
	});

	it("resolves by legacy alias after migration reconciliation", async () => {
		const path = repo();
		seed(path);
		const legacy = `# Decisions

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| same fork | default-taken | a | b | https://github.com/pelaggio/pelaggio/issues/99 | 2026-01-01 |
<!-- decision:aaaaaaaaaaaaaaaa -->
| same fork | default-taken | a | b | https://github.com/pelaggio/pelaggio/issues/99 | 2026-01-01 |
<!-- decision:bbbbbbbbbbbbbbbb -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
`;
		mkdirSync(resolve(path, "docs"), { recursive: true });
		writeFileSync(resolve(path, "docs/decisions.md"), legacy);
		execFileSync("git", ["add", "docs/decisions.md"], { cwd: path });
		execFileSync("git", ["commit", "-q", "-m", "legacy decisions"], { cwd: path });

		const migrated = await migrateDecisions(path);
		assert.equal(migrated.status, "written");
		assert.equal(migrated.reconciled, 1);
		assert.ok(existsSync(resolve(path, "docs/decision-log/99.md")));
		const body = readFileSync(resolve(path, "docs/decision-log/99.md"), "utf8");
		assert.match(body, /decision:aaaaaaaaaaaaaaaa/);
		// Duplicate legacy ID is retained as alias metadata (not a second table row).
		const meta = body.match(/<!-- decision-meta:([A-Za-z0-9_-]+) -->/);
		assert.ok(meta?.[1]);
		const payload = JSON.parse(Buffer.from(meta[1], "base64url").toString("utf8"));
		assert.deepEqual(payload.aliases, ["bbbbbbbbbbbbbbbb"]);

		// Identical re-run is a no-op before lifecycle mutates authority.
		const again = await migrateDecisions(path);
		assert.equal(again.status, "noop");

		await resolveDecision(path, "bbbbbbbbbbbbbbbb", { now: new Date("2026-02-01T00:00:00Z") });
		assert.match(readFileSync(resolve(path, "docs/decision-log/99.md"), "utf8"), /resolved.*2026-02-01/);
	});

	it("rebuild-index is deterministic and a second rebuild is a no-op", async () => {
		const path = repo();
		seed(path);
		const decision = { fork: "index me" };
		await appendDecisions(path, {
			itemId: "7",
			runId: "r",
			step: "plan",
			attempt: 1,
			source: "7",
			now: new Date("2026-01-02T00:00:00Z"),
			decisions: [{ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", contentFingerprint: contentFingerprint(decision), occurrence: 0, decision }],
		});
		const first = await rebuildDecisionIndex(path);
		assert.equal(first.status, "written");
		const index = readFileSync(resolve(path, "docs/decisions.md"), "utf8");
		assert.match(index, /Do not edit/);
		assert.match(index, /decision-log/);
		assert.match(index, /index me/);
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
		const second = await rebuildDecisionIndex(path);
		assert.equal(second.status, "noop");
		assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim(), head);
	});

	it("resolve from main discovers a unique ID only present in a sibling worktree", async () => {
		const main = repo();
		seed(main);
		const feature = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-resolve-wt-"));
		execFileSync("git", ["worktree", "add", "-q", "-b", "feat/42", feature], { cwd: main });
		const decision = { fork: "discover me" };
		const written = await appendDecisions(feature, {
			itemId: "42",
			runId: "r",
			step: "implement",
			attempt: 1,
			source: "42",
			decisions: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", contentFingerprint: contentFingerprint(decision), occurrence: 0, decision }],
		});
		assert.equal(written.status, "written");
		const id = written.ids[0]!;
		const featureHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim();
		const mainHeadBefore = execFileSync("git", ["rev-parse", "main"], { cwd: main, encoding: "utf8" }).trim();

		await resolveDecision(main, id, { now: new Date("2026-04-01T00:00:00Z") });
		assert.match(readFileSync(resolve(feature, "docs/decision-log/42.md"), "utf8"), /resolved.*2026-04-01/);
		assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim(), featureHeadBefore);
		// Main branch tip unchanged (commit landed on feature branch).
		assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: main, encoding: "utf8" }).trim(), mainHeadBefore);
	});
});

function escalation(overrides: Partial<ReviewEscalation> = {}): ReviewEscalation {
	return {
		kind: "review-escalation",
		itemId: "300",
		step: "shakedown-code",
		reviewedSha: "a".repeat(40),
		evidenceFingerprint: "b".repeat(64),
		reviewRecordSource: ".dev/review-records/cycle-1-300.json",
		hasSafetyBlocker: false,
		drivers: [],
		...overrides,
	};
}

function dummyAdjudication(esc: ReviewEscalation, overrides: Partial<ReviewEscalationAdjudication> = {}): ReviewEscalationAdjudication {
	return {
		spend: { amount: 1.5, estimated: false },
		evidenceFingerprint: esc.evidenceFingerprint,
		...overrides,
	};
}

function writeInput(esc: ReviewEscalation, overrides: Partial<ReviewEscalationAdjudication> = {}): ReviewEscalationWriteInput {
	return { escalation: esc, adjudication: dummyAdjudication(esc, overrides), now: new Date("2026-01-01T00:00:00Z") };
}

const RULE = "| --- | --- | --- | --- | --- | --- |";

describe("review escalation tamper-evidence", () => {
	it("folds hasSafetyBlocker into the escalation ID so flipping it changes the ID", () => {
		const withoutBlocker = reviewEscalationId(escalation({ hasSafetyBlocker: false }));
		const withBlocker = reviewEscalationId(escalation({ hasSafetyBlocker: true }));
		assert.notEqual(withoutBlocker, withBlocker);
	});

	it("round-trips an active escalation through append and lookup on per-item authority", async () => {
		const path = repo();
		seed(path);
		const written = await appendReviewEscalation(path, writeInput(escalation({ hasSafetyBlocker: true })));
		assert.equal(written.status, "written");
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "active");
		if (found.state === "active") {
			assert.equal(found.id, written.ids[0]);
			assert.equal(found.escalation.hasSafetyBlocker, true);
		}
		assert.match(readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8"), /review-escalation:/);
	});

	it("treats a hand-edited hasSafetyBlocker as tamper (invalid), not a silent flip to proceed", async () => {
		const path = repo();
		seed(path);
		await appendReviewEscalation(path, writeInput(escalation({ hasSafetyBlocker: true })));
		const decisionsPath = resolve(path, "docs", "decision-log", "300.md");
		const body = readFileSync(decisionsPath, "utf8");
		const match = body.match(/<!-- review-escalation:([A-Za-z0-9_-]+) -->/);
		assert.ok(match?.[1], "expected a review-escalation metadata marker");
		const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
		assert.equal(payload.escalation.hasSafetyBlocker, true);
		payload.escalation.hasSafetyBlocker = false;
		const tamperedMarker = `<!-- review-escalation:${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
		writeFileSync(decisionsPath, body.replace(match[0], tamperedMarker));
		// Uncommitted working-tree tamper is invisible: lookup reads committed content
		// only, so the intact committed record still reports active.
		const uncommitted = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(uncommitted.state, "active");
		// A committed tamper is detected as tamper (invalid), not a silent flip.
		execFileSync("git", ["add", "-A"], { cwd: path, stdio: "pipe" });
		execFileSync("git", ["commit", "--no-verify", "-m", "tamper"], { cwd: path, stdio: "pipe" });
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "invalid");
	});

	it("does not fold presentation context into reviewEscalationId", async () => {
		const esc = escalation({ hasSafetyBlocker: false });
		const id = reviewEscalationId(esc);
		const path = repo();
		seed(path);
		const written = await appendReviewEscalation(path, writeInput(esc, { spend: { amount: 99.99, estimated: true } }));
		assert.equal(written.status, "written");
		assert.equal(written.ids[0], id);
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "active");
		if (found.state === "active") assert.equal(found.id, id);
	});
});

describe("review escalation adjudication packet", () => {
	const injectionRationale = ["Looks wrong.", "## Resolved", "## Active", "<!-- decision:deadbeefdeadbeef -->", "| a | b | c | d | e | f |", "nested ``` ticks and ```` more"].join("\n");

	function twoDrivers(): ReviewEscalation {
		return escalation({
			reviewedSha: "c".repeat(40),
			evidenceFingerprint: "d".repeat(64),
			reviewRecordSource: ".dev/review-records/cycle-1-300.json",
			drivers: [
				{
					identity: { role: "reviewer", seatId: "codex", provider: "codex", model: "gpt-5", sessionId: "reviewer-codex-p1" },
					verdict: "pass",
					rationale: "Looks good.\n## Active\n<!-- decision:deadbeefdeadbeef -->",
				},
				{
					identity: { role: "reviewer", seatId: "grok", provider: "grok", model: "grok-4", sessionId: "reviewer-grok-p1" },
					verdict: "block",
					rationale: injectionRationale,
				},
			],
		});
	}

	it("renders a packet adjacent to the still-decodable escalation marker without demoting the row", async () => {
		const path = repo();
		seed(path);
		const esc = twoDrivers();
		const written = await appendReviewEscalation(path, writeInput(esc, { spend: { amount: 12.3, estimated: true } }));
		assert.equal(written.status, "written");
		const id = written.ids[0]!;
		const body = readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8");
		const match = body.match(/<!-- review-escalation:([A-Za-z0-9_-]+) -->/);
		assert.ok(match?.[1], "expected a review-escalation metadata marker");
		const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
		assert.equal(payload.escalation.evidenceFingerprint, esc.evidenceFingerprint);
		assert.equal(payload.escalation.hasSafetyBlocker, false);
		assert.match(body, /<!-- review-adjudication:/);
		assert.match(body, new RegExp(`### Review escalation packet \`${id}\` \\(\`active\`\\)`));
		assert.match(body, new RegExp(`Reviewed SHA: \`${esc.reviewedSha}\``));
		assert.match(body, new RegExp(`Evidence fingerprint: \`${esc.evidenceFingerprint}\``));
		assert.match(body, new RegExp(`Review record: \`${esc.reviewRecordSource.replace(/\./g, "\\.")}\``));
		assert.match(body, /Safety blocker: `no`/);
		assert.match(body, /Cycle spend: `~\$12\.30`/);
		assert.match(body, /\*\*`reviewer` \/ `codex`\*\*/);
		assert.match(body, /\*\*`reviewer` \/ `grok`\*\*/);
		assert.match(body, /\*\*`pass`\*\*/);
		assert.match(body, /\*\*`block`\*\*/);
		const commands = reviewEscalationCommands(id, esc);
		assert.equal(body.split("\n").includes(commands.resume), true, "packet resume line must equal reviewEscalationCommands().resume exactly");
		assert.ok(commands.resume.includes(esc.evidenceFingerprint));
		assert.ok(!commands.resume.includes("<evidence") && !commands.resume.includes("<fingerprint"));
		assert.equal(body.split("\n").includes(commands.blockResolve), true);
		assert.ok(commands.blockResolve.includes(id));
		assert.equal(body.split("\n").filter((line) => line === "## Active").length, 1);
		assert.equal(body.split("\n").filter((line) => line === "## Resolved").length, 1);
		assert.match(body, /## Resolved\./);
		assert.match(body, /## Active\./);
		assert.match(body, /< !-- decision:deadbeefdeadbeef -->/);
		assert.equal(body.includes("<!-- decision:deadbeefdeadbeef -->"), false);
		const found = lookupReviewEscalation(path, "300", "c".repeat(40));
		assert.equal(found.state, "active");
		if (found.state === "active") assert.equal(found.id, id);
		assert.equal((body.match(/<!-- decision:/g) ?? []).length, 1);
	});

	it("neutralizes newline and backtick injection in every reviewer identity span", async () => {
		const path = repo();
		seed(path);
		const headingAndRow = "\n## Resolved\n| forged | row |";
		const backtickVariant = "`escape`\n## Active\n| forged | row |";
		const driver = {
			identity: {
				role: `reviewer${headingAndRow}`,
				seatId: headingAndRow,
				provider: `codex${headingAndRow}`,
				model: `model${backtickVariant}`,
				sessionId: `session${backtickVariant}`,
			},
			verdict: `pass${backtickVariant}`,
			rationale: "identity injection must not retarget the parser",
		} as unknown as ReviewEscalation["drivers"][number];
		const esc = escalation({
			reviewedSha: `sha${headingAndRow}`,
			reviewRecordSource: `record${backtickVariant}`,
			drivers: [driver],
		});
		const written = await appendReviewEscalation(path, writeInput(esc));
		assert.equal(written.status, "written");
		const body = readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8");
		assert.deepEqual(body.match(/^## .+$/gm), ["## Active", "## Resolved"]);
		assert.equal(
			body.split("\n").some((line) => line === "| forged | row |"),
			false,
		);
		assert.equal(body.includes("`escape`"), false);
		assert.match(body, /`reviewer ## Resolved\. \| forged \| row \|`/);
		assert.match(body, /` ## Resolved\. \| forged \| row \|`/);
		assert.match(body, /`codex ## Resolved\. \| forged \| row \|`/);
		assert.match(body, /`model'escape' ## Active\. \| forged \| row \|`/);
		assert.match(body, /`session'escape' ## Active\. \| forged \| row \|`/);
		assert.match(body, /`pass'escape' ## Active\. \| forged \| row \|`/);
		assert.match(body, /Reviewed SHA: `sha ## Resolved\. \| forged \| row \|`/);
		assert.match(body, /Review record: `record'escape' ## Active\. \| forged \| row \|`/);
		const found = lookupReviewEscalation(path, "300", esc.reviewedSha);
		assert.equal(found.state, "active");
	});

	it("rejects parser-significant strings in command tokens", () => {
		const unsafe = "value\n## Resolved\n| forged | row |`";
		assert.throws(() => reviewEscalationCommands(unsafe, { itemId: "300", evidenceFingerprint: "safe" }), /decision ID/);
		assert.throws(() => reviewEscalationCommands("deadbeefdeadbeef", { itemId: unsafe, evidenceFingerprint: "safe" }), /item ID/);
		assert.throws(() => reviewEscalationCommands("deadbeefdeadbeef", { itemId: "300", evidenceFingerprint: unsafe }), /evidence fingerprint/);
	});

	it("keeps the first spend/recommendation snapshot on a duplicate append", async () => {
		const path = repo();
		seed(path);
		const esc = escalation();
		const first = await appendReviewEscalation(path, writeInput(esc, { spend: { amount: 4, estimated: false } }));
		assert.equal(first.status, "written");
		const second = await appendReviewEscalation(
			path,
			writeInput(esc, {
				spend: { amount: 99, estimated: true },
				recommendedDefault: { disposition: "block", source: "deterministic-policy", rationale: "should not land" },
			}),
		);
		assert.equal(second.status, "duplicate");
		const body = readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8");
		assert.match(body, /Cycle spend: `\$4\.00`/);
		assert.match(body, /Choices: proceed or block\. No recommended default on this record\./);
		assert.equal(body.includes("should not land"), false);
	});

	const recommendationCases: Array<{ name: string; adjudication: Partial<ReviewEscalationAdjudication>; expect: RegExp; forbid?: RegExp }> = [
		{
			name: "deterministic safety recommendation",
			adjudication: {
				recommendedDefault: { disposition: "block", source: "deterministic-policy", rationale: "safety floor cannot be acknowledged through" },
			},
			expect: /Recommended default: `block` \(deterministic-policy\)/,
			forbid: /No recommended default on this record/,
		},
		{
			name: "supplied Judge recommendation",
			adjudication: {
				recommendedDefault: { disposition: "proceed", source: "judge", rationale: "judgment band only" },
			},
			expect: /Recommended default: `proceed` \(judge\)/,
			forbid: /No recommended default on this record/,
		},
		{
			name: "no recommendation",
			adjudication: {},
			expect: /Choices: proceed or block\. No recommended default on this record\./,
			forbid: /Recommended default:/,
		},
	];

	for (const fixture of recommendationCases) {
		it(`renders ${fixture.name}`, async () => {
			const path = repo();
			seed(path);
			const written = await appendReviewEscalation(path, writeInput(escalation({ itemId: "301" }), fixture.adjudication));
			assert.equal(written.status, "written");
			const body = readFileSync(resolve(path, "docs/decision-log/301.md"), "utf8");
			assert.match(body, fixture.expect);
			if (fixture.forbid) assert.equal(fixture.forbid.test(body), false);
		});
	}

	it("retains the packet and unacknowledgeable note after resolving as block", async () => {
		const path = repo();
		seed(path);
		const esc = twoDrivers();
		const written = await appendReviewEscalation(path, writeInput(esc));
		assert.equal(written.status, "written");
		const id = written.ids[0]!;
		await resolveDecision(path, id, {
			disposition: "block",
			actor: "supervisor",
			rationale: "safety-class split stays blocked\n## Resolved",
			now: new Date("2026-02-02T00:00:00Z"),
		});
		const body = readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8");
		assert.match(body, new RegExp(`### Review escalation packet \`${id}\` \\(\`resolved-block\`\\)`));
		assert.match(body, /<!-- review-adjudication:/);
		assert.match(body, /Disposition: `block`/);
		assert.match(body, /Actor: `supervisor`/);
		assert.match(body, /Timestamp: `2026-02-02T00:00:00\.000Z`/);
		assert.match(body, /Acknowledgement cannot resume a `resolved-block` record\./);
		assert.match(body, /safety-class split stays blocked/);
		assert.match(body, /## Resolved\./);
		const found = lookupReviewEscalation(path, "300", "c".repeat(40));
		assert.equal(found.state, "resolved-block");
	});

	it("parses and resolves a legacy escalation without inventing a packet", async () => {
		const path = repo();
		seed(path);
		const esc = escalation();
		const id = reviewEscalationId(esc);
		const payload = Buffer.from(JSON.stringify({ escalation: esc })).toString("base64url");
		const body = `# Decision log — 300

Status values are \`default-taken\`, \`resolved\`, or \`resolved→ADR-nnnn\`. Source is an item, pull request, or review-note reference.

## Active

${DECISIONS_HEADER}
${RULE}
| Cross-model review split for 300 | default-taken | Human adjudication required | proceed or block | ${esc.reviewRecordSource} | 2026-01-01 |
<!-- decision:${id} -->
<!-- review-escalation:${payload} -->

## Resolved

${DECISIONS_HEADER}
${RULE}
`;
		mkdirSync(resolve(path, "docs/decision-log"), { recursive: true });
		writeFileSync(resolve(path, "docs/decision-log/300.md"), body);
		execFileSync("git", ["add", "-A"], { cwd: path, stdio: "pipe" });
		execFileSync("git", ["commit", "--no-verify", "-q", "-m", "legacy escalation"], { cwd: path, stdio: "pipe" });

		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "active");
		if (found.state === "active") {
			assert.equal(found.id, id);
			assert.equal(found.escalation.evidenceFingerprint, esc.evidenceFingerprint);
		}
		assert.equal(body.includes("### Review escalation packet"), false);
		assert.equal(body.includes("review-adjudication:"), false);

		await resolveDecision(path, id, { disposition: "proceed", actor: "legacy-op", rationale: "honor the old record", now: new Date("2026-03-01T00:00:00Z") });
		const rewritten = readFileSync(resolve(path, "docs/decision-log/300.md"), "utf8");
		assert.equal(rewritten.includes("### Review escalation packet"), false);
		assert.equal(rewritten.includes("review-adjudication:"), false);
		assert.match(rewritten, /review-escalation:/);
		const resolved = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(resolved.state, "resolved-proceed");
	});

	it("rejects malformed additive context at the write boundary", async () => {
		const path = repo();
		seed(path);
		const esc = escalation();
		const cases: Array<{ label: string; adj: ReviewEscalationAdjudication; pattern: RegExp }> = [
			{ label: "negative spend", adj: { spend: { amount: -1, estimated: false }, evidenceFingerprint: esc.evidenceFingerprint }, pattern: /spend\.amount/ },
			{ label: "non-finite spend", adj: { spend: { amount: Number.POSITIVE_INFINITY, estimated: false }, evidenceFingerprint: esc.evidenceFingerprint }, pattern: /spend\.amount/ },
			{
				label: "invalid recommendation source",
				adj: {
					spend: { amount: 1, estimated: false },
					evidenceFingerprint: esc.evidenceFingerprint,
					recommendedDefault: { disposition: "block", source: "coin-flip", rationale: "nope" },
				} as unknown as ReviewEscalationAdjudication,
				pattern: /recommendedDefault\.source/,
			},
			{
				label: "empty rationale",
				adj: {
					spend: { amount: 1, estimated: false },
					evidenceFingerprint: esc.evidenceFingerprint,
					recommendedDefault: { disposition: "block", source: "judge", rationale: "   " },
				},
				pattern: /recommendedDefault\.rationale/,
			},
			{ label: "fingerprint mismatch", adj: { spend: { amount: 1, estimated: false }, evidenceFingerprint: "f".repeat(64) }, pattern: /evidenceFingerprint mismatch/ },
		];
		for (const fixture of cases) {
			const result = await appendReviewEscalation(path, { escalation: esc, adjudication: fixture.adj });
			assert.equal(result.status, "failed", fixture.label);
			if (result.status === "failed") assert.match(result.error, fixture.pattern, fixture.label);
		}
		assert.equal(existsSync(resolve(path, "docs/decision-log/300.md")), false);
	});

	it("rejects a committed adjudication marker whose fingerprint does not match the sibling escalation", async () => {
		const path = repo();
		seed(path);
		const esc = escalation();
		const written = await appendReviewEscalation(path, writeInput(esc));
		assert.equal(written.status, "written");
		const decisionsPath = resolve(path, "docs/decision-log/300.md");
		const body = readFileSync(decisionsPath, "utf8");
		const match = body.match(/<!-- review-adjudication:([A-Za-z0-9_-]+) -->/);
		assert.ok(match?.[1]);
		const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
		payload.evidenceFingerprint = "0".repeat(64);
		const tampered = `<!-- review-adjudication:${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
		writeFileSync(decisionsPath, body.replace(match[0], tampered));
		execFileSync("git", ["add", "-A"], { cwd: path, stdio: "pipe" });
		execFileSync("git", ["commit", "--no-verify", "-q", "-m", "tamper adjudication"], { cwd: path, stdio: "pipe" });
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "invalid");
	});
});

describe("emitDecisionsFromText", () => {
	it("assigns distinct UUIDs and equal fingerprints for equal normalized content", () => {
		let n = 0;
		const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
		const emitted = emitDecisionsFromText("DECISION: fork | chose: a | alternatives: b\nDECISION: fork | chose: a | alternatives: b", () => ids[n++]!);
		assert.equal(emitted.length, 2);
		assert.equal(emitted[0]!.id, ids[0]);
		assert.equal(emitted[1]!.id, ids[1]);
		assert.equal(emitted[0]!.contentFingerprint, emitted[1]!.contentFingerprint);
		assert.equal(emitted[0]!.contentFingerprint, contentFingerprint({ fork: "fork", chosen: "a", alternatives: "b" }));
		assert.match(emitted[0]!.id, /^[0-9a-f-]{36}$/i);
	});
});
