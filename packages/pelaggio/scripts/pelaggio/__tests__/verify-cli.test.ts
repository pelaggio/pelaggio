import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadBundle, publishAttachment, publishObject, writeRoots } from "../delivery/bundle.js";
import { inspectGitSubject, subjectFacts } from "../delivery/git-subject.js";
import type { DeliveryCase, DeliveryRecord } from "../delivery/types.js";
import { registerPath } from "../registers.js";
import { main, parseVerifyArgs } from "../verify-cli.js";

const ISSUED = "2026-08-31T12:00:00.000Z";

function issuer() {
	return { kind: "local" as const, id: "pelaggio-shadow" };
}

function tempGit(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-verify-cli-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	writeFileSync(join(dir, "base.txt"), "base\n");
	execSync("git add -A && git commit -q -m base", { cwd: dir });
	execSync("git checkout -q -b feat/751", { cwd: dir });
	writeFileSync(join(dir, "impl.txt"), "fix\n");
	execSync("git add -A && git commit -q -m impl", { cwd: dir });
	return dir;
}

function rec(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
	return {
		schemaVersion: 1,
		kind: "Observation",
		id: "r",
		role: "subject",
		issuedAt: ISSUED,
		issuer: issuer(),
		...overrides,
	};
}

function publishFor(repo: string, dest: string, extra?: { human?: boolean; mutateTree?: boolean }): { commit: string; tree: string } {
	const git = inspectGitSubject(repo);
	mkdirSync(dest, { recursive: true });
	const subject = rec({
		id: "subject",
		role: "subject",
		subjectBinding: { resultTree: git.resultTree },
		facts: subjectFacts(git),
	});
	const intent = rec({ kind: "Decision", id: "intent", role: "authorized-intent" });
	const scope = rec({ kind: "Assessment", id: "scope", role: "scope" });
	const context = rec({ id: "context", role: "governing-context" });
	const acceptance = rec({
		id: "acceptance",
		role: "acceptance-claim",
		subjectBinding: { resultTree: git.resultTree, configuration: "automatic-quick" },
	});
	const review = rec({ kind: "Assessment", id: "review", role: "review" });
	const att = publishAttachment(dest, "handoff\n");
	intent.attachments = [{ digest: att, role: "handoff" }];
	const digests = [subject, intent, scope, context, acceptance, review].map((r) => publishObject(dest, r));
	const subjectD = digests[0];
	const intentD = digests[1];
	const scopeD = digests[2];
	const contextD = digests[3];
	const acceptanceD = digests[4];
	const reviewD = digests[5];
	if (!subjectD || !intentD || !scopeD || !contextD || !acceptanceD || !reviewD) throw new Error("expected six record digests");
	const subjectTree = extra?.mutateTree ? "0".repeat(40) : git.resultTree;
	const deliveryCase: DeliveryCase = {
		schemaVersion: 1,
		kind: "Case",
		id: "case-751",
		issuedAt: ISSUED,
		issuer: issuer(),
		subject: extra?.mutateTree ? { ...git, resultTree: subjectTree } : git,
		admittedRecords: digests,
		obligations: [
			{ id: "intent", group: "intent", recordDigests: [intentD], attachmentDigests: [att] },
			{ id: "subject", group: "subject-result-tree", recordDigests: [subjectD], attachmentDigests: [] },
			{ id: "binding", group: "subject-config-binding", recordDigests: [acceptanceD], attachmentDigests: [] },
			{ id: "scope", group: "scope", recordDigests: [scopeD], attachmentDigests: [] },
			{ id: "context", group: "governing-context", recordDigests: [contextD], attachmentDigests: [] },
			{ id: "acceptance", group: "acceptance", recordDigests: [acceptanceD], attachmentDigests: [] },
			{ id: "review", group: "review-findings", recordDigests: [reviewD], attachmentDigests: [] },
		],
		residuals: ["Human authorization pending"],
	};
	const caseDigest = publishObject(dest, deliveryCase);
	const policyDecision = publishObject(
		dest,
		rec({
			kind: "Decision",
			id: "policy",
			role: "policy",
			caseDigest,
			authority: "harness-policy",
		}),
	);
	const roots: { schemaVersion: 1; case: string; policyDecision: string; humanDecision?: string } = { schemaVersion: 1, case: caseDigest, policyDecision };
	if (extra?.human) {
		roots.humanDecision = publishObject(
			dest,
			rec({
				kind: "Decision",
				id: "human",
				role: "human-authorization",
				caseDigest,
				authority: "operator",
			}),
		);
	}
	writeRoots(dest, roots);
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
	return { commit, tree: git.resultTree };
}

describe("parseVerifyArgs", () => {
	it("requires a commit or --bundle", () => {
		assert.equal(parseVerifyArgs([]).kind, "error");
		assert.deepEqual(parseVerifyArgs(["abc", "--json"]), { kind: "run", commit: "abc", json: true });
		assert.deepEqual(parseVerifyArgs(["--bundle", "/tmp/p"]), { kind: "run", bundle: "/tmp/p", json: false });
		assert.equal(parseVerifyArgs(["--bogus"]).kind, "error");
	});
});

describe("pelaggio verify CLI", () => {
	it("exit 2 on usage errors", () => {
		const log: string[] = [];
		assert.equal(
			main([], {
				cwd: "/tmp",
				log: (m) => log.push(m),
				inspectGit: inspectGitSubject,
				loadBundle: () => {
					throw new Error("no");
				},
				readFile: () => "",
				exists: () => false,
			}),
			2,
		);
		assert.match(log.join("\n"), /usage: pelaggio verify/);
	});

	it("verifies an explicit --bundle and returns 1 for the golden WITHHOLD packet", () => {
		const repo = tempGit();
		const bundle = join(repo, "packet");
		publishFor(repo, bundle);
		const log: string[] = [];
		const code = main(["--bundle", bundle, "--json"], {
			cwd: repo,
			log: (m) => log.push(m),
			inspectGit: inspectGitSubject,
			loadBundle,
			readFile: (p) => readFileSync(p, "utf8"),
			exists: (p) => existsSync(p),
		});
		assert.equal(code, 1);
		const parsed = JSON.parse(log[0] ?? "{}") as { overall: string; case: string; authorization: string; effect: string };
		assert.equal(parsed.overall, "WITHHOLD");
		assert.equal(parsed.case, "ACCEPTED");
		assert.equal(parsed.authorization, "AWAITING AUTHORIZATION");
		assert.equal(parsed.effect, "EFFECT UNPROVEN");
	});

	it("discovers the sidecar via registerPath for pelaggio verify <commit>", () => {
		const repo = tempGit();
		const { commit, tree } = publishFor(repo, join(mkdtempSync(join(tmpdir(), "pkt-")), "b"));
		const sidecar = registerPath(repo, "delivery-cases", "by-tree", tree);
		publishFor(repo, sidecar, { human: true });
		const log: string[] = [];
		const code = main([commit, "--json"], {
			cwd: repo,
			log: (m) => log.push(m),
			inspectGit: inspectGitSubject,
			loadBundle,
			readFile: (p) => readFileSync(p, "utf8"),
			exists: (p) => existsSync(p),
		});
		assert.equal(code, 0, log.join("\n"));
		const parsed = JSON.parse(log[0] ?? "{}") as { overall: string };
		assert.equal(parsed.overall, "ACCEPTED");
	});

	it("discovers a same-tree sidecar and keeps the Case ACCEPTED for a successor commit", () => {
		const repo = tempGit();
		const first = inspectGitSubject(repo);
		const sidecar = registerPath(repo, "delivery-cases", "by-tree", first.resultTree);
		publishFor(repo, sidecar, { human: true });
		execSync("git commit -q --allow-empty -m same-tree-successor", { cwd: repo });
		const successor = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
		assert.notEqual(successor, first.candidateCommit);
		assert.equal(inspectGitSubject(repo, successor).resultTree, first.resultTree);

		const log: string[] = [];
		const code = main([successor, "--json"], {
			cwd: repo,
			log: (m) => log.push(m),
			inspectGit: inspectGitSubject,
			loadBundle,
			readFile: (p) => readFileSync(p, "utf8"),
			exists: (p) => existsSync(p),
		});
		assert.equal(code, 0, log.join("\n"));
		const parsed = JSON.parse(log[0] ?? "{}") as { overall: string; case: string };
		assert.equal(parsed.overall, "ACCEPTED");
		assert.equal(parsed.case, "ACCEPTED");
	});

	it("a mutated result-tree bundle exits 1 with REJECTED", () => {
		const repo = tempGit();
		const bundle = join(repo, "mut");
		publishFor(repo, bundle, { mutateTree: true });
		const log: string[] = [];
		const code = main(["--bundle", bundle, "--json"], {
			cwd: repo,
			log: (m) => log.push(m),
			inspectGit: inspectGitSubject,
			loadBundle,
			readFile: (p) => readFileSync(p, "utf8"),
			exists: (p) => existsSync(p),
		});
		assert.equal(code, 1);
		const parsed = JSON.parse(log[0] ?? "{}") as { overall: string; case: string };
		assert.equal(parsed.overall, "REJECTED");
		assert.equal(parsed.case, "REJECTED");
	});
});
