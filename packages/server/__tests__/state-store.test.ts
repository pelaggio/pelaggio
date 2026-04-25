import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "../src/state-store.js";
import type { PersistedRun } from "../src/types.js";

function tmp(): string {
	return join(mkdtempSync(join(tmpdir(), "server-state-")), "state.json");
}

function makeRun(id: string, patch: Partial<PersistedRun> = {}): PersistedRun {
	return {
		id,
		repo: "main",
		item: "TOOL-1",
		status: "running",
		pid: 1234,
		startedAt: "2026-04-19T00:00:00.000Z",
		logPath: "/tmp/log",
		cwd: "/tmp",
		...patch,
	};
}

describe("StateStore", () => {
	it("roundtrips: upsert → read → identical shape", () => {
		const path = tmp();
		const a = new StateStore(path);
		a.upsert(makeRun("01", { item: "X-1" }));
		const b = new StateStore(path);
		assert.deepEqual(b.get("01"), makeRun("01", { item: "X-1" }));
	});

	it("upsert replaces by id (last-write-wins)", () => {
		const path = tmp();
		const s = new StateStore(path);
		s.upsert(makeRun("01", { status: "running" }));
		s.upsert(makeRun("01", { status: "completed", endedAt: "2026-04-19T00:01:00.000Z" }));
		const got = s.get("01");
		assert.equal(got?.status, "completed");
		assert.equal(s.list().length, 1);
	});

	it("remove drops the run and rewrites file", () => {
		const path = tmp();
		const s = new StateStore(path);
		s.upsert(makeRun("01"));
		s.upsert(makeRun("02"));
		s.remove("01");
		const fresh = new StateStore(path);
		assert.equal(fresh.list().length, 1);
		assert.equal(fresh.get("01"), null);
	});

	it("atomic write: corrupted json on disk yields empty store, not crash", () => {
		const path = tmp();
		writeFileSync(path, "not json{{{");
		const s = new StateStore(path);
		assert.deepEqual(s.list(), []);
	});

	it("atomic write: temp file does not linger after upsert", () => {
		const path = tmp();
		const s = new StateStore(path);
		s.upsert(makeRun("01"));
		assert.ok(existsSync(path));
		// No .tmp- siblings should remain
		const dirContents = readFileSync(path, "utf-8");
		assert.match(dirContents, /"id": "01"/);
	});
});
