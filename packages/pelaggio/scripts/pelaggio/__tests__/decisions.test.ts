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
	emitDecisionsFromText,
	lookupReviewEscalation,
	migrateDecisions,
	rebuildDecisionIndex,
	resolveDecision,
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

describe("review escalation tamper-evidence", () => {
	it("folds hasSafetyBlocker into the escalation ID so flipping it changes the ID", () => {
		const withoutBlocker = reviewEscalationId(escalation({ hasSafetyBlocker: false }));
		const withBlocker = reviewEscalationId(escalation({ hasSafetyBlocker: true }));
		assert.notEqual(withoutBlocker, withBlocker);
	});

	it("round-trips an active escalation through append and lookup on per-item authority", async () => {
		const path = repo();
		seed(path);
		const written = await appendReviewEscalation(path, escalation({ hasSafetyBlocker: true }));
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
		await appendReviewEscalation(path, escalation({ hasSafetyBlocker: true }));
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
