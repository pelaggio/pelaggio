import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { NOTIFY_EVENTS, NOTIFY_FORMATS, type NotifyConfig, type NotifyEvent, type NotifyFormat } from "./notify-schema.js";
import { type RawTaxonomyInput, resolveTaxonomy, type TaxonomyConfig } from "./review/taxonomy.js";
import { type GithubRoadmapConfig, isScope, type LinearRoadmapConfig, PLAN_LOCATIONS, type PlanLocation, ROADMAP_SOURCE_NAMES, type RoadmapSourceName, type Scope } from "./roadmap/types.js";
import { ALL_STEPS, type Step } from "./step-names.js";
import type { ProviderName, ShipTargetName } from "./types.js";

const SHIP_TARGET_NAMES: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

// Security-relevant default: `pull-request` keeps a human review gate in the loop.
// `direct-push` / `auto-merge-pr` are explicit opt-ins (they emit a loud startup banner).
export const DEFAULT_SHIP_TARGET: ShipTargetName = "pull-request";

// The backends a step's model can run on. Mirrors `SHIP_TARGET_NAMES`: the type
// lives in `types.ts`, this validation array is its module-private companion. #80
// opened both for a second provider; codex/grok/opencode (#137) now register here.
// `DEFAULT_PROVIDER` is the fallback every step resolves to when a profile names
// none, so no provider string is hardcoded outside this file.
const PROVIDER_NAMES: readonly ProviderName[] = ["claude", "codex", "grok", "opencode"];
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

// ── Model literals ─────────────────────────────────────────────────────

const OPUS = "claude-opus-5";
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
	/** Sparse per-profile Grok/OpenCode model maps (issue #431). Mirror `profileCodexModels`:
	 *  a provider only receives a model for a step it explicitly names, else its CLI default. */
	profileGrokModels: Record<string, Partial<Record<Step, string>>>;
	profileOpenCodeModels: Record<string, Partial<Record<Step, string>>>;
	profileBudgets: Record<string, Partial<Record<Step, number>>>;
	profileTurnLimits: Record<string, Partial<Record<Step, number>>>;
	profileEffort: Record<string, Partial<Record<Step, Effort>>>;
	profileProviders: Record<string, Partial<Record<Step, ProviderSelection>>>;
	/** Per-provider driver executable override (issue #241). Keyed by provider name; a missing
	 *  entry falls back to the provider's default binary (resolved via PATH). Lets an off-PATH
	 *  driver (e.g. `~/.grok/bin/grok`) be pinned without editing PATH. */
	providerBins: Partial<Record<ProviderName, string>>;
	/** Explicit escape hatch for Linux hosts whose kernel does not expose Landlock. */
	grokAllowUnsandboxedFallback: boolean;
	shipTarget: ShipTargetName;
	/** Checks that must be present + green for the `--admin` red-merge guard (#292). Default
	 *  `["ci"]`; an explicit `[]` is the "no gating CI" escape hatch. */
	shipRequiredChecks: string[];
	roadmapSource: RoadmapSourceName;
	roadmapGithub: GithubRoadmapConfig;
	roadmapLinear: LinearRoadmapConfig;
	/** Auto-pick readiness gate (#201). Explicit `--item` bypasses it; `XL` disables it. */
	pick: { maxScope: Scope };
	/** Overnight park-and-resume policy. `maxWait` and `unknownResetWait` are raw wait
	 *  strings (parsed with `parseWaitFlag` at the consumer to avoid a config↔helpers
	 *  import cycle). `unknownResetWait` is the conservative estimate used when a rate-limit
	 *  event carries no reset time (Codex 429s never do — issue #68). */
	park: { autoResume: boolean; maxWait: string; unknownResetWait: string };
	/** Continuous watch day-budget default (issue #83). Undefined = unlimited. CLI
	 *  `--day-budget` overrides this when present; server StartForm prefill surfaces it. */
	watch: { dailyBudget?: number };
	/** Local revise sweep (issue #76). When `local` is true (the default), an auto-pick run on a
	 *  github-issues + PR-ship repo sweeps for red-review PRs and revises them in-process on the
	 *  local Claude subscription. `local: false` is the documented off-switch. */
	revise: { local: boolean };
	/** PR review poster. `ci` preserves the GitHub Actions gate; `local` runs a trusted local sweep
	 *  and posts commit statuses with context `review`. `statuslessAfter` is parsed by consumers. */
	review: ReviewConfig;
	/** Worktree confinement policy. Allowing a dirty main checkout disables only main-root auditing. */
	confinement: { allowDirtyMain: boolean };
	/** Secret hygiene for spawned driver subprocesses (issue #237 / TC-014). `envAllowlist` names
	 *  extra env vars forwarded to a child beyond the deny-by-default allowlist — e.g. a driver's
	 *  auth var when using key auth. Empty by default. */
	security: { envAllowlist: string[] };
	/** Outbound run-outcome notifications. Disabled when `url` is empty (the default). */
	notify: NotifyConfig;
}

export type ProviderPool = readonly [ProviderName, ...ProviderName[]];
export type ProviderSelection = ProviderName | ProviderPool;

export type ProviderDiversityPolicy = "off" | "prefer" | "require";
export type AuthoringReviewMode = "off" | "local" | "keys";
/** @deprecated Prefer `ReviewFindingClass` from `./review/findings.js` (an alias of this id type). */
export type { FindingClassId as AuthoringFindingClass } from "./review/taxonomy.js";
export type AuthoringBlockingBar = "must-fix";
export type ReviewSlot = { id: string; provider: "claude" | "grok" | "opencode"; model?: string } | { id: string; provider: "codex"; codexModel?: string };
export interface AuthoringReviewConfig {
	enabled: AuthoringReviewMode;
	reviewers: ReviewSlot[];
	judge: ReviewSlot;
	blockingBar: AuthoringBlockingBar;
	maxPasses: number;
	maxRevisions: number;
	budgetCap: number;
	providerDiversity: "prefer";
}
export interface ReviewConfig {
	runner: ReviewRunner;
	statuslessAfter: string;
	maxPasses: number;
	budgetCap: number;
	providerDiversity: ProviderDiversityPolicy;
	/** Cross-push finding-disposition carry (#495). `false` (the shipped default — canary-off)
	 *  restores per-push cold reviews exactly (no reads, no narrowing — disposition records are
	 *  still written, so enabling later has priors). Default stays `false` until the store-trust
	 *  prerequisite is met for every local review provider: the carry stores are AUTHORIZATION
	 *  inputs, and the grok seat's write surface at main cwd is not yet verified closed (Claude
	 *  seats get denial hooks; codex review seats run read-only — see docs/pr-review.md). */
	carry: boolean;
	authoring: AuthoringReviewConfig;
	/** ADR-0016 safety/judgment taxonomy (baseline ADR table; owner-signed to contract the floor). */
	taxonomy: TaxonomyConfig;
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
	pick: { maxScope: "M" } satisfies { maxScope: Scope },
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
	// Continuous watch day-budget: absent / undefined means unlimited (issue #83).
	watch: {} as { dailyBudget?: number },
	// Local revise sweep on by default (issue #76 frames the knob as *opt-out*). The sweep is a
	// hard no-op unless the repo is github-issues + a PR ship target + auto-pick mode, so
	// default-on does nothing for every markdown/direct-push consumer. `revise.local: false` is
	// the off-switch, mirroring the CI `AUTOPILOT_AUTO_REVISE=false` off-switch.
	revise: { local: true },
	review: {
		runner: "ci",
		statuslessAfter: "2h",
		maxPasses: 1,
		budgetCap: 20,
		providerDiversity: "off",
		carry: false,
		taxonomy: resolveTaxonomy({}),
		authoring: {
			enabled: "off",
			reviewers: [
				{ id: "claude", provider: "claude" },
				{ id: "codex", provider: "codex" },
				{ id: "grok", provider: "grok" },
			],
			judge: { id: "judge", provider: "claude" },
			blockingBar: "must-fix",
			maxPasses: 5,
			maxRevisions: 4,
			budgetCap: 180,
			providerDiversity: "prefer",
		},
	},
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

function parseReviewSlot(value: unknown, label: string, configPath: string, fallbackId?: string): ReviewSlot {
	if (!isPlainObject(value)) throw new Error(`${configPath}: expected \`${label}\` to be a map`);
	const id = value.id ?? fallbackId;
	if (!isString(id) || id.trim() === "") throw new Error(`${configPath}: expected \`${label}.id\` to be a non-empty string`);
	if (!isProviderName(value.provider)) throw new Error(`${configPath}: expected \`${label}.provider\` to be one of ${PROVIDER_NAMES.join("|")}`);
	if (value.provider === "codex") {
		if (value.model !== undefined) throw new Error(`${configPath}: \`${label}.model\` cannot be used with codex; use codex-model`);
		const codexModel = value["codex-model"];
		if (codexModel !== undefined && (!isString(codexModel) || codexModel.trim() === "")) throw new Error(`${configPath}: expected \`${label}.codex-model\` to be a non-empty string`);
		return { id, provider: "codex", ...(codexModel ? { codexModel } : {}) };
	}
	if (value["codex-model"] !== undefined) throw new Error(`${configPath}: \`${label}.codex-model\` is only valid for codex`);
	const model = value.model;
	if (model !== undefined && (!isString(model) || model.trim() === "")) throw new Error(`${configPath}: expected \`${label}.model\` to be a non-empty string`);
	return { id, provider: value.provider, ...(model ? { model } : {}) };
}

/**
 * Structurally validate `review.taxonomy` into a `RawTaxonomyInput` (fail-closed). Strictly rejects unknown
 * keys here and under `classes` / `contract` (the surrounding `review` block is not strict-keyed). Does NOT
 * apply the signed-contraction gate — that is `resolveTaxonomy`'s job (class-id grammar, tier values, sig).
 */
function readRawTaxonomy(value: unknown, configPath: string): RawTaxonomyInput {
	if (!isPlainObject(value)) throw new Error(`${configPath}: expected \`review.taxonomy\` to be a map`);
	const allowed = ["owner", "judgment-default", "classes", "contract"];
	const unknownKey = Object.keys(value).find((k) => !allowed.includes(k));
	if (unknownKey) throw new Error(`${configPath}: unknown key \`review.taxonomy.${unknownKey}\``);
	const raw: RawTaxonomyInput = {};
	if (value.owner !== undefined) {
		if (!isString(value.owner) || value.owner.trim() === "") throw new Error(`${configPath}: expected \`review.taxonomy.owner\` to be a non-empty string`);
		raw.owner = value.owner;
	}
	const judgmentDefault = value["judgment-default"];
	if (judgmentDefault !== undefined) {
		if (judgmentDefault !== "permissive" && judgmentDefault !== "park") throw new Error(`${configPath}: expected \`review.taxonomy.judgment-default\` to be permissive|park, got ${JSON.stringify(judgmentDefault)}`);
		raw.judgmentDefault = judgmentDefault;
	}
	if (value.classes !== undefined) {
		if (!isPlainObject(value.classes)) throw new Error(`${configPath}: expected \`review.taxonomy.classes\` to be a map`);
		const classes: Record<string, string> = {};
		for (const [id, tier] of Object.entries(value.classes)) {
			if (tier !== "safety" && tier !== "judgment") throw new Error(`${configPath}: expected \`review.taxonomy.classes.${id}\` to be safety|judgment, got ${JSON.stringify(tier)}`);
			classes[id] = tier;
		}
		raw.classes = classes;
	}
	if (value.contract !== undefined) {
		if (!isPlainObject(value.contract)) throw new Error(`${configPath}: expected \`review.taxonomy.contract\` to be a map`);
		const unknownContractKey = Object.keys(value.contract).find((k) => k !== "signature-b64");
		if (unknownContractKey) throw new Error(`${configPath}: unknown key \`review.taxonomy.contract.${unknownContractKey}\``);
		const sig = value.contract["signature-b64"];
		if (!isString(sig) || sig.trim() === "") throw new Error(`${configPath}: expected \`review.taxonomy.contract.signature-b64\` to be a non-empty string`);
		raw.contract = { signatureB64: sig };
	}
	return raw;
}

/** Parse + gate `review.taxonomy` into a resolved `TaxonomyConfig`, throwing with config-path context. */
function parseTaxonomyBlock(value: unknown, configPath: string): TaxonomyConfig {
	const raw = readRawTaxonomy(value, configPath);
	try {
		return resolveTaxonomy(raw);
	} catch (error) {
		throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Read `review.taxonomy` into a validated `RawTaxonomyInput` WITHOUT the signed-contraction gate. The
 * operator `taxonomy sign` / `canonical` paths need the pre-gate overlay: a contracted config is unsigned at
 * sign time, so the full `loadConfig` would reject it before the owner can produce the signature.
 */
export function readTaxonomyOverlay(opts: { repo?: string; configPath?: string } = {}): RawTaxonomyInput {
	const repo = opts.repo ?? REPO;
	const configPath = opts.configPath ?? resolve(repo, ".pelaggio.yml");
	const reviewBlock = parseFile(configPath).review;
	if (reviewBlock === undefined) return {};
	if (!isPlainObject(reviewBlock)) throw new Error(`${configPath}: expected \`review\` to be a map`);
	if (reviewBlock.taxonomy === undefined) return {};
	return readRawTaxonomy(reviewBlock.taxonomy, configPath);
}

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
	grokModels: Record<string, Partial<Record<Step, string>>>;
	openCodeModels: Record<string, Partial<Record<Step, string>>>;
	budgets: Record<string, Partial<Record<Step, number>>>;
	turnLimits: Record<string, Partial<Record<Step, number>>>;
	effort: Record<string, Partial<Record<Step, Effort>>>;
	providers: Record<string, Partial<Record<Step, ProviderSelection>>>;
}

// pr-review is a fan-out set (every candidate runs); other pooled steps are selection sets
// (pipeline picks one eligible driver). Same config type; semantics differ by step.
const POOLED_STEPS: readonly Step[] = ["plan", "implement", "shakedown-plan", "shakedown-code", "pr-review"];

function parseProviderSelections(override: unknown, section: string, configPath: string): Partial<Record<Step, ProviderSelection>> {
	if (override === undefined) return {};
	if (!isPlainObject(override)) throw new Error(`${configPath}: expected \`${section}\` to be a map, got ${Array.isArray(override) ? "array" : typeof override}`);
	const out: Partial<Record<Step, ProviderSelection>> = {};
	for (const [key, value] of Object.entries(override)) {
		if (!isStep(key)) throw new Error(`${configPath}: unknown step at \`${section}.${key}\``);
		if (!Array.isArray(value)) {
			if (!isProviderName(value)) throw new Error(`${configPath}: invalid value at \`${section}.${key}\``);
			out[key] = value;
			continue;
		}
		if (!(POOLED_STEPS as readonly string[]).includes(key)) throw new Error(`${configPath}: provider lists are not supported at \`${section}.${key}\``);
		if (value.length === 0) throw new Error(`${configPath}: expected \`${section}.${key}\` to be a non-empty provider list`);
		const names: ProviderName[] = [];
		for (const entry of value) {
			if (!isProviderName(entry)) throw new Error(`${configPath}: invalid provider in \`${section}.${key}\``);
			names.push(entry);
		}
		if (new Set(names).size !== names.length) throw new Error(`${configPath}: duplicate provider in \`${section}.${key}\``);
		const [first, ...rest] = names;
		if (first === undefined) throw new Error(`${configPath}: expected \`${section}.${key}\` to be a non-empty provider list`);
		out[key] = [first, ...rest];
	}
	return out;
}

function parseProfiles(defaults: Record<string, Partial<Record<Step, string>>>, override: unknown, configPath: string): ParsedProfiles {
	const models: Record<string, Partial<Record<Step, string>>> = {};
	for (const [name, base] of Object.entries(defaults)) models[name] = { ...base };
	const budgets: Record<string, Partial<Record<Step, number>>> = {};
	const codexModels: Record<string, Partial<Record<Step, string>>> = {};
	const grokModels: Record<string, Partial<Record<Step, string>>> = {};
	const openCodeModels: Record<string, Partial<Record<Step, string>>> = {};
	const turnLimits: Record<string, Partial<Record<Step, number>>> = {};
	const effort: Record<string, Partial<Record<Step, Effort>>> = {};
	const providers: Record<string, Partial<Record<Step, ProviderSelection>>> = {};

	if (override === undefined) return { models, codexModels, grokModels, openCodeModels, budgets, turnLimits, effort, providers };
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
		const p = parseProviderSelections(profile.providers, `models.profiles.${name}.providers`, configPath);
		if (Object.keys(p).length > 0) providers[name] = p;
		const cm = parseSparseStepRecord(profile.codex, `models.profiles.${name}.codex`, isString, configPath);
		if (Object.keys(cm).length > 0) codexModels[name] = cm;
		const gm = parseSparseStepRecord(profile.grok, `models.profiles.${name}.grok`, isString, configPath);
		if (Object.keys(gm).length > 0) grokModels[name] = gm;
		const om = parseSparseStepRecord(profile.opencode, `models.profiles.${name}.opencode`, isString, configPath);
		if (Object.keys(om).length > 0) openCodeModels[name] = om;
	}
	return { models, codexModels, grokModels, openCodeModels, budgets, turnLimits, effort, providers };
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

	let pickMaxScope: Scope = DEFAULTS.pick.maxScope;
	const pickBlock = yml.pick;
	if (pickBlock !== undefined) {
		if (!isPlainObject(pickBlock)) {
			throw new Error(`${configPath}: expected \`pick\` to be a map`);
		}
		const value = pickBlock["max-scope"];
		const normalized = typeof value === "string" ? value.toUpperCase() : undefined;
		if (value !== undefined && !isScope(normalized)) {
			throw new Error(`${configPath}: expected \`pick.max-scope\` to be one of XS|S|M|L|XL, got ${JSON.stringify(value)}`);
		}
		if (isScope(normalized)) pickMaxScope = normalized;
	}

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
		grokModels: profileGrokModels,
		openCodeModels: profileOpenCodeModels,
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
	// ship.requiredChecks: the checks that must be present + green for the deterministic `--admin`
	// red-merge guard (issue #292). Default `["ci"]` — the near-universal gating check — so admin
	// land is fail-closed on a missing/pending/red `ci` out of the box. An explicit list overrides;
	// an explicit `[]` is the escape hatch for a repo with no gating CI (see `assertCiGreen`).
	let shipRequiredChecks: string[] = ["ci"];
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
		const rc = shipBlock["required-checks"];
		if (rc !== undefined) {
			if (!Array.isArray(rc) || !rc.every(isString)) {
				throw new Error(`${configPath}: expected \`ship.required-checks\` to be a list of check-name strings (use \`[]\` to assert no gating CI)`);
			}
			shipRequiredChecks = rc as string[];
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

	// watch.daily-budget: continuous watch day-budget default (issue #83). Absent = unlimited.
	let watchDailyBudget: number | undefined;
	const watchBlock = yml.watch;
	if (watchBlock !== undefined) {
		if (!isPlainObject(watchBlock)) {
			throw new Error(`${configPath}: expected \`watch\` to be a map`);
		}
		const dailyBudget = watchBlock["daily-budget"];
		if (dailyBudget !== undefined) {
			if (typeof dailyBudget !== "number" || !Number.isFinite(dailyBudget) || dailyBudget <= 0) {
				throw new Error(`${configPath}: expected \`watch.daily-budget\` to be a finite positive number, got ${JSON.stringify(dailyBudget)}`);
			}
			watchDailyBudget = dailyBudget;
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
	let reviewCarry: boolean = DEFAULTS.review.carry;
	let reviewAuthoring: AuthoringReviewConfig = {
		...DEFAULTS.review.authoring,
		reviewers: DEFAULTS.review.authoring.reviewers.map((slot) => ({ ...slot })),
		judge: { ...DEFAULTS.review.authoring.judge },
	};
	// Default to the baseline ADR taxonomy (empty overlay ⇒ no contraction ⇒ no signature required).
	let reviewTaxonomy: TaxonomyConfig = DEFAULTS.review.taxonomy;
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
		const carry = reviewBlock.carry;
		if (carry !== undefined) {
			if (typeof carry !== "boolean") throw new Error(`${configPath}: expected \`review.carry\` to be a boolean, got ${typeof carry}`);
			reviewCarry = carry;
		}
		const authoring = reviewBlock.authoring;
		if (authoring !== undefined) {
			if (!isPlainObject(authoring)) throw new Error(`${configPath}: expected \`review.authoring\` to be a map`);
			if (authoring.enabled !== undefined && typeof authoring.enabled !== "boolean" && authoring.enabled !== "off" && authoring.enabled !== "local" && authoring.enabled !== "keys")
				throw new Error(`${configPath}: expected \`review.authoring.enabled\` to be one of off|local|keys (legacy booleans are also accepted)`);
			let authoringMaxPasses = reviewAuthoring.maxPasses;
			if (authoring["max-passes"] !== undefined) {
				const mp = authoring["max-passes"];
				if (!Number.isInteger(mp) || (mp as number) < 1 || (mp as number) > 5) throw new Error(`${configPath}: \`review.authoring.max-passes\` must be an integer from 1 to 5, got ${JSON.stringify(mp)}`);
				authoringMaxPasses = mp as number;
			}
			let authoringMaxRevisions = Math.min(reviewAuthoring.maxRevisions, authoringMaxPasses - 1);
			if (authoring["max-revisions"] !== undefined) {
				const mr = authoring["max-revisions"];
				if (!Number.isInteger(mr) || (mr as number) < 0 || (mr as number) > authoringMaxPasses - 1)
					throw new Error(`${configPath}: \`review.authoring.max-revisions\` must be an integer from 0 to ${authoringMaxPasses - 1} (max-passes − 1), got ${JSON.stringify(mr)}`);
				authoringMaxRevisions = mr as number;
			}
			if (authoring["blocking-bar"] !== undefined && authoring["blocking-bar"] !== "must-fix") throw new Error(`${configPath}: \`review.authoring.blocking-bar\` must be must-fix`);
			if (authoring["provider-diversity"] !== undefined && authoring["provider-diversity"] !== "prefer") throw new Error(`${configPath}: \`review.authoring.provider-diversity\` must be prefer`);
			const cap = authoring["budget-cap"] ?? reviewAuthoring.budgetCap;
			if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) throw new Error(`${configPath}: expected \`review.authoring.budget-cap\` to be a finite positive number`);
			let reviewers = reviewAuthoring.reviewers;
			if (authoring.reviewers !== undefined) {
				if (!Array.isArray(authoring.reviewers) || authoring.reviewers.length === 0) throw new Error(`${configPath}: expected \`review.authoring.reviewers\` to be a non-empty array`);
				reviewers = authoring.reviewers.map((slot, index) => parseReviewSlot(slot, `review.authoring.reviewers[${index}]`, configPath, `reviewer-${index + 1}`));
				if (new Set(reviewers.map((slot) => slot.id)).size !== reviewers.length) throw new Error(`${configPath}: review.authoring reviewer ids must be unique`);
				if (new Set(reviewers.map((slot) => slot.provider)).size !== reviewers.length) throw new Error(`${configPath}: review.authoring reviewer providers must be unique`);
			}
			const judge = authoring.judge === undefined ? reviewAuthoring.judge : parseReviewSlot(authoring.judge, "review.authoring.judge", configPath, "judge");
			const enabled = authoring.enabled === true ? "local" : authoring.enabled === false ? "off" : ((authoring.enabled as AuthoringReviewMode | undefined) ?? reviewAuthoring.enabled);
			reviewAuthoring = {
				enabled,
				reviewers,
				judge,
				blockingBar: "must-fix",
				maxPasses: authoringMaxPasses,
				maxRevisions: authoringMaxRevisions,
				budgetCap: cap,
				providerDiversity: "prefer",
			};
		}
		if (reviewBlock.taxonomy !== undefined) reviewTaxonomy = parseTaxonomyBlock(reviewBlock.taxonomy, configPath);
	}

	// Per-invocation execution-context override for `review.authoring.enabled` — env wins over
	// file for this one key (mirrors PELAGGIO_WORKTREE_PREFIX). Repo CI callers use it to run
	// with authoring off without forking .pelaggio.yml: CI has no subprocess-provider keys, and
	// CI-shipped PRs are gated by the cold pr-review path, so the in-cycle loop is redundant there.
	const authoringEnvMode = process.env.PELAGGIO_AUTHORING_ENABLED;
	if (authoringEnvMode !== undefined) {
		if (authoringEnvMode !== "off" && authoringEnvMode !== "local" && authoringEnvMode !== "keys") {
			throw new Error(`PELAGGIO_AUTHORING_ENABLED must be one of off|local|keys, got ${JSON.stringify(authoringEnvMode)}`);
		}
		reviewAuthoring = { ...reviewAuthoring, enabled: authoringEnvMode };
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

	// providers.<name>.bin: per-provider driver executable override (issue #241). Lets an
	// off-PATH driver be pinned without editing PATH; a leading `~/` expands at resolve time.
	// Validated against PROVIDER_NAMES — an entry for a not-yet-registered provider (e.g. grok
	// before #136) fails loudly rather than silently no-op'ing.
	const providerBins: Partial<Record<ProviderName, string>> = {};
	let grokAllowUnsandboxedFallback = false;
	const providersBlock = yml.providers;
	if (providersBlock !== undefined) {
		if (!isPlainObject(providersBlock)) {
			throw new Error(`${configPath}: expected \`providers\` to be a map`);
		}
		for (const [name, entry] of Object.entries(providersBlock)) {
			if (!isProviderName(name)) {
				throw new Error(`${configPath}: unknown provider \`providers.${name}\`; expected one of ${PROVIDER_NAMES.join("|")}`);
			}
			if (!isPlainObject(entry)) {
				throw new Error(`${configPath}: expected \`providers.${name}\` to be a map`);
			}
			const bin = entry.bin;
			if (bin !== undefined) {
				if (!isString(bin) || bin.trim() === "") {
					throw new Error(`${configPath}: expected \`providers.${name}.bin\` to be a non-empty string`);
				}
				providerBins[name] = bin;
			}
			const allowUnsandboxedFallback = entry["allow-unsandboxed-fallback"];
			if (allowUnsandboxedFallback !== undefined) {
				if (name !== "grok") throw new Error(`${configPath}: \`providers.${name}.allow-unsandboxed-fallback\` is only supported for grok`);
				if (typeof allowUnsandboxedFallback !== "boolean") {
					throw new Error(`${configPath}: expected \`providers.grok.allow-unsandboxed-fallback\` to be a boolean, got ${typeof allowUnsandboxedFallback}`);
				}
				grokAllowUnsandboxedFallback = allowUnsandboxedFallback;
			}
		}
	}

	// security.env-allowlist: extra env var names forwarded to spawned driver subprocesses beyond
	// the deny-by-default allowlist (issue #237 / TC-014). Type-validate as a string array.
	let securityEnvAllowlist: string[] = [];
	const securityBlock = yml.security;
	if (securityBlock !== undefined) {
		if (!isPlainObject(securityBlock)) {
			throw new Error(`${configPath}: expected \`security\` to be a map`);
		}
		const allow = securityBlock["env-allowlist"];
		if (allow !== undefined) {
			if (!Array.isArray(allow) || !allow.every((v) => isString(v))) {
				throw new Error(`${configPath}: expected \`security.env-allowlist\` to be an array of strings`);
			}
			securityEnvAllowlist = allow as string[];
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
		profileGrokModels,
		profileOpenCodeModels,
		profileBudgets,
		profileTurnLimits,
		profileEffort,
		profileProviders,
		providerBins,
		grokAllowUnsandboxedFallback,
		shipTarget,
		shipRequiredChecks,
		roadmapSource,
		roadmapGithub,
		roadmapLinear,
		pick: { maxScope: pickMaxScope },
		park: { autoResume: parkAutoResume, maxWait: parkMaxWait, unknownResetWait: parkUnknownResetWait },
		watch: { ...(watchDailyBudget !== undefined ? { dailyBudget: watchDailyBudget } : {}) },
		revise: { local: reviseLocal },
		review: {
			runner: reviewRunner,
			statuslessAfter: reviewStatuslessAfter,
			maxPasses: reviewMaxPasses,
			budgetCap: reviewBudgetCap,
			providerDiversity: reviewProviderDiversity,
			carry: reviewCarry,
			authoring: reviewAuthoring,
			taxonomy: reviewTaxonomy,
		},
		confinement: { allowDirtyMain: confinementAllowDirtyMain },
		security: { envAllowlist: securityEnvAllowlist },
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
	/** Sparse per-profile Grok/OpenCode model slots (issue #431). Like `codexModel`, they
	 *  stay `string | undefined` with no default fill: absence delegates to the CLI default. */
	grokModel: string | undefined;
	openCodeModel: string | undefined;
	provider: ProviderName;
}

/**
 * Project the model a given provider should run for these resolved settings (issue #431).
 * Routing glue, not a fallback policy: each provider carries its own slot (`model` for Claude,
 * `codexModel`/`grokModel`/`openCodeModel` for the subprocess providers), so a Grok/OpenCode
 * seat never scavenges the Claude `model` slot. Used at conversion sites that turn a raw
 * `StepSettings` (a profile default) into a realized driver identity or execution override.
 */
export function modelForProvider(settings: StepSettings, provider: ProviderName): string | undefined {
	switch (provider) {
		case "codex":
			return settings.codexModel;
		case "grok":
			return settings.grokModel;
		case "opencode":
			return settings.openCodeModel;
		default:
			return settings.model;
	}
}

/**
 * Resolve the effective per-step settings for a profile.
 * Precedence: profile override > global step value (top-level yml merged onto
 * DEFAULTS). The sparse override maps hold only steps a profile explicitly sets,
 * so a missing key falls through to the always-present global — a resolution can
 * never surface `undefined` for budget/turns/effort. `model` and `codexModel`
 * stay `string | undefined` (a profile need not name every step; the SDK/CLI
 * defaults). `codexModel`, `grokModel`, and `openCodeModel` each mirror `model` as
 * sparse per-profile lookups with no default fill (issue #431), so each subprocess
 * provider receives only its own slot. `provider` mirrors `model`'s per-profile lookup but falls back to
 * `DEFAULT_PROVIDER` instead of `undefined`, so it never surfaces unset — every
 * present and future step resolves to a concrete backend with no exhaustive map.
 */
export function resolveStepSettings(config: ResolvedConfig, profile: string, step: Step): StepSettings {
	const inheritedStep = step === "pr-verify" ? "pr-review" : step;
	const selection = config.profileProviders[profile]?.[step] ?? config.profileProviders[profile]?.[inheritedStep] ?? DEFAULT_PROVIDER;
	return {
		budget: config.profileBudgets[profile]?.[step] ?? config.budgets[step],
		turns: config.profileTurnLimits[profile]?.[step] ?? config.turnLimits[step],
		effort: config.profileEffort[profile]?.[step] ?? config.effort[step],
		model: config.modelProfiles[profile]?.[step] ?? config.modelProfiles[profile]?.[inheritedStep],
		codexModel: config.profileCodexModels[profile]?.[step] ?? config.profileCodexModels[profile]?.[inheritedStep],
		grokModel: config.profileGrokModels[profile]?.[step] ?? config.profileGrokModels[profile]?.[inheritedStep],
		openCodeModel: config.profileOpenCodeModels[profile]?.[step] ?? config.profileOpenCodeModels[profile]?.[inheritedStep],
		provider: Array.isArray(selection) ? selection[0] : selection,
	};
}

/** Resolve the ordered execution candidates for a policy-managed step. */
export function resolveDriverCandidates(config: ResolvedConfig, profile: string, step: Step): StepSettings[] {
	const base = resolveStepSettings(config, profile, step);
	const selection = config.profileProviders[profile]?.[step] ?? base.provider;
	// ProviderName is a string union; ProviderPool is a non-empty tuple. typeof is the
	// reliable narrow — Array.isArray does not exclude string from a string|tuple union cleanly.
	const providers: readonly ProviderName[] = typeof selection === "string" ? [selection] : selection;
	return providers.map((provider) => ({ ...base, provider }));
}

/**
 * Resolve the executable a subprocess-backed provider should spawn (issue #241).
 * Returns the `providers.<provider>.bin` override when set, else `fallback` (the
 * provider's default binary name, resolved via PATH). A leading `~/` expands to the
 * home directory so an off-PATH driver (e.g. `~/.grok/bin/grok`) can be pinned in yml.
 */
export function resolveProviderBin(config: ResolvedConfig, provider: ProviderName, fallback: string): string {
	const raw = config.providerBins[provider] ?? fallback;
	return raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
}

// ── Resolved exports (populated at import time) ────────────────────────

export const CONFIG = loadConfig();

export const WORKTREE_PREFIX = CONFIG.worktreePrefix;
export const MODEL_PROFILES: Record<string, Partial<Record<Step, string>>> = CONFIG.modelProfiles;
export const SHIP_TARGET: ShipTargetName = CONFIG.shipTarget;
export const SHIP_REQUIRED_CHECKS: readonly string[] = CONFIG.shipRequiredChecks;
export const ROADMAP_SOURCE: RoadmapSourceName = CONFIG.roadmapSource;
export const ROADMAP_GITHUB: GithubRoadmapConfig = CONFIG.roadmapGithub;
export const ROADMAP_LINEAR: LinearRoadmapConfig = CONFIG.roadmapLinear;
export const REVISE_LOCAL: boolean = CONFIG.revise.local;
export const REVIEW_CONFIG: ReviewConfig = CONFIG.review;
export const CONFINEMENT_CONFIG: { allowDirtyMain: boolean } = CONFIG.confinement;
