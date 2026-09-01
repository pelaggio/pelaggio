import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadBundle } from "../../packages/pelaggio/scripts/pelaggio/delivery/bundle.js";
import { inspectGitSubject } from "../../packages/pelaggio/scripts/pelaggio/delivery/git-subject.js";
import { renderDossier, verifyLoadedBundle } from "../../packages/pelaggio/scripts/pelaggio/delivery/verify.js";
import { registerPath } from "../../packages/pelaggio/scripts/pelaggio/registers.js";
import { main as verifyMain } from "../../packages/pelaggio/scripts/pelaggio/verify-cli.js";
import { composeReconciledChange751, packetHasForbiddenLeak, parseComposeArgs } from "../reconciled-change-751.js";

function tempGit(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-751-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	writeFileSync(join(dir, "base.txt"), "base\n");
	execSync("git add -A && git commit -q -m base", { cwd: dir });
	execSync("git checkout -q -b feat/751", { cwd: dir });
	writeFileSync(join(dir, "impl.txt"), "706-fix\n");
	execSync("git add -A && git commit -q -m impl", { cwd: dir });
	return dir;
}

function verifyDeps(cwd: string) {
	return {
		cwd,
		log: () => {},
		inspectGit: inspectGitSubject,
		loadBundle,
		readFile: (p: string) => readFileSync(p, "utf8"),
		exists: (p: string) => existsSync(p),
	};
}

describe("parseComposeArgs", () => {
	it("requires --out", () => {
		assert.throws(() => parseComposeArgs([]), /--out/);
	});
});

describe("reconciled-change-751 composer", () => {
	it("composes a Case-complete golden packet, six mutations, and two randomized cold packets", () => {
		const repo = tempGit();
		const out = mkdtempSync(join(tmpdir(), "pelaggio-751-out-"));
		const result = composeReconciledChange751({ out, cwd: repo });
		assert.equal(result.status, "withheld");
		assert.match(result.caseDigest, /^[0-9a-f]{64}$/);

		const git = inspectGitSubject(repo);
		const golden = verifyLoadedBundle(loadBundle(join(out, "golden")), git, "npx pelaggio verify --bundle golden");
		assert.equal(golden.caseDisposition, "ACCEPTED");
		assert.equal(golden.authorization, "AWAITING AUTHORIZATION");
		assert.equal(golden.effect, "EFFECT UNPROVEN");
		assert.equal(golden.overall, "WITHHOLD");

		assert.equal(result.mutations["result-tree"].caseDisposition, "REJECTED");
		assert.equal(result.mutations["result-tree"].overall, "REJECTED");
		assert.equal(result.mutations["missing-attachment"].caseDisposition, "WITHHOLD");
		assert.equal(result.mutations["other-subject"].caseDisposition, "WITHHOLD");
		assert.equal(result.mutations["open-finding"].caseDisposition, "REJECTED");
		assert.equal(result.mutations["missing-disposition"].caseDisposition, "WITHHOLD");
		assert.equal(result.mutations["wrong-authority"].caseDisposition, "ACCEPTED");
		assert.equal(result.mutations["wrong-authority"].overall, "WITHHOLD");

		const mapping = JSON.parse(readFileSync(result.sealedMappingPath, "utf8")) as { valid: string; mutation: string; order: string[] };
		assert.equal(existsSync(join(out, "cold", mapping.valid, "roots.json")), true);
		assert.equal(existsSync(join(out, "cold", mapping.mutation, "roots.json")), true);
		assert.notEqual(mapping.valid, mapping.mutation);
		assert.equal(mapping.order.length, 2);
		assert.equal(existsSync(join(out, "cold", mapping.valid, "sealed-mapping.json")), false);
		assert.deepEqual(packetHasForbiddenLeak(join(out, "cold", mapping.valid)), []);
		assert.deepEqual(packetHasForbiddenLeak(join(out, "cold", mapping.mutation)), []);

		const coldNames = readdirSync(join(out, "cold")).sort();
		assert.equal(coldNames.length, 2);
		assert.ok(coldNames.every((n) => /^pkt-[0-9a-f]+$/.test(n)));

		const regenerated = renderDossier(verifyLoadedBundle(loadBundle(join(out, "golden")), git, `npx pelaggio verify --bundle ${join(out, "golden")}`));
		assert.equal(readFileSync(join(out, "golden", "dossier.md"), "utf8"), regenerated);

		writeFileSync(join(out, "golden", "dossier.md"), "# hand-authored green\nOverall: ACCEPTED\n");
		const afterEdit = renderDossier(verifyLoadedBundle(loadBundle(join(out, "golden")), git, `npx pelaggio verify --bundle ${join(out, "golden")}`));
		assert.equal(afterEdit, regenerated);

		const logs: string[] = [];
		const code = verifyMain(["--bundle", join(out, "golden"), "--json"], {
			...verifyDeps(repo),
			log: (m) => logs.push(m),
		});
		assert.equal(code, 1);
		assert.equal(JSON.parse(logs[0] ?? "{}").overall, "WITHHOLD");

		const payload = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { status: string };
		assert.equal(payload.status, "withheld");
	});

	it("publishes through registerPath only when --publish-to is set", () => {
		const repo = tempGit();
		const out = mkdtempSync(join(tmpdir(), "pelaggio-751-out-"));
		const publishTo = mkdtempSync(join(tmpdir(), "pelaggio-751-main-"));
		const git = inspectGitSubject(repo);
		composeReconciledChange751({ out, cwd: repo, publishTo });
		const sidecar = registerPath(publishTo, "delivery-cases", "by-tree", git.resultTree, "roots.json");
		assert.equal(existsSync(sidecar), true);
		const logs: string[] = [];
		const commit = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim();
		const code = verifyMain([commit, "--json"], {
			cwd: publishTo,
			log: (m) => logs.push(m),
			inspectGit: () => inspectGitSubject(repo),
			loadBundle,
			readFile: (p) => readFileSync(p, "utf8"),
			exists: (p) => existsSync(p),
		});
		assert.equal(code, 1, logs.join("\n"));
		assert.equal(JSON.parse(logs[0] ?? "{}").overall, "WITHHOLD");
	});
});
