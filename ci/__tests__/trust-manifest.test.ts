import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildManifest, loadClaims, manifestBytes, type TrustRegistry, validateManifest } from "../trust-manifest.js";
import { runTrustGate } from "../verify-claims.js";

const registry = {
	meta: { schema_version: "0.1.0" },
	claims: [
		{
			id: "TC-001",
			claim: "A shipped guarantee",
			status: "guarantee",
			applies_to: ">=0.1.0",
			mechanism: "A local command proves it.",
			evidence_command: 'node -e "process.exit(0)"',
			last_verified: "2026-01-01",
		},
		{
			id: "TC-002",
			claim: "A planned capability",
			status: "planned",
			applies_to: "planned",
			mechanism: "Documented intent.",
			evidence_command: "rg -n planned docs",
			last_verified: "2026-01-01",
		},
	],
	manifest: {
		defaults: {
			ship_target: "pull-request",
			telemetry: "off",
			control_plane_auth: "required_or_loopback_only",
		},
		capabilities: [{ id: "repo.write.worktree", default: "allowed", approval: "not_required", evidence: ["TC-002"] }],
		egress: [{ destination: "anthropic", data_categories: ["prompts"], required: true, evidence: ["TC-001"] }],
		never: [{ statement: "send telemetry", evidence: ["TC-001"] }],
		provenance: { npm_provenance: true, signed_tag: true, sigstore_bundle: "planned", evidence: ["TC-001"] },
		permission_tiers: [{ id: "worktree_write", description: "Worktree writes", default: true, capabilities: ["repo.write.worktree"], evidence: ["TC-002"] }],
		sandbox_scope: { worktree_scope: "worktree", main_repo_protection: "hook", planned_hardening: "diff", evidence: ["TC-002"] },
	},
} satisfies TrustRegistry;

const schema = {
	type: "object",
	required: ["schema_version", "product", "posture", "claims_ref"],
	additionalProperties: false,
	properties: {
		schema_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
		product: { const: "pelaggio" },
		posture: { enum: ["shipped", "intent"] },
		claims_ref: { type: "string" },
	},
};

describe("trust manifest generator", () => {
	it("discloses Grok prompt and read-file egress in the real registry", () => {
		const manifest = buildManifest(loadClaims(process.cwd()));
		const grok = manifest.egress.find((entry) => entry.destination === "cli-chat-proxy.grok.com");
		assert.ok(grok, "real registry must disclose the Grok service destination");
		assert.deepEqual(grok.data_categories, ["prompts", "source_context", "read_file_context"]);
		assert.deepEqual(grok.evidence, ["TC-006", "TC-014"]);
	});

	it("generates stable manifest bytes with required scalars and a real claims_ref", () => {
		const manifest = buildManifest(registry, { release: "1.2.3" });
		assert.equal(manifest.product, "pelaggio");
		assert.equal(manifest.release, "1.2.3");
		assert.equal(manifest.posture, "intent");
		assert.equal(manifest.generated_from, "trust-claims.yml");
		assert.equal(manifest.claims_ref, "./trust-claims.yml");
		assert.equal(manifestBytes(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
	});

	it("rejects manifest entries linked to unknown claims", () => {
		assert.throws(
			() =>
				buildManifest({
					...registry,
					manifest: { ...registry.manifest, capabilities: [{ id: "bad", default: "allowed", approval: "not_required", evidence: ["TC-999"] }] },
				}),
			/unknown evidence claim TC-999/,
		);
	});

	it("rejects permission tiers linked to unknown capabilities", () => {
		assert.throws(
			() =>
				buildManifest({
					...registry,
					manifest: { ...registry.manifest, permission_tiers: [{ id: "local_read", description: "Local reads", default: true, capabilities: ["repo.read"], evidence: ["TC-002"] }] },
				}),
			/unknown capability repo\.read/,
		);
	});

	it("validates the local schema subset", () => {
		assert.deepEqual(validateManifest({ schema_version: "0.1.0", product: "pelaggio", posture: "intent", claims_ref: "./trust-claims.yml" }, schema), []);
		const errors = validateManifest({ schema_version: "bad", product: "other", posture: "maybe", claims_ref: "./trust-claims.yml", extra: true }, schema);
		assert.ok(errors.some((error) => error.includes("schema_version")));
		assert.ok(errors.some((error) => error.includes("product")));
		assert.ok(errors.some((error) => error.includes("posture")));
		assert.ok(errors.some((error) => error.includes("extra")));
	});
});

describe("trust gate", () => {
	it("fails on manifest drift and placeholder guarantee evidence", () => {
		const root = writeTrustRepo({
			registryText: registryYaml({ evidenceCommand: "GAP: add evidence", lastVerified: "2026-01-01" }),
			manifestText: "{}\n",
		});
		assert.equal(runTrustGate(root), 1);
	});

	it("warns but exits 0 for stale last_verified when evidence and manifest are current", () => {
		const registryText = registryYaml({ evidenceCommand: 'node -e "process.exit(0)"', lastVerified: "2020-01-01" });
		const root = writeTrustRepo({ registryText, manifestText: null });
		const loaded = loadClaims(root);
		writeFileSync(join(root, "docs/trust/pelaggio.trust.json"), manifestBytes(buildManifest(loaded, { repoRoot: root })));
		assert.equal(runTrustGate(root), 0);
	});
});

function writeTrustRepo(opts: { registryText: string; manifestText: string | null }): string {
	const root = mkdtempSync(join(tmpdir(), "trust-test-"));
	mkdirSync(join(root, "docs/trust"), { recursive: true });
	mkdirSync(join(root, "packages/pelaggio"), { recursive: true });
	writeFileSync(join(root, "packages/pelaggio/package.json"), JSON.stringify({ version: "0.1.0" }));
	writeFileSync(join(root, "docs/trust/trust-claims.yml"), opts.registryText);
	writeFileSync(
		join(root, "docs/trust/pelaggio.trust.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["schema_version", "product", "posture", "claims_ref"],
			properties: {
				schema_version: { type: "string" },
				product: { const: "pelaggio" },
				posture: { enum: ["shipped", "intent"] },
				claims_ref: { type: "string" },
			},
		}),
	);
	if (opts.manifestText !== null) writeFileSync(join(root, "docs/trust/pelaggio.trust.json"), opts.manifestText);
	return root;
}

function registryYaml(opts: { evidenceCommand: string; lastVerified: string }): string {
	return [
		"meta:",
		'  schema_version: "0.1.0"',
		"claims:",
		"  - id: TC-001",
		'    claim: "A shipped guarantee"',
		"    status: guarantee",
		'    applies_to: ">=0.1.0"',
		'    mechanism: "A local command proves it."',
		`    evidence_command: ${JSON.stringify(opts.evidenceCommand)}`,
		`    last_verified: "${opts.lastVerified}"`,
		"manifest:",
		"  defaults:",
		"    ship_target: pull-request",
		"    telemetry: off",
		"    control_plane_auth: required_or_loopback_only",
		"  capabilities:",
		"    - id: repo.write.worktree",
		"      default: allowed",
		"      approval: not_required",
		"      evidence: [TC-001]",
		"  egress:",
		"    - destination: anthropic",
		"      data_categories: [prompts]",
		"      required: true",
		"      evidence: [TC-001]",
		"  never:",
		'    - statement: "send telemetry"',
		"      evidence: [TC-001]",
		"  provenance:",
		"    npm_provenance: true",
		"    signed_tag: true",
		"    sigstore_bundle: planned",
		"    evidence: [TC-001]",
		"  permission_tiers:",
		"    - id: worktree_write",
		'      description: "Worktree writes"',
		"      default: true",
		"      capabilities: [repo.write.worktree]",
		"      evidence: [TC-001]",
		"  sandbox_scope:",
		'    worktree_scope: "worktree"',
		'    main_repo_protection: "hook"',
		'    planned_hardening: "diff"',
		"    evidence: [TC-001]",
		"",
	].join("\n");
}
