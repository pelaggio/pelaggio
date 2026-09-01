/**
 * Conformance for the `.dev` register chokepoint (plan step 7a). Two halves make the guarantee
 * hold by construction: (1) every `.dev` token in a string/template/regex literal in either
 * package lives in `registers.ts` — recognize-by-invariant, so no path can be built around the
 * API (a dependency-free bootstrap module is exempted only through a binding test that pins its
 * composition to the table); (2) the seat denials derive from the table — a harness register is
 * denied without anyone remembering to extend a list.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	bashDeniedRegisterPattern,
	bashDeniedRegisters,
	devRootPathspec,
	REGISTER_SPECS,
	REGISTERS,
	type RegisterName,
	registerFamilyPath,
	registerPath,
	registerRelativePath,
	writeDeniedRegisterFor,
	writeDeniedRegisters,
} from "../registers.js";

const PELAGGIO_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PELAGGIO_SRC, "..", "..", "..", "..");
const SCAN_ROOTS = [PELAGGIO_SRC, join(REPO, "packages", "server", "src")];
const CHOKEPOINT = "registers.ts";
/**
 * Dependency-free bootstrap modules: they run under plain node before dependencies exist, so
 * they cannot import the chokepoint. Each is still scanned, but its `.dev` composition is
 * exempted from the literal ban and pinned to the register table by its own binding test below —
 * a new bootstrap literal, or drift from the registered path, fails closed.
 */
const BOUND_BOOTSTRAP_SOURCES = new Set([join(PELAGGIO_SRC, "review", "seat-deps-core.js")]);

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (name === "__tests__" || name === "node_modules") continue;
		if (statSync(full).isDirectory()) out.push(...sources(full));
		else if (/\.(?:ts|m?js)$/.test(name) && !name.endsWith(".d.ts") && !/\.test\.(?:ts|m?js)$/.test(name)) out.push(full);
	}
	return out;
}

/** Literal texts (string, template chunk, regex) that mention `.dev` — comments never count. */
export function devLiterals(file: string, src: string): string[] {
	const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
	const hits: string[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)) {
			const text = ts.isRegularExpressionLiteral(n) ? n.text : n.text;
			if (/\.dev(?:[/\\]|$|[^a-zA-Z0-9_.-])|\\\.dev/.test(text)) hits.push(text);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return hits;
}

/** `devRootPathspec()` used to compose a path — as a join/resolve argument or followed by `/`. */
export function devPathspecCompositions(file: string, src: string): string[] {
	const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const hits: string[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "devRootPathspec") {
			const parent = n.parent;
			const inJoin =
				ts.isCallExpression(parent) && ((ts.isIdentifier(parent.expression) && /^(join|resolve)$/.test(parent.expression.text)) || (ts.isPropertyAccessExpression(parent.expression) && /^(join|resolve)$/.test(parent.expression.name.text)));
			const followedBySlash = ts.isTemplateSpan(parent) && parent.literal.text.startsWith("/");
			if (inJoin || followedBySlash) hits.push(n.parent.getText(sf).slice(0, 80));
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return hits;
}

describe("registers", () => {
	it("names are unique and shapes are consistent", () => {
		const names = REGISTERS.map((r) => r.name);
		assert.equal(new Set(names).size, names.length);
		for (const r of REGISTERS) {
			if (r.shape === "file-family") assert.ok(r.name.endsWith("-"), `${r.name}: a file-family name is a prefix`);
			if (r.shape === "file") assert.ok(r.name.includes("."), `${r.name}: a file register carries its extension`);
		}
	});

	it("builds paths only under .dev", () => {
		assert.equal(registerPath("/r", "effects", "run", "x.json"), "/r/.dev/effects/run/x.json");
		assert.equal(registerRelativePath("execution-receipts", "run", "x.json"), ".dev/execution-receipts/run/x.json");
		assert.equal(registerFamilyPath("/r", "pelaggio-", "3.log"), "/r/.dev/pelaggio-3.log");
		assert.throws(() => registerFamilyPath("/r", "effects", "x"), /not a file family/);
	});

	it("refuses segments that would leave the register (fail closed on dynamic ids)", () => {
		for (const bad of ["../../x", "..", ".", "", "/etc/passwd", "run/../../x"]) {
			assert.throws(() => registerPath("/r", "effects", bad), /would leave the register/, `registerPath ${bad}`);
			assert.throws(() => registerRelativePath("effects", bad), /would leave the register/, `registerRelativePath ${bad}`);
		}
		assert.throws(() => registerFamilyPath("/r", "pelaggio-", "../x.log"));
		assert.throws(() => registerFamilyPath("/r", "pelaggio-", "sub/x.log"), /single filename/);
		assert.equal(registerPath("/r", "effects", "run-1", "plan-1.json"), "/r/.dev/effects/run-1/plan-1.json");
	});

	it("Bash-mention pattern: shell spellings match, look-alike names do not", () => {
		const re = bashDeniedRegisterPattern();
		for (const cmd of ["cat > .dev/effects/x", "cat > .dev//effects/x", "cat > .dev/./effects/x", "echo hi >.dev/flow-events/01J.jsonl", "rm -rf .dev/sessions", "ls .dev/effects"]) assert.ok(re.test(cmd), cmd);
		for (const cmd of ["cat .dev/effects-old/x", "cat .dev/pr-review-gate-records.backup", "cat .dev/pelaggio-log.jsonl", "cat .dev/plans/12.md", "echo effects"]) assert.ok(!re.test(cmd), cmd);
	});

	it("derives the seat denials from the table: every harness register a skill does not read", () => {
		const denied = bashDeniedRegisters();
		for (const r of REGISTER_SPECS) {
			const expected = r.kind === "harness" && !r.agentReads;
			assert.equal(denied.includes(r.name as RegisterName), expected, `${r.name} (${r.kind}${r.agentReads ? ", agentReads" : ""})`);
		}
		// The four registers plan step 7a widens the deny list to are harness and not skill-read.
		for (const name of ["effects", "execution-receipts", "attempts", "flow-events"]) assert.ok(denied.includes(name as never), name);
		// Skill-read and agent-written registers must never be denied (no false fire).
		for (const name of ["pelaggio-log.jsonl", "plans", "ship", "authoring-review-seats", "review-heads", "review-findings-"]) assert.ok(!denied.includes(name as never), name);
		// Write/Edit denial covers EVERY harness register — files and families too; agentReads only relaxes Bash mention.
		assert.deepEqual(
			writeDeniedRegisters("/r")
				.map((r) => r.name)
				.sort(),
			REGISTER_SPECS.filter((r) => r.kind === "harness")
				.map((r) => r.name)
				.sort(),
		);
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/effects/run/plan-1.json")?.name, "effects");
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/roadmap-mutation.lock")?.name, "roadmap-mutation.lock");
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/pelaggio-log.jsonl")?.name, "pelaggio-log.jsonl");
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/pelaggio-3.log")?.name, "pelaggio-");
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/plans/12.md"), null);
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/review-findings-12.md"), null);
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/authoring-review-seats/abc/p1/.dev/x"), null, "a seat tree is not a harness register (its own .dev is checked under the seat root)");
		assert.equal(writeDeniedRegisterFor("/r", "/r/.dev/effects-not-a-register/x"), null, "directory match is by path segment, not prefix");
	});

	it(`every .dev literal in both packages lives in ${CHOKEPOINT} (no path built around the registry)`, () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of sources(root)) {
				if (file.endsWith(`/${CHOKEPOINT}`)) continue;
				if (BOUND_BOOTSTRAP_SOURCES.has(file)) continue; // exempted, but pinned by the binding test below
				for (const lit of devLiterals(file, readFileSync(file, "utf8"))) offenders.push(`${relative(REPO, file)}: ${JSON.stringify(lit)}`);
			}
		}
		assert.deepEqual(offenders, [], `build these through registerPath()/registerRelativePath() instead:\n  ${offenders.join("\n  ")}`);
	});

	it("bound bootstrap .dev compositions match the register table (dependency-free modules cannot import it)", () => {
		const seatDepsCore = join(PELAGGIO_SRC, "review", "seat-deps-core.js");
		assert.deepEqual([...BOUND_BOOTSTRAP_SOURCES], [seatDepsCore], "every bound bootstrap module needs its own binding assertions here");
		const src = readFileSync(seatDepsCore, "utf8");
		// One literal, one composition, and the composed path is exactly the registered
		// node-modules-repair.lock — a second `.dev` literal or a drifted path fails.
		assert.deepEqual(devLiterals(seatDepsCore, src), [".dev"]);
		assert.match(src, /resolve\(mainRepo, "\.dev", "node-modules-repair\.lock"\)/);
		assert.equal(registerRelativePath("node-modules-repair.lock"), ".dev/node-modules-repair.lock");
	});

	it("devRootPathspec() is never composed into a path anywhere in either package", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) for (const file of sources(root)) for (const hit of devPathspecCompositions(file, readFileSync(file, "utf8"))) offenders.push(`${relative(REPO, file)}: ${hit}`);
		assert.deepEqual(offenders, []);
		assert.deepEqual(devPathspecCompositions("x.ts", 'const a = join(root, devRootPathspec(), "x"); const b = `${devRootPathspec()}/y`; const c = `git reset -- ${devRootPathspec()}`;').length, 2);
	});

	it("recognizes .dev in every literal form and ignores comments", () => {
		const src = [
			'const a = ".dev";',
			'const b = join(root, ".dev", "x");',
			"const c = `.dev/" + "${" + "x}/y`;",
			"const d = /\\.dev\\/review-records\\//;",
			"// .dev/in-a-comment",
			"/* .dev/in-a-block */",
			'const e = "device"; const f = "dev.to";',
		].join("\n");
		assert.equal(devLiterals("x.ts", src).length, 4);
		assert.equal(devRootPathspec(), ".dev");
	});
});
