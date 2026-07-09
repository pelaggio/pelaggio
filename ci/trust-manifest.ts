import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require(resolve(repoRoot(), "packages/pelaggio/node_modules/yaml")) as { parse: (input: string) => unknown };

export type ClaimStatus = "guarantee" | "default" | "best_effort" | "planned" | "not_supported";

export interface TrustClaim {
	id: string;
	claim: string;
	status: ClaimStatus;
	applies_to: string;
	mechanism: string;
	evidence_command?: string;
	test_file?: string;
	failure_mode?: string;
	known_limits?: string;
	standards?: string[];
	adr?: string | null;
	last_verified?: string;
}

export interface TrustRegistry {
	meta: {
		schema_version: string;
		[key: string]: unknown;
	};
	claims: TrustClaim[];
	manifest: ManifestProjection;
}

interface ManifestProjection {
	defaults: Record<string, unknown>;
	capabilities: ManifestEntry[];
	egress: ManifestEntry[];
	never: ManifestEntry[];
	provenance?: Record<string, unknown> & { evidence?: string[] };
	permission_tiers?: ManifestEntry[];
	sandbox_scope?: Record<string, unknown> & { evidence?: string[] };
}

interface ManifestEntry {
	evidence: string[];
	[key: string]: unknown;
}

export type TrustManifest = Record<string, unknown>;

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadClaims(root = repoRoot()): TrustRegistry {
	const registry = parse(readFileSync(resolve(root, "docs/trust/trust-claims.yml"), "utf8"));
	assertRegistry(registry);
	return registry;
}

export function buildManifest(registry: TrustRegistry, opts: { repoRoot?: string; release?: string } = {}): TrustManifest {
	const claimIds = new Set(registry.claims.map((claim) => claim.id));
	const linkedClaims = new Set<string>();
	const requireEvidence = (path: string, evidence: unknown): string[] => {
		if (!Array.isArray(evidence) || evidence.length === 0) {
			throw new Error(`${path}: evidence must be a non-empty array`);
		}
		for (const id of evidence) {
			if (typeof id !== "string" || !/^TC-\d{3}$/.test(id)) throw new Error(`${path}: invalid evidence id ${JSON.stringify(id)}`);
			if (!claimIds.has(id)) throw new Error(`${path}: unknown evidence claim ${id}`);
			linkedClaims.add(id);
		}
		return evidence;
	};
	const entries = <T extends ManifestEntry>(path: string, items: T[] | undefined): T[] => {
		if (items === undefined) return [];
		return items.map((item, index) => ({ ...item, evidence: requireEvidence(`${path}[${index}]`, item.evidence) }));
	};
	const capabilities = entries("manifest.capabilities", registry.manifest.capabilities);
	const egress = entries("manifest.egress", registry.manifest.egress);
	const never = entries("manifest.never", registry.manifest.never).map(({ statement, evidence }, index) => {
		if (typeof statement !== "string") throw new Error(`manifest.never[${index}]: statement must be a string`);
		return { statement, evidence };
	});
	const permissionTiers = entries("manifest.permission_tiers", registry.manifest.permission_tiers);
	const sandboxScope = registry.manifest.sandbox_scope === undefined ? undefined : { ...registry.manifest.sandbox_scope, evidence: requireEvidence("manifest.sandbox_scope", registry.manifest.sandbox_scope.evidence) };
	const provenance = registry.manifest.provenance === undefined ? undefined : { ...registry.manifest.provenance, evidence: requireEvidence("manifest.provenance", registry.manifest.provenance.evidence) };
	const posture = [...linkedClaims].some((id) => registry.claims.find((claim) => claim.id === id)?.status === "planned") ? "intent" : "shipped";
	const manifest: TrustManifest = {
		schema_version: registry.meta.schema_version,
		product: "pelaggio",
		release: opts.release ?? packageVersion(opts.repoRoot ?? repoRoot()),
		posture,
		generated_from: "trust-claims.yml",
		threat_model_ref: "./threat-model.md",
		defaults: registry.manifest.defaults,
		capabilities,
		egress,
		never,
		provenance,
		permission_tiers: permissionTiers,
		sandbox_scope: sandboxScope,
		claims_ref: "./trust-claims.yml",
	};
	return manifest;
}

export function manifestBytes(manifest: TrustManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateManifest(manifest: unknown, schema: unknown): string[] {
	const errors: string[] = [];
	validateNode(manifest, schema, "$", errors);
	return errors;
}

export function runCli(argv: string[] = process.argv.slice(2)): number {
	const root = repoRoot();
	const write = argv.includes("--write");
	const registry = loadClaims(root);
	const manifest = buildManifest(registry, { repoRoot: root });
	const schema = JSON.parse(readFileSync(resolve(root, "docs/trust/pelaggio.trust.schema.json"), "utf8")) as unknown;
	const errors = validateManifest(manifest, schema);
	if (errors.length > 0) {
		for (const error of errors) console.error(error);
		return 1;
	}
	if (write) {
		writeFileSync(resolve(root, "docs/trust/pelaggio.trust.json"), manifestBytes(manifest));
		return 0;
	}
	process.stdout.write(manifestBytes(manifest));
	return 0;
}

function packageVersion(root: string): string {
	try {
		const pkg = JSON.parse(readFileSync(resolve(root, "packages/pelaggio/package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0-unreleased";
	} catch {
		return "0.0.0-unreleased";
	}
}

function assertRegistry(value: unknown): asserts value is TrustRegistry {
	if (!isRecord(value)) throw new Error("trust registry must be an object");
	if (!isRecord(value.meta) || typeof value.meta.schema_version !== "string") throw new Error("trust registry meta.schema_version is required");
	if (!Array.isArray(value.claims)) throw new Error("trust registry claims must be an array");
	if (!isRecord(value.manifest)) throw new Error("trust registry manifest projection is required");
}

function validateNode(value: unknown, schema: unknown, path: string, errors: string[]): void {
	if (!isRecord(schema)) return;
	if ("const" in schema && value !== schema.const) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: expected one of ${schema.enum.map(String).join("|")}`);
	if (typeof schema.type === "string" && !matchesType(value, schema.type)) errors.push(`${path}: expected type ${schema.type}`);
	if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: string does not match ${schema.pattern}`);
	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) {
			for (const required of schema.required) {
				if (typeof required === "string" && !(required in value)) errors.push(`${path}: missing required property ${required}`);
			}
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) errors.push(`${path}: unexpected property ${key}`);
			}
		}
		for (const [key, childSchema] of Object.entries(properties)) {
			if (key in value) validateNode(value[key], childSchema, `${path}.${key}`, errors);
		}
	}
	if (Array.isArray(value) && isRecord(schema.items)) {
		for (const [index, item] of value.entries()) validateNode(item, schema.items, `${path}[${index}]`, errors);
	}
}

function matchesType(value: unknown, type: string): boolean {
	if (type === "array") return Array.isArray(value);
	if (type === "object") return isRecord(value);
	if (type === "boolean") return typeof value === "boolean";
	return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = runCli();
}
