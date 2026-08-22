import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "../codex-provider.js";
import { CONFIG } from "../config.js";
import { grokCapabilities } from "../grok-provider.js";
import type { MainCheckoutDeltaObserver, MainCheckoutDeltaResult } from "../helpers.js";
import { OPENCODE_CAPABILITIES, opencodeProvider } from "../opencode-provider.js";
import {
	beginMainCheckoutAttribution,
	blockForeignRootWrite,
	blockPlanPolish,
	blockWorktreeInstall,
	claudeProvider,
	composeSystemAppend,
	createStepTextProjection,
	endMainCheckoutAttribution,
	getProvider,
	isClaudeMaxTurnsError,
	isWorktreePath,
	projectClaudeAssistantBlocks,
	runStep,
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

describe("provider test guard (#420)", () => {
	it("blocks the production dispatcher under node --test before a provider can run", () => {
		assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, "this regression test must run under node --test");
		assert.throws(
			() =>
				void runStep(
					"implement",
					"must not reach a provider",
					{
						cwd: "/tmp/pelaggio-test-guard",
						profile: "standard",
						trace: false,
						parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
					},
					() => {},
				),
			/provider execution blocked under node --test.*inject a RunStepFn/s,
		);
	});
});

describe("projectClaudeAssistantBlocks", () => {
	it("projects text and tool_use input and ignores other block types", () => {
		const projection = createStepTextProjection({ assistantSeparator: "\n" });
		projectClaudeAssistantBlocks(
			[
				{ type: "text", text: "hello" },
				{ type: "thinking", text: "secret-output" },
				{ type: "tool_use", input: { command: "echo hi", description: "say hi", new_string: "FILE_BODY" } },
			],
			projection,
		);
		const { assistantText, fullText } = projection.read();
		assert.match(assistantText, /hello/);
		assert.equal(assistantText.includes("echo hi"), false);
		assert.match(fullText, /echo hi/);
		assert.match(fullText, /say hi/);
		assert.equal(fullText.includes("secret-output"), false);
		assert.equal(fullText.includes("FILE_BODY"), false);
	});
});

describe("isClaudeMaxTurnsError (#437)", () => {
	it("preserves an error_max_turns result across a later generic process exit", () => {
		assert.equal(isClaudeMaxTurnsError(new Error("Claude Code process exited with code 1"), "error_max_turns"), true);
	});

	it("recognizes the SDK max_turns_reached attachment", () => {
		const error = Object.assign(new Error("Claude Code process exited with code 1"), { attachments: [{ type: "max_turns_reached" }] });
		assert.equal(isClaudeMaxTurnsError(error, "unknown"), true);
	});

	it("does not reclassify an unrelated process failure", () => {
		const error = Object.assign(new Error("Claude Code process exited with code 1"), { attachments: [{ type: "diagnostic" }] });
		assert.equal(isClaudeMaxTurnsError(error, "unknown"), false);
	});
});

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

describe("blockForeignRootWrite (#369 / #269 nested seats)", () => {
	const main = "/home/user/my-repo";
	const sibling = "/home/user/my-repo-269";
	const other = "/home/user/my-repo-other";
	const seat = "/home/user/my-repo/.dev/authoring-review-seats/abc/grok-p1";
	const registered = [main, sibling, other];

	it("allows writes inside a sibling worktree (cwd)", () => {
		assert.deepEqual(blockForeignRootWrite(write(`${sibling}/src/a.ts`), sibling, main, registered, sibling), {});
		assert.deepEqual(blockForeignRootWrite(write("src/a.ts"), sibling, main, registered, sibling), {});
	});

	it("blocks writes that target the main checkout from a sibling worktree", () => {
		const out = blockForeignRootWrite(write(`${main}/packages/pelaggio/x.ts`), sibling, main, registered, sibling);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /main repo/);
	});

	it("blocks writes into a foreign sibling worktree", () => {
		const out = blockForeignRootWrite(write(`${other}/src/x.ts`), sibling, main, registered, sibling);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /foreign worktree/);
	});

	it("allows absolute writes inside a nested seat under MAIN_REPO/.dev/", () => {
		assert.deepEqual(blockForeignRootWrite(write(`${seat}/notes.md`), seat, main, registered), {});
		assert.deepEqual(blockForeignRootWrite(write("notes.md"), seat, main, registered), {});
	});

	it("blocks writes from a nested seat into the main tree outside the seat", () => {
		const out = blockForeignRootWrite(write(`${main}/packages/pelaggio/x.ts`), seat, main, registered);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /main repo/);
	});

	it("shipwreck shape: main cwd + ownWorktree allows own tree, blocks foreign sibling", () => {
		assert.deepEqual(blockForeignRootWrite(write(`${sibling}/done.ts`), main, main, registered, sibling), {});
		assert.deepEqual(blockForeignRootWrite(write(`${main}/bookkeeping.md`), main, main, registered, sibling), {});
		const out = blockForeignRootWrite(write(`${other}/x.ts`), main, main, registered, sibling);
		assert.equal(out.decision, "block");
	});

	it("denies Write/Edit into .dev/sessions even when cwd would allow", () => {
		const sessionsPath = `${main}/.dev/sessions/forged.json`;
		const out = blockForeignRootWrite(write(sessionsPath), main, main, registered, sibling);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /session-record/);
		// Relative path from main cwd
		const out2 = blockForeignRootWrite(write(".dev/sessions/forged.json"), main, main, registered);
		assert.equal(out2.decision, "block");
	});

	it("respects path-component boundaries (prefix sibling names)", () => {
		const almost = "/home/user/my-repo-269-extra";
		assert.deepEqual(blockForeignRootWrite(write(`${almost}/x.ts`), almost, main, [main, sibling, almost], almost), {});
	});

	it("ignores Bash commands that do not touch harness-owned registers (residual)", () => {
		assert.deepEqual(blockForeignRootWrite(bash(`echo ${main}/x`), seat, main, registered), {});
	});

	it("blocks Bash commands referencing docs/decision-log (#386 forge path)", () => {
		const out = blockForeignRootWrite(bash("printf forged > docs/decision-log/tool-1.md"), seat, main, registered);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /harness-owned register/);
	});

	it("blocks Bash commands referencing .dev/sessions", () => {
		const out = blockForeignRootWrite(bash(`cat x >> ${main}/.dev/sessions/s.json`), seat, main, registered);
		assert.equal(out.decision, "block");
	});

	it("blocks Bash commands referencing the pr-adjudication evidence stores (#510 forge path)", () => {
		const gate = blockForeignRootWrite(bash(`printf '{}' > ${main}/.dev/pr-review-gate-records/510-abc.json`), sibling, main, registered, sibling);
		assert.equal(gate.decision, "block");
		assert.match(String(gate.reason), /harness-owned register/);
		const source = blockForeignRootWrite(bash("cat forged.json >> .dev/pr-review-adjudication-sources/510-abc.json"), seat, main, registered);
		assert.equal(source.decision, "block");
		// Bare directory mention (delete/replace the store wholesale) is denied too.
		assert.equal(blockForeignRootWrite(bash("rm -rf .dev/pr-review-gate-records"), sibling, main, registered, sibling).decision, "block");
		assert.equal(blockForeignRootWrite(bash("mv forged .dev/pr-review-adjudication-sources"), sibling, main, registered, sibling).decision, "block");
	});

	it("denies Write/Edit into the pr-adjudication evidence stores even when cwd would allow (#510)", () => {
		const out = blockForeignRootWrite(write(`${main}/.dev/pr-review-gate-records/510-abc.json`), main, main, registered, sibling);
		assert.equal(out.decision, "block");
		assert.match(String(out.reason), /evidence store/);
		const out2 = blockForeignRootWrite(edit(".dev/pr-review-adjudication-sources/510-abc.json"), main, main, registered);
		assert.equal(out2.decision, "block");
		assert.match(String(out2.reason), /evidence store/);
	});

	it("blocks Bash mention and Write/Edit of the freshness-gate record store (#424 forge path)", () => {
		// A forged record would let a ship resume skip the deterministic typecheck + freshness gates.
		const bashOut = blockForeignRootWrite(bash(`printf '{}' > ${main}/.dev/freshness-gate-records/${"a".repeat(40)}.json`), sibling, main, registered, sibling);
		assert.equal(bashOut.decision, "block");
		assert.match(String(bashOut.reason), /harness-owned register/);
		assert.equal(blockForeignRootWrite(bash("rm -rf .dev/freshness-gate-records"), sibling, main, registered, sibling).decision, "block");
		const writeOut = blockForeignRootWrite(write(`${main}/.dev/freshness-gate-records/${"a".repeat(40)}.json`), main, main, registered, sibling);
		assert.equal(writeOut.decision, "block");
		assert.match(String(writeOut.reason), /evidence store/);
	});

	it("blocks Bash mention and Write/Edit of the freshness ours-intent store (#571 forge path)", () => {
		// This store is read back by the freshness classifications: a seat-forged
		// state=confirmed record (or a deletion) would launder an unproven ours merge
		// through up-to-date. The denylist covers Bash string mention and Write/Edit via
		// this hook seam; the documented residual (variable-composed paths, host
		// processes outside the hook system) stands until #511 harness-attested evidence.
		const bashOut = blockForeignRootWrite(bash(`printf '{"state":"confirmed"}' > ${main}/.dev/freshness-ours-intents/feat%2Ftool-99.json`), sibling, main, registered, sibling);
		assert.equal(bashOut.decision, "block");
		assert.match(String(bashOut.reason), /harness-owned register/);
		assert.equal(blockForeignRootWrite(bash("rm -rf .dev/freshness-ours-intents"), sibling, main, registered, sibling).decision, "block");
		const writeOut = blockForeignRootWrite(write(`${main}/.dev/freshness-ours-intents/feat%2Ftool-99.json`), main, main, registered, sibling);
		assert.equal(writeOut.decision, "block");
		assert.match(String(writeOut.reason), /evidence store/);
		const editOut = blockForeignRootWrite(edit(".dev/freshness-ours-intents/feat%2Ftool-99.json"), main, main, registered);
		assert.equal(editOut.decision, "block");
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

	it("returns the exact registered opencodeProvider instance", () => {
		assert.equal(getProvider("opencode"), opencodeProvider);
	});

	it("throws on an unknown provider name (defense-in-depth for #80)", () => {
		assert.throws(() => getProvider("bogus" as ProviderName), /unknown step provider: bogus/);
	});
});

describe("provider capability matrix (#337)", () => {
	it("exposes a complete descriptor on every registered provider", () => {
		for (const name of ["claude", "codex", "grok", "opencode"] as const) {
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
		assert.deepEqual(getProvider("opencode").capabilities, {
			semanticDeny: false,
			isolation: [], // OPENCODE_PERMISSION is a permission-policy env, not OS isolation (#137)
			costMeter: { kind: "usd-estimated" },
			cacheReporting: false,
			outputTransport: "stream",
			sessionResume: false,
		});
		assert.deepEqual(getProvider("opencode").capabilities, OPENCODE_CAPABILITIES);
	});

	it("claims semanticDeny only for Claude (not OS isolation)", () => {
		assert.equal(getProvider("claude").capabilities.semanticDeny, true);
		assert.equal(getProvider("codex").capabilities.semanticDeny, false);
		assert.equal(getProvider("grok").capabilities.semanticDeny, false);
		assert.equal(getProvider("opencode").capabilities.semanticDeny, false);
		// Isolation membership is independent of semantic deny.
		assert.ok(getProvider("codex").capabilities.isolation.includes("workspace-write"));
		assert.equal(getProvider("grok").capabilities.isolation.includes("landlock"), !CONFIG.grokAllowUnsandboxedFallback);
		assert.equal(getProvider("claude").capabilities.isolation.length, 0);
		// OpenCode's OPENCODE_PERMISSION is a policy env, not OS isolation — honest empty row (#137).
		assert.equal(getProvider("opencode").capabilities.isolation.length, 0);
	});

	it("does not advertise Landlock when unsandboxed Grok fallback is enabled", () => {
		assert.deepEqual(grokCapabilities(false).isolation, ["landlock"]);
		assert.deepEqual(grokCapabilities(true).isolation, []);
	});

	it("reports cache counters on claude/codex/grok but not opencode (unevidenced)", () => {
		assert.equal(getProvider("claude").capabilities.cacheReporting, true);
		assert.equal(getProvider("codex").capabilities.cacheReporting, true);
		assert.equal(getProvider("grok").capabilities.cacheReporting, true);
		// OpenCode's cache-counter fields are unverified (binary absent at implement) — claim false.
		assert.equal(getProvider("opencode").capabilities.cacheReporting, false);
	});

	it("does not claim typed structured output or session resume on any driver", () => {
		for (const name of ["claude", "codex", "grok", "opencode"] as const) {
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
