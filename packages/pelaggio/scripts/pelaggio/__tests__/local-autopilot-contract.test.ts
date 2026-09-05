import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyTransition, canTransition, nextState } from "../local-autopilot/lifecycle.js";
import { parseArtifact, parseLocalConfig, parseMetrics, parseProblem, parseRunEvent, parseRunSnapshot, parseStartRunRequest, parseWorkContract } from "../local-autopilot/parse.js";
import { encodeJsonStdout, looksLikeAnsi } from "../local-autopilot/transport.js";
import { PROTOCOL_PROBLEM_TYPES, type RunSnapshot } from "../local-autopilot/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/local-autopilot");
const load = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("local autopilot contract parsers", () => {
	it("parses every valid fixture", () => {
		assert.equal(parseWorkContract(load("work-contract.json")).ok, true);
		assert.equal(parseStartRunRequest(load("start-run-request.json")).ok, true);
		assert.equal(parseRunSnapshot(load("snapshot-running.json")).ok, true);
		assert.equal(parseRunSnapshot(load("snapshot-paused-decision.json")).ok, true);
		assert.equal(parseRunSnapshot(load("snapshot-ready-for-review.json")).ok, true);
		assert.equal(parseRunEvent(load("event-run-started.json")).ok, true);
		assert.equal(parseMetrics(load("metrics.json")).ok, true);
		assert.equal(parseProblem(load("problem-protocol.json")).ok, true);
		assert.equal(parseArtifact(load("artifact.json")).ok, true);
		assert.equal(parseLocalConfig(load("config.json")).ok, true);
	});

	it("rejects unknown fields on startRunRequest", () => {
		const result = parseStartRunRequest(load("invalid-start-unknown-field.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "unknown-field");
		assert.equal(result.problem.type, "protocol");
	});

	it("rejects accepted and shipped dispositions", () => {
		const result = parseRunSnapshot(load("invalid-snapshot-accepted.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "disposition");
	});

	it("rejects a paused snapshot without pauseReason", () => {
		const result = parseRunSnapshot(load("invalid-snapshot-paused-without-reason.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "pause-reason");
	});

	it("rejects ready_for_review while a blocking finding is open", () => {
		const result = parseRunSnapshot(load("invalid-snapshot-ready-with-blocker.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "readiness");
	});

	it("rejects ready_for_review without verification evidence", () => {
		const raw = load("snapshot-ready-for-review.json") as Record<string, unknown>;
		raw.artifacts = [];
		const result = parseRunSnapshot(raw);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "readiness");
	});

	it("rejects execution assurance that overstates host containment", () => {
		const raw = load("snapshot-running.json") as Record<string, unknown>;
		raw.execution = { mode: "host", contained: true, effectsEnforced: true };
		const result = parseRunSnapshot(raw);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "execution-assurance");
	});

	it("rejects metrics that could carry repository content", () => {
		const result = parseMetrics(load("invalid-metrics-path.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.code, "unknown-field");
	});

	it("rejects a non-empty effects allow-list", () => {
		const result = parseLocalConfig(load("invalid-config-effect.json"));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.type, "config");
		assert.equal(result.problem.code, "effects-denied");
	});

	it("tolerates additive fields on output snapshots", () => {
		const raw = load("snapshot-running.json") as Record<string, unknown>;
		raw.futureExtension = { ok: true };
		const result = parseRunSnapshot(raw);
		assert.equal(result.ok, true);
	});
});

describe("local autopilot lifecycle", () => {
	const running = (): RunSnapshot => {
		const parsed = parseRunSnapshot(load("snapshot-running.json"));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) throw new Error("fixture");
		return parsed.value;
	};

	it("allows the documented transitions and no others", () => {
		assert.equal(canTransition("queued", "start"), true);
		assert.equal(canTransition("queued", "cancel"), true);
		assert.equal(canTransition("queued", "pause"), false);
		assert.equal(canTransition("running", "pause"), true);
		assert.equal(canTransition("running", "complete"), true);
		assert.equal(canTransition("running", "cancel"), true);
		assert.equal(canTransition("running", "start"), false);
		assert.equal(canTransition("paused", "continue"), true);
		assert.equal(canTransition("paused", "cancel"), true);
		assert.equal(canTransition("paused", "complete"), false);
		assert.equal(canTransition("completed", "start"), false);
		assert.equal(nextState("completed", "cancel").ok, false);
	});

	it("pauses a running snapshot with a decision reason", () => {
		const result = applyTransition(running(), "pause", {
			updatedAt: "2026-09-04T12:00:05.000Z",
			pauseReason: { code: "decision_required", message: "Choose the public export name." },
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.state, "paused");
		assert.equal(result.value.pauseReason?.code, "decision_required");
		assert.equal(result.value.disposition, undefined);
	});

	it("completes to ready_for_review only without blocking findings", () => {
		const verified = {
			...running(),
			artifacts: [
				{
					kind: "verification",
					uri: "file:.pelaggio/verification.json",
					mediaType: "application/json",
					digest: { algorithm: "sha256" as const, value: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
				},
			],
		};
		const ok = applyTransition(verified, "complete", { updatedAt: "2026-09-04T12:01:00.000Z", disposition: "ready_for_review" });
		assert.equal(ok.ok, true);
		if (!ok.ok) return;
		assert.equal(ok.value.disposition, "ready_for_review");
		const blocked = applyTransition({ ...verified, problems: [{ schemaVersion: 1, type: "verification", code: "tests-failed", message: "red", retryable: true }] }, "complete", {
			updatedAt: "2026-09-04T12:01:00.000Z",
			disposition: "ready_for_review",
		});
		assert.equal(blocked.ok, false);
	});

	it("cancel yields cancelled", () => {
		const result = applyTransition(running(), "cancel", { updatedAt: "2026-09-04T12:02:00.000Z" });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.state, "completed");
		assert.equal(result.value.disposition, "cancelled");
	});
});

describe("local autopilot transport", () => {
	it("encodes exactly one JSON object for stdout", () => {
		const body = encodeJsonStdout({ schemaVersion: 1, ok: true });
		assert.equal(body.endsWith("\n"), true);
		assert.equal(body.split("\n").filter(Boolean).length, 1);
		assert.equal(looksLikeAnsi(body), false);
		assert.deepEqual(JSON.parse(body), { schemaVersion: 1, ok: true });
	});

	it("classifies config, protocol, and conflict as transport faults", () => {
		assert.equal(PROTOCOL_PROBLEM_TYPES.has("protocol"), true);
		assert.equal(PROTOCOL_PROBLEM_TYPES.has("config"), true);
		assert.equal(PROTOCOL_PROBLEM_TYPES.has("conflict"), true);
		assert.equal(PROTOCOL_PROBLEM_TYPES.has("decision"), false);
	});
});
