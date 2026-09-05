import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parseArtifact, parseLocalConfig, parseMetrics, parseProblem, parseRunEvent, parseRunSnapshot, parseStartRunRequest, parseWorkContract } from "../../packages/pelaggio/scripts/pelaggio/local-autopilot/parse.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(readFileSync(join(root, "packages/pelaggio/scripts/pelaggio/local-autopilot/schemas/v0.schema.json"), "utf8"));
const fixtures = join(root, "packages/pelaggio/scripts/pelaggio/__tests__/fixtures/local-autopilot");
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const ref = (def: string) => ajv.compile({ $ref: `${schema.$id}#/$defs/${def}` });

const validators = {
	workContract: ref("workContract"),
	startRunRequest: ref("startRunRequest"),
	runIdRequest: ref("runIdRequest"),
	runSnapshot: ref("runSnapshot"),
	event: ref("event"),
	metrics: ref("metrics"),
	problem: ref("problem"),
	artifact: ref("artifact"),
	localConfig: ref("localConfig"),
};

const parsers = {
	workContract: parseWorkContract,
	startRunRequest: parseStartRunRequest,
	runSnapshot: parseRunSnapshot,
	event: parseRunEvent,
	metrics: parseMetrics,
	problem: parseProblem,
	artifact: parseArtifact,
	localConfig: parseLocalConfig,
};

const cases: Array<[keyof typeof parsers, string, boolean]> = [
	["workContract", "work-contract.json", true],
	["startRunRequest", "start-run-request.json", true],
	["runSnapshot", "snapshot-running.json", true],
	["runSnapshot", "snapshot-paused-decision.json", true],
	["runSnapshot", "snapshot-ready-for-review.json", true],
	["event", "event-run-started.json", true],
	["metrics", "metrics.json", true],
	["problem", "problem-protocol.json", true],
	["artifact", "artifact.json", true],
	["localConfig", "config.json", true],
	["startRunRequest", "invalid-start-unknown-field.json", false],
	["runSnapshot", "invalid-snapshot-paused-without-reason.json", false],
	["runSnapshot", "invalid-snapshot-ready-with-blocker.json", false],
	["runSnapshot", "invalid-snapshot-accepted.json", false],
	["metrics", "invalid-metrics-path.json", false],
	["localConfig", "invalid-config-effect.json", false],
];

describe("local autopilot JSON Schema 2020-12", () => {
	it("compiles every $defs document", () => {
		for (const name of Object.keys(schema.$defs)) assert.equal(typeof ref(name), "function", name);
	});

	it("checks every fixture against both independent validators", () => {
		for (const [kind, file, expected] of cases) {
			const value = load(file);
			assert.equal(validators[kind](value), expected, `${file}: ${JSON.stringify(validators[kind].errors)}`);
			assert.equal(parsers[kind](value).ok, expected, `${file} parser`);
		}
	});

	it("validates the run-id operation request schemas", () => {
		for (const name of ["getRunRequest", "continueRunRequest", "cancelRunRequest"]) {
			const validate = ref(name);
			assert.equal(validate({ schemaVersion: 1, runId: "run-1" }), true);
			assert.equal(validate({ schemaVersion: 1 }), false);
			assert.equal(validate({ schemaVersion: 1, runId: "run-1", extra: true }), false);
		}
	});

	it("accepts the Codex auto-mode adapter without weakening host assurance", () => {
		const config = { harness: { adapter: "codex", codex: { bin: "/opt/codex", model: "gpt-codex" } }, execution: { mode: "host" } };
		assert.equal(validators.localConfig(config), true, JSON.stringify(validators.localConfig.errors));
		assert.deepEqual(parseLocalConfig(config), { ok: true, value: config });
	});

	it("agrees on additive output field names", () => {
		for (const [kind, file] of cases.filter(([kind, , valid]) => valid && ["runSnapshot", "event", "problem", "artifact"].includes(kind))) {
			for (const key of ["futureExtension", "future_extension"]) {
				const value = { ...(load(file) as Record<string, unknown>), [key]: true };
				assert.equal(validators[kind](value), key === "futureExtension", `${kind} schema ${key}`);
				assert.equal(parsers[kind](value).ok, key === "futureExtension", `${kind} parser ${key}`);
			}
		}
	});

	it("agrees at Unicode string-length boundaries", () => {
		const probes: Array<[keyof typeof parsers, string, string, number]> = [
			["workContract", "work-contract.json", "title", 200],
			["problem", "problem-protocol.json", "message", 2000],
			["artifact", "artifact.json", "uri", 4096],
			["artifact", "artifact.json", "mediaType", 128],
		];
		for (const [kind, file, key, max] of probes) {
			for (const length of [max, max + 1]) {
				const value = { ...(load(file) as Record<string, unknown>), [key]: "😀".repeat(length) };
				assert.equal(validators[kind](value), length === max, `${kind}.${key} schema ${length}`);
				assert.equal(parsers[kind](value).ok, length === max, `${kind}.${key} parser ${length}`);
			}
		}
	});

	it("agrees on readiness evidence and execution assurance invariants", () => {
		const missingEvidence = load("snapshot-ready-for-review.json") as Record<string, unknown>;
		missingEvidence.artifacts = [];
		assert.equal(validators.runSnapshot(missingEvidence), false);
		assert.equal(parseRunSnapshot(missingEvidence).ok, false);

		const overstatedHost = load("snapshot-running.json") as Record<string, unknown>;
		overstatedHost.execution = { mode: "host", contained: true, effectsEnforced: true };
		assert.equal(validators.runSnapshot(overstatedHost), false);
		assert.equal(parseRunSnapshot(overstatedHost).ok, false);
	});

	it("keeps fixture names aligned with the on-disk set", () => {
		const names = readdirSync(fixtures)
			.filter((name) => name.endsWith(".json"))
			.sort();
		assert.deepEqual(cases.map(([, file]) => file).sort(), names);
	});
});
