/**
 * L1 git subject binder. Argument-array git inspection only; no verdicts.
 * Takes an explicit `cwd` — never imports `REPO` from `config.ts`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { DeliveryFact, DeliverySubject } from "./types.js";

export class GitSubjectError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "GitSubjectError";
	}
}

function gitText(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
	} catch (e) {
		throw new GitSubjectError(`git ${args.join(" ")} failed`, { cause: e });
	}
}

function gitBytes(cwd: string, args: string[]): Buffer {
	try {
		return execFileSync("git", args, { cwd, encoding: "buffer" });
	} catch (e) {
		throw new GitSubjectError(`git ${args.join(" ")} failed`, { cause: e });
	}
}

export function digestDiffTreeBytes(bytes: Buffer | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Bind the candidate revision's result tree, its merge-base with `main`, and the
 * raw diff-tree digest. `candidateRev` defaults to HEAD.
 */
export function inspectGitSubject(cwd: string, candidateRev = "HEAD"): DeliverySubject {
	const gitDir = gitText(cwd, ["rev-parse", "--absolute-git-dir"]);
	let repository: string | null = null;
	try {
		const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf-8" }).trim();
		repository = url === "" ? null : url;
	} catch {
		repository = null;
	}
	const candidateCommit = gitText(cwd, ["rev-parse", candidateRev]);
	const resultTree = gitText(cwd, ["rev-parse", `${candidateCommit}^{tree}`]);
	const baseCommit = gitText(cwd, ["merge-base", candidateCommit, "refs/heads/main"]);
	const baseTree = gitText(cwd, ["rev-parse", `${baseCommit}^{tree}`]);
	const diffBytes = gitBytes(cwd, ["diff-tree", "-r", "--no-commit-id", "--raw", "-z", "--no-renames", baseTree, resultTree]);
	return {
		gitDir,
		repository,
		repositoryResidual: repository === null ? "no-origin" : null,
		baseCommit,
		baseTree,
		candidateCommit,
		resultTree,
		diffTreeDigest: digestDiffTreeBytes(diffBytes),
	};
}

export function subjectFacts(subject: DeliverySubject): DeliveryFact[] {
	return [
		{ key: "gitDir", value: subject.gitDir },
		{ key: "repository", value: subject.repository ?? "" },
		{ key: "repositoryResidual", value: subject.repositoryResidual ?? "" },
		{ key: "baseCommit", value: subject.baseCommit },
		{ key: "baseTree", value: subject.baseTree },
		{ key: "candidateCommit", value: subject.candidateCommit },
		{ key: "resultTree", value: subject.resultTree },
		{ key: "diffTreeDigest", value: subject.diffTreeDigest },
	];
}
