import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "../codex-provider.js";
import {
	blockPlanPolish,
	blockWorktreeInstall,
	claudeProvider,
	composeSystemAppend,
	confinementViolations,
	getProvider,
	insideAny,
	isWorktreePath,
	mutationTargets,
	type PathSnapshot,
	realResolve,
	snapshotChanged,
	snapshotPath,
	worktreeConfinementBlock,
} from "../step-runner.js";
import type { ProviderName } from "../types.js";

function bash(command: string): HookInput {
	return { tool_name: "Bash", tool_input: { command } } as unknown as HookInput;
}

function write(fp: string): HookInput {
	return { tool_name: "Write", tool_input: { file_path: fp } } as unknown as HookInput;
}

function edit(fp: string): HookInput {
	return { tool_name: "Edit", tool_input: { file_path: fp } } as unknown as HookInput;
}

function multiEdit(fp: string): HookInput {
	return { tool_name: "MultiEdit", tool_input: { file_path: fp } } as unknown as HookInput;
}

function notebookEdit(np: string): HookInput {
	return { tool_name: "NotebookEdit", tool_input: { notebook_path: np } } as unknown as HookInput;
}

function read(fp: string): HookInput {
	return { tool_name: "Read", tool_input: { file_path: fp } } as unknown as HookInput;
}

/** A throwaway three-workspace layout under a real tmp dir: this worktree (`base`),
 * the main repo (`main`) and a sibling worktree (`sibling`) — the latter two forbidden.
 * `repo` is a prefix of `repo-105`/`repo-99` so `insideAny`'s boundary is exercised.
 * Real dirs (not synthetic strings) so realpath / symlink behavior is genuine. */
function makeWorkspace(tag: string) {
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), `conf-${tag}-`)));
	const base = join(tmp, "repo-105");
	const main = join(tmp, "repo");
	const sibling = join(tmp, "repo-99");
	for (const d of [base, main, sibling]) mkdirSync(d);
	return { tmp, base, main, sibling, roots: [main, sibling] as string[] };
}

describe("blockPlanPolish", () => {
	const cwd = "/tmp/wt";

	it("blocks Write to a relative path under docs/plans/", () => {
		const out = blockPlanPolish(write("docs/plans/tool-24.md"), cwd);
		assert.equal(out.decision, "block");
		assert.match(out.reason ?? "", /docs\/plans\//);
	});

	it("blocks Edit to an absolute path under docs/plans/", () => {
		const out = blockPlanPolish(edit("/tmp/wt/docs/plans/tool-24.md"), cwd);
		assert.equal(out.decision, "block");
	});

	it("allows writes to code files", () => {
		assert.deepEqual(blockPlanPolish(write("scripts/autopilot/foo.ts"), cwd), {});
		assert.deepEqual(blockPlanPolish(edit("src/index.ts"), cwd), {});
	});

	it("allows writes to docs/ outside plans/", () => {
		assert.deepEqual(blockPlanPolish(write("docs/roadmap-core.md"), cwd), {});
		assert.deepEqual(blockPlanPolish(write("docs/plans-archive/old.md"), cwd), {});
	});

	it("ignores non-mutating tools", () => {
		const read = { tool_name: "Read", tool_input: { file_path: "docs/plans/tool-24.md" } } as unknown as HookInput;
		const bash = { tool_name: "Bash", tool_input: { command: "echo hi > docs/plans/tool-24.md" } } as unknown as HookInput;
		assert.deepEqual(blockPlanPolish(read, cwd), {});
		assert.deepEqual(blockPlanPolish(bash, cwd), {});
	});

	it("handles missing file_path gracefully", () => {
		const bad = { tool_name: "Write", tool_input: {} } as unknown as HookInput;
		assert.deepEqual(blockPlanPolish(bad, cwd), {});
	});
});

describe("blockWorktreeInstall", () => {
	it("blocks each pnpm install-family subcommand", () => {
		for (const sub of ["install", "i", "add", "update", "up", "upgrade", "remove", "rm"]) {
			const out = blockWorktreeInstall(bash(`pnpm ${sub}`));
			assert.equal(out.decision, "block", `pnpm ${sub} should be blocked`);
			assert.match(out.reason ?? "", /symlink/i);
		}
	});

	it("blocks each npm install-family subcommand", () => {
		for (const sub of ["install", "i", "ci"]) {
			const out = blockWorktreeInstall(bash(`npm ${sub}`));
			assert.equal(out.decision, "block", `npm ${sub} should be blocked`);
		}
	});

	it("allows the worktree-deps --repair-main escape hatch", () => {
		assert.deepEqual(blockWorktreeInstall(bash("npx @cdhorne/claude-autopilot worktree-deps --repair-main")), {});
	});

	it("allows the chained escape hatch even when the trailing command would otherwise match", () => {
		assert.deepEqual(blockWorktreeInstall(bash("npx @cdhorne/claude-autopilot worktree-deps --repair-main && pnpm install")), {});
	});

	it("allows non-install pnpm/npm subcommands", () => {
		for (const cmd of ["pnpm test", "pnpm exec tsx foo.ts", "pnpm autopilot --dry-run", "pnpm check", "npm test"]) {
			assert.deepEqual(blockWorktreeInstall(bash(cmd)), {}, `should allow: ${cmd}`);
		}
	});

	it("ignores non-Bash tools", () => {
		const write = { tool_name: "Write", tool_input: { file_path: "foo.ts" } } as unknown as HookInput;
		assert.deepEqual(blockWorktreeInstall(write), {});
	});

	it("handles missing command field gracefully", () => {
		const empty = { tool_name: "Bash", tool_input: {} } as unknown as HookInput;
		assert.deepEqual(blockWorktreeInstall(empty), {});
	});

	it("blocks chained forms (cd ... && pnpm install)", () => {
		const out = blockWorktreeInstall(bash("cd packages/autopilot && pnpm install"));
		assert.equal(out.decision, "block");
	});
});

describe("isWorktreePath", () => {
	it("returns false when cwd equals repo (no-worktree / CI mode)", () => {
		assert.equal(isWorktreePath("/home/user/my-repo", "/home/user/my-repo"), false);
	});

	it("returns true when cwd is a sibling worktree", () => {
		assert.equal(isWorktreePath("/home/user/my-repo-tool-99", "/home/user/my-repo"), true);
	});

	it("returns false when paths resolve to the same directory (trailing slash)", () => {
		assert.equal(isWorktreePath("/home/user/my-repo/", "/home/user/my-repo"), false);
	});

	it("returns true for distinct paths with matching prefix", () => {
		assert.equal(isWorktreePath("/home/user/my-repo-extra", "/home/user/my-repo"), true);
	});
});

describe("getProvider — registry + guard", () => {
	it("returns the claude provider by name", () => {
		assert.equal(getProvider("claude").name, "claude");
	});

	it("returns the exact registered claudeProvider instance", () => {
		assert.equal(getProvider("claude"), claudeProvider);
	});

	it("returns the exact registered codexProvider instance", () => {
		assert.equal(getProvider("codex"), codexProvider);
	});

	it("throws on an unknown provider name (defense-in-depth for #80)", () => {
		assert.throws(() => getProvider("bogus" as ProviderName), /unknown step provider: bogus/);
	});
});

describe("composeSystemAppend", () => {
	const base = { cwd: "/tmp/wt", repo: "/home/user/repo" };

	it("includes the autonomy block in every combination", () => {
		for (const isWorktree of [true, false])
			for (const planBlockActive of [true, false]) {
				const out = composeSystemAppend({ ...base, isWorktree, planBlockActive });
				assert.match(out, /## Operating autonomously/);
				assert.match(out, /operating autonomously inside a headless pipeline/);
				assert.notEqual(out.trim(), "");
			}
	});

	it("includes the BLOCKED output contract in every combination", () => {
		for (const isWorktree of [true, false])
			for (const planBlockActive of [true, false]) {
				const out = composeSystemAppend({ ...base, isWorktree, planBlockActive });
				assert.match(out, /BLOCKED:/, "autonomy append must document the BLOCKED sentinel");
				assert.match(out, /final line/, "contract must specify the sentinel is the final line");
			}
	});

	it("emits only the autonomy block when neither worktree nor plan applies", () => {
		const out = composeSystemAppend({ ...base, isWorktree: false, planBlockActive: false });
		assert.match(out, /## Operating autonomously/);
		assert.doesNotMatch(out, /## CRITICAL/);
	});

	it("layers the worktree block after autonomy, interpolating cwd and repo", () => {
		const out = composeSystemAppend({ ...base, isWorktree: true, planBlockActive: false });
		assert.match(out, /## CRITICAL: Worktree isolation/);
		assert.match(out, /git worktree at: \/tmp\/wt/);
		assert.match(out, /main repository is at: \/home\/user\/repo/);
		assert.ok(out.indexOf("## Operating autonomously") < out.indexOf("## CRITICAL"), "autonomy precedes CRITICAL");
	});

	it("layers the plan block when planBlockActive", () => {
		const out = composeSystemAppend({ ...base, isWorktree: false, planBlockActive: true });
		assert.match(out, /## CRITICAL: Do not edit the plan/);
		assert.doesNotMatch(out, /## CRITICAL: Worktree isolation/);
	});

	it("composes all three blocks in order when worktree and plan both apply", () => {
		const out = composeSystemAppend({ ...base, isWorktree: true, planBlockActive: true });
		const iAuto = out.indexOf("## Operating autonomously");
		const iWt = out.indexOf("## CRITICAL: Worktree isolation");
		const iPlan = out.indexOf("## CRITICAL: Do not edit the plan");
		assert.ok(iAuto >= 0 && iWt >= 0 && iPlan >= 0);
		assert.ok(iAuto < iWt && iWt < iPlan, "order: autonomy → worktree → plan");
	});
});

describe("mutationTargets", () => {
	it("returns [file_path] for Write / Edit / MultiEdit", () => {
		assert.deepEqual(mutationTargets("Write", { file_path: "a.ts" }), ["a.ts"]);
		assert.deepEqual(mutationTargets("Edit", { file_path: "b.ts" }), ["b.ts"]);
		assert.deepEqual(mutationTargets("MultiEdit", { file_path: "c.ts" }), ["c.ts"]);
	});

	it("returns [notebook_path] for NotebookEdit", () => {
		assert.deepEqual(mutationTargets("NotebookEdit", { notebook_path: "nb.ipynb" }), ["nb.ipynb"]);
	});

	it("returns path-like tokens for Bash", () => {
		assert.deepEqual(mutationTargets("Bash", { command: "cd ../repo && echo x > out" }), ["../repo"]);
		assert.deepEqual(mutationTargets("Bash", { command: "cp $HOME/repo/a /tmp/b" }), ["$HOME/repo/a", "/tmp/b"]);
	});

	it("returns [] for Read and for missing fields", () => {
		assert.deepEqual(mutationTargets("Read", { file_path: "a.ts" }), []);
		assert.deepEqual(mutationTargets("Write", {}), []);
		assert.deepEqual(mutationTargets("NotebookEdit", {}), []);
		assert.deepEqual(mutationTargets("Bash", {}), []);
		assert.deepEqual(mutationTargets("Agent", { prompt: "do a thing" }), []);
	});
});

describe("insideAny", () => {
	const roots = ["/w/repo", "/w/repo-99"];

	it("matches an exact root", () => {
		assert.equal(insideAny("/w/repo", roots), "/w/repo");
	});

	it("matches a descendant of a root", () => {
		assert.equal(insideAny("/w/repo/src/x.ts", roots), "/w/repo");
		assert.equal(insideAny("/w/repo-99/y.ts", roots), "/w/repo-99");
	});

	it("does NOT match a sibling that merely shares a prefix", () => {
		assert.equal(insideAny("/w/repo-105/x.ts", roots), null);
		assert.equal(insideAny("/w/repofoo", roots), null);
	});

	it("returns null for a path outside every root", () => {
		assert.equal(insideAny("/tmp/scratch/x", roots), null);
	});
});

describe("realResolve", () => {
	it("resolves a relative path against base", () => {
		assert.equal(realResolve("a/b", "/w/base", "/home/u"), "/w/base/a/b");
	});

	it("resolves .. traversal against base", () => {
		assert.equal(realResolve("../repo/x", "/w/repo-105", "/home/u"), "/w/repo/x");
	});

	// "$" + "{HOME}/foo" avoids biome's noTemplateCurlyInString false-positive on the literal.
	it("expands a leading tilde, $HOME, and brace-HOME", () => {
		assert.equal(realResolve("~/foo", "/w/base", "/home/u"), "/home/u/foo");
		assert.equal(realResolve("$HOME/foo", "/w/base", "/home/u"), "/home/u/foo");
		assert.equal(realResolve("$" + "{HOME}/foo", "/w/base", "/home/u"), "/home/u/foo");
	});

	it("does not expand a non-home lookalike ($HOMEFOO)", () => {
		assert.equal(realResolve("$HOMEFOO/x", "/w/base", "/home/u"), "/w/base/$HOMEFOO/x");
	});

	it("follows a symlinked ancestor and resolves a not-yet-created leaf without throwing", () => {
		const tmp = realpathSync(mkdtempSync(join(tmpdir(), "conf-rr-")));
		after(() => rmSync(tmp, { recursive: true, force: true }));
		const realDir = join(tmp, "real");
		mkdirSync(realDir);
		symlinkSync(realDir, join(tmp, "linkdir"));
		// linkdir/leaf.txt does not exist yet; the symlinked ancestor must still be followed.
		assert.equal(realResolve("linkdir/leaf.txt", tmp), join(realDir, "leaf.txt"));
	});
});

describe("snapshotChanged", () => {
	const base: PathSnapshot = { exists: true, mtimeMs: 1000, size: 10 };

	it("detects creation (absent → present)", () => {
		assert.equal(snapshotChanged({ exists: false, mtimeMs: 0, size: 0 }, base), true);
	});

	it("detects deletion (present → absent)", () => {
		assert.equal(snapshotChanged(base, { exists: false, mtimeMs: 0, size: 0 }), true);
	});

	it("detects an mtime change", () => {
		assert.equal(snapshotChanged(base, { ...base, mtimeMs: 2000 }), true);
	});

	it("detects a size change", () => {
		assert.equal(snapshotChanged(base, { ...base, size: 20 }), true);
	});

	it("reports no change for identical snapshots", () => {
		assert.equal(snapshotChanged(base, { ...base }), false);
	});

	it("reports no change when both are absent", () => {
		const absent: PathSnapshot = { exists: false, mtimeMs: 0, size: 0 };
		assert.equal(snapshotChanged(absent, { ...absent }), false);
	});
});

describe("snapshotPath + confinementViolations", () => {
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "conf-viol-")));
	after(() => rmSync(tmp, { recursive: true, force: true }));

	it("flags a baselined path whose content changed", () => {
		const f = join(tmp, "changed.txt");
		writeFileSync(f, "one");
		const baselines = new Map([[f, snapshotPath(f)]]);
		writeFileSync(f, "two-longer"); // size + mtime change
		assert.deepEqual(confinementViolations(baselines), [f]);
	});

	it("flags a baselined path that did not exist but was then created", () => {
		const f = join(tmp, "created.txt");
		const baselines = new Map([[f, snapshotPath(f)]]); // baseline: absent
		writeFileSync(f, "new");
		assert.deepEqual(confinementViolations(baselines), [f]);
	});

	it("reports no violation for an untouched baselined path", () => {
		const f = join(tmp, "stable.txt");
		writeFileSync(f, "fixed");
		const baselines = new Map([[f, snapshotPath(f)]]);
		// The file is not modified after baselining, so re-stat must match.
		assert.deepEqual(confinementViolations(baselines), []);
	});
});

describe("worktreeConfinementBlock", () => {
	const ws = makeWorkspace("block");
	after(() => rmSync(ws.tmp, { recursive: true, force: true }));
	// home injected as ws.tmp so ~ / $HOME resolve to the workspace root.
	const ctx = { worktreeCwd: ws.base, forbiddenRoots: ws.roots, home: ws.tmp };

	it("blocks a Write to an absolute main-repo path", () => {
		const out = worktreeConfinementBlock(write(join(ws.main, "x.ts")), ctx);
		assert.equal(out.decision, "block");
		assert.match(out.reason ?? "", /another workspace/);
	});

	it("blocks a Write to a sibling-worktree path", () => {
		assert.equal(worktreeConfinementBlock(write(join(ws.sibling, "y.ts")), ctx).decision, "block");
	});

	it("blocks a relative ../<main>/x escape", () => {
		assert.equal(worktreeConfinementBlock(write("../repo/x.ts"), ctx).decision, "block");
	});

	it("blocks $HOME/<main>/x and ~/<main>/x spellings", () => {
		assert.equal(worktreeConfinementBlock(write("$HOME/repo/x.ts"), ctx).decision, "block");
		assert.equal(worktreeConfinementBlock(write("~/repo/x.ts"), ctx).decision, "block");
	});

	it("blocks a write through a symlinked ancestor", () => {
		symlinkSync(ws.main, join(ws.base, "mainlink"));
		assert.equal(worktreeConfinementBlock(write(join(ws.base, "mainlink", "evil.ts")), ctx).decision, "block");
	});

	it("blocks MultiEdit and NotebookEdit equivalently", () => {
		assert.equal(worktreeConfinementBlock(multiEdit(join(ws.main, "m.ts")), ctx).decision, "block");
		assert.equal(worktreeConfinementBlock(notebookEdit(join(ws.main, "n.ipynb")), ctx).decision, "block");
	});

	it("blocks a Bash `cd ../<main> && …`", () => {
		assert.equal(worktreeConfinementBlock(bash("cd ../repo && echo pwn > note"), ctx).decision, "block");
	});

	it("allows a Write inside the worktree", () => {
		assert.deepEqual(worktreeConfinementBlock(write(join(ws.base, "src", "ok.ts")), ctx), {});
		assert.deepEqual(worktreeConfinementBlock(write("src/ok.ts"), ctx), {});
	});

	it("allows Bash writing inside the worktree or to a scratch tmp path", () => {
		assert.deepEqual(worktreeConfinementBlock(bash(`echo x > ${join(ws.base, "out.txt")}`), ctx), {});
		assert.deepEqual(worktreeConfinementBlock(bash("echo x > out.txt"), ctx), {});
		assert.deepEqual(worktreeConfinementBlock(bash(`echo x > ${join(tmpdir(), "conf-outside-probe.txt")}`), ctx), {});
	});

	it("ignores Read (no mutation target)", () => {
		assert.deepEqual(worktreeConfinementBlock(read(join(ws.main, "x.ts")), ctx), {});
	});

	it("regression: an in-worktree-only run produces zero confinement violations", () => {
		// The backstop only baselines foreign targets; an all-in-worktree step
		// accumulates none, so the assertion is a no-op (ok/subtype unchanged).
		const baselines = new Map<string, PathSnapshot>();
		for (const cand of ["src/a.ts", "src/b.ts", join(ws.base, "c.ts")]) {
			const real = realResolve(cand, ws.base);
			if (insideAny(real, ws.roots)) baselines.set(real, snapshotPath(real));
		}
		assert.equal(baselines.size, 0);
		assert.deepEqual(confinementViolations(baselines), []);
	});
});
