import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadBundle, publishAttachment, publishObject, writeRoots } from "../delivery/bundle.js";
import { subjectFacts } from "../delivery/git-subject.js";
import type { DeliveryCase, DeliveryRecord, DeliverySubject } from "../delivery/types.js";
import { renderDossier, verifyLoadedBundle } from "../delivery/verify.js";

const ISSUED = "2026-08-31T12:00:00.000Z";
const INSPECT = "npx pelaggio verify --bundle $PWD";

function issuer() {
	return { kind: "local" as const, id: "pelaggio-shadow" };
}

function git(overrides: Partial<DeliverySubject> = {}): DeliverySubject {
	return {
		gitDir: "/tmp/repo/.git",
		repository: "git@example.com:acme/pelaggio.git",
		repositoryResidual: null,
		baseCommit: "1".repeat(40),
		baseTree: "2".repeat(40),
		candidateCommit: "3".repeat(40),
		resultTree: "4".repeat(40),
		diffTreeDigest: "5".repeat(64),
		...overrides,
	};
}

function rec(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
	return {
		schemaVersion: 1,
		kind: "Observation",
		id: "r1",
		role: "subject",
		issuedAt: ISSUED,
		issuer: issuer(),
		subjectBinding: { resultTree: git().resultTree, configuration: "quick-automatic" },
		...overrides,
	};
}

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-dverify-"));
}

function publishGolden(opts: { findings?: DeliveryRecord["findings"]; extraRecord?: DeliveryRecord; extraAttachment?: string } = {}) {
	const root = tempRoot();
	const subjectObs = rec({
		id: "subject",
		role: "subject",
		facts: subjectFacts(git()),
	});
	const intent = rec({
		kind: "Decision",
		id: "intent",
		role: "authorized-intent",
		facts: [
			{ key: "campaign", value: "751" },
			{ key: "payload", value: "706" },
		],
	});
	const scope = rec({ kind: "Assessment", id: "scope", role: "scope", facts: [{ key: "accepted", value: "pick+verifier" }] });
	const context = rec({ id: "context", role: "governing-context", facts: [{ key: "resolver", value: "v1" }] });
	const ac = rec({
		id: "ac",
		role: "acceptance-claim",
		claims: ["AC-1", "AC-2", "AC-3", "AC-4"],
		facts: [{ key: "observed", value: "clamp-matrix" }],
	});
	const review = rec({
		kind: "Assessment",
		id: "review",
		role: "review",
		findings: opts.findings ?? [{ id: "f-residual", severity: "note", summary: "PR-gate records not yet present", disposition: "residual" }],
	});
	const att = publishAttachment(root, "# handoff\n#751 carries #706\n");
	intent.attachments = [{ digest: att, role: "handoff" }];
	const records = [subjectObs, intent, scope, context, ac, review];
	if (opts.extraRecord) records.push(opts.extraRecord);
	const digests = records.map((r) => publishObject(root, r));
	const subjectD = digests[0];
	const intentD = digests[1];
	const scopeD = digests[2];
	const contextD = digests[3];
	const acD = digests[4];
	const reviewD = digests[5];
	if (!subjectD || !intentD || !scopeD || !contextD || !acD || !reviewD) throw new Error("expected six golden record digests");
	if (opts.extraAttachment) publishAttachment(root, opts.extraAttachment);
	const deliveryCase: DeliveryCase = {
		schemaVersion: 1,
		kind: "Case",
		id: "case-751",
		issuedAt: ISSUED,
		issuer: issuer(),
		subject: git(),
		admittedRecords: digests,
		obligations: [
			{ id: "intent", group: "intent", recordDigests: [intentD], attachmentDigests: [att] },
			{ id: "subject", group: "subject-result-tree", recordDigests: [subjectD], attachmentDigests: [] },
			{ id: "binding", group: "subject-config-binding", recordDigests: [acD], attachmentDigests: [] },
			{ id: "scope", group: "scope", recordDigests: [scopeD], attachmentDigests: [] },
			{ id: "context", group: "governing-context", recordDigests: [contextD], attachmentDigests: [] },
			{ id: "acceptance", group: "acceptance", recordDigests: [acD], attachmentDigests: [] },
			{ id: "review", group: "review-findings", recordDigests: [reviewD], attachmentDigests: [] },
		],
		residuals: ["PR-gate records do not yet exist", "Human authorization pending"],
	};
	const caseDigest = publishObject(root, deliveryCase);
	const policy = rec({
		kind: "Decision",
		id: "policy",
		role: "policy",
		caseDigest,
		authority: "harness-policy",
		facts: [{ key: "over", value: caseDigest }],
	});
	const policyDigest = publishObject(root, policy);
	writeRoots(root, { schemaVersion: 1, case: caseDigest, policyDecision: policyDigest });
	return { root, caseDigest, policyDigest, att, digests, deliveryCase };
}

describe("verifyLoadedBundle — golden cold packet", () => {
	it("is Case ACCEPTED, AWAITING AUTHORIZATION, EFFECT UNPROVEN, overall WITHHOLD", () => {
		const { root } = publishGolden();
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "AWAITING AUTHORIZATION");
		assert.equal(result.effect, "EFFECT UNPROVEN");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "awaiting-authorization"));
	});

	it("regenerates a byte-stable dossier and ignores a hand-edited green projection", () => {
		const { root } = publishGolden();
		const first = renderDossier(verifyLoadedBundle(loadBundle(root), git(), INSPECT));
		const second = renderDossier(verifyLoadedBundle(loadBundle(root), git(), INSPECT));
		assert.equal(first, second);
		writeFileSync(join(root, "dossier.md"), "# green\nOverall: ACCEPTED\n");
		const third = renderDossier(verifyLoadedBundle(loadBundle(root), git(), INSPECT));
		assert.equal(third, first);
		assert.match(first, /Overall: WITHHOLD/);
		assert.doesNotMatch(first, /^# green/m);
	});

	it("withholds an empty Case even when a Human Decision authorizes it", () => {
		const { root, deliveryCase } = publishGolden();
		const emptyCaseDigest = publishObject(root, { ...deliveryCase, admittedRecords: [], obligations: [] });
		const humanDigest = publishObject(root, rec({ kind: "Decision", id: "human-empty", role: "human-authorization", caseDigest: emptyCaseDigest, authority: "operator" }));
		writeRoots(root, { schemaVersion: 1, case: emptyCaseDigest, humanDecision: humanDigest });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.authorization, "authorized");
		assert.equal(result.caseDisposition, "WITHHOLD");
		assert.equal(result.overall, "WITHHOLD");
		assert.equal(result.obligations.filter((row) => row.state === "open").length, 7);
	});

	it("withholds under-declared and vacuous required obligation groups", () => {
		const { root, deliveryCase } = publishGolden();
		const underDeclaredDigest = publishObject(root, { ...deliveryCase, obligations: deliveryCase.obligations.slice(0, 1) });
		writeRoots(root, { schemaVersion: 1, case: underDeclaredDigest });
		const underDeclared = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(underDeclared.caseDisposition, "WITHHOLD");
		assert.ok(underDeclared.reasons.some((reason) => reason.detail.includes("required obligation group scope is missing")));

		const vacuousDigest = publishObject(root, {
			...deliveryCase,
			obligations: deliveryCase.obligations.map((obligation) => ({ ...obligation, recordDigests: [], attachmentDigests: [] })),
		});
		writeRoots(root, { schemaVersion: 1, case: vacuousDigest });
		const vacuous = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(vacuous.caseDisposition, "WITHHOLD");
		assert.ok(vacuous.obligations.every((row) => row.state === "open"));
	});
});

describe("verifyLoadedBundle — mutations", () => {
	it("same result/base/diff with a different candidate commit keeps the Case ACCEPTED", () => {
		const { root } = publishGolden();
		const result = verifyLoadedBundle(loadBundle(root), git({ candidateCommit: "9".repeat(40) }), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(!result.reasons.some((r) => r.code === "subject-result-tree"));
	});

	it("result tree differs from the candidate → REJECTED subject-result-tree", () => {
		const { root } = publishGolden();
		const result = verifyLoadedBundle(loadBundle(root), git({ resultTree: "9".repeat(40) }), INSPECT);
		assert.equal(result.caseDisposition, "REJECTED");
		assert.equal(result.overall, "REJECTED");
		assert.ok(result.reasons.some((r) => r.code === "subject-result-tree" && r.group === "subject-result-tree"));
	});

	it("required attachment missing → WITHHOLD named obligation", () => {
		const { root, att } = publishGolden();
		const bundle = loadBundle(root);
		bundle.attachments.delete(att);
		const result = verifyLoadedBundle(bundle, git(), INSPECT);
		assert.equal(result.caseDisposition, "WITHHOLD");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "obligation-evidence-missing" && r.group === "intent"));
	});

	it("otherwise valid evidence binds another subject → WITHHOLD subject-config-binding", () => {
		const { root } = publishGolden({
			extraRecord: rec({
				id: "foreign",
				role: "acceptance-claim",
				subjectBinding: { resultTree: "e".repeat(40), configuration: "other" },
			}),
		});
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "subject-config-binding"));
	});

	it("open material finding → REJECTED finding-closure", () => {
		const { root } = publishGolden({
			findings: [{ id: "blocker", severity: "material", summary: "open defect", disposition: "open" }],
		});
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "REJECTED");
		assert.equal(result.overall, "REJECTED");
		assert.ok(result.reasons.some((r) => r.code === "finding-closure"));
	});

	it("material finding lacks a disposition → WITHHOLD finding-disposition-missing", () => {
		const { root } = publishGolden({
			findings: [{ id: "needs-call", severity: "material", summary: "no disposition yet" }],
		});
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "WITHHOLD");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "finding-disposition-missing"));
	});

	it("adverse open finding is not laundered into WITHHOLD by a missing disposition on another finding", () => {
		const { root } = publishGolden({
			findings: [
				{ id: "blocker", severity: "material", summary: "open defect", disposition: "open" },
				{ id: "needs-call", severity: "material", summary: "no disposition yet" },
			],
		});
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "REJECTED");
		assert.equal(result.overall, "REJECTED");
	});

	it("Human Decision with wrong authority leaves Case unchanged and overall WITHHOLD", () => {
		const { root, caseDigest, policyDigest } = publishGolden();
		const human = rec({
			kind: "Decision",
			id: "human",
			role: "human-authorization",
			caseDigest,
			authority: "imposter",
		});
		const humanDigest = publishObject(root, human);
		writeRoots(root, { schemaVersion: 1, case: caseDigest, policyDecision: policyDigest, humanDecision: humanDigest });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "AWAITING AUTHORIZATION");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "wrong-authority"));
	});

	it("Human Decision for another Case leaves Case unchanged", () => {
		const { root, caseDigest, policyDigest } = publishGolden();
		const human = rec({
			kind: "Decision",
			id: "human",
			role: "human-authorization",
			caseDigest: "f".repeat(64),
			authority: "operator",
		});
		const humanDigest = publishObject(root, human);
		writeRoots(root, { schemaVersion: 1, case: caseDigest, policyDecision: policyDigest, humanDecision: humanDigest });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "AWAITING AUTHORIZATION");
		assert.ok(result.reasons.some((r) => r.code === "cross-case-decision"));
	});

	it("landing Effect tree mismatch rejects landing/overall, Case digest intact", () => {
		const { root, caseDigest, policyDigest } = publishGolden();
		const landing = rec({
			kind: "Effect",
			id: "land",
			role: "landing",
			caseDigest,
			resultTree: "0".repeat(40),
		});
		const effectDigest = publishObject(root, landing);
		writeRoots(root, { schemaVersion: 1, case: caseDigest, policyDecision: policyDigest, effects: [effectDigest] });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.effect, "rejected");
		assert.equal(result.overall, "REJECTED");
		assert.equal(result.caseDigest, caseDigest);
		assert.ok(result.reasons.some((r) => r.code === "landing-tree-mismatch"));
	});

	it("same-tree squash/merge Effect is proven; Human Decision authorizes overall ACCEPTED", () => {
		const { root, caseDigest, policyDigest } = publishGolden();
		const landing = rec({
			kind: "Effect",
			id: "land",
			role: "landing",
			caseDigest,
			resultTree: git().resultTree,
		});
		const human = rec({
			kind: "Decision",
			id: "human",
			role: "human-authorization",
			caseDigest,
			authority: "operator",
		});
		writeRoots(root, {
			schemaVersion: 1,
			case: caseDigest,
			policyDecision: policyDigest,
			humanDecision: publishObject(root, human),
			effects: [publishObject(root, landing)],
		});
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "authorized");
		assert.equal(result.effect, "proven");
		assert.equal(result.overall, "ACCEPTED");
	});

	it("missing Policy withholds overall without changing an accepted Case", () => {
		const { root, caseDigest } = publishGolden();
		const humanDecision = publishObject(root, rec({ kind: "Decision", id: "human", role: "human-authorization", caseDigest, authority: "operator" }));
		writeRoots(root, { schemaVersion: 1, case: caseDigest, humanDecision });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "authorized");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "policy-unsatisfied" && r.group === "policy"));
	});

	it("cross-Case Policy withholds overall without changing an accepted Case", () => {
		const { root, caseDigest } = publishGolden();
		const humanDecision = publishObject(root, rec({ kind: "Decision", id: "human", role: "human-authorization", caseDigest, authority: "operator" }));
		const policyDigest = publishObject(
			root,
			rec({
				kind: "Decision",
				id: "other-policy",
				role: "policy",
				caseDigest: "f".repeat(64),
			}),
		);
		writeRoots(root, { schemaVersion: 1, case: caseDigest, policyDecision: policyDigest, humanDecision });
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.caseDisposition, "ACCEPTED");
		assert.equal(result.authorization, "authorized");
		assert.equal(result.overall, "WITHHOLD");
		assert.ok(result.reasons.some((r) => r.code === "policy-unsatisfied" && r.group === "policy"));
	});

	it("unattached extra objects do not change disposition", () => {
		const { root } = publishGolden();
		publishObject(root, rec({ id: "stray" }));
		const golden = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(golden.caseDisposition, "ACCEPTED");
		assert.equal(golden.overall, "WITHHOLD");
		assert.ok(golden.diagnostics.some((d) => d.includes("unreachable")));
	});

	it("absence (no Human/Effect) is WITHHOLD/UNPROVEN, not REJECTED", () => {
		const { root } = publishGolden();
		const result = verifyLoadedBundle(loadBundle(root), git(), INSPECT);
		assert.equal(result.authorization, "AWAITING AUTHORIZATION");
		assert.equal(result.effect, "EFFECT UNPROVEN");
		assert.notEqual(result.caseDisposition, "REJECTED");
		assert.equal(result.overall, "WITHHOLD");
	});
});
