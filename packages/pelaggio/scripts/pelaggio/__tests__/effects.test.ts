import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { dispatchStepEffects, type EffectsDispatchContext, EffectsManifestError, effectManifestPath, loadAndValidateEffectsManifest, writeEffectsManifest } from "../effects.js";
import { allCommitMessages, makeMockRoadmap, makeTempGitRepo } from "./mocks.js";

function baseContext(cwd = mkdtempSync(join(tmpdir(), "pelaggio-effects-test-"))): EffectsDispatchContext {
	return {
		runId: "cycle-1-TOOL-99",
		itemId: "TOOL-99",
		step: "plan",
		attempt: 1,
		cwd,
		preSha: null,
		roadmap: makeMockRoadmap(),
		log: () => {},
	};
}

describe("effects manifest validation", () => {
	it("accepts a valid manifest with matching provenance", () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);

		const manifest = loadAndValidateEffectsManifest(ctx);

		assert.equal(manifest.runId, ctx.runId);
		assert.equal(manifest.itemId, ctx.itemId);
		assert.equal(manifest.step, "plan");
		assert.deepEqual(manifest.effects, [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }]);
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

	it("declares reserved kinds but fails closed when dispatched", async () => {
		const ctx = baseContext();
		writeEffectsManifest(ctx, [{ kind: "ship.ShipDecision", decision: "merge" }]);

		await assert.rejects(
			() => dispatchStepEffects(ctx),
			(err) => err instanceof EffectsManifestError && err.code === "unknown_effect_kind",
		);
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

		await dispatchStepEffects(ctx);

		assert.equal(existsSync(effectManifestPath(ctx)), false);
		assert.deepEqual(publishCalls, [{ body: "# Plan\nbody", id: "TOOL-99", worktree: ctx.cwd }]);
		assert.ok(allCommitMessages(ctx.cwd).includes("wip: pelaggio plan"));
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
});
