import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { appendDecisions, archiveResolvedDecisions, resolveDecision } from "../decisions.js";

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
