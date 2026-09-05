#!/usr/bin/env tsx

/**
 * `pelaggio verify <commit> [--bundle <dir>] [--json]` — read-only Case verifier (#751).
 *
 * Exit codes: 0 only when overall is ACCEPTED; 1 for WITHHOLD or REJECTED; 2 for usage/config.
 * Dossier.md and stored verify.json are never ingested as evidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedBundle, loadBundle, validateDeliveryCase, validateDeliveryRecord } from "./delivery/bundle.js";
import { inspectGitSubject } from "./delivery/git-subject.js";
import type { DeliveryRecord, DeliverySubject, DeliveryVerifyResult } from "./delivery/types.js";
import { renderDossier, renderVerifyJson, renderVerifyText, verifyLoadedBundle } from "./delivery/verify.js";
import { registerPath } from "./registers.js";

export const VERIFY_USAGE = "usage: pelaggio verify <commit> [--bundle <dir>] [--json]";

export interface VerifyCliDeps {
	cwd: string;
	log: (msg: string) => void;
	inspectGit: (cwd: string, rev?: string) => DeliverySubject;
	loadBundle: typeof loadBundle;
	readFile: (path: string) => string;
	exists: (path: string) => boolean;
}

const defaultDeps: VerifyCliDeps = {
	cwd: process.cwd(),
	log: (msg) => {
		process.stdout.write(`${msg}\n`);
	},
	inspectGit: inspectGitSubject,
	loadBundle,
	readFile: (path) => readFileSync(path, "utf8"),
	exists: existsSync,
};

export type ParsedVerifyArgs = { kind: "run"; commit?: string; bundle?: string; json: boolean } | { kind: "error"; message: string };

export function parseVerifyArgs(argv: string[]): ParsedVerifyArgs {
	let commit: string | undefined;
	let bundle: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--json") {
			json = true;
			continue;
		}
		if (a === "--bundle") {
			bundle = argv[++i];
			if (!bundle) return { kind: "error", message: VERIFY_USAGE };
			continue;
		}
		if (a.startsWith("-")) return { kind: "error", message: `unknown argument: ${a}` };
		if (commit) return { kind: "error", message: VERIFY_USAGE };
		commit = a;
	}
	if (!commit && !bundle) return { kind: "error", message: VERIFY_USAGE };
	return { kind: "run", ...(commit ? { commit } : {}), ...(bundle ? { bundle } : {}), json };
}

export function discoverBundle(repo: string, resultTree: string, deps: Pick<VerifyCliDeps, "exists">): string {
	const roots = registerPath(repo, "delivery-cases", "by-tree", resultTree, "roots.json");
	if (!deps.exists(roots)) throw new Error(`no delivery-cases sidecar for tree ${resultTree} at ${roots}`);
	return resolve(roots, "..");
}

export function verifyBundleDir(bundleDir: string, git: DeliverySubject, inspectionCommand: string, deps: Pick<VerifyCliDeps, "loadBundle">): DeliveryVerifyResult {
	const loaded = deps.loadBundle(bundleDir);
	return verifyLoadedBundle(loaded, git, inspectionCommand);
}

function fact(record: DeliveryRecord, key: string): string | undefined {
	return record.facts?.find((f) => f.key === key)?.value;
}

function residualFromFact(value: string | undefined, fallback: string | null): string | null {
	if (value === undefined) return fallback;
	return value === "" ? null : value;
}

/** Freeze-time git observation reconstructed from the admitted subject record — never from Case.subject. */
export function gitFromSubjectRecord(record: DeliveryRecord, fallback: DeliverySubject): DeliverySubject {
	const emptyToNull = (value: string | undefined): string | null => (value === undefined ? fallback.repository : value === "" ? null : value);
	return {
		gitDir: fact(record, "gitDir") ?? fallback.gitDir,
		repository: emptyToNull(fact(record, "repository")),
		repositoryResidual: residualFromFact(fact(record, "repositoryResidual"), fallback.repositoryResidual),
		baseCommit: fact(record, "baseCommit") ?? fallback.baseCommit,
		baseTree: fact(record, "baseTree") ?? fallback.baseTree,
		candidateCommit: fact(record, "candidateCommit") ?? fallback.candidateCommit,
		resultTree: record.subjectBinding?.resultTree ?? fact(record, "resultTree") ?? fallback.resultTree,
		diffTreeDigest: fact(record, "diffTreeDigest") ?? fallback.diffTreeDigest,
	};
}

export function resolveInjectedGit(loaded: LoadedBundle, live: DeliverySubject | undefined): DeliverySubject {
	const deliveryCase = validateDeliveryCase(requireCase(loaded));
	if (live) return live;
	for (const digest of deliveryCase.admittedRecords) {
		const obj = loaded.objects.get(digest);
		if (!obj) continue;
		try {
			const record = validateDeliveryRecord(obj.value);
			if (record.role === "subject") return gitFromSubjectRecord(record, deliveryCase.subject);
		} catch {}
	}
	return deliveryCase.subject;
}

function requireCase(loaded: LoadedBundle): unknown {
	const obj = loaded.objects.get(loaded.roots.case);
	if (!obj) throw new Error("bundle Case object is missing");
	return obj.value;
}

export function main(argv: string[], deps: VerifyCliDeps = defaultDeps): number {
	const parsed = parseVerifyArgs(argv);
	if (parsed.kind === "error") {
		deps.log(parsed.message);
		return 2;
	}
	try {
		let bundleDir: string;
		let git: DeliverySubject;
		let inspection: string;
		if (parsed.bundle) {
			bundleDir = resolve(deps.cwd, parsed.bundle);
			if (!deps.exists(bundleDir)) {
				deps.log(`bundle not found: ${bundleDir}`);
				return 2;
			}
			const loaded = deps.loadBundle(bundleDir);
			const live = parsed.commit ? deps.inspectGit(deps.cwd, parsed.commit) : undefined;
			git = resolveInjectedGit(loaded, live);
			inspection = `npx pelaggio verify --bundle ${bundleDir}`;
			const result = verifyLoadedBundle(loaded, git, inspection);
			return emit(result, parsed.json, deps);
		}
		if (!parsed.commit) {
			deps.log(VERIFY_USAGE);
			return 2;
		}
		git = deps.inspectGit(deps.cwd, parsed.commit);
		bundleDir = discoverBundle(deps.cwd, git.resultTree, deps);
		inspection = `npx pelaggio verify ${parsed.commit}`;
		const result = verifyBundleDir(bundleDir, git, inspection, deps);
		return emit(result, parsed.json, deps);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/usage:/.test(message)) {
			deps.log(message);
			return 2;
		}
		deps.log(message);
		return 1;
	}
}

function emit(result: DeliveryVerifyResult, json: boolean, deps: VerifyCliDeps): number {
	if (json) deps.log(renderVerifyJson(result).trimEnd());
	else {
		deps.log(renderVerifyText(result).trimEnd());
		deps.log("");
		deps.log(renderDossier(result).trimEnd());
	}
	if (result.overall === "ACCEPTED") return 0;
	return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main(process.argv.slice(2)));
}
