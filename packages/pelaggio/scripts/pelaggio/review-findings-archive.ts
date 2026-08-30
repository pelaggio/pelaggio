import { createHash } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { registerPath } from "./registers.js";

const DIGEST_PREFIX_LENGTH = 12;

export function reviewFindingsDigest(contents: Buffer | string): string {
	return createHash("sha256").update(contents).digest("hex");
}

export function appliedReviewFindingsArchivePath(mainRepo: string, itemId: string, findingsSha256: string, appliedOnSha: string): string {
	return registerPath(mainRepo, "archive", "applied-findings", `${itemId.toLowerCase()}-${findingsSha256.slice(0, DIGEST_PREFIX_LENGTH)}-${appliedOnSha}.md`);
}

export function archiveAppliedReviewFindings(mainRepo: string, itemId: string, findingsSha256: string, appliedOnSha: string, sourcePath: string): string {
	const archivePath = appliedReviewFindingsArchivePath(mainRepo, itemId, findingsSha256, appliedOnSha);
	mkdirSync(dirname(archivePath), { recursive: true });
	renameSync(sourcePath, archivePath);
	return archivePath;
}
