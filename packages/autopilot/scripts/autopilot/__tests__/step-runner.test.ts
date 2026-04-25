import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { blockPlanPolish, blockWorktreeInstall, isWorktreePath } from "../step-runner.js";

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
