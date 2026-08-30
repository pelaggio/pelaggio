import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadShadowGraph } from "./assurance-graph.js";
import { resolveFileWithinRoot } from "./root-files.js";

export type AssuranceObservation = {
	kind: "test" | "probe" | "receipt";
	id: string;
	path: string;
};

export type ObservationResolution = { ok: true } | { ok: false; reason: string };
export type ObservationTestResultEvent = {
	type: "test:fail" | "test:pass";
	data: {
		details: { duration_ms: number; type?: "suite" | "test" };
		file?: string;
		name: string;
		nesting: number;
		skip?: string | boolean;
		testNumber: number;
		todo?: string | boolean;
	};
};

const OBSERVATION_RESULTS_ENV = "PELAGGIO_ASSURANCE_OBSERVATION_RESULTS";
const NO_CURRENT_RESULT = "no current exact harness test result";

function key(observation: AssuranceObservation): string {
	return JSON.stringify([observation.kind, observation.id, observation.path]);
}

function exactPattern(value: string): string {
	return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function passedObservationKeysFromEnv(): ReadonlySet<string> {
	const encoded = process.env[OBSERVATION_RESULTS_ENV];
	if (!encoded) return new Set();
	try {
		const parsed: unknown = JSON.parse(encoded);
		if (!Array.isArray(parsed) || !parsed.every((value): value is string => typeof value === "string")) return new Set();
		return new Set(parsed);
	} catch {
		return new Set();
	}
}

/** Resolve observation structure and exact pass receipts against one checkout. */
export function resolveObservations(root: string, observations: readonly AssuranceObservation[], passedKeys: ReadonlySet<string> = passedObservationKeysFromEnv()): Map<string, ObservationResolution> {
	const unique = new Map(observations.map((observation) => [key(observation), observation]));
	const resolutions = new Map<string, ObservationResolution>();
	for (const [observationKey, observation] of unique) {
		if (!observation.id.trim() || !observation.path.trim()) {
			resolutions.set(observationKey, { ok: false, reason: "observation needs non-empty id and path" });
			continue;
		}
		if (!resolveFileWithinRoot(root, observation.path)) {
			resolutions.set(observationKey, { ok: false, reason: `observation no longer exists: ${observation.path}` });
			continue;
		}
		if (observation.kind !== "test") {
			resolutions.set(observationKey, { ok: false, reason: `no harness resolver for ${observation.kind} observation ${observation.id}` });
			continue;
		}
		resolutions.set(observationKey, passedKeys.has(observationKey) ? { ok: true } : { ok: false, reason: NO_CURRENT_RESULT });
	}
	return resolutions;
}

function eventIdentity(root: string, event: ObservationTestResultEvent): string | undefined {
	if (event.data.details.type === "suite" || !event.data.file) return undefined;
	try {
		return `${realpathSync(resolve(root, event.data.file))}\0${event.data.name}`;
	} catch {
		return undefined;
	}
}

/** Convert node:test result events into per-observation receipts. Missing and skipped identities fail closed. */
export function resolveTestObservationEvents(root: string, observations: readonly AssuranceObservation[], events: readonly ObservationTestResultEvent[]): Map<string, ObservationResolution> {
	const structural = resolveObservations(root, observations, new Set());
	const expected = new Map<string, string>();
	for (const observation of observations) {
		const observationKey = key(observation);
		const result = structural.get(observationKey);
		if (result?.ok !== false || result.reason !== NO_CURRENT_RESULT) continue;
		const file = resolveFileWithinRoot(root, observation.path);
		if (file) expected.set(`${file}\0${observation.id}`, observationKey);
	}

	for (const event of events) {
		const identity = eventIdentity(root, event);
		const observationKey = identity ? expected.get(identity) : undefined;
		if (!observationKey) continue;
		const current = structural.get(observationKey);
		if (event.type === "test:fail") {
			structural.set(observationKey, { ok: false, reason: `observation test failed: ${event.data.name}` });
		} else if (event.data.skip !== undefined) {
			structural.set(observationKey, { ok: false, reason: `observation test was skipped: ${event.data.name}` });
		} else if (event.data.todo !== undefined) {
			structural.set(observationKey, { ok: false, reason: `observation test was TODO: ${event.data.name}` });
		} else if (current?.ok) {
			structural.set(observationKey, { ok: false, reason: `observation test identity is not unique: ${event.data.name}` });
		} else if (current?.reason === NO_CURRENT_RESULT) {
			structural.set(observationKey, { ok: true });
		}
	}
	return structural;
}

export function observationKey(observation: AssuranceObservation): string {
	return key(observation);
}

export function graphObservations(root: string): AssuranceObservation[] {
	const graph = loadShadowGraph(root);
	const realizations = graph.nodes.filter((node) => node.kind === "realization");
	const unbound = realizations.filter((node) => !Array.isArray(node.observations) || node.observations.length === 0);
	if (unbound.length > 0) throw new Error(`realizations without observations: ${unbound.map((node) => node.id).join(", ")}`);
	return realizations.flatMap((node) => node.observations ?? []);
}

function isObservationTestResultEvent(value: unknown): value is ObservationTestResultEvent {
	if (!value || typeof value !== "object" || !("type" in value) || !("data" in value)) return false;
	if (value.type !== "test:pass" && value.type !== "test:fail") return false;
	const data: unknown = value.data;
	return Boolean(data && typeof data === "object" && "name" in data && typeof data.name === "string" && "details" in data && data.details && typeof data.details === "object");
}

if (process.argv.includes("--node-test-args")) {
	const root = resolve(new URL("..", import.meta.url).pathname);
	const observations = graphObservations(root);
	const resolutions = resolveObservations(root, observations, new Set());
	const structuralFailures = [...resolutions.values()].filter((result): result is { ok: false; reason: string } => !result.ok && result.reason !== NO_CURRENT_RESULT);
	if (structuralFailures.length > 0) throw new Error(structuralFailures.map((result) => result.reason).join("\n"));
	const testObservations = observations.filter((observation) => observation.kind === "test");
	const byPath = new Map<string, AssuranceObservation[]>();
	for (const observation of testObservations) byPath.set(observation.path, [...(byPath.get(observation.path) ?? []), observation]);
	const args = [...byPath].flatMap(([path, pathObservations]) => [`--test-name-pattern=${pathObservations.map((observation) => exactPattern(observation.id)).join("|")}`, path]);
	process.stdout.write(`${args.join("\0")}\0`);
}

if (process.argv.includes("--resolve-test-events")) {
	const root = resolve(new URL("..", import.meta.url).pathname);
	const observations = graphObservations(root);
	const events = readFileSync(0, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): unknown => JSON.parse(line))
		.filter(isObservationTestResultEvent);
	const resolutions = resolveTestObservationEvents(root, observations, events);
	const passed = [...resolutions].filter(([, result]) => result.ok).map(([observationKey]) => observationKey);
	process.stdout.write(JSON.stringify(passed));
	for (const [observationKey, result] of resolutions) if (!result.ok) process.stderr.write(`${observationKey}: ${result.reason}\n`);
	if (passed.length !== resolutions.size) process.exitCode = 1;
}
