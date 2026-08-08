import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { allocateAttempt, attemptRunId, attemptsDir, currentAttempt } from "../attempt-identity.js";

let repo: string;
before(() => {
	repo = mkdtempSync(join(tmpdir(), "pelaggio-attempt-"));
});
after(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("attempt-identity", () => {
	it("allocates monotonically per item, starting at 1", () => {
		assert.equal(allocateAttempt(repo, "A-1"), 1);
		assert.equal(allocateAttempt(repo, "A-1"), 2);
		assert.equal(allocateAttempt(repo, "A-1"), 3);
	});

	it("keeps items independent", () => {
		assert.equal(allocateAttempt(repo, "B-1"), 1);
		assert.equal(allocateAttempt(repo, "B-2"), 1);
		assert.equal(allocateAttempt(repo, "B-1"), 2);
	});

	it("reports 0 for an item that has never been attempted", () => {
		assert.equal(currentAttempt(repo, "never-seen"), 0);
	});

	it("never reuses a number when a NON-highest record is deleted", () => {
		const item = "C-1";
		assert.equal(allocateAttempt(repo, item), 1);
		assert.equal(allocateAttempt(repo, item), 2);
		rmSync(join(attemptsDir(repo), "c-1", "1.json"), { force: true });
		assert.equal(allocateAttempt(repo, item), 3);
	});

	it("never reuses a number when the HIGHEST record is deleted", () => {
		// The case the first version of this module got wrong: scanning records alone makes
		// a deleted maximum invisible, so the next allocation re-creates it and regenerates
		// the superseded runId — re-opening the exact receipt collision this module closes.
		// A tidy sweep or a stray `rm` on .dev/ is enough to trigger it.
		const item = "C-2";
		assert.equal(allocateAttempt(repo, item), 1);
		assert.equal(allocateAttempt(repo, item), 2);
		assert.equal(allocateAttempt(repo, item), 3);
		rmSync(join(attemptsDir(repo), "c-2", "3.json"), { force: true });
		assert.equal(allocateAttempt(repo, item), 4);
		assert.equal(currentAttempt(repo, item), 4);
	});

	it("never reuses a number when EVERY record is deleted", () => {
		const item = "C-3";
		assert.equal(allocateAttempt(repo, item), 1);
		assert.equal(allocateAttempt(repo, item), 2);
		for (const n of [1, 2]) rmSync(join(attemptsDir(repo), "c-3", `${n}.json`), { force: true });
		assert.equal(allocateAttempt(repo, item), 3, "high-water mark must survive record pruning");
	});

	it("confines item ids to the attempts directory", () => {
		// Ids arrive from roadmap adapters and land in a path, so traversal must not escape.
		allocateAttempt(repo, "../../../etc/passwd");
		const entries = readdirSync(attemptsDir(repo));
		assert.ok(
			entries.every((e) => !e.includes("..") && !e.startsWith(".")),
			`traversal escaped: ${entries.join(", ")}`,
		);
	});

	it("tolerates unrelated files in the item directory", () => {
		const item = "D-1";
		assert.equal(allocateAttempt(repo, item), 1);
		writeFileSync(join(attemptsDir(repo), "d-1", "notes.txt"), "ignore me");
		assert.equal(allocateAttempt(repo, item), 2);
	});

	it("salts the runId so a resumed attempt cannot collide with its predecessor", () => {
		// The #451 shape: a fresh `--resume` recomputes cycle as 1, so runIdBase repeats.
		assert.notEqual(attemptRunId("cycle-1", "435", 1), attemptRunId("cycle-1", "435", 2));
		assert.equal(attemptRunId("cycle-1", "435", 2), "cycle-1-435-a2");
	});

	it("allocates uniquely across concurrent processes", () => {
		const item = "E-1";
		const script = `
			import { allocateAttempt } from ${JSON.stringify(join(import.meta.dirname, "..", "attempt-identity.ts"))};
			process.stdout.write(String(allocateAttempt(${JSON.stringify(repo)}, ${JSON.stringify(item)})));
		`;
		const file = join(repo, "alloc.mts");
		writeFileSync(file, script);
		const N = 6;
		const got = Array.from({ length: N }, () => Number(execFileSync("npx", ["tsx", file], { encoding: "utf-8" }).trim()));
		// O_EXCL decides the winner, so every process must receive a distinct number.
		assert.equal(new Set(got).size, N, `duplicate attempt numbers: ${got.join(", ")}`);
	});
});
