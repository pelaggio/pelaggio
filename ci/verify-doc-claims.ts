import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadClaims, repoRoot } from "./trust-manifest.js";
import { findMarkdownFiles } from "./verify-links.js";

const CLAIM_ID = /\bTC-\d{3}\b/g;

interface OrphanCitation {
	file: string;
	line: number;
	id: string;
}

export function citedIds(content: string): { id: string; line: number }[] {
	const cited: { id: string; line: number }[] = [];
	content.split("\n").forEach((line, index) => {
		for (const match of line.matchAll(CLAIM_ID)) cited.push({ id: match[0], line: index + 1 });
	});
	return cited;
}

export function checkFile(file: string, knownIds: Set<string>): OrphanCitation[] {
	return citedIds(readFileSync(file, "utf8"))
		.filter(({ id }) => !knownIds.has(id))
		.map(({ id, line }) => ({ file, line, id }));
}

// Scope is docs/trust/ only, deliberately (#521): this is a required CI step, so
// widening its input (e.g. to issue bodies) would add a new merge-blocking condition.
// The non-blocking issue-body citation detector is chartered separately as #530.
export function runDocClaimsGate(root = repoRoot(), dir = resolve(root, "docs/trust")): number {
	const knownIds = new Set(loadClaims(root).claims.map((claim) => claim.id));
	const orphans = findMarkdownFiles(dir)
		.sort()
		.flatMap((file) => checkFile(file, knownIds));

	console.log(`\n  Pelaggio doc-claims gate\n  ${"-".repeat(70)}`);
	if (orphans.length === 0) {
		console.log(`  all cited TC-ids resolve against trust-claims.yml\n  ${"-".repeat(70)}\n  0 orphan citations\n`);
		return 0;
	}
	for (const orphan of orphans) {
		console.log(`  ${resolve(orphan.file).slice(root.length + 1)}:${orphan.line}  cites ${orphan.id}, absent from trust-claims.yml`);
	}
	console.log(`  ${"-".repeat(70)}\n  ${orphans.length} orphan citation${orphans.length === 1 ? "" : "s"}\n`);
	return 1;
}

if (process.argv[1]?.endsWith("verify-doc-claims.ts")) {
	process.exitCode = runDocClaimsGate();
}
