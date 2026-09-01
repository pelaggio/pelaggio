import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { managedAuthoringReviewHostDependencyNames, resolveAuthoringReviewMainRepo, verifyOrRepairAuthoringReviewHostDependencies } from "../review/seat-deps-core.js";

const DEPENDENCIES = ["@anthropic-ai/claude-agent-sdk", "tsx", "yaml"];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pelaggio-cold-start-"));
	const main = resolve(root, "main");
	const packageNodeModules = resolve(main, "packages", "pelaggio", "node_modules");
	const seatStore = resolve(root, "seat", "node_modules", ".pnpm");
	mkdirSync(packageNodeModules, { recursive: true });
	writeFileSync(
		resolve(main, "pnpm-lock.yaml"),
		[
			"lockfileVersion: '9.0'",
			"importers:",
			"  packages/pelaggio:",
			"    dependencies:",
			...DEPENDENCIES.flatMap((name) => [`      ${JSON.stringify(name)}:`, "        specifier: ^1.0.0", "        version: 1.0.0"]),
			"",
		].join("\n"),
	);

	const expectedLinks = new Map();
	for (const name of DEPENDENCIES) {
		const parts = name.split("/");
		const storeTarget = resolve(main, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...parts);
		const seatTarget = resolve(seatStore, `${name.replace("/", "+")}@1.0.0`, "node_modules", ...parts);
		const link = resolve(packageNodeModules, ...parts);
		mkdirSync(storeTarget, { recursive: true });
		mkdirSync(seatTarget, { recursive: true });
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(relative(dirname(link), storeTarget), link, "dir");
		unlinkSync(link);
		symlinkSync(seatTarget, link, "dir");
		expectedLinks.set(link, relative(dirname(link), storeTarget));
	}
	return { root, main, expectedLinks };
}

describe("authoring-review cold-start restoration (#647)", () => {
	it("repairs startup dependencies when loaded by plain Node before tsx and yaml", async () => {
		const fx = fixture();
		try {
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.main);

			assert.equal(result.status, "repaired");
			assert.deepEqual(
				result.repaired.map((link) => link.name),
				DEPENDENCIES,
			);
			for (const [link, expected] of fx.expectedLinks) assert.equal(readlinkSync(link), expected);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("routes the workspace command through cold repair before resolving tsx", () => {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		assert.equal(manifest.scripts?.pelaggio, "node bin/pelaggio.js run");
		const binSource = readFileSync(resolve(packageRoot, "bin", "pelaggio.js"), "utf8");
		assert.ok(binSource.indexOf("verifyOrRepairAuthoringReviewHostDependencies(mainRepo)") < binSource.indexOf('import.meta.resolve("tsx")'));
	});

	it("parses the real pnpm importer without loading the yaml package", () => {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const lockfile = readFileSync(resolve(packageRoot, "../..", "pnpm-lock.yaml"), "utf8");
		assert.deepEqual(managedAuthoringReviewHostDependencyNames(lockfile), ["@anthropic-ai/claude-agent-sdk", "@linear/sdk", "diff", "tsx", "typescript", "ulid", "yaml"]);
	});

	it("resolves the primary checkout from git's dependency-free commondir file", () => {
		const root = mkdtempSync(join(tmpdir(), "pelaggio-cold-main-"));
		const main = resolve(root, "main");
		const worktree = resolve(root, "worktree");
		const gitDir = resolve(main, ".git", "worktrees", "fixture");
		try {
			mkdirSync(gitDir, { recursive: true });
			mkdirSync(worktree, { recursive: true });
			writeFileSync(resolve(worktree, ".git"), `gitdir: ${gitDir}\n`);
			writeFileSync(resolve(gitDir, "commondir"), "../..\n");

			assert.equal(resolveAuthoringReviewMainRepo(worktree), main);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
