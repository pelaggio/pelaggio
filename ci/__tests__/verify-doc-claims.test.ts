import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkFile, citedIds, runDocClaimsGate } from "../verify-doc-claims.js";

const KNOWN_IDS = new Set(["TC-001", "TC-002"]);

describe("doc-claims gate", () => {
	it("passes when every cited TC-id is in the registry", () => {
		const root = writeRepo({
			"docs/trust/README.md": "Guarantees: TC-001 and TC-002.",
		});
		assert.equal(runDocClaimsGate(root, join(root, "docs/trust")), 0);
	});

	it("fails when a doc cites a TC-id absent from the registry", () => {
		const root = writeRepo({
			"docs/trust/README.md": "Guarantees: TC-001 and TC-999.",
		});
		assert.equal(runDocClaimsGate(root, join(root, "docs/trust")), 1);
	});

	it("reports the file and line number of an orphan citation", () => {
		const root = writeRepo({
			"docs/trust/README.md": "intro\n\nSee TC-999 for details.\n",
		});
		const [orphan] = checkFile(join(root, "docs/trust/README.md"), KNOWN_IDS);
		assert.equal(orphan.line, 3);
		assert.equal(orphan.id, "TC-999");
	});

	it("finds cited ids across nested markdown files", () => {
		const root = writeRepo({
			"docs/trust/README.md": "TC-001",
			"docs/trust/reference/errors.md": "TC-999",
		});
		assert.equal(runDocClaimsGate(root, join(root, "docs/trust")), 1);
	});

	it("extracts every TC-id occurrence with its line number", () => {
		assert.deepEqual(citedIds("TC-001 here\nand TC-002 there"), [
			{ id: "TC-001", line: 1 },
			{ id: "TC-002", line: 2 },
		]);
	});
});

function writeRepo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "doc-claims-gate-"));
	mkdirSync(join(root, "packages/pelaggio"), { recursive: true });
	mkdirSync(join(root, "docs/trust"), { recursive: true });
	writeFileSync(join(root, "packages/pelaggio/package.json"), JSON.stringify({ version: "0.1.0" }));
	writeFileSync(join(root, "docs/trust/trust-claims.yml"), registryYaml());
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

function registryYaml(): string {
	return [
		"meta:",
		'  schema_version: "0.1.0"',
		"claims:",
		"  - id: TC-001",
		'    claim: "A shipped guarantee"',
		"    status: guarantee",
		'    applies_to: ">=0.1.0"',
		'    mechanism: "A local command proves it."',
		'    evidence_command: "node -e \\"process.exit(0)\\""',
		'    last_verified: "2026-01-01"',
		"  - id: TC-002",
		'    claim: "A planned capability"',
		"    status: planned",
		'    applies_to: "planned"',
		'    mechanism: "Documented intent."',
		'    evidence_command: "rg -n planned docs"',
		'    last_verified: "2026-01-01"',
		"manifest:",
		"  defaults: {}",
		"",
	].join("\n");
}
