import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { dispatchStepEffects, type EffectsDispatchContext, EffectsManifestError, effectManifestPath, loadAndValidateEffectsManifest, writeEffectsManifest } from "../effects.js";
import { digestManifestBytes, executionReceiptPath } from "../execution-receipt.js";
import type { NewReviewRequest } from "../review-request-queue.js";
import { allCommitMessages, makeMockRoadmap, makeTempGitRepo } from "./mocks.js";
import { makeTestTmpDir } from "./tmp-fixture.js";

const FIXED_CHALLENGE = new Uint8Array(32).fill(7);

function baseContext(cwd = makeTestTmpDir("pelaggio-effects-test-")): EffectsDispatchContext {
	return {
		runId: "cycle-1-TOOL-99",
		itemId: "TOOL-99",
		step: "plan",
		attempt: 1,
		cwd,
		preSha: null,
		roadmap: makeMockRoadmap(),
		log: () => {},
		challenge: FIXED_CHALLENGE,
		provider: "claude",
		model: "test-model",
		observeGit: () => ({ worktree: "test-wt", headSha: "abc123", branch: "feat/test" }),
		now: () => "2026-08-03T12:00:00.000Z",
	};
}

/** A committed repo on `feat/tool-99` with an origin remote, ready for `runShipPrEffects` to push. */
function shipReadyRepo(): string {
	const cwd = makeTempGitRepo();
	const remote = makeTestTmpDir("pelaggio-effects-remote-");
	execSync("git init -q --bare", { cwd: remote });
	execSync(`git remote add origin ${remote}`, { cwd });
	writeFileSync(join(cwd, "src.txt"), "hello");
	writeFileSync(join(cwd, ".gitignore"), ".dev/\n");
	execSync("git add -A && git commit -q -m work", { cwd });
	// Squash/diff now require origin/main to resolve and be an ancestor of HEAD (#424).
	execSync("git push -q origin main:main", { cwd });
	return cwd;
}

function shipEffect(itemId: string): { kind: "ship.ShipDecision"; target: "pull-request"; itemId: string; headBranch: string; prTitle: string; prBody: string } {
	return { kind: "ship.ShipDecision", target: "pull-request", itemId, headBranch: "feat/tool-99", prTitle: "Ship TOOL-99", prBody: "Body" };
}

/** Gated-OID binding matching the repo's current state (ADR-0025 ship binding, #424). */
function shipGateFor(cwd: string): { gatedHeadOid: string; originMainOid: string } {
	return {
		gatedHeadOid: execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim(),
		originMainOid: execSync("git rev-parse origin/main", { cwd, encoding: "utf-8" }).trim(),
	};
}

/** Run `fn` with a fake `gh` on PATH that answers `pr list` empty and `pr create` with `prUrl`. */
async function withFakeGh(opts: { prUrl: string }, fn: () => Promise<void>): Promise<void> {
	const bin = makeTestTmpDir("pelaggio-effects-fakebin-");
	writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n"pr list") echo '[]' ;;\n"pr create") echo '${opts.prUrl}' ;;\n*) echo "unexpected gh call: $*" >&2; exit 1 ;;\nesac\n`, { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}:${savedPath}`;
	try {
		await fn();
	} finally {
		process.env.PATH = savedPath;
	}
}

describe("effects manifest validation", () => {
	it("accepts a valid manifest with matching provenance", () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);

		const { manifest, rawText } = loadAndValidateEffectsManifest(ctx);

		assert.equal(manifest.runId, ctx.runId);
		assert.equal(manifest.itemId, ctx.itemId);
		assert.equal(manifest.step, "plan");
		assert.deepEqual(manifest.effects, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);
		assert.equal(typeof rawText, "string");
		assert.ok(rawText.includes('"schemaVersion": 1'));
	});

	it("rejects mismatched provenance", () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }]);
		const manifest = JSON.parse(readFileSync(effectManifestPath(ctx), "utf-8")) as Record<string, unknown>;
		writeFileSync(effectManifestPath(ctx), `${JSON.stringify({ ...manifest, runId: "cycle-2-TOOL-99" })}\n`);

		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "provenance_mismatch",
		);
	});

	it("rejects invalid JSON and empty effects", () => {
		const ctx = baseContext();
		const path = effectManifestPath(ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{not json");

		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest",
		);

		writeFileSync(
			path,
			`${JSON.stringify({
				schemaVersion: 1,
				runId: ctx.runId,
				itemId: ctx.itemId,
				step: ctx.step,
				attempt: ctx.attempt,
				cwd: ctx.cwd,
				preSha: ctx.preSha,
				effects: [],
			})}\n`,
		);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest",
		);
	});

	it("validates ship decisions but rejects direct-push dispatch through the effect path", async () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [
			{
				kind: "ship.ShipDecision",
				target: "direct-push",
				itemId: "TOOL-99",
				headBranch: "feat/tool-99",
				prTitle: "Ship TOOL-99",
				prBody: "Body",
			},
		]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "unknown_effect_kind",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("rejects malformed ship decisions during manifest validation", () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [
			{
				kind: "ship.ShipDecision",
				target: "pull-request",
				itemId: "TOOL-99",
				headBranch: "",
				prTitle: "Ship TOOL-99",
				prBody: "Body",
			},
		]);

		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest",
		);
	});

	it("keeps reserved kinds fail-closed when dispatched", async () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [{ kind: "pick.explainSelection", reason: "x" }]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "unknown_effect_kind",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});
});

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FINGERPRINT = "a".repeat(64);
const verdictEffect = {
	kind: "review.Verdict" as const,
	itemId: "TOOL-99",
	reviewedSha: SHA,
	reviewRecordSource: ".dev/review-records/cycle-1-TOOL-99.json",
	outcome: "converged-clean" as const,
	seats: [
		{ role: "author" as const, seatId: "author", provider: "claude" as const, model: "m" },
		{ role: "reviewer" as const, seatId: "codex", provider: "codex" as const },
		{ role: "judge" as const, seatId: "judge", provider: "claude" as const },
	],
};
const escalationEffect = {
	kind: "review.Escalation" as const,
	itemId: "TOOL-99",
	reviewedSha: SHA,
	reviewRecordSource: ".dev/review-records/cycle-1-TOOL-99.json",
	evidenceFingerprint: FINGERPRINT,
	hasSafetyBlocker: false,
};

describe("review.Verdict / review.Escalation effects (#337)", () => {
	it("accepts a valid verdict + escalation manifest and dispatches (validate-and-log)", async () => {
		const ctx = baseContext();
		ctx.step = "shakedown-code";
		ctx.attempt = 0;
		ctx.preSha = SHA;
		const logs: string[] = [];
		ctx.log = (msg) => logs.push(msg);
		writeEffectsManifest(ctx, [verdictEffect, escalationEffect]);

		const { manifest } = loadAndValidateEffectsManifest(ctx);
		assert.equal(manifest.effects.length, 2);
		assert.equal(manifest.effects[0]?.kind, "review.Verdict");
		assert.equal(manifest.effects[1]?.kind, "review.Escalation");

		const result = await dispatchStepEffects(ctx);
		assert.equal(existsSync(effectManifestPath(ctx)), false);
		assert.ok(result.receipt);
		assert.ok(logs.some((l) => l.includes("review.Verdict")));
		assert.ok(logs.some((l) => l.includes("review.Escalation")));
	});

	it("rejects malformed verdict payloads", () => {
		const ctx = baseContext();
		ctx.step = "shakedown-code";
		ctx.attempt = 0;
		ctx.preSha = SHA;

		writeEffectsManifest(ctx, [{ ...verdictEffect, outcome: "not-a-real-outcome" as "converged-clean" }]);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest" && /outcome/.test(err.message),
		);

		writeEffectsManifest(ctx, [{ ...verdictEffect, reviewedSha: "nope" }]);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest" && /reviewedSha/.test(err.message),
		);

		writeEffectsManifest(ctx, [{ ...verdictEffect, seats: [] }]);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest" && /seats/.test(err.message),
		);
	});

	it("rejects malformed escalation fingerprints and SHAs", () => {
		const ctx = baseContext();
		ctx.step = "shakedown-code";
		ctx.attempt = 0;
		ctx.preSha = SHA;

		writeEffectsManifest(ctx, [{ ...escalationEffect, evidenceFingerprint: "short" }]);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest" && /evidenceFingerprint/.test(err.message),
		);

		writeEffectsManifest(ctx, [{ ...escalationEffect, hasSafetyBlocker: "yes" as unknown as boolean }]);
		assert.throws(
			() => loadAndValidateEffectsManifest(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "invalid_manifest" && /hasSafetyBlocker/.test(err.message),
		);
	});

	it("rejects provenance mismatch on itemId and reviewedSha vs preSha", async () => {
		const ctx = baseContext();
		ctx.step = "shakedown-code";
		ctx.attempt = 0;
		ctx.preSha = SHA;

		// Effect reviewedSha ≠ preSha (manifest preSha still matches ctx so load succeeds).
		const otherSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		writeEffectsManifest(ctx, [{ ...verdictEffect, reviewedSha: otherSha }]);
		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "provenance_mismatch" && /reviewedSha/.test(err.message),
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);

		// Effect itemId ≠ ctx.itemId (handler checks).
		writeEffectsManifest(ctx, [{ ...verdictEffect, itemId: "OTHER" }]);
		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "provenance_mismatch" && /itemId/.test(err.message),
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("retains the manifest when review effect dispatch fails", async () => {
		const ctx = baseContext();
		ctx.step = "shakedown-code";
		ctx.attempt = 0;
		ctx.preSha = SHA;
		writeEffectsManifest(ctx, [{ ...escalationEffect, itemId: "WRONG" }]);
		await assert.rejects(() => dispatchStepEffects(ctx));
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});
});

describe("effects dispatch", () => {
	it("dispatches checkpoint and plan.publish, then deletes the manifest", async () => {
		const ctx = baseContext(makeTempGitRepo());
		const planPath = `${ctx.cwd}/docs/plans/tool-99.md`;
		const publishCalls: Array<{ body: string; id: string; worktree: string }> = [];
		mkdirSync(dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# Plan\nbody");
		writeFileSync(`${ctx.cwd}/planned.txt`, "dirty");
		ctx.roadmap = makeMockRoadmap({
			resolvePlanPath: () => planPath,
			async publishPlan(body, publishCtx) {
				publishCalls.push({ body, id: publishCtx.id, worktree: publishCtx.worktree });
			},
		});
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);

		const result = await dispatchStepEffects(ctx);

		assert.equal(existsSync(effectManifestPath(ctx)), false);
		assert.deepEqual(publishCalls, [{ body: "# Plan\nbody", id: "TOOL-99", worktree: ctx.cwd }]);
		assert.ok(allCommitMessages(ctx.cwd).includes("wip: pelaggio plan"));
		assert.ok(result.receipt);
		assert.ok(existsSync(join(ctx.cwd, result.receipt!.path)));
	});

	it("treats a plan.publish failure as best-effort (#98 parity), deleting the manifest", async () => {
		const ctx = baseContext();
		const planPath = `${ctx.cwd}/docs/plans/tool-99.md`;
		mkdirSync(dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# Plan\nbody");
		ctx.roadmap = makeMockRoadmap({
			resolvePlanPath: () => planPath,
			async publishPlan() {
				throw new Error("network down");
			},
		});
		writeEffectsManifest(ctx, [{ kind: "plan.publish" }]);

		await dispatchStepEffects(ctx); // must not reject — publishing the plan is best-effort

		assert.equal(existsSync(effectManifestPath(ctx)), false);
	});

	it("fails closed and retains the manifest when a handler throws unexpectedly", async () => {
		const ctx = baseContext();
		ctx.roadmap = makeMockRoadmap({
			resolvePlanPath: () => {
				throw new Error("boom");
			},
		});
		writeEffectsManifest(ctx, [{ kind: "plan.publish" }]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "effect_failed",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("wraps PR ship handler failures and retains the manifest", async () => {
		const ctx = baseContext();
		ctx.step = "ship";
		// A syntactically valid binding so dispatch reaches the handler; the non-git cwd fails it.
		ctx.shipGate = { gatedHeadOid: "a".repeat(40), originMainOid: "b".repeat(40) };
		writeEffectsManifest(ctx, [
			{
				kind: "ship.ShipDecision",
				target: "pull-request",
				itemId: "TOOL-99",
				headBranch: "feat/tool-99",
				prTitle: "Ship TOOL-99",
				prBody: "Body",
			},
		]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "effect_failed",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("refuses to dispatch a ship decision without a gated-OID binding (ADR-0025 fail-closed)", async () => {
		const cwd = shipReadyRepo();
		const ctx = baseContext(cwd);
		ctx.step = "ship";
		writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "provenance_mismatch" && /shipGate/.test(err.message),
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("TOCTOU: a post-gate commit is refused by the ship effect, naming both OIDs, and the manifest is retained", async () => {
		const cwd = shipReadyRepo();
		const gate = shipGateFor(cwd); // snapshot BEFORE the post-gate commit — as the pipeline does
		writeFileSync(join(cwd, "sneaky.txt"), "post-gate change");
		execSync("git add -A && git commit -q -m sneaky", { cwd });
		const headNow = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
		assert.notEqual(headNow, gate.gatedHeadOid);

		const ctx = baseContext(cwd);
		ctx.step = "ship";
		ctx.shipGate = gate;
		writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "effect_failed" && err.message.includes(gate.gatedHeadOid) && err.message.includes(headNow),
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
		// Nothing was pushed: the remote still has no feat branch.
		const remoteRefs = execSync("git ls-remote origin", { cwd, encoding: "utf-8" });
		assert.ok(!remoteRefs.includes("feat/tool-99"), "refused ship must not push the branch");
	});

	it("rejects a ship decision whose effect-level itemId does not match dispatch provenance, retaining the manifest", async () => {
		const ctx = baseContext();
		ctx.step = "ship";
		writeEffectsManifest(ctx, [
			{
				kind: "ship.ShipDecision",
				target: "pull-request",
				itemId: "OTHER-1",
				headBranch: "feat/other-1",
				prTitle: "Ship OTHER-1",
				prBody: "Body",
			},
		]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "provenance_mismatch" && /itemId/.test(err.message),
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
	});

	it("enqueues a review-request after a successful local-runner PR ship (#387)", async () => {
		const cwd = shipReadyRepo();
		const enqueued: Array<{ mainRepo: string; record: NewReviewRequest }> = [];
		await withFakeGh({ prUrl: "https://github.com/acme/widget/pull/42" }, async () => {
			const ctx = baseContext(cwd);
			ctx.step = "ship";
			ctx.shipGate = shipGateFor(cwd);
			ctx.reviewEnqueue = { runner: "local", ghRepo: "acme/widget", mainRepo: (c) => c, enqueue: (mainRepo, record) => enqueued.push({ mainRepo, record }) };
			writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);
			const result = await dispatchStepEffects(ctx);
			assert.equal(result.appendText, "https://github.com/acme/widget/pull/42");
		});
		assert.equal(enqueued.length, 1);
		assert.equal(enqueued[0].record.prNumber, 42);
		assert.equal(enqueued[0].record.itemId, "TOOL-99");
		assert.equal(enqueued[0].record.headBranch, "feat/tool-99");
		assert.match(enqueued[0].record.headSha, /^[0-9a-f]{40}$/i);
		assert.equal(enqueued[0].record.enqueuedAt, "2026-08-03T12:00:00.000Z");
	});

	it("does not enqueue under the ci runner or a non-github-issues source (#387)", async () => {
		for (const deps of [
			{ runner: "ci" as const, ghRepo: "acme/widget" },
			{ runner: "local" as const, ghRepo: "" },
		]) {
			const cwd = shipReadyRepo();
			const enqueued: NewReviewRequest[] = [];
			await withFakeGh({ prUrl: "https://github.com/acme/widget/pull/42" }, async () => {
				const ctx = baseContext(cwd);
				ctx.step = "ship";
				ctx.shipGate = shipGateFor(cwd);
				ctx.reviewEnqueue = { ...deps, mainRepo: (c) => c, enqueue: (_m, record) => enqueued.push(record) };
				writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);
				await dispatchStepEffects(ctx);
			});
			assert.equal(enqueued.length, 0, `expected no enqueue for ${JSON.stringify(deps)}`);
		}
	});

	it("a null PR number skips the enqueue without failing the ship (#387)", async () => {
		const cwd = shipReadyRepo();
		const enqueued: NewReviewRequest[] = [];
		const logs: string[] = [];
		// A pr create URL that does not parse to a number → result.prNumber === null.
		await withFakeGh({ prUrl: "https://github.com/acme/widget/pulls" }, async () => {
			const ctx = baseContext(cwd);
			ctx.step = "ship";
			ctx.shipGate = shipGateFor(cwd);
			ctx.log = (m) => logs.push(m);
			ctx.reviewEnqueue = { runner: "local", ghRepo: "acme/widget", mainRepo: (c) => c, enqueue: (_m, record) => enqueued.push(record) };
			writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);
			const result = await dispatchStepEffects(ctx);
			assert.equal(result.appendText, "https://github.com/acme/widget/pulls"); // ship still succeeds
		});
		assert.equal(enqueued.length, 0);
		assert.ok(logs.some((l) => l.includes("enqueue skipped")));
	});

	it("an enqueue failure does not throw out of the ship handler (#387)", async () => {
		const cwd = shipReadyRepo();
		const logs: string[] = [];
		await withFakeGh({ prUrl: "https://github.com/acme/widget/pull/42" }, async () => {
			const ctx = baseContext(cwd);
			ctx.step = "ship";
			ctx.shipGate = shipGateFor(cwd);
			ctx.log = (m) => logs.push(m);
			ctx.reviewEnqueue = {
				runner: "local",
				ghRepo: "acme/widget",
				mainRepo: (c) => c,
				enqueue: () => {
					throw new Error("disk full");
				},
			};
			writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);
			const result = await dispatchStepEffects(ctx); // must not reject
			assert.equal(result.appendText, "https://github.com/acme/widget/pull/42");
			assert.equal(existsSync(effectManifestPath(ctx)), false, "manifest still deleted after a non-fatal enqueue failure");
		});
		assert.ok(logs.some((l) => l.includes("enqueue failed")));
	});

	it("maps a successful ship dispatch's prUrl onto the dispatch result's appendText", async () => {
		const cwd = shipReadyRepo();
		const prUrl = "https://github.com/acme/widget/pull/42";
		await withFakeGh({ prUrl }, async () => {
			const ctx = baseContext(cwd);
			ctx.step = "ship";
			ctx.shipGate = shipGateFor(cwd);
			writeEffectsManifest(ctx, [shipEffect(ctx.itemId)]);

			const result = await dispatchStepEffects(ctx);

			assert.equal(result.appendText, prUrl);
			assert.equal(existsSync(effectManifestPath(ctx)), false);
			assert.ok(result.receipt);
		});
	});
});

describe("effects execution receipt (#188)", () => {
	it("writes the receipt before deleting the manifest and digests exact source bytes", async () => {
		const ctx = baseContext(makeTempGitRepo());
		writeFileSync(join(ctx.cwd, ".gitignore"), ".dev/\n");
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }]);
		const rawBefore = readFileSync(effectManifestPath(ctx), "utf-8");
		const expectedDigest = digestManifestBytes(rawBefore);

		const result = await dispatchStepEffects(ctx);

		assert.ok(result.receipt);
		assert.equal(existsSync(effectManifestPath(ctx)), false);
		const receiptAbs = join(ctx.cwd, result.receipt!.path);
		assert.ok(existsSync(receiptAbs));
		const receipt = JSON.parse(readFileSync(receiptAbs, "utf-8")) as {
			manifestDigest: string;
			dispatch: { outcome: string; effectKinds: string[] };
			provider: string;
			model: string;
			preGit: { headSha: string | null };
			postGit: { headSha: string | null };
		};
		assert.equal(receipt.manifestDigest, expectedDigest);
		assert.deepEqual(receipt.dispatch, { outcome: "completed", effectKinds: ["checkpoint"] });
		assert.equal(receipt.provider, "claude");
		assert.equal(receipt.model, "test-model");
		assert.equal(receipt.preGit.headSha, null);
		assert.equal(receipt.postGit.headSha, "abc123");
	});

	it("retains the manifest when receipt production fails", async () => {
		// plan.publish is best-effort (no plan file → no throw); receipt fails on short challenge.
		const ctx = baseContext();
		ctx.challenge = new Uint8Array(16); // wrong length → receipt_failed
		writeEffectsManifest(ctx, [{ kind: "plan.publish" }]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "receipt_failed",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
		assert.equal(existsSync(executionReceiptPath(ctx.cwd, ctx.runId, ctx.step, ctx.attempt)), false);
	});

	it("retains the manifest and writes no receipt when a handler fails", async () => {
		const ctx = baseContext();
		ctx.roadmap = makeMockRoadmap({
			resolvePlanPath: () => {
				throw new Error("boom");
			},
		});
		writeEffectsManifest(ctx, [{ kind: "plan.publish" }]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "effect_failed",
		);
		assert.equal(existsSync(effectManifestPath(ctx)), true);
		assert.equal(existsSync(executionReceiptPath(ctx.cwd, ctx.runId, ctx.step, ctx.attempt)), false);
	});

	it("records ordered effectKinds from the validated manifest", async () => {
		const ctx = baseContext(makeTempGitRepo());
		const planPath = `${ctx.cwd}/docs/plans/tool-99.md`;
		mkdirSync(dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# Plan\n");
		ctx.roadmap = makeMockRoadmap({
			resolvePlanPath: () => planPath,
			async publishPlan() {},
		});
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);

		const result = await dispatchStepEffects(ctx);
		const receipt = JSON.parse(readFileSync(join(ctx.cwd, result.receipt!.path), "utf-8")) as {
			dispatch: { effectKinds: string[] };
		};
		assert.deepEqual(receipt.dispatch.effectKinds, ["checkpoint", "plan.publish"]);
	});
});
