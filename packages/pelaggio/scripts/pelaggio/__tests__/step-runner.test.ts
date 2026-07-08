import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "../codex-provider.js";
import { blockPlanPolish, blockWorktreeInstall, claudeProvider, composeSystemAppend, getProvider, isWorktreePath } from "../step-runner.js";
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
		assert.deepEqual(blockPlanPolish(write("scripts/pelaggio/foo.ts"), cwd), {});
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
		assert.deepEqual(blockWorktreeInstall(bash("npx pelaggio worktree-deps --repair-main")), {});
	});

	it("allows the chained escape hatch even when the trailing command would otherwise match", () => {
		assert.deepEqual(blockWorktreeInstall(bash("npx pelaggio worktree-deps --repair-main && pnpm install")), {});
	});

	it("allows non-install pnpm/npm subcommands", () => {
		for (const cmd of ["pnpm test", "pnpm exec tsx foo.ts", "pnpm pelaggio --dry-run", "pnpm check", "npm test"]) {
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
		const out = blockWorktreeInstall(bash("cd packages/pelaggio && pnpm install"));
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
