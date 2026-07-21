import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { appendDecisions, appendReviewEscalation, archiveResolvedDecisions, lookupReviewEscalation, resolveDecision, reviewEscalationId } from "../decisions.js";
import type { ReviewEscalation } from "../types.js";

function repo(): string {
	const path = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-"));
	execFileSync("git", ["init", "-q"], { cwd: path });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: path });
	return path;
}

describe("decision register", () => {
	it("batch appends idempotently, escapes cells, resolves, and archives", async () => {
		const path = repo();
		const input = {
			itemId: "85",
			runId: "cycle-1",
			step: "implement" as const,
			attempt: 1,
			source: "85",
			now: new Date("2026-01-01T00:00:00Z"),
			decisions: [{ occurrence: 0, decision: { fork: "a | b", chosen: "a", alternatives: "b" } }],
		};
		const first = await appendDecisions(path, input);
		assert.equal(first.status, "written");
		assert.match(readFileSync(resolve(path, "docs/decisions.md"), "utf8"), /a \\\| b/);
		assert.equal((await appendDecisions(path, input)).status, "duplicate");
		const id = first.ids[0];
		await resolveDecision(path, id, { adr: "ADR-0001", now: new Date("2026-02-01T00:00:00Z") });
		assert.match(readFileSync(resolve(path, "docs/decisions.md"), "utf8"), /resolved→ADR-0001.*2026-02-01/);
		assert.equal(await archiveResolvedDecisions(path, new Date("2026-03-15T00:00:00Z")), 1);
		assert.match(readFileSync(resolve(path, "docs/archived/decisions.md"), "utf8"), /decision:[a-f0-9]{16}/);
	});

	it("archive-resolved is a no-op (not an ENOENT) when no register exists", async () => {
		// /tidy invokes archive-resolved routinely; a fresh repo with no docs/decisions.md must
		// return 0, not throw ENOENT (regression for the unguarded readFileSync).
		assert.equal(await archiveResolvedDecisions(repo(), new Date("2026-03-15T00:00:00Z")), 0);
	});

	it("keeps identical occurrences distinct", async () => {
		const path = repo();
		const result = await appendDecisions(path, {
			runId: "unclaimed-run",
			step: "pick",
			attempt: 1,
			source: "unclaimed:run",
			decisions: [0, 1].map((occurrence) => ({ occurrence, decision: { fork: "same" } })),
		});
		assert.equal(result.status, "written");
		assert.notEqual(result.ids[0], result.ids[1]);
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

	it("round-trips an active escalation through append and lookup", async () => {
		const path = repo();
		const written = await appendReviewEscalation(path, escalation({ hasSafetyBlocker: true }));
		assert.equal(written.status, "written");
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "active");
		if (found.state === "active") {
			assert.equal(found.id, written.ids[0]);
			assert.equal(found.escalation.hasSafetyBlocker, true);
		}
	});

	it("treats a hand-edited hasSafetyBlocker as tamper (invalid), not a silent flip to proceed", async () => {
		const path = repo();
		await appendReviewEscalation(path, escalation({ hasSafetyBlocker: true }));
		const decisionsPath = resolve(path, "docs", "decisions.md");
		const body = readFileSync(decisionsPath, "utf8");
		const match = body.match(/<!-- review-escalation:([A-Za-z0-9_-]+) -->/);
		assert.ok(match, "expected a review-escalation metadata marker");
		const payload = JSON.parse(Buffer.from(match![1], "base64url").toString("utf8"));
		assert.equal(payload.escalation.hasSafetyBlocker, true);
		payload.escalation.hasSafetyBlocker = false;
		const tamperedMarker = `<!-- review-escalation:${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
		writeFileSync(decisionsPath, body.replace(match![0], tamperedMarker));
		const found = lookupReviewEscalation(path, "300", "a".repeat(40));
		assert.equal(found.state, "invalid");
	});
});
