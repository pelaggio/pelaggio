import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildManifest, type ClaimStatus, loadClaims, manifestBytes, repoRoot, type TrustClaim, validateManifest } from "./trust-manifest.js";

const VALID_STATUSES = new Set<ClaimStatus>(["guarantee", "default", "best_effort", "planned", "not_supported"]);
const PLACEHOLDER = /\b(?:GAP|planned|n\/a|TBD|TODO)\b|<[^>]+>|npm view/i;
const STALE_DAYS = 180;

interface GateRow {
	id: string;
	result: "PASS" | "FAIL" | "WARN" | "DRIFT" | "SCHEMA";
	note: string;
}

export function runTrustGate(root = repoRoot()): number {
	const rows: GateRow[] = [];
	let failed = 0;
	let ran = 0;
	const registry = loadClaims(root);

	for (const claim of registry.claims) {
		const errors = validateClaim(claim);
		if (errors.length > 0) {
			failed += errors.length;
			rows.push({ id: claim.id ?? "(missing)", result: "FAIL", note: errors.join("; ") });
			continue;
		}
		const stale = staleNote(claim.last_verified);
		if (stale !== null) rows.push({ id: claim.id, result: "WARN", note: stale });
		if (claim.status !== "guarantee") continue;
		const command = claim.evidence_command?.trim() ?? "";
		if (command === "" || PLACEHOLDER.test(command)) {
			failed++;
			rows.push({ id: claim.id, result: "FAIL", note: "guarantee evidence is missing or placeholder-like" });
			continue;
		}
		const result = runEvidence(command, root);
		ran++;
		if (!result.pass) failed++;
		rows.push({ id: claim.id, result: result.pass ? "PASS" : "FAIL", note: result.note });
	}

	const manifest = buildManifest(registry, { repoRoot: root });
	const schema = JSON.parse(readFileSync(resolve(root, "docs/trust/pelaggio.trust.schema.json"), "utf8")) as unknown;
	const schemaErrors = validateManifest(manifest, schema);
	for (const error of schemaErrors) rows.push({ id: "manifest", result: "SCHEMA", note: error });
	failed += schemaErrors.length;

	const expectedManifest = manifestBytes(manifest);
	const manifestPath = resolve(root, "docs/trust/pelaggio.trust.json");
	const actualManifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
	if (actualManifest !== expectedManifest) {
		failed++;
		rows.push({ id: "manifest", result: "DRIFT", note: "generated manifest differs; run `pnpm trust:generate`" });
	}

	console.log("\n  Pelaggio trust gate\n  " + "-".repeat(70));
	for (const row of rows) console.log(`  ${row.id.padEnd(10)} ${row.result.padEnd(6)} ${row.note}`);
	console.log(`  ${"-".repeat(70)}\n  ${ran} guarantee commands run · ${failed} failed\n`);
	return failed === 0 ? 0 : 1;
}

function validateClaim(claim: Partial<TrustClaim>): string[] {
	const errors: string[] = [];
	if (typeof claim.id !== "string" || !/^TC-\d{3}$/.test(claim.id)) errors.push("invalid id");
	if (!VALID_STATUSES.has(claim.status as ClaimStatus)) errors.push("invalid status");
	if (typeof claim.claim !== "string" || claim.claim.trim() === "") errors.push("missing claim");
	if (typeof claim.mechanism !== "string" || claim.mechanism.trim() === "") errors.push("missing mechanism");
	if (typeof claim.last_verified !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(claim.last_verified)) {
		errors.push("missing or malformed last_verified");
	} else if (isFutureDate(claim.last_verified)) {
		errors.push("last_verified is in the future");
	}
	return errors;
}

function runEvidence(command: string, root: string): { pass: boolean; note: string } {
	const expectNone = /expect:\s*none/i.test(command);
	let out = "";
	let code = 0;
	let stderr = "";
	try {
		out = execSync(command, { cwd: root, shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).toString();
	} catch (error) {
		const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		code = err.status ?? 1;
		out = err.stdout?.toString() ?? "";
		stderr = err.stderr?.toString() ?? "";
	}
	if (expectNone) {
		const pass = out.trim() === "" && code < 2;
		return { pass, note: pass ? "(expect: none)" : `exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}` };
	}
	return { pass: code === 0, note: `exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}` };
}

function staleNote(date: string | undefined): string | null {
	if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isFutureDate(date)) return null;
	const then = new Date(`${date}T00:00:00.000Z`);
	const ageDays = Math.floor((Date.now() - then.getTime()) / 86_400_000);
	return ageDays > STALE_DAYS ? `last_verified is ${ageDays} days old; evidence still ran live` : null;
}

function isFutureDate(date: string): boolean {
	return new Date(`${date}T00:00:00.000Z`).getTime() > Date.now() + 86_400_000;
}

if (process.argv[1]?.endsWith("verify-claims.ts")) {
	process.exitCode = runTrustGate();
}
