import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { NOTIFY_EVENTS, NOTIFY_FORMATS, type NotifyConfig, type NotifyEvent, type NotifyFormat } from "./notify.js";
import { type GithubRoadmapConfig, type LinearRoadmapConfig, PLAN_LOCATIONS, type PlanLocation, ROADMAP_SOURCE_NAMES, type RoadmapSourceName } from "./roadmap/types.js";
import type { ProviderName, ShipTargetName } from "./types.js";

const SHIP_TARGET_NAMES: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

// Security-relevant default: `pull-request` keeps a human review gate in the loop.
// `direct-push` / `auto-merge-pr` are explicit opt-ins (they emit a loud startup banner).
export const DEFAULT_SHIP_TARGET: ShipTargetName = "pull-request";

// The backends a step's model can run on. Mirrors `SHIP_TARGET_NAMES`: the type
// lives in `types.ts`, this validation array is its module-private companion. #80
// widens both to add a second provider. `DEFAULT_PROVIDER` is the fallback every
// step resolves to when a profile names none, so no provider string is hardcoded
// outside this file.
const PROVIDER_NAMES: readonly ProviderName[] = ["claude", "codex"];
const DEFAULT_PROVIDER: ProviderName = "claude";
const isProviderName = (v: unknown): v is ProviderName => typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);

// ── Paths ──────────────────────────────────────────────────────────────

/**
 * Resolve the consuming repo's root.
 *
 * Resolution order:
 *   1. `PELAGGIO_REPO` env var (escape hatch, mirrors `PELAGGIO_WORKTREE_PREFIX`).
 *   2. `git rev-parse --show-toplevel` from CWD — works whether pelaggio lives
 *      in the repo itself (dogfooding) or under `node_modules/` (consumer install).
 */
export function resolveRepo(): string {
	if (process.env.PELAGGIO_REPO) return resolve(process.env.PELAGGIO_REPO);
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
	} catch {
		throw new Error("pelaggio must run inside a git repository (or set PELAGGIO_REPO)");
	}
}

export const REPO = resolveRepo();
export const LOG_PATH = resolve(REPO, ".dev", "pelaggio-log.jsonl");

// ── Pipeline steps ─────────────────────────────────────────────────────

export const STEPS = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"] as const;
export type PipelineStep = (typeof STEPS)[number];
/** Pipeline steps + non-pipeline actions. These carry per-step config but are absent from `STEPS`. */
export type Step = PipelineStep | "shipwreck" | "pr-review" | "pr-verify";

/** Type guard for a valid pipeline step. Excludes all non-pipeline actions — see `--from` validation in pipeline.ts. */
export function isPipelineStep(s: string): s is PipelineStep {
	return (STEPS as readonly string[]).includes(s);
}

const ALL_STEPS: readonly Step[] = [...STEPS, "shipwreck", "pr-review", "pr-verify"];

// ── Model literals ─────────────────────────────────────────────────────

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-5";

// ── Defaults ───────────────────────────────────────────────────────────

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReviewRunner = "ci" | "local";

export interface ResolvedConfig {
	repo: string;
	worktreePrefix: string;
	/** The yml-layer prefix alone (no env/basename fallback) — adapters resolve their own repo-local default. */
	worktreePrefixFromYml: string | undefined;
	budgets: Record<Step, number>;
	turnLimits: Record<Step, number>;
	effort: Record<Step, Effort>;
	modelProfiles: Record<string, Partial<Record<Step, string>>>;
	profileCodexModels: Record<string, Partial<Record<Step, string>>>;
	profileBudgets: Record<string, Partial<Record<Step, number>>>;
	profileTurnLimits: Record<string, Partial<Record<Step, number>>>;
	profileEffort: Record<string, Partial<Record<Step, Effort>>>;
	profileProviders: Record<string, Partial<Record<Step, ProviderName>>>;
	shipTarget: ShipTargetName;
	roadmapSource: RoadmapSourceName;
	roadmapGithub: GithubRoadmapConfig;
	roadmapLinear: LinearRoadmapConfig;
	/** Overnight park-and-resume policy. `maxWait` and `unknownResetWait` are raw wait
	 *  strings (parsed with `parseWaitFlag` at the consumer to avoid a config↔helpers
	 *  import cycle). `unknownResetWait` is the conservative estimate used when a rate-limit
	 *  event carries no reset time (Codex 429s never do — issue #68). */
	park: { autoResume: boolean; maxWait: string; unknownResetWait: string };
	/** Local revise sweep (issue #76). When `local` is true (the default), an auto-pick run on a
	 *  github-issues + PR-ship repo sweeps for red-review PRs and revises them in-process on the
	 *  local Claude subscription. `local: false` is the documented off-switch. */
	revise: { local: boolean };
	/** PR review poster. `ci` preserves the GitHub Actions gate; `local` runs a trusted local sweep
	 *  and posts commit statuses with context `review`. `statuslessAfter` is parsed by consumers. */
	review: ReviewConfig;
	/** Worktree confinement policy. Allowing a dirty main checkout disables only main-root auditing. */
	confinement: { allowDirtyMain: boolean };
	/** Outbound run-outcome notifications. Disabled when `url` is empty (the default). */
	notify: NotifyConfig;
}

export type ProviderDiversityPolicy = "off" | "prefer" | "require";
export interface ReviewConfig {
	runner: ReviewRunner;
	statuslessAfter: string;
	maxPasses: number;
	budgetCap: number;
	providerDiversity: ProviderDiversityPolicy;
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
		"pr-verify": 5,
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
		"pr-verify": 60,
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
		"pr-verify": "xhigh",
	} satisfies Record<Step, Effort>,
	// `pr-verify` deliberately stays sparse: its model/provider settings inherit
	// the resolved `pr-review` settings unless a consumer supplies an override.
	modelProfiles: {
		standard: { pick: SONNET, plan: OPUS, "shakedown-plan": OPUS, implement: OPUS, "shakedown-code": OPUS, ship: OPUS, shipwreck: SONNET, "pr-review": OPUS },
		quick: { pick: SONNET, plan: SONNET, "shakedown-plan": SONNET, implement: SONNET, "shakedown-code": SONNET, ship: SONNET, shipwreck: SONNET, "pr-review": SONNET },
	} satisfies Record<string, Partial<Record<Step, string>>>,
	// Default `autoResume: true` preserves today's waiting behavior (the pipeline already
	// waits by default via the old `--max-wait` 6h default) — flipping it false would
	// regress unattended overnight runs. `false` is the explicit interactive off-switch.
	park: { autoResume: true, maxWait: "6h", unknownResetWait: "60m" },
	// Local revise sweep on by default (issue #76 frames the knob as *opt-out*). The sweep is a
	// hard no-op unless the repo is github-issues + a PR ship target + auto-pick mode, so
	// default-on does nothing for every markdown/direct-push consumer. `revise.local: false` is
	// the off-switch, mirroring the CI `AUTOPILOT_AUTO_REVISE=false` off-switch.
	revise: { local: true },
	review: { runner: "ci", statuslessAfter: "2h", maxPasses: 1, budgetCap: 20, providerDiversity: "off" },
	confinement: { allowDirtyMain: false },
	// Notifications off by default (empty url). Enabling only `notify.url` turns on every
	// event with the `json` format; `format: ntfy` + a topic URL gives ntfy.sh pushes.
	// `NOTIFY_EVENTS` is the single source of the event list (validation uses it too) —
	// a new event added in notify.ts is subscribed-by-default and yml-valid with no edit here.
	notify: { url: "", format: "json", events: NOTIFY_EVENTS },
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
const isReviewRunner = (v: unknown): v is ReviewRunner => v === "ci" || v === "local";

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
	codexModels: Record<string, Partial<Record<Step, string>>>;
	budgets: Record<string, Partial<Record<Step, number>>>;
	turnLimits: Record<string, Partial<Record<Step, number>>>;
	effort: Record<string, Partial<Record<Step, Effort>>>;
	providers: Record<string, Partial<Record<Step, ProviderName>>>;
}

function parseProfiles(defaults: Record<string, Partial<Record<Step, string>>>, override: unknown, configPath: string): ParsedProfiles {
	const models: Record<string, Partial<Record<Step, string>>> = {};
	for (const [name, base] of Object.entries(defaults)) models[name] = { ...base };
	const budgets: Record<string, Partial<Record<Step, number>>> = {};
	const codexModels: Record<string, Partial<Record<Step, string>>> = {};
	const turnLimits: Record<string, Partial<Record<Step, number>>> = {};
	const effort: Record<string, Partial<Record<Step, Effort>>> = {};
	const providers: Record<string, Partial<Record<Step, ProviderName>>> = {};

	if (override === undefined) return { models, codexModels, budgets, turnLimits, effort, providers };
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
		const p = parseSparseStepRecord(profile.providers, `models.profiles.${name}.providers`, isProviderName, configPath);
		if (Object.keys(p).length > 0) providers[name] = p;
		const cm = parseSparseStepRecord(profile.codex, `models.profiles.${name}.codex`, isString, configPath);
		if (Object.keys(cm).length > 0) codexModels[name] = cm;
	}
	return { models, codexModels, budgets, turnLimits, effort, providers };
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
	const configPath = opts.configPath ?? resolve(repo, ".pelaggio.yml");
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
	const {
		models: modelProfiles,
		codexModels: profileCodexModels,
		budgets: profileBudgets,
		turnLimits: profileTurnLimits,
		effort: profileEffort,
		providers: profileProviders,
	} = parseProfiles(DEFAULTS.modelProfiles, profilesOverride, configPath);

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
	const worktreePrefix = process.env.PELAGGIO_WORKTREE_PREFIX ?? ymlPrefix ?? `${basename(repo)}-`;

	// ship.target: default DEFAULT_SHIP_TARGET ("pull-request"); validate against SHIP_TARGET_NAMES
	let shipTarget: ShipTargetName = DEFAULT_SHIP_TARGET;
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
	let parkUnknownResetWait: string = DEFAULTS.park.unknownResetWait;
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
		const urw = parkBlock["unknown-reset-wait"];
		if (urw !== undefined) {
			if (!isString(urw)) {
				throw new Error(`${configPath}: expected \`park.unknown-reset-wait\` to be a string, got ${typeof urw}`);
			}
			parkUnknownResetWait = urw;
		}
	}

	// revise.local: local revise sweep on/off (issue #76). Type-validate only.
	let reviseLocal: boolean = DEFAULTS.revise.local;
	const reviseBlock = yml.revise;
	if (reviseBlock !== undefined) {
		if (!isPlainObject(reviseBlock)) {
			throw new Error(`${configPath}: expected \`revise\` to be a map`);
		}
		const local = reviseBlock.local;
		if (local !== undefined) {
			if (typeof local !== "boolean") {
				throw new Error(`${configPath}: expected \`revise.local\` to be a boolean, got ${typeof local}`);
			}
			reviseLocal = local;
		}
	}

	// review.*: CI vs local PR-review poster. Type-validate only; the wait string is parsed by
	// the sweep consumer with parseWaitFlag, matching park.max-wait's tolerant parsing.
	let reviewRunner: ReviewRunner = DEFAULTS.review.runner;
	let reviewStatuslessAfter: string = DEFAULTS.review.statuslessAfter;
	let reviewMaxPasses: number = DEFAULTS.review.maxPasses;
	let reviewBudgetCap: number = DEFAULTS.review.budgetCap;
	let reviewProviderDiversity: ProviderDiversityPolicy = DEFAULTS.review.providerDiversity;
	const reviewBlock = yml.review;
	if (reviewBlock !== undefined) {
		if (!isPlainObject(reviewBlock)) {
			throw new Error(`${configPath}: expected \`review\` to be a map`);
		}
		const runner = reviewBlock.runner;
		if (runner !== undefined) {
			if (!isReviewRunner(runner)) {
				throw new Error(`${configPath}: expected \`review.runner\` to be one of ci|local, got ${JSON.stringify(runner)}`);
			}
			reviewRunner = runner;
		}
		const statuslessAfter = reviewBlock["statusless-after"];
		if (statuslessAfter !== undefined) {
			if (!isString(statuslessAfter)) {
				throw new Error(`${configPath}: expected \`review.statusless-after\` to be a string, got ${typeof statuslessAfter}`);
			}
			reviewStatuslessAfter = statuslessAfter;
		}
		const maxPasses = reviewBlock["max-passes"];
		if (maxPasses !== undefined) {
			if (!Number.isInteger(maxPasses) || (maxPasses as number) < 1 || (maxPasses as number) > 3) throw new Error(`${configPath}: expected \`review.max-passes\` to be an integer from 1 to 3, got ${JSON.stringify(maxPasses)}`);
			reviewMaxPasses = maxPasses as number;
		}
		const budgetCap = reviewBlock["budget-cap"];
		if (budgetCap !== undefined) {
			if (typeof budgetCap !== "number" || !Number.isFinite(budgetCap) || budgetCap <= 0) throw new Error(`${configPath}: expected \`review.budget-cap\` to be a finite positive number, got ${JSON.stringify(budgetCap)}`);
			reviewBudgetCap = budgetCap;
		}
		const providerDiversity = reviewBlock["provider-diversity"];
		if (providerDiversity !== undefined) {
			if (providerDiversity !== "off" && providerDiversity !== "prefer" && providerDiversity !== "require")
				throw new Error(`${configPath}: expected \`review.provider-diversity\` to be one of off|prefer|require, got ${JSON.stringify(providerDiversity)}`);
			reviewProviderDiversity = providerDiversity;
		}
	}

	let confinementAllowDirtyMain: boolean = DEFAULTS.confinement.allowDirtyMain;
	const confinementBlock = yml.confinement;
	if (confinementBlock !== undefined) {
		if (!isPlainObject(confinementBlock)) {
			throw new Error(`${configPath}: expected \`confinement\` to be a map`);
		}
		const allowDirtyMain = confinementBlock["allow-dirty-main"];
		if (allowDirtyMain !== undefined) {
			if (typeof allowDirtyMain !== "boolean") {
				throw new Error(`${configPath}: expected \`confinement.allow-dirty-main\` to be a boolean, got ${typeof allowDirtyMain}`);
			}
			confinementAllowDirtyMain = allowDirtyMain;
		}
	}

	// notify.*: outbound run-outcome webhook. Disabled by default (url: "").
	let notifyUrl: string = DEFAULTS.notify.url;
	let notifyFormat: NotifyFormat = DEFAULTS.notify.format;
	let notifyEvents: NotifyEvent[] = [...DEFAULTS.notify.events];
	const notifyBlock = yml.notify;
	if (notifyBlock !== undefined) {
		if (!isPlainObject(notifyBlock)) {
			throw new Error(`${configPath}: expected \`notify\` to be a map`);
		}
		if (notifyBlock.url !== undefined) {
			if (!isString(notifyBlock.url)) {
				throw new Error(`${configPath}: expected \`notify.url\` to be a string`);
			}
			notifyUrl = notifyBlock.url;
		}
		if (notifyBlock.format !== undefined) {
			if (!isString(notifyBlock.format) || !(NOTIFY_FORMATS as readonly string[]).includes(notifyBlock.format)) {
				throw new Error(`${configPath}: expected \`notify.format\` to be one of ${NOTIFY_FORMATS.join("|")}, got ${JSON.stringify(notifyBlock.format)}`);
			}
			notifyFormat = notifyBlock.format as NotifyFormat;
		}
		if (notifyBlock.events !== undefined) {
			if (!Array.isArray(notifyBlock.events)) {
				throw new Error(`${configPath}: expected \`notify.events\` to be an array, got ${typeof notifyBlock.events}`);
			}
			for (const ev of notifyBlock.events) {
				if (!isString(ev) || !(NOTIFY_EVENTS as readonly string[]).includes(ev)) {
					throw new Error(`${configPath}: expected \`notify.events\` entries to be one of ${NOTIFY_EVENTS.join("|")}, got ${JSON.stringify(ev)}`);
				}
			}
			notifyEvents = notifyBlock.events as NotifyEvent[];
		}
	}

	return {
		repo,
		worktreePrefix,
		worktreePrefixFromYml: ymlPrefix,
		budgets,
		turnLimits,
		effort,
		modelProfiles,
		profileCodexModels,
		profileBudgets,
		profileTurnLimits,
		profileEffort,
		profileProviders,
		shipTarget,
		roadmapSource,
		roadmapGithub,
		roadmapLinear,
		park: { autoResume: parkAutoResume, maxWait: parkMaxWait, unknownResetWait: parkUnknownResetWait },
		revise: { local: reviseLocal },
		review: { runner: reviewRunner, statuslessAfter: reviewStatuslessAfter, maxPasses: reviewMaxPasses, budgetCap: reviewBudgetCap, providerDiversity: reviewProviderDiversity },
		confinement: { allowDirtyMain: confinementAllowDirtyMain },
		notify: { url: notifyUrl, format: notifyFormat, events: notifyEvents },
	};
}

// ── Step-settings resolver ─────────────────────────────────────────────

export interface StepSettings {
	budget: number;
	turns: number;
	effort: Effort;
	model: string | undefined;
	codexModel: string | undefined;
	provider: ProviderName;
}

/**
 * Resolve the effective per-step settings for a profile.
 * Precedence: profile override > global step value (top-level yml merged onto
 * DEFAULTS). The sparse override maps hold only steps a profile explicitly sets,
 * so a missing key falls through to the always-present global — a resolution can
 * never surface `undefined` for budget/turns/effort. `model` and `codexModel`
 * stay `string | undefined` (a profile need not name every step; the SDK/CLI
 * defaults). `codexModel` mirrors `model` as a sparse per-profile lookup with
 * no default fill. `provider` mirrors `model`'s per-profile lookup but falls back to
 * `DEFAULT_PROVIDER` instead of `undefined`, so it never surfaces unset — every
 * present and future step resolves to a concrete backend with no exhaustive map.
 */
export function resolveStepSettings(config: ResolvedConfig, profile: string, step: Step): StepSettings {
	const inheritedStep = step === "pr-verify" ? "pr-review" : step;
	return {
		budget: config.profileBudgets[profile]?.[step] ?? config.budgets[step],
		turns: config.profileTurnLimits[profile]?.[step] ?? config.turnLimits[step],
		effort: config.profileEffort[profile]?.[step] ?? config.effort[step],
		model: config.modelProfiles[profile]?.[step] ?? config.modelProfiles[profile]?.[inheritedStep],
		codexModel: config.profileCodexModels[profile]?.[step] ?? config.profileCodexModels[profile]?.[inheritedStep],
		provider: config.profileProviders[profile]?.[step] ?? config.profileProviders[profile]?.[inheritedStep] ?? DEFAULT_PROVIDER,
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
export const REVISE_LOCAL: boolean = CONFIG.revise.local;
export const REVIEW_CONFIG: ReviewConfig = CONFIG.review;
export const CONFINEMENT_CONFIG: { allowDirtyMain: boolean } = CONFIG.confinement;
