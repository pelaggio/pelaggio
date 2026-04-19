import type { ShipTarget, ShipTargetName } from "../types.js";
import { autoMergePr } from "./auto-merge-pr.js";
import { directPush } from "./direct-push.js";
import { pullRequest } from "./pull-request.js";

export type { ShipContext, ShipResult, ShipTarget, ShipTargetName } from "../types.js";

export const SHIP_TARGET_NAMES: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

export function getShipTarget(name: ShipTargetName): ShipTarget {
	switch (name) {
		case "direct-push":
			return directPush;
		case "pull-request":
			return pullRequest;
		case "auto-merge-pr":
			return autoMergePr;
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown ship target: ${JSON.stringify(exhaustive)}. Valid: ${SHIP_TARGET_NAMES.join(", ")}`);
		}
	}
}

export function isShipTargetName(v: unknown): v is ShipTargetName {
	return typeof v === "string" && (SHIP_TARGET_NAMES as readonly string[]).includes(v);
}
