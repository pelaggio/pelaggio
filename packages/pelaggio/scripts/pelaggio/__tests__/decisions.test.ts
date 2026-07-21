import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { appendDecisions, archiveResolvedDecisions, resolveDecision } from "../decisions.js";

function repo(): string {
	const path = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
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

	it("writes and commits on local main when called from a feature worktree", async () => {
		const main = repo();
		writeFileSync(resolve(main, "seed"), "seed\n");
		execFileSync("git", ["add", "seed"], { cwd: main });
		execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: main });
		const feature = mkdtempSync(resolve(tmpdir(), "pelaggio-decisions-worktree-"));
		execFileSync("git", ["worktree", "add", "-q", "-b", "feature", feature], { cwd: main });
		const featureHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim();

		const result = await appendDecisions(feature, {
			itemId: "301",
			runId: "cycle-301",
			step: "implement",
			attempt: 1,
			source: "301",
			decisions: [{ occurrence: 0, decision: { fork: "where to commit", chosen: "local main" } }],
		});

		assert.equal(result.status, "written");
		assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim(), featureHead);
		assert.notEqual(execFileSync("git", ["rev-parse", "main"], { cwd: feature, encoding: "utf8" }).trim(), featureHead);
		assert.match(readFileSync(resolve(main, "docs/decisions.md"), "utf8"), /where to commit/);
	});

	it("falls back to the caller's repo when no worktree holds main (--no-worktree/CI)", async () => {
		// Claim in --no-worktree/CI mode leaves only the feature branch checked out, so no worktree
		// holds refs/heads/main. mainWorktree() must fall back to the repo rather than throw (#301 finding).
		const path = repo();
		writeFileSync(resolve(path, "seed"), "seed\n");
		execFileSync("git", ["add", "seed"], { cwd: path });
		execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: path });
		execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: path });
		const result = await appendDecisions(path, {
			itemId: "301",
			runId: "cycle-301",
			step: "implement",
			attempt: 1,
			source: "301",
			decisions: [{ occurrence: 0, decision: { fork: "no main worktree", chosen: "fall back to repo" } }],
		});
		assert.equal(result.status, "written");
		assert.match(readFileSync(resolve(path, "docs/decisions.md"), "utf8"), /no main worktree/);
	});
});
