import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(root, "docs/ai-delivery/v0.1", name), "utf8"));
const schema = fixture("predicate.schema.json");
const statement = fixture("examples/pelaggio-cycle.statement.json") as Record<string, unknown>;
const envelope = fixture("examples/pelaggio-cycle.dsse.json") as Record<string, unknown>;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const clonePredicate = (): Record<string, unknown> => structuredClone(statement.predicate as Record<string, unknown>);
const runDetails = (predicate: Record<string, unknown>): Record<string, unknown> => predicate.runDetails as Record<string, unknown>;

test("schema compiles and validates the predicate fixture", () => {
	assert.equal(validate(statement.predicate), true, JSON.stringify(validate.errors));
	assert.equal(statement._type, "https://in-toto.io/Statement/v1");
	assert.equal(statement.predicateType, "https://pelaggio.dev/ai-delivery/v0.1");
	const subjects = statement.subject as Array<{ digest: { sha256: string } }>;
	assert.equal(subjects.length, 1);
	assert.match(subjects[0].digest.sha256, /^[0-9a-f]{64}$/);
	const details = statement.predicate as { runDetails: { evidence: Array<{ id: string }>; policy: { assertions: Array<{ evidenceRefs: string[] }> } } };
	const evidenceIds = new Set(details.runDetails.evidence.map(({ id }) => id));
	for (const assertion of details.runDetails.policy.assertions) {
		for (const reference of assertion.evidenceRefs) assert.equal(evidenceIds.has(reference), true);
	}
});

test("unsigned DSSE payload is the exact checked-in Statement", () => {
	assert.equal(envelope.payloadType, "application/vnd.in-toto+json");
	assert.deepEqual(envelope.signatures, []);
	const bytes = Buffer.from(envelope.payload as string, "base64");
	assert.deepEqual(bytes, readFileSync(resolve(root, "docs/ai-delivery/v0.1/examples/pelaggio-cycle.statement.json")));
	assert.deepEqual(JSON.parse(bytes.toString("utf8")), statement);
});

test("schema rejects unknown and missing required data", () => {
	const unknown = clonePredicate();
	unknown.surprise = true;
	assert.equal(validate(unknown), false);
	for (const field of ["authorship", "review", "policy", "evidence", "outcome"] as const) {
		const value = clonePredicate();
		delete runDetails(value)[field];
		assert.equal(validate(value), false, field);
	}
});

test("schema rejects invalid enums, timestamps, URIs, and digests", () => {
	const invalid = [
		(value: Record<string, unknown>) => ((runDetails(value).outcome as Record<string, unknown>).state = "maybe"),
		(value: Record<string, unknown>) => ((runDetails(value).metadata as Record<string, unknown>).startedAt = "yesterday"),
		(value: Record<string, unknown>) => (((value.deliveryDefinition as Record<string, unknown>).change as Record<string, unknown>).roadmapUrl = "not a uri"),
		(value: Record<string, unknown>) => (((runDetails(value).evidence as Array<Record<string, unknown>>)[0].digest as Record<string, unknown>).sha256 = "ABC"),
	];
	for (const mutate of invalid) {
		const value = clonePredicate();
		mutate(value);
		assert.equal(validate(value), false);
	}
});

test("policy pass and terminal failures fail closed", () => {
	const passWithoutEvidence = clonePredicate();
	((runDetails(passWithoutEvidence).policy as { assertions: Array<Record<string, unknown>> }).assertions[1].evidenceRefs as unknown[]) = [];
	assert.equal(validate(passWithoutEvidence), false);
	const blockedWithoutReason = clonePredicate();
	runDetails(blockedWithoutReason).outcome = { state: "blocked", gateSummary: "failed" };
	assert.equal(validate(blockedWithoutReason), false);
	const shippedWithFailedGate = clonePredicate();
	runDetails(shippedWithFailedGate).outcome = { state: "shipped", gateSummary: "failed" };
	assert.equal(validate(shippedWithFailedGate), false);
	const blockedWithPassedGate = clonePredicate();
	runDetails(blockedWithPassedGate).outcome = { state: "blocked", reasonCode: "gate-failed", gateSummary: "passed" };
	assert.equal(validate(blockedWithPassedGate), false);
});

test("schema rejects free-form prose in code and identity fields", () => {
	const mutations: Array<(value: Record<string, unknown>) => void> = [
		(value) => {
			(runDetails(value).policy as { assertions: Array<Record<string, unknown>> }).assertions[0].reasonCode = "No durable assertion exists in current receipts.";
		},
		(value) => {
			(runDetails(value).evidence as Array<Record<string, unknown>>)[0].description = "Synthesized fixture digest.";
		},
		(value) => {
			(runDetails(value).authorship as Array<Record<string, unknown>>)[0].step = "implemented the requested feature";
		},
		(value) => {
			(runDetails(value).authorship as Array<Record<string, unknown>>)[0].subtype = "completed after carefully checking everything";
		},
		(value) => {
			(runDetails(value).authorship as Array<Record<string, unknown>>)[0].filesChanged = ["all documentation files were updated"];
		},
		(value) => {
			(runDetails(value).metadata as Record<string, unknown>).unavailable = ["provider request identity was not recorded"];
		},
		(value) => {
			(runDetails(value).review as Array<Record<string, unknown>>)[0].findingRefs = ["the review found no blocking issues"];
		},
		(value) => {
			(runDetails(value).review as Array<Record<string, unknown>>)[0].resolution = { disposition: "proceed", actor: "the release manager", rationaleCode: "Everything looks good.", evidenceRefs: ["review-record"] };
		},
		(value) => {
			((value.deliveryDefinition as Record<string, unknown>).policy as Record<string, unknown>).version = "the current release version";
		},
		(value) => {
			((runDetails(value).authorship as Array<Record<string, unknown>>)[0].identity as Record<string, unknown>).provider = "the primary model provider";
		},
		(value) => {
			(runDetails(value).evidence as Array<Record<string, unknown>>)[0].id = "the test report produced by CI";
		},
		(value) => {
			(runDetails(value).metadata as Record<string, unknown>).runId = "the example run for issue 186";
		},
		(value) => {
			runDetails(value).outcome = { state: "blocked", reasonCode: "the gate did not pass after review", gateSummary: "failed" };
		},
	];
	for (const mutate of mutations) {
		const value = clonePredicate();
		mutate(value);
		assert.equal(validate(value), false);
	}
});

test("schema rejects hyphenated prose in identifier and reference fields", () => {
	const prose = "everything-looks-good-after-review";
	const mutations: Array<(value: Record<string, unknown>) => void> = [
		(value) => {
			(runDetails(value).evidence as Array<Record<string, unknown>>)[0].id = prose;
		},
		(value) => {
			(runDetails(value).metadata as Record<string, unknown>).runId = prose;
		},
		(value) => {
			((runDetails(value).authorship as Array<Record<string, unknown>>)[0].identity as Record<string, unknown>).provider = prose;
		},
		(value) => {
			(runDetails(value).review as Array<Record<string, unknown>>)[0].findingRefs = [prose];
		},
	];
	for (const mutate of mutations) {
		const value = clonePredicate();
		mutate(value);
		assert.equal(validate(value), false);
	}
});

test("trust classifications are required and closed", () => {
	const missing = clonePredicate();
	delete missing.trustModel;
	assert.equal(validate(missing), false);
	const overstated = clonePredicate();
	(overstated.trustModel as Record<string, unknown>).reviewVerdict = "external";
	assert.equal(validate(overstated), false);
});
