import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
	BASELINE_TAXONOMY,
	BASELINE_TAXONOMY_CLASSES,
	canonicalizeContractionPayload,
	contractionSet,
	DEFAULT_SAFETY_PRECEDENCE,
	type FindingClassId,
	type FindingTier,
	isContraction,
	isSafetyClass,
	isWellFormedClassId,
	type RawTaxonomyInput,
	resolveTaxonomy,
	safetyClasses,
	signContractionPayload,
	TaxonomyResolveError,
	tierOf,
	verifyContractSignature,
} from "../review/taxonomy.js";

function keypair(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

function classesOf(overrides: Record<FindingClassId, FindingTier>): Map<FindingClassId, FindingTier> {
	return new Map<FindingClassId, FindingTier>([...Object.entries(BASELINE_TAXONOMY_CLASSES), ...Object.entries(overrides)]);
}

describe("taxonomy — tierOf / isSafetyClass / default-to-safety", () => {
	it("unknown class defaults to safety", () => {
		assert.equal(tierOf("totally-unknown", BASELINE_TAXONOMY), "safety");
		assert.equal(isSafetyClass("totally-unknown"), true);
	});

	it("baseline resolve matches the ADR owner table", () => {
		for (const id of DEFAULT_SAFETY_PRECEDENCE) assert.equal(tierOf(id, BASELINE_TAXONOMY), "safety", id);
		for (const id of ["judgment", "spec-fit/scope-drift", "maintainability/design", "performance", "test-coverage", "style", "documentation"]) {
			assert.equal(tierOf(id, BASELINE_TAXONOMY), "judgment", id);
			assert.equal(isSafetyClass(id), false, id);
		}
	});

	it("safetyClasses returns ADR precedence order for the baseline", () => {
		assert.deepEqual(safetyClasses(BASELINE_TAXONOMY), [...DEFAULT_SAFETY_PRECEDENCE]);
	});
});

describe("taxonomy — contraction detection", () => {
	it("identity, add-safety, and elevate are NOT contractions", () => {
		assert.equal(isContraction(new Map(Object.entries(BASELINE_TAXONOMY_CLASSES))), false);
		assert.equal(isContraction(classesOf({ "my-new-risk": "safety" })), false);
		assert.equal(isContraction(classesOf({ style: "safety" })), false); // judgment → safety (elevation)
	});

	it("demote baseline-safety and seat-new-judgment ARE contractions", () => {
		assert.equal(isContraction(classesOf({ "security-and-secrets": "judgment" })), true);
		assert.equal(isContraction(classesOf({ "experimental-lint": "judgment" })), true);
	});

	it("contraction set lists only the shrinking classes, sorted, extensions absent", () => {
		const set = contractionSet(classesOf({ "correctness-regression": "judgment", "my-new-risk": "safety", "z-lint": "judgment" }));
		assert.deepEqual(set, [
			["correctness-regression", "judgment"],
			["z-lint", "judgment"],
		]);
	});
});

describe("taxonomy — sign / verify", () => {
	it("signs and verifies a contraction payload; rejects tamper and wrong key", () => {
		const { publicKeyPem, privateKeyPem } = keypair();
		const payload = canonicalizeContractionPayload(classesOf({ "security-and-secrets": "judgment" }));
		const sig = signContractionPayload(payload, privateKeyPem);
		assert.equal(verifyContractSignature(payload, publicKeyPem, sig), true);
		assert.equal(verifyContractSignature(`${payload} `, publicKeyPem, sig), false);
		assert.equal(verifyContractSignature(payload, keypair().publicKeyPem, sig), false);
	});

	it("fails closed on malformed key or signature", () => {
		assert.equal(verifyContractSignature("[]", "not-a-pem", "notbase64!!"), false);
	});
});

describe("taxonomy — resolveTaxonomy gate", () => {
	const { publicKeyPem, privateKeyPem } = keypair();

	it("baseline (empty) resolves without a signature", () => {
		const t = resolveTaxonomy({});
		assert.equal(t.owner, "operator");
		assert.equal(t.judgmentDefault, "permissive");
		assert.equal(tierOf("security-and-secrets", t), "safety");
	});

	it("extend-only config resolves without a contract", () => {
		const t = resolveTaxonomy({ classes: { "my-new-risk": "safety", style: "safety" } });
		assert.equal(isSafetyClass("my-new-risk", t), true);
		assert.equal(isSafetyClass("style", t), true);
	});

	it("contraction without signature throws naming the contracted class", () => {
		assert.throws(
			() => resolveTaxonomy({ classes: { "security-and-secrets": "judgment" } }, undefined, publicKeyPem),
			(e: unknown) => e instanceof TaxonomyResolveError && /security-and-secrets/.test(String(e)),
		);
	});

	it("contraction with a valid signature resolves against the passed key", () => {
		const raw: RawTaxonomyInput = { classes: { "security-and-secrets": "judgment" } };
		const payload = canonicalizeContractionPayload(classesOf({ "security-and-secrets": "judgment" }));
		raw.contract = { signatureB64: signContractionPayload(payload, privateKeyPem) };
		const t = resolveTaxonomy(raw, undefined, publicKeyPem);
		assert.equal(tierOf("security-and-secrets", t), "judgment");
	});

	it("contraction with a wrong-key signature throws (agent cannot self-sign against the pinned key)", () => {
		const payload = canonicalizeContractionPayload(classesOf({ "security-and-secrets": "judgment" }));
		const raw: RawTaxonomyInput = { classes: { "security-and-secrets": "judgment" }, contract: { signatureB64: signContractionPayload(payload, keypair().privateKeyPem) } };
		assert.throws(() => resolveTaxonomy(raw, undefined, publicKeyPem), TaxonomyResolveError);
	});

	it("rejects malformed class ids and invalid judgment-default", () => {
		assert.throws(() => resolveTaxonomy({ classes: { "Bad Id": "safety" } }), TaxonomyResolveError);
		assert.throws(() => resolveTaxonomy({ classes: { UPPER: "safety" } }), TaxonomyResolveError);
		assert.throws(() => resolveTaxonomy({ judgmentDefault: "loose" as never }), TaxonomyResolveError);
	});
});

describe("taxonomy — canonical payload stability", () => {
	it("is order-independent across input insertion order", () => {
		const a = canonicalizeContractionPayload(new Map<FindingClassId, FindingTier>([...Object.entries(BASELINE_TAXONOMY_CLASSES), ["b-lint", "judgment"], ["a-lint", "judgment"]]));
		const b = canonicalizeContractionPayload(new Map<FindingClassId, FindingTier>([...Object.entries(BASELINE_TAXONOMY_CLASSES), ["a-lint", "judgment"], ["b-lint", "judgment"]]));
		assert.equal(a, b);
	});

	it("extend-after-contract: adding a safety class does not change a signed contraction's bytes", () => {
		const { publicKeyPem, privateKeyPem } = keypair();
		const contractedOnly = canonicalizeContractionPayload(classesOf({ "correctness-regression": "judgment" }));
		const sig = signContractionPayload(contractedOnly, privateKeyPem);
		// Same signature must still verify after an autonomous extension is added alongside the contraction.
		const withExtension = canonicalizeContractionPayload(classesOf({ "correctness-regression": "judgment", "y-new": "safety" }));
		assert.equal(withExtension, contractedOnly);
		assert.equal(verifyContractSignature(withExtension, publicKeyPem, sig), true);
		const t = resolveTaxonomy({ classes: { "correctness-regression": "judgment", "y-new": "safety" }, contract: { signatureB64: sig } }, undefined, publicKeyPem);
		assert.equal(tierOf("correctness-regression", t), "judgment");
		assert.equal(isSafetyClass("y-new", t), true);
	});
});

describe("taxonomy — class id grammar", () => {
	it("accepts ADR tokens and rejects junk", () => {
		for (const id of Object.keys(BASELINE_TAXONOMY_CLASSES)) assert.equal(isWellFormedClassId(id), true, id);
		for (const id of ["Bad", "with space", "a//b", "/leading", "trailing/", "a_b", ""]) assert.equal(isWellFormedClassId(id), false, id);
	});
});
