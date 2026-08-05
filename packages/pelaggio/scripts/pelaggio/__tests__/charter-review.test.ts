import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ResolvedConfig } from "../config.js";
import type { CharterExecutorResult } from "../review/charter-executor.js";
import { CharterPolicyError, type CharterReviewConfig, canonicalizeCharterFloorPayload, canonicalizeCharterPolicy, isCharterContraction, resolveCharterPolicy, signCharterFloorPayload } from "../review/charter-policy.js";
import { type CharterReviewRecord, canonicalizeCharterRecord, charterRecordInputsMatch, charterReviewInputs, computeCharterRecordDigest, readCharterReviewRecord, writeCharterReviewRecord } from "../review/charter-record.js";
import { canonicalizeContractionPayload } from "../review/taxonomy.js";
import { activateDeferredItem, charterReviewRequired, createReviewedItem } from "../roadmap/charter-gate.js";
import { parseCharterMarker, renderCharterMarker, stripCharterMarker, withCharterMarker } from "../roadmap/charter-provenance.js";
import type { CreateItemOpts, ReviewProvenance, RoadmapItem, RoadmapItemStatus, RoadmapSource } from "../roadmap/types.js";

function ed25519(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

const BASE_RAW = {
	reviewers: [
		{ id: "claude", provider: "claude" as const },
		{ id: "codex", provider: "codex" as const },
	],
	judge: { id: "judge", provider: "claude" as const },
	maxPasses: 2,
};

describe("charter-policy resolution + signing (#367)", () => {
	it("defaults to off and never contracts", () => {
		const policy = resolveCharterPolicy({ ...BASE_RAW }, { env: {} });
		assert.equal(policy.effectiveLevel, "off");
		assert.equal(policy.rawEnvFloor, "off");
	});

	it("env floor is raise-only for an absent yml level", () => {
		const policy = resolveCharterPolicy({ ...BASE_RAW }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" } });
		assert.equal(policy.effectiveLevel, "triad");
		assert.equal(policy.rawEnvFloor, "triad");
	});

	it("explicit yml >= floor keeps the yml level", () => {
		const policy = resolveCharterPolicy({ ...BASE_RAW, level: "triad" }, { env: {} });
		assert.equal(policy.effectiveLevel, "triad");
	});

	it("an explicit sub-floor level with no owner anchor fails at read", () => {
		assert.throws(() => resolveCharterPolicy({ ...BASE_RAW, level: "off" }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" } }), CharterPolicyError);
	});

	it("an unsigned sub-floor contraction fails even with an owner anchor", () => {
		const { publicKeyPem } = ed25519();
		assert.throws(() => resolveCharterPolicy({ ...BASE_RAW, level: "off" }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" }, ownerPubKeyPem: publicKeyPem }), /unsigned/);
	});

	it("a validly-signed sub-floor contraction resolves to the yml level", () => {
		const { publicKeyPem, privateKeyPem } = ed25519();
		const signatureB64 = signCharterFloorPayload(canonicalizeCharterFloorPayload("off", "triad"), privateKeyPem);
		const policy = resolveCharterPolicy({ ...BASE_RAW, level: "off", contract: { signatureB64 } }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" }, ownerPubKeyPem: publicKeyPem });
		assert.equal(policy.effectiveLevel, "off");
	});

	it("malformed base64 signatures fail closed", () => {
		const { publicKeyPem } = ed25519();
		assert.throws(() => resolveCharterPolicy({ ...BASE_RAW, level: "off", contract: { signatureB64: "!!!not-base64!!!" } }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" }, ownerPubKeyPem: publicKeyPem }), /does not verify/);
	});

	it("a taxonomy signature does not verify against the charter-floor domain (no cross-replay)", () => {
		const { publicKeyPem, privateKeyPem } = ed25519();
		// Sign a taxonomy-shaped payload; try to pass it off as a charter-floor contraction.
		const taxonomySig = signCharterFloorPayload(canonicalizeContractionPayload(new Map([["security-and-secrets", "judgment"]])), privateKeyPem);
		assert.throws(() => resolveCharterPolicy({ ...BASE_RAW, level: "off", contract: { signatureB64: taxonomySig } }, { env: { PELAGGIO_CHARTER_REVIEW_FLOOR: "triad" }, ownerPubKeyPem: publicKeyPem }), /does not verify/);
	});

	it("triad with a non-capable seat provider is validation-fatal", () => {
		assert.throws(() => resolveCharterPolicy({ ...BASE_RAW, level: "triad" }, { env: {}, capableProviders: ["claude"] }), /no available registered driver/);
	});

	it("rejects duplicate reviewer providers at triad", () => {
		assert.throws(
			() =>
				resolveCharterPolicy(
					{
						reviewers: [
							{ id: "a", provider: "claude" },
							{ id: "b", provider: "claude" },
						],
						judge: { id: "j", provider: "codex" },
						maxPasses: 2,
						level: "triad",
					},
					{ env: {} },
				),
			/providers must be unique/,
		);
	});

	it("isCharterContraction is rank-ordered", () => {
		assert.equal(isCharterContraction("off", "triad"), true);
		assert.equal(isCharterContraction("triad", "off"), false);
		assert.equal(isCharterContraction("triad", "triad"), false);
	});
});

describe("charter-record canonicalization + digest binding (#367)", () => {
	const policy = resolveCharterPolicy({ ...BASE_RAW, level: "triad" }, { env: {} });
	function makeRecord(over: Partial<CharterReviewRecord> = {}): CharterReviewRecord {
		return {
			schemaVersion: 1,
			recordId: "charter-abc-1",
			createdAt: "2026-08-05T00:00:00.000Z",
			scope: "M",
			origin: "create",
			verdict: "ship",
			inputs: charterReviewInputs("Title", "Body", policy),
			policy,
			evidence: { outcome: "converged-clean", diversity: "met", passes: 1, survivors: 0, notes: 0, cost: 1, seats: [] },
			...over,
		};
	}

	it("canonicalization is stable across object insertion order", () => {
		const a = makeRecord();
		const b: CharterReviewRecord = { evidence: a.evidence, policy: a.policy, inputs: a.inputs, verdict: a.verdict, origin: a.origin, scope: a.scope, createdAt: a.createdAt, recordId: a.recordId, schemaVersion: 1 };
		assert.equal(canonicalizeCharterRecord(a), canonicalizeCharterRecord(b));
	});

	it("changing one byte of the title invalidates the digest", () => {
		const base = makeRecord();
		const mutated = makeRecord({ inputs: charterReviewInputs("Title!", "Body", policy) });
		assert.notEqual(computeCharterRecordDigest(base), computeCharterRecordDigest(mutated));
	});

	it("write is content-addressed and read verifies the digest", () => {
		const dir = mkdtempSync(join(tmpdir(), "charter-rec-"));
		try {
			const { digest, path } = writeCharterReviewRecord(dir, makeRecord());
			assert.match(path, new RegExp(`${digest}\\.json$`));
			const read = readCharterReviewRecord(dir, digest);
			assert.ok(read);
			assert.equal(read?.verdict, "ship");
			// A wrong digest → null (fail-closed), never a mismatched record.
			assert.equal(readCharterReviewRecord(dir, "0".repeat(64)), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("input hashes match the then-current title/body/policy", () => {
		const record = makeRecord();
		assert.equal(charterRecordInputsMatch(record, "Title", "Body", policy), true);
		assert.equal(charterRecordInputsMatch(record, "Title", "changed", policy), false);
	});
});

describe("charter provenance marker round-trip (#367)", () => {
	it("renders and parses a full marker", () => {
		const provenance: ReviewProvenance = { reviewDigest: "a".repeat(64), level: "triad", scope: "M", origin: "create", deferred: true };
		const parsed = parseCharterMarker(renderCharterMarker(provenance));
		assert.ok(parsed);
		assert.equal(parsed?.reviewDigest, "a".repeat(64));
		assert.equal(parsed?.level, "triad");
		assert.equal(parsed?.deferred, true);
	});

	it("digest=none round-trips as an absent digest", () => {
		const parsed = parseCharterMarker(renderCharterMarker({ reviewDigest: "", level: "off", deferred: false }));
		assert.equal(parsed?.reviewDigest, undefined);
	});

	it("withCharterMarker replaces an existing marker rather than duplicating", () => {
		const first = withCharterMarker("Body text", { reviewDigest: "", level: "off", deferred: true });
		const second = withCharterMarker(first, { reviewDigest: "b".repeat(64), level: "triad", deferred: false });
		assert.equal((second.match(/pelaggio:charter-review/g) ?? []).length, 1);
		assert.equal(parseCharterMarker(second)?.deferred, false);
		assert.match(stripCharterMarker(second), /Body text/);
		assert.doesNotMatch(stripCharterMarker(second), /pelaggio:charter-review/);
	});

	it("legacy text with no marker parses to null", () => {
		assert.equal(parseCharterMarker("just a plain body"), null);
	});
});

// ── Gate + activation with a fake source + fake executor (never spins real drivers) ──

class FakeSource implements RoadmapSource {
	readonly name = "markdown" as const;
	items = new Map<string, RoadmapItemStatus>();
	createCalls: CreateItemOpts[] = [];
	activateCalls: Array<{ id: string; provenance: ReviewProvenance }> = [];
	async listOpenItems() {
		return [];
	}
	async listItems() {
		return [...this.items.values()];
	}
	async getItem(id: string) {
		return this.items.get(id) ?? null;
	}
	async claimItem() {
		return { branch: "b", worktree: "w" };
	}
	async markDone() {}
	async getItemPlan() {
		return null;
	}
	resolvePlanPath() {
		return "";
	}
	async publishPlan() {}
	async createItem(opts: CreateItemOpts): Promise<RoadmapItem> {
		this.createCalls.push(opts);
		const item: RoadmapItemStatus = {
			id: `NEW-${this.createCalls.length}`,
			title: opts.title,
			deps: "",
			sourceRef: "fake",
			status: "open",
			...(opts.deferred ? { deferred: true } : {}),
			...(opts.reviewDigest ? { reviewDigest: opts.reviewDigest } : {}),
			...(opts.reviewLevel ? { reviewLevel: opts.reviewLevel } : {}),
			...(opts.scope ? { scope: opts.scope } : {}),
			...(opts.body !== undefined ? { body: opts.body } : {}),
		};
		this.items.set(item.id, item);
		return item;
	}
	async activateItem(id: string, provenance: ReviewProvenance): Promise<RoadmapItemStatus> {
		this.activateCalls.push({ id, provenance });
		const current = this.items.get(id);
		const updated: RoadmapItemStatus = { ...(current ?? { id, title: "", deps: "", sourceRef: "fake", status: "open" }), deferred: false, reviewDigest: provenance.reviewDigest, reviewLevel: provenance.level };
		this.items.set(id, updated);
		return updated;
	}
	async archivePlan() {}
	isCharterPickRace() {
		return false;
	}
	async parseItemId() {
		return null;
	}
}

function charterConfig(level: "off" | "triad"): CharterReviewConfig {
	return resolveCharterPolicy({ ...BASE_RAW, level }, { env: {} });
}

function fakeExecutor(verdict: CharterExecutorResult["verdict"], digest = "d".repeat(64)): (o: never) => Promise<CharterExecutorResult> {
	return (async () =>
		({
			verdict,
			digest,
			recordPath: "/tmp/rec.json",
			record: {
				schemaVersion: 1,
				recordId: "r",
				createdAt: "2026-08-05T00:00:00.000Z",
				origin: "create",
				verdict,
				inputs: { title: "t", bodySha256: "0".repeat(64), titleSha256: "0".repeat(64), policySha256: "0".repeat(64) },
				policy: charterConfig("triad"),
				evidence: { outcome: verdict, diversity: "met", passes: 1, survivors: 0, notes: 0, cost: 0, seats: [] },
			},
		}) as CharterExecutorResult) as unknown as (o: never) => Promise<CharterExecutorResult>;
}

describe("charter create gate (#367)", () => {
	it("charterReviewRequired: triad + M ⇒ true; off ⇒ false; triad + S ⇒ false", () => {
		assert.equal(charterReviewRequired("triad", "M"), true);
		assert.equal(charterReviewRequired("triad", undefined), true);
		assert.equal(charterReviewRequired("off", "M"), false);
		assert.equal(charterReviewRequired("triad", "S"), false);
	});

	it("above-floor ship ⇒ created non-deferred with the minted digest", async () => {
		const source = new FakeSource();
		let executed = 0;
		const executor = fakeExecutor("ship");
		const item = await createReviewedItem(
			source,
			{ title: "Big", scope: "M" },
			{
				config: { repo: "/x", review: { charter: charterConfig("triad") } } as unknown as ResolvedConfig,
				executor: (async (o: never) => {
					executed++;
					return (executor as (o: never) => Promise<CharterExecutorResult>)(o as never);
				}) as never,
			},
		);
		assert.equal(executed, 1);
		assert.equal(item.id, "NEW-1");
		const call = source.createCalls[0]!;
		assert.equal(call.deferred, false);
		assert.equal(call.reviewDigest, "d".repeat(64));
		assert.equal(call.reviewLevel, "triad");
	});

	it("above-floor non-ship ⇒ forced deferred but still created", async () => {
		const source = new FakeSource();
		await createReviewedItem(source, { title: "Big", scope: "L" }, { config: { repo: "/x", review: { charter: charterConfig("triad") } } as unknown as ResolvedConfig, executor: fakeExecutor("defer") as never });
		const call = source.createCalls[0]!;
		assert.equal(call.deferred, true);
		assert.equal(call.reviewDigest, "d".repeat(64));
	});

	it("sub-floor create skips execution but records scope + level", async () => {
		const source = new FakeSource();
		let executed = 0;
		await createReviewedItem(
			source,
			{ title: "Small", scope: "S" },
			{
				config: { repo: "/x", review: { charter: charterConfig("triad") } } as unknown as ResolvedConfig,
				executor: (async () => {
					executed++;
					return {} as CharterExecutorResult;
				}) as never,
			},
		);
		assert.equal(executed, 0);
		const call = source.createCalls[0]!;
		assert.equal(call.deferred, false);
		assert.equal(call.reviewLevel, "triad");
		assert.equal(call.reviewDigest, undefined);
	});

	it("harness-deferral mints deferred WITHOUT executing the panel", async () => {
		const source = new FakeSource();
		let executed = 0;
		await createReviewedItem(
			source,
			{ title: "Follow-up", scope: "M", origin: "harness-deferral" },
			{
				config: { repo: "/x", review: { charter: charterConfig("triad") } } as unknown as ResolvedConfig,
				executor: (async () => {
					executed++;
					return {} as CharterExecutorResult;
				}) as never,
			},
		);
		assert.equal(executed, 0);
		const call = source.createCalls[0]!;
		assert.equal(call.deferred, true);
		assert.equal(call.origin, "harness-deferral");
		assert.equal(call.reviewDigest, undefined);
	});

	it("normalizes description into body", async () => {
		const source = new FakeSource();
		await createReviewedItem(source, { title: "X", scope: "S", description: "the spec" }, { config: { repo: "/x", review: { charter: charterConfig("off") } } as unknown as ResolvedConfig, executor: fakeExecutor("ship") as never });
		assert.equal(source.createCalls[0]!.body, "the spec");
	});
});

describe("charter activation (#367)", () => {
	it("a deferred item with no valid record backfills, and a ship activates it", async () => {
		const source = new FakeSource();
		source.items.set("A-1", { id: "A-1", title: "Deferred", deps: "", sourceRef: "fake", status: "open", deferred: true, body: "body", scope: "M" });
		const result = await activateDeferredItem(source, "A-1", { config: { repo: "/x", review: { charter: charterConfig("off") } } as unknown as ResolvedConfig, executor: fakeExecutor("ship", "e".repeat(64)) as never });
		assert.equal(result.activated, true);
		assert.equal(source.activateCalls.length, 1);
		assert.equal(source.activateCalls[0]!.provenance.reviewDigest, "e".repeat(64));
	});

	it("a non-ship activation leaves the item deferred and reports failure", async () => {
		const source = new FakeSource();
		source.items.set("A-2", { id: "A-2", title: "Deferred", deps: "", sourceRef: "fake", status: "open", deferred: true, body: "body" });
		const result = await activateDeferredItem(source, "A-2", { config: { repo: "/x", review: { charter: charterConfig("off") } } as unknown as ResolvedConfig, executor: fakeExecutor("defer") as never });
		assert.equal(result.activated, false);
		assert.equal(source.activateCalls.length, 0);
	});

	it("a non-deferred item is a no-op success", async () => {
		const source = new FakeSource();
		source.items.set("A-3", { id: "A-3", title: "Open", deps: "", sourceRef: "fake", status: "open" });
		let executed = 0;
		const result = await activateDeferredItem(source, "A-3", {
			config: { repo: "/x", review: { charter: charterConfig("off") } } as unknown as ResolvedConfig,
			executor: (async () => {
				executed++;
				return {} as CharterExecutorResult;
			}) as never,
		});
		assert.equal(result.activated, true);
		assert.equal(executed, 0);
	});

	it("canonicalizeCharterPolicy is order-independent for reviewer seats", () => {
		const a = resolveCharterPolicy(
			{
				reviewers: [
					{ id: "a", provider: "claude" },
					{ id: "b", provider: "codex" },
				],
				judge: { id: "j", provider: "claude" },
				maxPasses: 2,
				level: "triad",
			},
			{ env: {} },
		);
		const b = resolveCharterPolicy(
			{
				reviewers: [
					{ id: "b", provider: "codex" },
					{ id: "a", provider: "claude" },
				],
				judge: { id: "j", provider: "claude" },
				maxPasses: 2,
				level: "triad",
			},
			{ env: {} },
		);
		assert.equal(canonicalizeCharterPolicy(a), canonicalizeCharterPolicy(b));
	});
});
