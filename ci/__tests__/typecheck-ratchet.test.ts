import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BaseBaselineResult, type CompilerResult, countDiagnostics, formatDeltaMarker, type PackageKey, parseBaseline, type RatchetDeps, runRatchet, type TypecheckBaseline } from "../typecheck-ratchet.js";

const BASE: TypecheckBaseline = {
	typescript: "6.0.3",
	packages: { pelaggio: 10, server: 5 },
};

function compilerOk(count: number): CompilerResult {
	const lines = Array.from({ length: count }, (_, i) => `file.ts(${i + 1},1): error TS2304: Cannot find name 'x${i}'.`);
	return { ok: true, exitCode: count === 0 ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
}

function deps(over: Partial<RatchetDeps> & { actual?: Record<PackageKey, number> } = {}): RatchetDeps {
	const actual = over.actual ?? { pelaggio: 10, server: 5 };
	return {
		runCompiler: (key) => compilerOk(actual[key]),
		readBaseline: () => structuredClone(BASE),
		readRootTypescript: () => "6.0.3",
		...over,
	};
}

describe("countDiagnostics", () => {
	it("counts one-line diagnostic headers", () => {
		const out = "a.ts(1,1): error TS2304: Cannot find name 'x'.\nb.ts(2,2): error TS2322: Type mismatch.";
		assert.equal(countDiagnostics(out, ""), 2);
	});

	it("does not count indented continuation lines", () => {
		const out = ["file.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.", "  Type 'A' is missing properties from type 'B'.", "    Property 'x' is missing."].join("\n");
		assert.equal(countDiagnostics(out, ""), 1);
	});

	it("sums stdout and stderr", () => {
		assert.equal(countDiagnostics("a.ts(1,1): error TS1: x.", "b.ts(2,2): error TS2: y."), 2);
	});

	it("returns zero for clean output", () => {
		assert.equal(countDiagnostics("", ""), 0);
		assert.equal(countDiagnostics("All good\n", "warnings only\n"), 0);
	});

	it("ignores non-TypeScript error lines", () => {
		assert.equal(countDiagnostics("error: boom\nError TS2304 missing colon", "error TSnotadigit: x"), 0);
	});
});

describe("parseBaseline", () => {
	it("accepts a well-formed baseline", () => {
		assert.deepEqual(parseBaseline(BASE), BASE);
	});

	it("rejects missing packages, extras, negatives, and non-integers", () => {
		assert.throws(() => parseBaseline({ typescript: "6.0.3", packages: { pelaggio: 1 } }), /exactly keys/);
		assert.throws(() => parseBaseline({ typescript: "6.0.3", packages: { pelaggio: 1, server: 2, web: 0 } }), /unknown key|exactly keys/);
		assert.throws(() => parseBaseline({ typescript: "6.0.3", packages: { pelaggio: -1, server: 0 } }), /non-negative/);
		assert.throws(() => parseBaseline({ typescript: "6.0.3", packages: { pelaggio: 1.5, server: 0 } }), /non-negative integer/);
		assert.throws(() => parseBaseline({ typescript: "6.0.3", packages: { pelaggio: 1, server: 2 }, extra: true }), /unknown key/);
		assert.throws(() => parseBaseline({ packages: { pelaggio: 1, server: 2 } }), /typescript/);
	});
});

describe("formatDeltaMarker", () => {
	it("formats the documented marker line", () => {
		assert.equal(formatDeltaMarker({ pelaggio: 22, server: 8 }, { pelaggio: 10, server: 5 }), "typecheck-baseline-delta: pelaggio +12, server +3");
		assert.equal(formatDeltaMarker({ pelaggio: 8, server: 5 }, { pelaggio: 10, server: 5 }), "typecheck-baseline-delta: pelaggio -2, server +0");
	});
});

describe("runRatchet — current counts", () => {
	it("passes when actual equals baseline", () => {
		const result = runRatchet(deps());
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.actual, { pelaggio: 10, server: 5 });
	});

	it("passes when actual is below baseline", () => {
		const result = runRatchet(deps({ actual: { pelaggio: 9, server: 0 } }));
		assert.equal(result.ok, true);
	});

	it("fails when either package exceeds baseline", () => {
		const highPel = runRatchet(deps({ actual: { pelaggio: 11, server: 5 } }));
		assert.equal(highPel.ok, false);
		if (!highPel.ok) {
			assert.match(highPel.message, /pelaggio: actual 11 > baseline 10/);
			assert.match(highPel.message, /environment note: if missing-module diagnostics dominate, this checkout's dependency resolution is broken rather than its code/);
			assert.match(highPel.message, /In-worktree installs are blocked by the write guard — an operator or the harness must repair the checkout before this gate can pass/);
		}

		const highSrv = runRatchet(deps({ actual: { pelaggio: 10, server: 6 } }));
		assert.equal(highSrv.ok, false);
		if (!highSrv.ok) assert.match(highSrv.message, /server: actual 6 > baseline 5/);
	});

	it("fails when baseline typescript mismatches root resolution", () => {
		const result = runRatchet(deps({ readRootTypescript: () => "5.9.0" }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /does not match root lockfile/);
	});

	it("treats compiler exit 1 and 2 with parseable diagnostics as success path", () => {
		for (const exitCode of [1, 2] as const) {
			const result = runRatchet(
				deps({
					runCompiler: () => ({
						ok: true,
						exitCode,
						stdout: "a.ts(1,1): error TS2304: x.",
						stderr: "",
					}),
					// 1 diagnostic each package → pass under matching baseline
					readBaseline: () => ({ typescript: "6.0.3", packages: { pelaggio: 1, server: 1 } }),
				}),
			);
			assert.equal(result.ok, true, `exit ${exitCode} with parseable diagnostics`);
		}
	});

	it("fails closed on spawn failure / unparseable tool exit", () => {
		const spawn = runRatchet(deps({ runCompiler: () => ({ ok: false, reason: "spawn failed for pelaggio: ENOENT" }) }));
		assert.equal(spawn.ok, false);
		if (!spawn.ok) assert.match(spawn.message, /spawn failed/);

		const unparseable = runRatchet(
			deps({
				runCompiler: () => ({ ok: false, reason: "compiler exit 2 for pelaggio with no parseable diagnostics (stdout/stderr unparseable)" }),
			}),
		);
		assert.equal(unparseable.ok, false);
		if (!unparseable.ok) assert.match(unparseable.message, /unparseable|tool failure|spawn/);
	});
});

describe("runRatchet — base-ref policy", () => {
	const prior: TypecheckBaseline = { typescript: "6.0.3", packages: { pelaggio: 10, server: 5 } };

	function withBase(base: BaseBaselineResult, over: Partial<RatchetDeps> & { actual?: Record<PackageKey, number>; baseline?: TypecheckBaseline } = {}): RatchetResultLike {
		const baseline = over.baseline ?? structuredClone(BASE);
		const d = deps({
			...over,
			readBaseline: () => baseline,
			readBaseBaseline: () => base,
			readBaseRootTypescript: over.readBaseRootTypescript ?? (() => "6.0.3"),
			readPrBody: over.readPrBody ?? (() => null),
		});
		return runRatchet(d, { baseRef: "origin/main" });
	}

	// local alias so the helper return type is named
	type RatchetResultLike = ReturnType<typeof runRatchet>;

	it("missing base baseline skips increase policy and still enforces current counts", () => {
		const ok = withBase({ kind: "missing" }, { baseline: { typescript: "6.0.3", packages: { pelaggio: 100, server: 50 } }, actual: { pelaggio: 100, server: 50 } });
		assert.equal(ok.ok, true);

		const over = withBase({ kind: "missing" }, { baseline: { typescript: "6.0.3", packages: { pelaggio: 100, server: 50 } }, actual: { pelaggio: 101, server: 50 } });
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.message, /exceeded baseline/);
	});

	it("unknown base ref / git tool failure fails closed", () => {
		const result = withBase({ kind: "error", reason: "git show origin/main:ci/typecheck-baseline.json failed (exit 128): unknown revision" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /unknown revision|failed/);
	});

	it("baseline decreases pass without a TypeScript change", () => {
		const result = withBase({ kind: "present", baseline: prior }, { baseline: { typescript: "6.0.3", packages: { pelaggio: 8, server: 4 } }, actual: { pelaggio: 8, server: 4 } });
		assert.equal(result.ok, true);
	});

	it("baseline increase fails when root TypeScript is unchanged", () => {
		const result = withBase(
			{ kind: "present", baseline: prior },
			{
				baseline: { typescript: "6.0.3", packages: { pelaggio: 12, server: 5 } },
				actual: { pelaggio: 12, server: 5 },
				readBaseRootTypescript: () => "6.0.3",
				readPrBody: () => "typecheck-baseline-delta: pelaggio +2, server +0",
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /root TypeScript resolution unchanged/);
	});

	it("baseline increase fails when PR body is absent", () => {
		const result = withBase(
			{ kind: "present", baseline: prior },
			{
				baseline: { typescript: "6.0.4", packages: { pelaggio: 12, server: 5 } },
				actual: { pelaggio: 12, server: 5 },
				readRootTypescript: () => "6.0.4",
				readBaseRootTypescript: () => "6.0.3",
				readPrBody: () => null,
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /PR body unavailable/);
	});

	it("baseline increase fails when the delta marker is wrong", () => {
		const result = withBase(
			{ kind: "present", baseline: prior },
			{
				baseline: { typescript: "6.0.4", packages: { pelaggio: 12, server: 5 } },
				actual: { pelaggio: 12, server: 5 },
				readRootTypescript: () => "6.0.4",
				readBaseRootTypescript: () => "6.0.3",
				readPrBody: () => "typecheck-baseline-delta: pelaggio +99, server +0",
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.message, /missing exact delta marker/);
			assert.match(result.message, /typecheck-baseline-delta: pelaggio \+2, server \+0/);
		}
	});

	it("baseline increase passes only with changed root TS and exact marker", () => {
		const marker = "typecheck-baseline-delta: pelaggio +2, server +0";
		const result = withBase(
			{ kind: "present", baseline: prior },
			{
				baseline: { typescript: "6.0.4", packages: { pelaggio: 12, server: 5 } },
				actual: { pelaggio: 12, server: 5 },
				readRootTypescript: () => "6.0.4",
				readBaseRootTypescript: () => "6.0.3",
				readPrBody: () => `## Notes\n\n${marker}\n`,
			},
		);
		assert.equal(result.ok, true);
	});

	it("does not treat web's separate TypeScript declaration as an upgrade exception", () => {
		// Base and head share the same root importer resolution; only a web package
		// change would not surface here because we only inspect importers["."].
		const result = withBase(
			{ kind: "present", baseline: prior },
			{
				baseline: { typescript: "6.0.3", packages: { pelaggio: 12, server: 5 } },
				actual: { pelaggio: 12, server: 5 },
				readRootTypescript: () => "6.0.3",
				readBaseRootTypescript: () => "6.0.3",
				readPrBody: () => "typecheck-baseline-delta: pelaggio +2, server +0",
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /root TypeScript resolution unchanged/);
	});
});
