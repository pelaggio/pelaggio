import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type GithubRoadmapConfig, type LinearRoadmapConfig, PLAN_LOCATIONS, type PlanLocation, ROADMAP_SOURCE_NAMES, type RoadmapSourceName } from "./roadmap/types.js";
import type { ShipTargetName } from "./types.js";

const SHIP_TARGET_NAMES: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

// ── Paths ──────────────────────────────────────────────────────────────

/**
 * Resolve the consuming repo's root.
 *
 * Resolution order:
 *   1. `CLAUDE_AUTOPILOT_REPO` env var (escape hatch, mirrors `CLAUDE_AUTOPILOT_WORKTREE_PREFIX`).
 *   2. `git rev-parse --show-toplevel` from CWD — works whether autopilot lives
 *      in the repo itself (dogfooding) or under `node_modules/` (consumer install).
 */
export function resolveRepo(): string {
	if (process.env.CLAUDE_AUTOPILOT_REPO) return resolve(process.env.CLAUDE_AUTOPILOT_REPO);
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
	} catch {
		throw new Error("claude-autopilot must run inside a git repository (or set CLAUDE_AUTOPILOT_REPO)");
	}
}

export const REPO = resolveRepo();
export const LOG_PATH = resolve(REPO, ".dev", "autopilot-log.jsonl");

// ── Pipeline steps ─────────────────────────────────────────────────────

export const STEPS = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"] as const;
export type PipelineStep = (typeof STEPS)[number];
/** Pipeline steps + non-pipeline actions: `shipwreck` (runs after ship failure) and `pr-review`
 *  (the standalone CI review gate) — both carry per-step config but are absent from `STEPS`. */
export type Step = PipelineStep | "shipwreck" | "pr-review";

/** Type guard for a valid pipeline step. Excludes `shipwreck` and `pr-review` (not pipeline stages) — see `--from` validation in pipeline.ts. */
export function isPipelineStep(s: string): s is PipelineStep {
	return (STEPS as readonly string[]).includes(s);
}

const ALL_STEPS: readonly Step[] = [...STEPS, "shipwreck", "pr-review"];

// ── Model literals ─────────────────────────────────────────────────────

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-5";

// ── Defaults ───────────────────────────────────────────────────────────

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ResolvedConfig {
	repo: string;
	worktreePrefix: string;
	budgets: Record<Step, number>;
	turnLimits: Record<Step, number>;
	effort: Record<Step, Effort>;
	modelProfiles: Record<string, Partial<Record<Step, string>>>;
	profileBudgets: Record<string, Partial<Record<Step, number>>>;
	profileTurnLimits: Record<string, Partial<Record<Step, number>>>;
	profileEffort: Record<string, Partial<Record<Step, Effort>>>;
	shipTarget: ShipTargetName;
	roadmapSource: RoadmapSourceName;
	roadmapGithub: GithubRoadmapConfig;
	roadmapLinear: LinearRoadmapConfig;
	/** Overnight park-and-resume policy. `maxWait` is the raw wait string (parsed with
	 *  `parseWaitFlag` at the orchestrator to avoid a config↔helpers import cycle). */
	park: { autoResume: boolean; maxWait: string };
}

const DEFAULT_GITHUB_ROADMAP: GithubRoadmapConfig = {
	ghRepo: "",
	label: "autopilot",
	planLocation: "issue-comment",
};

const DEFAULT_LINEAR_ROADMAP: LinearRoadmapConfig = {
	teamId: "",
	label: "",
	planLocation: "issue-comment",
};

export const DEFAULTS = {
	budgets: {
		pick: 2,
		plan: 8,
		"shakedown-plan": 5,
		implement: 25,
		"shakedown-code": 25,
		ship: 3,
		shipwreck: 3,
		"pr-review": 5,
	} satisfies Record<Step, number>,
	turnLimits: {
		pick: 30,
		plan: 80,
		"shakedown-plan": 60,
		implement: 200,
		"shakedown-code": 150,
		ship: 60,
		shipwreck: 40,
		"pr-review": 60,
	} satisfies Record<Step, number>,
	effort: {
		pick: "medium",
		plan: "xhigh",
		"shakedown-plan": "xhigh",
		implement: "xhigh",
		"shakedown-code": "xhigh",
		ship: "medium",
		shipwreck: "medium",
		"pr-review": "xhigh",
	} satisfies Record<Step, Effort>,
	modelProfiles: {
		standard: { pick: SONNET, plan: OPUS, "shakedown-plan": OPUS, implement: OPUS, "shakedown-code": OPUS, ship: OPUS, shipwreck: SONNET, "pr-review": OPUS },
		quick: { pick: SONNET, plan: SONNET, "shakedown-plan": SONNET, implement: SONNET, "shakedown-code": SONNET, ship: SONNET, shipwreck: SONNET, "pr-review": SONNET },
	} satisfies Record<string, Partial<Record<Step, string>>>,
	// Default `autoResume: true` preserves today's waiting behavior (the pipeline already
	// waits by default via the old `--max-wait` 6h default) — flipping it false would
	// regress unattended overnight runs. `false` is the explicit interactive off-switch.
	park: { autoResume: true, maxWait: "6h" },
} as const;

// ── Loader ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStep(key: string): key is Step {
	return (ALL_STEPS as readonly string[]).includes(key);
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isEffort = (v: unknown): v is Effort => v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max";
const isString = (v: unknown): v is string => typeof v === "string";

function mergeStepRecord<T>(defaults: Record<Step, T>, override: unknown, section: string, validate: (v: unknown) => v is T, configPath: string): Record<Step, T> {
	if (override === undefined) return { ...defaults };
	if (!isPlainObject(override)) {
		throw new Error(`${configPath}: expected \`${section}\` to be a map, got ${Array.isArray(override) ? "array" : typeof override}`);
	}
	const out = { ...defaults };
	for (const [k, v] of Object.entries(override)) {
		if (!isStep(k)) continue;
		if (!validate(v)) {
			throw new Error(`${configPath}: invalid value at \`${section}.${k}\``);
		}
		out[k] = v;
	}
	return out;
}

/**
 * Parse a per-profile override block (`budgets` / `effort` / `turn-limits`) into
 * a *sparse* step map. Unlike `mergeStepRecord`, it starts from `{}` (no default
 * fill), so a profile only carries the steps it explicitly sets — the resolver's
 * `?? global[step]` fallback (see `resolveStepSettings`) supplies everything else.
 * Pre-filling with defaults here would let a per-profile default wrongly shadow a
 * top-level global override.
 */
function parseSparseStepRecord<T>(override: unknown, section: string, validate: (v: unknown) => v is T, configPath: string): Partial<Record<Step, T>> {
	if (override === undefined) return {};
	if (!isPlainObject(override)) {
		throw new Error(`${configPath}: expected \`${section}\` to be a map, got ${Array.isArray(override) ? "array" : typeof override}`);
	}
	const out: Partial<Record<Step, T>> = {};
	for (const [k, v] of Object.entries(override)) {
		if (!isStep(k)) continue;
		if (!validate(v)) {
			throw new Error(`${configPath}: invalid value at \`${section}.${k}\``);
		}
		out[k] = v;
	}
	return out;
}

interface ParsedProfiles {
	models: Record<string, Partial<Record<Step, string>>>;
	budgets: Record<string, Partial<Record<Step, number>>>;
	turnLimits: Record<string, Partial<Record<Step, number>>>;
	effort: Record<string, Partial<Record<Step, Effort>>>;
}

function parseProfiles(defaults: Record<string, Partial<Record<Step, string>>>, override: unknown, configPath: string): ParsedProfiles {
	const models: Record<string, Partial<Record<Step, string>>> = {};
	for (const [name, base] of Object.entries(defaults)) models[name] = { ...base };
	const budgets: Record<string, Partial<Record<Step, number>>> = {};
	const turnLimits: Record<string, Partial<Record<Step, number>>> = {};
	const effort: Record<string, Partial<Record<Step, Effort>>> = {};

	if (override === undefined) return { models, budgets, turnLimits, effort };
	if (!isPlainObject(override)) {
		throw new Error(`${configPath}: expected \`models.profiles\` to be a map, got ${Array.isArray(override) ? "array" : typeof override}`);
	}
	for (const [name, profile] of Object.entries(override)) {
		if (!isPlainObject(profile)) {
			throw new Error(`${configPath}: expected \`models.profiles.${name}\` to be a map`);
		}
		const merged: Partial<Record<Step, string>> = { ...(models[name] ?? {}) };
		for (const [step, model] of Object.entries(profile)) {
			if (!isStep(step)) continue;
			if (typeof model !== "string") {
				throw new Error(`${configPath}: expected \`models.profiles.${name}.${step}\` to be a string`);
			}
			merged[step] = model;
		}
		models[name] = merged;

		const b = parseSparseStepRecord(profile.budgets, `models.profiles.${name}.budgets`, isNumber, configPath);
		if (Object.keys(b).length > 0) budgets[name] = b;
		const t = parseSparseStepRecord(profile["turn-limits"], `models.profiles.${name}.turn-limits`, isNumber, configPath);
		if (Object.keys(t).length > 0) turnLimits[name] = t;
		const e = parseSparseStepRecord(profile.effort, `models.profiles.${name}.effort`, isEffort, configPath);
		if (Object.keys(e).length > 0) effort[name] = e;
	}
	return { models, budgets, turnLimits, effort };
}

function parseFile(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) return {};
	const raw = readFileSync(configPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		const hint = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to parse ${configPath}: ${hint}\n(Remove the file to fall back to defaults.)`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!isPlainObject(parsed)) {
		throw new Error(`${configPath}: expected a YAML map at the top level, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
	}
	return parsed;
}

export function loadConfig(opts: { repo?: string; configPath?: string } = {}): ResolvedConfig {
	const repo = opts.repo ?? REPO;
	const configPath = opts.configPath ?? resolve(repo, ".autopilot.yml");
	const yml = parseFile(configPath);

	const budgets = mergeStepRecord(DEFAULTS.budgets, yml.budgets, "budgets", isNumber, configPath);
	const turnLimits = mergeStepRecord(DEFAULTS.turnLimits, yml["turn-limits"], "turn-limits", isNumber, configPath);
	const effort = mergeStepRecord(DEFAULTS.effort, yml.effort, "effort", isEffort, configPath);

	const modelsBlock = yml.models;
	let profilesOverride: unknown;
	if (modelsBlock !== undefined) {
		if (!isPlainObject(modelsBlock)) {
			throw new Error(`${configPath}: expected \`models\` to be a map`);
		}
		profilesOverride = modelsBlock.profiles;
	}
	const { models: modelProfiles, budgets: profileBudgets, turnLimits: profileTurnLimits, effort: profileEffort } = parseProfiles(DEFAULTS.modelProfiles, profilesOverride, configPath);

	// Worktree prefix: env > yml > basename default
	let ymlPrefix: string | undefined;
	const worktreeBlock = yml.worktree;
	if (worktreeBlock !== undefined) {
		if (!isPlainObject(worktreeBlock)) {
			throw new Error(`${configPath}: expected \`worktree\` to be a map`);
		}
		const p = worktreeBlock.prefix;
		if (p !== undefined) {
			if (!isString(p)) {
				throw new Error(`${configPath}: expected \`worktree.prefix\` to be a string`);
			}
			ymlPrefix = p;
		}
	}
	const worktreePrefix = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX ?? ymlPrefix ?? `${basename(repo)}-`;

	// ship.target: default "direct-push"; validate against SHIP_TARGET_NAMES
	let shipTarget: ShipTargetName = "direct-push";
	const shipBlock = yml.ship;
	if (shipBlock !== undefined) {
		if (!isPlainObject(shipBlock)) {
			throw new Error(`${configPath}: expected \`ship\` to be a map`);
		}
		const t = shipBlock.target;
		if (t !== undefined) {
			if (!isString(t) || !(SHIP_TARGET_NAMES as readonly string[]).includes(t)) {
				throw new Error(`${configPath}: expected \`ship.target\` to be one of ${SHIP_TARGET_NAMES.join("|")}, got ${JSON.stringify(t)}`);
			}
			shipTarget = t as ShipTargetName;
		}
	}

	// roadmap.source: default "markdown"; validate against ROADMAP_SOURCE_NAMES
	let roadmapSource: RoadmapSourceName = "markdown";
	const roadmapGithub: GithubRoadmapConfig = { ...DEFAULT_GITHUB_ROADMAP };
	const roadmapLinear: LinearRoadmapConfig = { ...DEFAULT_LINEAR_ROADMAP };
	const roadmapBlock = yml.roadmap;
	if (roadmapBlock !== undefined) {
		if (!isPlainObject(roadmapBlock)) {
			throw new Error(`${configPath}: expected \`roadmap\` to be a map`);
		}
		const s = roadmapBlock.source;
		if (s !== undefined) {
			if (!isString(s) || !(ROADMAP_SOURCE_NAMES as readonly string[]).includes(s)) {
				throw new Error(`${configPath}: expected \`roadmap.source\` to be one of ${ROADMAP_SOURCE_NAMES.join("|")}, got ${JSON.stringify(s)}`);
			}
			roadmapSource = s as RoadmapSourceName;
		}
		const gh = roadmapBlock.github;
		if (gh !== undefined) {
			if (!isPlainObject(gh)) {
				throw new Error(`${configPath}: expected \`roadmap.github\` to be a map`);
			}
			if (gh.repo !== undefined) {
				if (!isString(gh.repo)) {
					throw new Error(`${configPath}: expected \`roadmap.github.repo\` to be a string (owner/repo)`);
				}
				roadmapGithub.ghRepo = gh.repo;
			}
			if (gh.label !== undefined) {
				if (!isString(gh.label)) {
					throw new Error(`${configPath}: expected \`roadmap.github.label\` to be a string`);
				}
				roadmapGithub.label = gh.label;
			}
			const pl = gh["plan-location"];
			if (pl !== undefined) {
				if (!isString(pl) || !(PLAN_LOCATIONS as readonly string[]).includes(pl)) {
					throw new Error(`${configPath}: expected \`roadmap.github.plan-location\` to be one of ${PLAN_LOCATIONS.join("|")}, got ${JSON.stringify(pl)}`);
				}
				roadmapGithub.planLocation = pl as PlanLocation;
			}
		}
		const lin = roadmapBlock.linear;
		if (lin !== undefined) {
			if (!isPlainObject(lin)) {
				throw new Error(`${configPath}: expected \`roadmap.linear\` to be a map`);
			}
			if (lin.team !== undefined) {
				if (!isString(lin.team)) {
					throw new Error(`${configPath}: expected \`roadmap.linear.team\` to be a string`);
				}
				roadmapLinear.teamId = lin.team;
			}
			if (lin.label !== undefined) {
				if (!isString(lin.label)) {
					throw new Error(`${configPath}: expected \`roadmap.linear.label\` to be a string`);
				}
				roadmapLinear.label = lin.label;
			}
			const pl = lin["plan-location"];
			if (pl !== undefined) {
				if (!isString(pl) || !(PLAN_LOCATIONS as readonly string[]).includes(pl)) {
					throw new Error(`${configPath}: expected \`roadmap.linear.plan-location\` to be one of ${PLAN_LOCATIONS.join("|")}, got ${JSON.stringify(pl)}`);
				}
				roadmapLinear.planLocation = pl as PlanLocation;
			}
		}
	}

	if (roadmapSource === "github-issues" && !roadmapGithub.ghRepo) {
		throw new Error(`${configPath}: \`roadmap.github.repo\` (owner/repo) is required when roadmap.source is github-issues`);
	}
	if (roadmapSource === "linear" && !roadmapLinear.teamId) {
		throw new Error(`${configPath}: \`roadmap.linear.team\` is required when roadmap.source is linear`);
	}

	// park.*: overnight park-and-resume policy. Type-validate only — `max-wait` uses
	// parseWaitFlag's tolerant format (unparseable falls back to 6h at read time).
	let parkAutoResume: boolean = DEFAULTS.park.autoResume;
	let parkMaxWait: string = DEFAULTS.park.maxWait;
	const parkBlock = yml.park;
	if (parkBlock !== undefined) {
		if (!isPlainObject(parkBlock)) {
			throw new Error(`${configPath}: expected \`park\` to be a map`);
		}
		const ar = parkBlock["auto-resume"];
		if (ar !== undefined) {
			if (typeof ar !== "boolean") {
				throw new Error(`${configPath}: expected \`park.auto-resume\` to be a boolean, got ${typeof ar}`);
			}
			parkAutoResume = ar;
		}
		const mw = parkBlock["max-wait"];
		if (mw !== undefined) {
			if (!isString(mw)) {
				throw new Error(`${configPath}: expected \`park.max-wait\` to be a string, got ${typeof mw}`);
			}
			parkMaxWait = mw;
		}
	}

	return {
		repo,
		worktreePrefix,
		budgets,
		turnLimits,
		effort,
		modelProfiles,
		profileBudgets,
		profileTurnLimits,
		profileEffort,
		shipTarget,
		roadmapSource,
		roadmapGithub,
		roadmapLinear,
		park: { autoResume: parkAutoResume, maxWait: parkMaxWait },
	};
}

// ── Step-settings resolver ─────────────────────────────────────────────

export interface StepSettings {
	budget: number;
	turns: number;
	effort: Effort;
	model: string | undefined;
}

/**
 * Resolve the effective per-step settings for a profile.
 * Precedence: profile override > global step value (top-level yml merged onto
 * DEFAULTS). The sparse override maps hold only steps a profile explicitly sets,
 * so a missing key falls through to the always-present global — a resolution can
 * never surface `undefined` for budget/turns/effort. `model` stays
 * `string | undefined` (a profile need not name every step; the SDK defaults).
 */
export function resolveStepSettings(config: ResolvedConfig, profile: string, step: Step): StepSettings {
	return {
		budget: config.profileBudgets[profile]?.[step] ?? config.budgets[step],
		turns: config.profileTurnLimits[profile]?.[step] ?? config.turnLimits[step],
		effort: config.profileEffort[profile]?.[step] ?? config.effort[step],
		model: config.modelProfiles[profile]?.[step],
	};
}

// ── Resolved exports (populated at import time) ────────────────────────

export const CONFIG = loadConfig();

export const WORKTREE_PREFIX = CONFIG.worktreePrefix;
export const MODEL_PROFILES: Record<string, Partial<Record<Step, string>>> = CONFIG.modelProfiles;
export const SHIP_TARGET: ShipTargetName = CONFIG.shipTarget;
export const ROADMAP_SOURCE: RoadmapSourceName = CONFIG.roadmapSource;
export const ROADMAP_GITHUB: GithubRoadmapConfig = CONFIG.roadmapGithub;
export const ROADMAP_LINEAR: LinearRoadmapConfig = CONFIG.roadmapLinear;
