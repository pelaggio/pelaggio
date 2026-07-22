import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "../codex-provider.js";
import { CONFIG } from "../config.js";
import { grokCapabilities } from "../grok-provider.js";
import type { MainCheckoutDeltaObserver, MainCheckoutDeltaResult } from "../helpers.js";
import { beginMainCheckoutAttribution, blockMainRepoWrite, blockPlanPolish, blockWorktreeInstall, claudeProvider, composeSystemAppend, endMainCheckoutAttribution, getProvider, isWorktreePath } from "../step-runner.js";
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

describe("main-checkout tool attribution hooks", () => {
	it("brackets every mutating tool and ignores Read", () => {
		const calls: string[] = [];
		const clean: MainCheckoutDeltaResult = { kind: "clean" };
		const observer: MainCheckoutDeltaObserver = {
			beforeTool: (id) => {
				calls.push(`before:${id}`);
				return clean;
			},
			afterTool: (id) => {
				calls.push(`after:${id}`);
				return clean;
			},
			finish: () => clean,
		};
		for (const [index, toolName] of ["Write", "Edit", "Bash", "Agent"].entries()) {
			const input = { tool_name: toolName, tool_input: {} } as unknown as HookInput;
			beginMainCheckoutAttribution(input, String(index), observer);
			endMainCheckoutAttribution(input, String(index), observer);
		}
		const read = { tool_name: "Read", tool_input: {} } as unknown as HookInput;
		beginMainCheckoutAttribution(read, "read", observer);
		endMainCheckoutAttribution(read, "read", observer);
		assert.deepEqual(calls, ["before:0", "after:0", "before:1", "after:1", "before:2", "after:2", "before:3", "after:3"]);
	});

	it("blocks a mutating tool when its baseline cannot be established", () => {
		const error: MainCheckoutDeltaResult = { kind: "error", message: "snapshot failed" };
		const observer: MainCheckoutDeltaObserver = { beforeTool: () => error, afterTool: () => error, finish: () => error };
		const out = beginMainCheckoutAttribution(write("x"), "id", observer);
		assert.equal(out.decision, "block");
		assert.match(out.reason ?? "", /snapshot failed/);
	});
});

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

describe("blockMainRepoWrite (#269 nested seats)", () => {
	const main = "/home/user/my-repo";
	const sibling = "/home/user/my-repo-269";
	const seat = "/home/user/my-repo/.dev/authoring-review-seats/abc/grok-p1";

	it("allows writes inside a sibling worktree", () => {
		assert.deepEqual(blockMainRepoWrite(write(`${sibling}/src/a.ts`), sibling, main), {});
		assert.deepEqual(blockMainRepoWrite(write("src/a.ts"), sibling, main), {});
	});

	it("blocks writes that target the main checkout from a sibling worktree", () => {
		const out = blockMainRepoWrite(write(`${main}/packages/pelaggio/x.ts`), sibling, main);
		assert.equal(out.decision, "block");
	});

	it("allows absolute writes inside a nested seat under MAIN_REPO/.dev/", () => {
		assert.deepEqual(blockMainRepoWrite(write(`${seat}/notes.md`), seat, main), {});
		assert.deepEqual(blockMainRepoWrite(write("notes.md"), seat, main), {});
	});

	it("blocks writes from a nested seat into the main tree outside the seat", () => {
		const out = blockMainRepoWrite(write(`${main}/packages/pelaggio/x.ts`), seat, main);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /targets main repo/);
	});

	it("ignores non-Write/Edit tools", () => {
		assert.deepEqual(blockMainRepoWrite(bash(`echo ${main}/x`), seat, main), {});
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

describe("provider capability matrix (#337)", () => {
	it("exposes a complete descriptor on every registered provider", () => {
		for (const name of ["claude", "codex", "grok"] as const) {
			const caps = getProvider(name).capabilities;
			assert.equal(typeof caps.semanticDeny, "boolean");
			assert.ok(Array.isArray(caps.isolation));
			assert.ok(caps.costMeter && typeof caps.costMeter.kind === "string");
			assert.equal(typeof caps.cacheReporting, "boolean");
			assert.equal(typeof caps.outputTransport, "string");
			assert.equal(typeof caps.sessionResume, "boolean");
		}
	});

	it("encodes the verified Claude/Codex/Grok factual rows", () => {
		assert.deepEqual(getProvider("claude").capabilities, {
			semanticDeny: true,
			isolation: [],
			costMeter: { kind: "usd-billed" },
			cacheReporting: true,
			outputTransport: "stream",
			sessionResume: false,
		});
		assert.deepEqual(getProvider("codex").capabilities, {
			semanticDeny: false,
			isolation: ["workspace-write"],
			costMeter: { kind: "usd-estimated" },
			cacheReporting: true,
			outputTransport: "stream-plus-final",
			sessionResume: false,
		});
		assert.deepEqual(getProvider("grok").capabilities, {
			semanticDeny: false,
			isolation: grokCapabilities(CONFIG.grokAllowUnsandboxedFallback).isolation,
			costMeter: { kind: "pool-quota", estimateFallback: "degraded" },
			cacheReporting: true,
			outputTransport: "stream",
			sessionResume: false,
		});
	});

	it("claims semanticDeny only for Claude (not OS isolation)", () => {
		assert.equal(getProvider("claude").capabilities.semanticDeny, true);
		assert.equal(getProvider("codex").capabilities.semanticDeny, false);
		assert.equal(getProvider("grok").capabilities.semanticDeny, false);
		// Isolation membership is independent of semantic deny.
		assert.ok(getProvider("codex").capabilities.isolation.includes("workspace-write"));
		assert.equal(getProvider("grok").capabilities.isolation.includes("landlock"), !CONFIG.grokAllowUnsandboxedFallback);
		assert.equal(getProvider("claude").capabilities.isolation.length, 0);
	});

	it("does not advertise Landlock when unsandboxed Grok fallback is enabled", () => {
		assert.deepEqual(grokCapabilities(false).isolation, ["landlock"]);
		assert.deepEqual(grokCapabilities(true).isolation, []);
	});

	it("reports cache counters on all three providers (corrected matrix)", () => {
		assert.equal(getProvider("claude").capabilities.cacheReporting, true);
		assert.equal(getProvider("codex").capabilities.cacheReporting, true);
		assert.equal(getProvider("grok").capabilities.cacheReporting, true);
	});

	it("does not claim typed structured output or session resume on any driver", () => {
		for (const name of ["claude", "codex", "grok"] as const) {
			const caps = getProvider(name).capabilities;
			assert.equal(caps.sessionResume, false);
			// No typed-output axis on the descriptor at all (#306 owns that future claim).
			assert.equal("typedOutput" in caps, false);
		}
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
