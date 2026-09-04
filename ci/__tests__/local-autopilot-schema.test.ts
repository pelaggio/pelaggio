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

describe("local autopilot JSON Schema 2020-12", () => {
	it("compiles every $defs document", () => {
		for (const [name, validate] of Object.entries(validators)) {
			assert.equal(typeof validate, "function", name);
		}
	});

	it("accepts valid fixtures and agrees with the TypeScript parser", () => {
		const pairs: Array<[keyof typeof validators, string]> = [
			["workContract", "work-contract.json"],
			["startRunRequest", "start-run-request.json"],
			["runSnapshot", "snapshot-running.json"],
			["runSnapshot", "snapshot-paused-decision.json"],
			["runSnapshot", "snapshot-ready-for-review.json"],
			["event", "event-run-started.json"],
			["metrics", "metrics.json"],
			["problem", "problem-protocol.json"],
			["artifact", "artifact.json"],
			["localConfig", "config.json"],
		];
		for (const [kind, file] of pairs) {
			const value = load(file);
			assert.equal(validators[kind](value), true, `${file}: ${JSON.stringify(validators[kind].errors)}`);
			assert.equal(parsers[kind](value).ok, true, `${file} parser`);
		}
	});

	it("rejects invalid fixtures; parser agrees", () => {
		const pairs: Array<[keyof typeof validators, string]> = [
			["startRunRequest", "invalid-start-unknown-field.json"],
			["runSnapshot", "invalid-snapshot-accepted.json"],
			["metrics", "invalid-metrics-path.json"],
			["localConfig", "invalid-config-effect.json"],
		];
		for (const [kind, file] of pairs) {
			const value = load(file);
			assert.equal(validators[kind](value), false, file);
			assert.equal(parsers[kind](value).ok, false, `${file} parser`);
		}
	});

	it("keeps fixture names aligned with the on-disk set", () => {
		const names = readdirSync(fixtures)
			.filter((name) => name.endsWith(".json"))
			.sort();
		assert.ok(names.includes("work-contract.json"));
		assert.ok(names.some((name) => name.startsWith("invalid-")));
	});
});
