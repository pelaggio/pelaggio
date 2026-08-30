import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { writeAtomically, writeJsonAtomically } from "../record-store.js";

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), "record-store-"));
	dirs.push(d);
	return d;
};
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("writeAtomically", () => {
	it("creates parents, publishes the bytes, and leaves no temp file behind", () => {
		const d = scratch();
		const path = join(d, "nested", "deeper", "r.json");
		writeAtomically(path, "hello\n", { mode: 0o600 });
		assert.equal(readFileSync(path, "utf8"), "hello\n");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(join(d, "nested", "deeper")), ["r.json"]);
	});

	it("keeps the umask default when no mode is given", () => {
		const d = scratch();
		const path = join(d, "q.json");
		writeAtomically(path, "{}\n");
		assert.ok(existsSync(path));
		// Node creates with 0o666 through the active umask (so 0o600 under umask 0o077 is correct, not a leak).
		const umask = process.umask();
		process.umask(umask);
		assert.equal(statSync(path).mode & 0o777, 0o666 & ~umask);
	});

	it("overwrites an existing record atomically", () => {
		const d = scratch();
		const path = join(d, "r.json");
		writeAtomically(path, "one\n");
		writeAtomically(path, "two\n");
		assert.equal(readFileSync(path, "utf8"), "two\n");
		assert.deepEqual(readdirSync(d), ["r.json"]);
	});

	it("leaves the destination untouched and removes its temp when the write fails", () => {
		const d = scratch();
		const path = join(d, "r.json");
		writeAtomically(path, "kept\n");
		// A directory at the destination makes rename fail after the temp is written.
		const blocked = join(d, "dir-target");
		writeAtomically(join(blocked, "child"), "x\n");
		assert.throws(() => writeAtomically(blocked, "boom\n"));
		assert.equal(readFileSync(path, "utf8"), "kept\n");
		assert.deepEqual(
			readdirSync(d).filter((n) => n.includes(".tmp-")),
			[],
		);
	});

	it("serializes JSON the way the record registers do (2-space, trailing newline)", () => {
		const d = scratch();
		const path = join(d, "j.json");
		writeJsonAtomically(path, { a: 1, b: [2] });
		assert.equal(readFileSync(path, "utf8"), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
		// A pre-existing predicted temp path is never reused (wx): the write still succeeds via a fresh name.
		writeFileSync(`${path}.tmp-${process.pid}-deadbeef`, "stale");
		writeJsonAtomically(path, { a: 2 });
		assert.equal(JSON.parse(readFileSync(path, "utf8")).a, 2);
	});
});
