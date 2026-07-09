import { EffectsManifestError, type ShipDecisionEffect } from "../effects.js";
import type { ShipTargetName, StepResult } from "../types.js";
import { SHIP_TARGET_NAMES } from "./index.js";

const SHIP_DECISION_RE = /SHIP_DECISION\s*([\s\S]*?)\s*END_SHIP_DECISION/;

export function parseShipDecisionEffect(step: StepResult, expected: { itemId: string; target: ShipTargetName }): ShipDecisionEffect {
	const haystack = `${step.text}\n${step.fullText}`;
	const match = haystack.match(SHIP_DECISION_RE);
	if (!match) throw new EffectsManifestError("invalid_manifest", "ship decision block not found");

	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", "ship decision block is not valid JSON", { cause: e });
	}
	if (!isRecord(parsed)) throw new EffectsManifestError("invalid_manifest", "ship decision must be a JSON object");
	if (!SHIP_TARGET_NAMES.includes(parsed.target as ShipTargetName)) throw new EffectsManifestError("invalid_manifest", "ship decision target must be a valid ship target");
	if (parsed.target !== expected.target) throw new EffectsManifestError("invalid_manifest", `ship decision target ${String(parsed.target)} does not match configured target ${expected.target}`);
	if (parsed.itemId !== undefined && parsed.itemId !== expected.itemId) throw new EffectsManifestError("invalid_manifest", `ship decision itemId ${String(parsed.itemId)} does not match ${expected.itemId}`);
	if (!isNonEmptyString(parsed.headBranch)) throw new EffectsManifestError("invalid_manifest", "ship decision headBranch must be a non-empty string");
	if (!isNonEmptyString(parsed.prTitle)) throw new EffectsManifestError("invalid_manifest", "ship decision prTitle must be a non-empty string");
	if (!isNonEmptyString(parsed.prBody)) throw new EffectsManifestError("invalid_manifest", "ship decision prBody must be a non-empty string");

	return {
		kind: "ship.ShipDecision",
		target: expected.target,
		itemId: expected.itemId,
		headBranch: parsed.headBranch,
		prTitle: parsed.prTitle,
		prBody: parsed.prBody,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}
