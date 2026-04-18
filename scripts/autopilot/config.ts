import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ──────────────────────────────────────────────────────────────

/** ESM-compatible `__dirname` — required because this package is `"type": "module"`. */
const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPO = resolve(__dirname, "../..");
export const LOG_PATH = resolve(REPO, ".dev", "autopilot-log.jsonl");

// ── Pipeline steps ─────────────────────────────────────────────────────

export const STEPS = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"] as const;
export type PipelineStep = (typeof STEPS)[number];
/** Pipeline steps + recovery actions (shipwreck runs after ship failure, not as a pipeline stage) */
export type Step = PipelineStep | "shipwreck";

// ── Per-step configuration ─────────────────────────────────────────────

/** Safety-net dollar caps (~3x observed max — only fire on true runaways) */
export const BUDGETS: Record<Step, number> = {
	pick: 2,
	plan: 8,
	"shakedown-plan": 5,
	implement: 25,
	"shakedown-code": 25,
	ship: 3,
	shipwreck: 3,
};

export const TURN_LIMITS: Record<Step, number> = {
	pick: 30,
	plan: 80,
	"shakedown-plan": 60,
	implement: 200,
	"shakedown-code": 150,
	ship: 40,
	shipwreck: 40,
};

export const EFFORT: Record<Step, "low" | "medium" | "high"> = {
	pick: "medium",
	plan: "high",
	"shakedown-plan": "high",
	implement: "high",
	"shakedown-code": "high",
	ship: "medium",
	shipwreck: "medium",
};

// ── Model profiles ─────────────────────────────────────────────────────

const OPUS = "claude-opus-4-7";
const SONNET = "claude-sonnet-4-6";

export const MODEL_PROFILES: Record<string, Partial<Record<Step, string>>> = {
	standard: { pick: SONNET, plan: OPUS, "shakedown-plan": OPUS, implement: OPUS, "shakedown-code": OPUS, ship: SONNET, shipwreck: SONNET },
	quick: { pick: SONNET, plan: SONNET, "shakedown-plan": SONNET, implement: SONNET, "shakedown-code": SONNET, ship: SONNET, shipwreck: SONNET },
};
