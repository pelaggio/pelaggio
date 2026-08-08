import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
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

	it("allocates uniquely across genuinely concurrent processes", async () => {
		const item = "E-1";
		const script = `
			import { allocateAttempt } from ${JSON.stringify(join(import.meta.dirname, "..", "attempt-identity.ts"))};
			process.stdout.write(String(allocateAttempt(${JSON.stringify(repo)}, ${JSON.stringify(item)})));
		`;
		const file = join(repo, "alloc.mts");
		writeFileSync(file, script);
		const N = 6;
		// execFileSync would launch these SEQUENTIALLY — the first version of this test did,
		// so it proved only that six sequential allocations differ, which is trivially true
		// and exercised no interleaving at all. Spawn them in parallel and await together.
		const run = promisify(execFile);
		const got = (await Promise.all(Array.from({ length: N }, () => run("npx", ["tsx", file])))).map((r) => Number(r.stdout.trim()));
		assert.equal(new Set(got).size, N, `duplicate attempt numbers: ${got.join(", ")}`);
	});

	it("does not lower the high-water mark under concurrent allocation", async () => {
		// The lost-update the create-only markers exist to prevent: with a single mutable
		// file, A reads 0, B writes 2, A overwrites with 1 — and a later prune of the highest
		// record reissues that number. Allocate concurrently, prune every numbered record,
		// then assert the next allocation still advances past the highest ever issued.
		const item = "E-2";
		const script = `
			import { allocateAttempt } from ${JSON.stringify(join(import.meta.dirname, "..", "attempt-identity.ts"))};
			process.stdout.write(String(allocateAttempt(${JSON.stringify(repo)}, ${JSON.stringify(item)})));
		`;
		const file = join(repo, "alloc-hw.mts");
		writeFileSync(file, script);
		const run = promisify(execFile);
		const got = (await Promise.all(Array.from({ length: 5 }, () => run("npx", ["tsx", file])))).map((r) => Number(r.stdout.trim()));
		const highest = Math.max(...got);
		const dir = join(attemptsDir(repo), "e-2");
		for (const name of readdirSync(dir)) if (/^\d+\.json$/.test(name)) rmSync(join(dir, name), { force: true });
		assert.equal(allocateAttempt(repo, item), highest + 1, `reissued a used attempt after pruning; issued ${got.join(", ")}`);
	});
});
