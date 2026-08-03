import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { activeQuarantineIds, clearEntry, itemFingerprint, listQuarantine, loadQuarantine, quarantinePath, resolveKeep, upsertHits } from "../roadmap/stale-quarantine.js";
import type { StaleHit } from "../roadmap/stale-scan.js";
import type { RoadmapItemStatus } from "../roadmap/types.js";

function item(overrides: Partial<RoadmapItemStatus> = {}): RoadmapItemStatus {
	return { id: "111", title: "Make confinement independent of the harness", deps: "—", sourceRef: "acme#111", status: "open", ...overrides };
}

function hit(id: string, fingerprint: string, overrides: Partial<StaleHit> = {}): StaleHit {
	return { id, fingerprint, reason: "shipped-by-commit", evidence: ["2ad0ba0 subject"], ...overrides };
}

function tempRepo(): string {
	// A plain (non-git) dir: mainWorktree() falls back to it, so it doubles as MAIN_REPO.
	return mkdtempSync(join(tmpdir(), "pelaggio-stale-store-"));
}

describe("itemFingerprint", () => {
	it("is stable for identical fields", () => {
		assert.equal(itemFingerprint(item()), itemFingerprint(item()));
	});

	it("changes when the title changes", () => {
		assert.notEqual(itemFingerprint(item()), itemFingerprint(item({ title: "Different title entirely" })));
	});

	it("changes when the body changes", () => {
		assert.notEqual(itemFingerprint(item({ body: "spec A" })), itemFingerprint(item({ body: "spec B" })));
	});

	it("changes when deps change", () => {
		assert.notEqual(itemFingerprint(item({ deps: "110" })), itemFingerprint(item({ deps: "110, 112" })));
	});

	it("ignores case and surrounding whitespace", () => {
		assert.equal(itemFingerprint(item({ title: "  Make Confinement Independent of the harness " })), itemFingerprint(item()));
	});
});

describe("activeQuarantineIds", () => {
	it("includes an entry whose live fingerprint still matches", () => {
		const it111 = item();
		const file = { version: 1 as const, entries: { "111": { fingerprint: itemFingerprint(it111), reason: "shipped-by-commit" as const, evidence: [], quarantinedAt: "2026-08-03" } } };
		assert.deepEqual([...activeQuarantineIds(file, [it111])], ["111"]);
	});

	it("drops an entry whose fingerprint drifted (item evolved)", () => {
		const file = { version: 1 as const, entries: { "111": { fingerprint: itemFingerprint(item()), reason: "shipped-by-commit" as const, evidence: [], quarantinedAt: "2026-08-03" } } };
		assert.deepEqual([...activeQuarantineIds(file, [item({ title: "Rewritten scope" })])], []);
	});

	it("excludes sticky keep dispositions from gating", () => {
		const it111 = item();
		const file = { version: 1 as const, entries: { "111": { fingerprint: itemFingerprint(it111), reason: "shipped-by-commit" as const, evidence: [], quarantinedAt: "2026-08-03", disposition: "keep" as const } } };
		assert.deepEqual([...activeQuarantineIds(file, [it111])], []);
	});
});

describe("listQuarantine", () => {
	it("returns active and suppressed entries but omits inert ones", () => {
		const active = item({ id: "111" });
		const kept = item({ id: "112", title: "Second still-open item that is long" });
		const inert = item({ id: "113", title: "Third item" });
		const file = {
			version: 1 as const,
			entries: {
				"111": { fingerprint: itemFingerprint(active), reason: "shipped-by-commit" as const, evidence: [], quarantinedAt: "2026-08-03" },
				"112": { fingerprint: itemFingerprint(kept), reason: "title-match-done" as const, evidence: ["done-1"], quarantinedAt: "2026-08-03", disposition: "keep" as const },
				"113": { fingerprint: "stale-fingerprint", reason: "shipped-by-commit" as const, evidence: [], quarantinedAt: "2026-08-03" },
			},
		};
		const rows = listQuarantine(file, [active, kept, inert]);
		assert.deepEqual(
			rows.map((r) => [r.id, r.suppressed]),
			[
				["111", false],
				["112", true],
			],
		);
	});
});

describe("quarantine store round-trip", () => {
	it("loadQuarantine returns empty when the file is absent", () => {
		const repo = tempRepo();
		assert.deepEqual(loadQuarantine(repo), { version: 1, entries: {} });
	});

	it("upsertHits writes the file and prunes ids that are no longer open", async () => {
		const repo = tempRepo();
		const it111 = item();
		const written = await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		assert.ok(written.entries["111"]);
		assert.equal(written.entries["111"].reason, "shipped-by-commit");
		assert.ok(existsSync(quarantinePath(repo)));

		// A follow-up scan where 111 is no longer open drops its entry.
		const pruned = await upsertHits(repo, [], new Set([]));
		assert.deepEqual(pruned.entries, {});
	});

	it("upsertHits preserves the first-seen date for an unchanged fingerprint", async () => {
		const repo = tempRepo();
		const it111 = item();
		const first = await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		const at = first.entries["111"]?.quarantinedAt;
		const again = await upsertHits(repo, [hit("111", itemFingerprint(it111), { evidence: ["different evidence"] })], new Set(["111"]));
		assert.equal(again.entries["111"]?.quarantinedAt, at);
	});

	it("upsertHits does not overwrite a sticky keep with a matching fingerprint", async () => {
		const repo = tempRepo();
		const it111 = item();
		await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		await resolveKeep(repo, "111", it111);
		const afterKeep = loadQuarantine(repo);
		assert.equal(afterKeep.entries["111"]?.disposition, "keep");

		// Re-scan fires the same hit — the keep must survive, and gating stays empty.
		await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		const reloaded = loadQuarantine(repo);
		assert.equal(reloaded.entries["111"]?.disposition, "keep");
		assert.deepEqual([...activeQuarantineIds(reloaded, [it111])], []);
	});

	it("resolveKeep rebinds to the live fingerprint so an edit clears the keep", async () => {
		const repo = tempRepo();
		const it111 = item();
		await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		await resolveKeep(repo, "111", it111);
		const kept = loadQuarantine(repo);
		assert.equal(kept.entries["111"]?.fingerprint, itemFingerprint(it111));
		// After an edit, the keep entry is inert (not listed, not gated).
		const edited = item({ title: "Reworked scope for this item" });
		assert.deepEqual(listQuarantine(kept, [edited]), []);
	});

	it("clearEntry removes an entry", async () => {
		const repo = tempRepo();
		const it111 = item();
		await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		await clearEntry(repo, "111");
		assert.deepEqual(loadQuarantine(repo).entries, {});
	});

	it("persists valid JSON at the resolved path", async () => {
		const repo = tempRepo();
		const it111 = item();
		await upsertHits(repo, [hit("111", itemFingerprint(it111))], new Set(["111"]));
		const parsed = JSON.parse(readFileSync(quarantinePath(repo), "utf8"));
		assert.equal(parsed.version, 1);
		assert.equal(parsed.entries["111"].reason, "shipped-by-commit");
	});
});
