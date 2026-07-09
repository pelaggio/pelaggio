import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkpoint, ensureCheckpointed } from "./helpers.js";
import type { RoadmapSource } from "./roadmap/index.js";
import type { Step } from "./types.js";

export const EFFECTS_SCHEMA_VERSION = 1;

export type ImplementedEffect = { kind: "checkpoint"; label: string } | { kind: "plan.publish"; planPath?: string };

export type ReservedEffect = ({ kind: "ship.ShipDecision" } & Record<string, unknown>) | ({ kind: "pick.explainSelection" } & Record<string, unknown>) | ({ kind: "shakedown.deferredItems" } & Record<string, unknown>);

export type Effect = ImplementedEffect | ReservedEffect;

export interface EffectsManifest {
	schemaVersion: typeof EFFECTS_SCHEMA_VERSION;
	runId: string;
	itemId: string;
	step: Step;
	attempt: number;
	cwd: string;
	preSha: string | null;
	effects: Effect[];
}

export interface EffectsContext {
	runId: string;
	itemId: string;
	step: Step;
	attempt: number;
	cwd: string;
	preSha: string | null;
}

export interface EffectsDispatchContext extends EffectsContext {
	roadmap: RoadmapSource;
	log: (msg: string) => void;
}

export class EffectsManifestError extends Error {
	constructor(
		readonly code: "missing_manifest" | "invalid_manifest" | "provenance_mismatch" | "unknown_effect_kind" | "effect_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "EffectsManifestError";
	}
}

type EffectHandler = (effect: ImplementedEffect, ctx: EffectsDispatchContext) => Promise<void> | void;

const EFFECT_HANDLERS: Record<ImplementedEffect["kind"], EffectHandler> = {
	checkpoint(effect, ctx) {
		const committed = checkpoint(ctx.cwd, effect.label);
		ctx.log(committed ? `${effect.label} committed` : `no changes to commit (${effect.label})`);
		ensureCheckpointed(ctx.cwd, effect.label, ctx.log);
	},
	async "plan.publish"(effect, ctx) {
		// #98 parity: publishing the plan (idempotent comment upsert) is best-effort. The plan file is
		// committed locally by the checkpoint effect and the implement prompt reads it from disk, so a
		// missing file (nothing to publish yet) or a transient roadmap/API failure must NOT fail the
		// cycle. Manifest validation (kind / provenance / preSha) stays fail-closed in loadAndValidate.
		const planPath = effect.planPath ?? ctx.roadmap.resolvePlanPath({ id: ctx.itemId, worktree: ctx.cwd });
		if (!existsSync(planPath)) {
			ctx.log(`plan not published (no file at ${planPath})`);
			return;
		}
		try {
			await ctx.roadmap.publishPlan(readFileSync(planPath, "utf-8"), { id: ctx.itemId, worktree: ctx.cwd });
			ctx.log("plan published");
		} catch (e) {
			ctx.log(`plan publish failed (non-fatal, committed locally): ${e instanceof Error ? e.message : String(e)}`);
		}
	},
};

export function effectManifestPath(ctx: EffectsContext): string {
	return join(ctx.cwd, ".dev", "effects", ctx.runId, `${ctx.step}-${ctx.attempt}.json`);
}

export function writeEffectsManifest(ctx: EffectsContext, effects: readonly Effect[]): void {
	const path = effectManifestPath(ctx);
	mkdirSync(dirname(path), { recursive: true });
	const manifest: EffectsManifest = {
		schemaVersion: EFFECTS_SCHEMA_VERSION,
		runId: ctx.runId,
		itemId: ctx.itemId,
		step: ctx.step,
		attempt: ctx.attempt,
		cwd: ctx.cwd,
		preSha: ctx.preSha,
		effects: [...effects],
	};
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function loadAndValidateEffectsManifest(ctx: EffectsContext): EffectsManifest {
	const path = effectManifestPath(ctx);
	if (!existsSync(path)) throw new EffectsManifestError("missing_manifest", `effects manifest not found: ${path}`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", `effects manifest is not valid JSON: ${path}`, { cause: e });
	}

	if (!isRecord(parsed)) throw new EffectsManifestError("invalid_manifest", "effects manifest must be an object");
	if (parsed.schemaVersion !== EFFECTS_SCHEMA_VERSION) throw new EffectsManifestError("invalid_manifest", "unsupported effects manifest schemaVersion");
	if (parsed.runId !== ctx.runId) throw new EffectsManifestError("provenance_mismatch", `manifest runId ${String(parsed.runId)} does not match ${ctx.runId}`);
	if (parsed.itemId !== ctx.itemId) throw new EffectsManifestError("provenance_mismatch", `manifest itemId ${String(parsed.itemId)} does not match ${ctx.itemId}`);
	if (parsed.step !== ctx.step) throw new EffectsManifestError("provenance_mismatch", `manifest step ${String(parsed.step)} does not match ${ctx.step}`);
	if (parsed.attempt !== ctx.attempt) throw new EffectsManifestError("provenance_mismatch", `manifest attempt ${String(parsed.attempt)} does not match ${ctx.attempt}`);
	if (typeof parsed.cwd !== "string" || resolve(parsed.cwd) !== resolve(ctx.cwd)) throw new EffectsManifestError("provenance_mismatch", `manifest cwd does not match ${ctx.cwd}`);
	if (parsed.preSha !== ctx.preSha) throw new EffectsManifestError("provenance_mismatch", "manifest preSha does not match current step provenance");
	if (!Array.isArray(parsed.effects) || parsed.effects.length === 0) throw new EffectsManifestError("invalid_manifest", "effects manifest must contain at least one effect");

	const effects = parsed.effects.map(validateEffect);
	return {
		schemaVersion: EFFECTS_SCHEMA_VERSION,
		runId: parsed.runId,
		itemId: parsed.itemId,
		step: parsed.step,
		attempt: parsed.attempt,
		cwd: parsed.cwd,
		preSha: parsed.preSha,
		effects,
	};
}

export async function dispatchStepEffects(ctx: EffectsDispatchContext): Promise<void> {
	const path = effectManifestPath(ctx);
	const manifest = loadAndValidateEffectsManifest(ctx);
	try {
		for (const effect of manifest.effects) {
			if (effect.kind === "checkpoint" || effect.kind === "plan.publish") {
				await EFFECT_HANDLERS[effect.kind](effect, ctx);
				continue;
			}
			throw new EffectsManifestError("unknown_effect_kind", `effect kind is not implemented: ${effect.kind}`);
		}
	} catch (e) {
		if (e instanceof EffectsManifestError) throw e;
		throw new EffectsManifestError("effect_failed", e instanceof Error ? e.message : String(e), { cause: e });
	}
	rmSync(path);
}

function validateEffect(effect: unknown): Effect {
	if (!isRecord(effect) || typeof effect.kind !== "string") throw new EffectsManifestError("invalid_manifest", "effect must be an object with a kind");
	switch (effect.kind) {
		case "checkpoint":
			if (typeof effect.label !== "string" || effect.label.trim() === "") throw new EffectsManifestError("invalid_manifest", "checkpoint effect requires a non-empty label");
			return { kind: "checkpoint", label: effect.label };
		case "plan.publish":
			if (effect.planPath !== undefined && typeof effect.planPath !== "string") throw new EffectsManifestError("invalid_manifest", "plan.publish planPath must be a string when present");
			return effect.planPath === undefined ? { kind: "plan.publish" } : { kind: "plan.publish", planPath: effect.planPath };
		case "ship.ShipDecision":
		case "pick.explainSelection":
		case "shakedown.deferredItems":
			return { ...effect, kind: effect.kind };
		default:
			throw new EffectsManifestError("unknown_effect_kind", `unknown effect kind: ${effect.kind}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
