import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { main, type ReviseCliDeps } from "../revise-cli.js";
import { type ClaimRevisionOutcome, reviseFindingsPath } from "../revise-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import type { CycleResult, Flags } from "../types.js";

const savedEnv: Record<string, string | undefined> = {};
before(() => {
	for (const key of ["CI", "PELAGGIO_SINGLE_SHOT"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const silentGh: GhRunner = () => {
	throw new Error("gh must not be called when primitives are injected");
};

interface Harness {
	deps: ReviseCliDeps;
	effects: string[];
	orchCalls: Array<{ flags: Flags; deps: { mode?: string } }>;
	logs: string[];
	errs: string[];
	repo: string;
	findingsPath: string;
}

function harness(
	over: {
		alreadyRevised?: boolean;
		managed?: "managed" | "unmanaged" | "unknown";
		resolveKind?: "ok" | "unavailable" | "ineligible";
		resolveReason?: string;
		recordOk?: boolean;
		claimOk?: boolean;
		claimOutcome?: ClaimRevisionOutcome;
		fetchOk?: boolean;
		worktreeOk?: boolean;
		orchExit?: number;
		ghRepo?: string;
		shipTargetName?: "direct-push" | "pull-request" | "auto-merge-pr";
		repo?: string;
	} = {},
): Harness {
	const repo = over.repo ?? mkdtempSync(join(tmpdir(), "revise-cli-"));
	const findingsPath = reviseFindingsPath(repo, "498");
	const effects: string[] = [];
	const orchCalls: Harness["orchCalls"] = [];
	const logs: string[] = [];
	const errs: string[] = [];
	const deps: ReviseCliDeps = {
		gh: silentGh,
		repo,
		ghRepo: over.ghRepo ?? "o/r",
		shipTargetName: over.shipTargetName ?? "pull-request",
		log: (msg) => {
			logs.push(msg);
		},
		err: (msg) => {
			errs.push(msg);
		},
		resolveTarget: (pr) => {
			effects.push(`resolve:${pr}`);
			if (over.resolveKind === "unavailable") return { kind: "unavailable", reason: over.resolveReason ?? "github lookup failed" };
			if (over.resolveKind === "ineligible") return { kind: "ineligible", reason: over.resolveReason ?? "pull request is a draft" };
			return {
				kind: "ok",
				target: { prNumber: pr, itemId: "498", branch: "feat/issue-498-revise", alreadyRevised: !!over.alreadyRevised },
			};
		},
		managedState: (itemId) => {
			effects.push(`managed:${itemId}`);
			return over.managed ?? "managed";
		},
		claimRevision: async (prNumber) => {
			effects.push(`claim:${prNumber}`);
			if (over.claimOutcome) return over.claimOutcome;
			return over.claimOk !== false ? "claimed" : "unavailable";
		},
		fetchFindings: (prNumber, path) => {
			effects.push(`fetch:${prNumber}`);
			if (over.fetchOk === false) return false;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "<!-- pelaggio-pr-review -->\nfindings");
			return true;
		},
		ensureWorktree: (worktreePath, branch) => {
			effects.push(`worktree:${branch}`);
			return over.worktreeOk === false ? null : worktreePath;
		},
		recordInvocation: (_prNumber, disposition, allowRepeat) => {
			effects.push(`record:${disposition}:allow=${allowRepeat}`);
			return over.recordOk !== false;
		},
		runOrchestrator: async (flags, orchDeps = {}) => {
			effects.push("orchestrator");
			orchCalls.push({ flags, deps: { mode: orchDeps.mode } });
			const result: CycleResult = { itemId: flags.resume ?? null, completed: (over.orchExit ?? 0) === 0, cost: 0 };
			return { exitCode: over.orchExit ?? 0, results: [result] };
		},
		resolveWorktree: (id) => join(repo, `wt-${id}`),
	};
	return { deps, effects, orchCalls, logs, errs, repo, findingsPath };
}

describe("pelaggio revise — parsing", () => {
	it("requires a positive numeric --pr and accepts optional --allow-repeat", async () => {
		const ok = harness();
		assert.equal(await main(["--pr", "42"], ok.deps), 0);
		assert.equal(await main(["--pr", "42", "--allow-repeat"], ok.deps), 0);
	});

	it("unknown, missing, zero, negative, and nonnumeric inputs exit 2 with no side effects", async () => {
		for (const argv of [[], ["--pr"], ["--pr", "0"], ["--pr", "-1"], ["--pr", "nope"], ["--pr", "1", "--bogus"], ["42"]]) {
			const h = harness();
			assert.equal(await main(argv, h.deps), 2, argv.join(" ") || "(empty)");
			assert.deepEqual(h.effects, []);
			assert.equal(h.orchCalls.length, 0);
		}
	});
});

describe("pelaggio revise — first pass", () => {
	it("records accepted-first-pass, claims, fetches findings, ensures worktree, and runs operator-revision", async () => {
		const h = harness({ orchExit: 0 });
		assert.equal(await main(["--pr", "42"], h.deps), 0);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:accepted-first-pass:allow=false", "claim:42", "fetch:42", "worktree:feat/issue-498-revise", "orchestrator"]);
		assert.equal(h.orchCalls.length, 1);
		assert.equal(h.orchCalls.at(0)?.flags.resume, "498");
		assert.equal(h.orchCalls.at(0)?.flags["review-findings"], h.findingsPath);
		assert.ok(h.findingsPath.startsWith("/"), "findings path must be absolute");
		assert.equal(h.orchCalls.at(0)?.deps.mode, "operator-revision");
		assert.ok(existsSync(h.findingsPath));
		rmSync(h.repo, { recursive: true, force: true });
	});

	it("propagates a non-zero orchestrator exit and leaves the findings file", async () => {
		const h = harness({ orchExit: 1 });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.ok(existsSync(h.findingsPath));
		rmSync(h.repo, { recursive: true, force: true });
	});
});

describe("pelaggio revise — one-pass label", () => {
	it("refuses a labeled PR without --allow-repeat: records refusal, no claim/fetch/worktree/orch", async () => {
		const h = harness({ alreadyRevised: true });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:refused-repeat:allow=false"]);
		assert.equal(h.orchCalls.length, 0);
		assert.ok(h.errs.some((e) => e.includes("--allow-repeat")));
		assert.ok(h.errs.some((e) => e.includes("--resume") && e.includes("--review-findings")));
		rmSync(h.repo, { recursive: true, force: true });
	});

	it("explicit --allow-repeat records the override and runs once without claiming", async () => {
		const h = harness({ alreadyRevised: true });
		assert.equal(await main(["--pr", "42", "--allow-repeat"], h.deps), 0);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:accepted-repeat:allow=true", "fetch:42", "worktree:feat/issue-498-revise", "orchestrator"]);
		assert.ok(!h.effects.some((e) => e.startsWith("claim:")));
		rmSync(h.repo, { recursive: true, force: true });
	});
});

describe("pelaggio revise — fail closed before GitHub writes", () => {
	it("missing GitHub repo config exits 2 with no resolve/record/orch", async () => {
		const h = harness({ ghRepo: "" });
		assert.equal(await main(["--pr", "42"], h.deps), 2);
		assert.deepEqual(h.effects, []);
		assert.match(h.errs.join("\n"), /no GitHub repo configured/);
	});

	it("direct-push ship target exits 2 with no GitHub writes", async () => {
		const h = harness({ shipTargetName: "direct-push" });
		assert.equal(await main(["--pr", "42"], h.deps), 2);
		assert.deepEqual(h.effects, []);
		assert.match(h.errs.join("\n"), /PR ship target/);
	});

	it("ambient CI=true exits 2 with no GitHub writes", async () => {
		process.env.CI = "true";
		try {
			const h = harness();
			assert.equal(await main(["--pr", "42"], h.deps), 2);
			assert.deepEqual(h.effects, []);
			assert.match(h.errs.join("\n"), /CI \/ PELAGGIO_SINGLE_SHOT/);
		} finally {
			delete process.env.CI;
		}
	});

	it("ambient PELAGGIO_SINGLE_SHOT=1 exits 2 with no GitHub writes", async () => {
		process.env.PELAGGIO_SINGLE_SHOT = "1";
		try {
			const h = harness();
			assert.equal(await main(["--pr", "42"], h.deps), 2);
			assert.deepEqual(h.effects, []);
		} finally {
			delete process.env.PELAGGIO_SINGLE_SHOT;
		}
	});
});

describe("pelaggio revise — fail closed before paid work", () => {
	it("ineligible target exits 1 with no record/claim/orch", async () => {
		const h = harness({ resolveKind: "ineligible", resolveReason: "pull request is a draft" });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42"]);
		assert.match(h.errs.join("\n"), /draft/);
	});

	it("unavailable target exits 1 (retryable) with no record", async () => {
		const h = harness({ resolveKind: "unavailable", resolveReason: "github lookup failed" });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42"]);
		assert.match(h.errs.join("\n"), /github lookup failed/);
	});

	it("unmanaged issue exits 1 with no record", async () => {
		const h = harness({ managed: "unmanaged" });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498"]);
		assert.match(h.errs.join("\n"), /not a pelaggio-managed item/);
	});

	it("unknown managed-state is unavailable, not unmanaged", async () => {
		const h = harness({ managed: "unknown" });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498"]);
		assert.ok(!h.errs.some((e) => /not a pelaggio/i.test(e)));
		assert.match(h.errs.join("\n"), /retry/);
	});

	it("audit-comment failure is fail-closed (no claim/fetch/orch)", async () => {
		const h = harness({ recordOk: false });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:accepted-first-pass:allow=false"]);
		assert.equal(h.orchCalls.length, 0);
	});

	it("label-claim failure is fail-closed (no fetch/orch)", async () => {
		const h = harness({ claimOk: false });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:accepted-first-pass:allow=false", "claim:42"]);
		assert.equal(h.orchCalls.length, 0);
	});

	it("a pass claimed concurrently between lookup and claim is refused (no fetch/worktree/orch)", async () => {
		// resolveTarget saw no label, but the atomic claim observed a concurrent winner
		// (in-run sweep or a second operator invocation) — the CLI must not start a
		// duplicate paid pass in the same claim worktree.
		const h = harness({ claimOutcome: "already-claimed" });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.deepEqual(h.effects, ["resolve:42", "managed:498", "record:accepted-first-pass:allow=false", "claim:42"]);
		assert.equal(h.orchCalls.length, 0);
		assert.ok(
			h.errs.some((e) => e.includes("concurrent revise caller")),
			`expected a concurrent-claim refusal message; got:\n${h.errs.join("\n")}`,
		);
		rmSync(h.repo, { recursive: true, force: true });
	});

	it("absent findings comment is fail-closed (no orch)", async () => {
		const h = harness({ fetchOk: false });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.ok(h.effects.includes("fetch:42"));
		assert.ok(!h.effects.includes("orchestrator"));
		assert.ok(!h.effects.includes("worktree:feat/issue-498-revise"));
	});

	it("worktree restoration failure is fail-closed (no orch)", async () => {
		const h = harness({ worktreeOk: false });
		assert.equal(await main(["--pr", "42"], h.deps), 1);
		assert.ok(h.effects.includes("worktree:feat/issue-498-revise"));
		assert.ok(!h.effects.includes("orchestrator"));
		rmSync(h.repo, { recursive: true, force: true });
	});
});
