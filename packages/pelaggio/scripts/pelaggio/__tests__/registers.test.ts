/**
 * Conformance for the `.dev` register chokepoint (plan step 7a). Two halves make the guarantee
 * hold by construction: (1) every `.dev` token in a string/template/regex literal in either
 * package lives in `registers.ts` — recognize-by-invariant, so no path can be built around the
 * API; (2) the seat denials derive from the table — a harness register is denied without anyone
 * remembering to extend a list.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bashDeniedRegisters, DEV_DIR, REGISTER_SPECS, REGISTERS, type RegisterName, registerFamilyPath, registerPath, registerRelativePath, writeDeniedRegisterDirs } from "../registers.js";

const PELAGGIO_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PELAGGIO_SRC, "..", "..", "..", "..");
const SCAN_ROOTS = [PELAGGIO_SRC, join(REPO, "packages", "server", "src")];
const CHOKEPOINT = "registers.ts";

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (name === "__tests__" || name === "node_modules") continue;
		if (statSync(full).isDirectory()) out.push(...sources(full));
		else if (/\.(?:ts|mjs)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

/** Literal texts (string, template chunk, regex) that mention `.dev` — comments never count. */
export function devLiterals(file: string, src: string): string[] {
	const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
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
		assert.deepEqual(
			writeDeniedRegisterDirs("/r").map((p) => relative("/r/.dev", p)),
			REGISTER_SPECS.filter((r) => r.kind === "harness" && !r.agentReads && r.shape === "dir").map((r) => r.name),
		);
	});

	it(`every .dev literal in both packages lives in ${CHOKEPOINT} (no path built around the registry)`, () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of sources(root)) {
				if (file.endsWith(`/${CHOKEPOINT}`)) continue;
				for (const lit of devLiterals(file, readFileSync(file, "utf8"))) offenders.push(`${relative(REPO, file)}: ${JSON.stringify(lit)}`);
			}
		}
		assert.deepEqual(offenders, [], `build these through registerPath()/registerRelativePath() instead:\n  ${offenders.join("\n  ")}`);
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
		assert.equal(DEV_DIR, ".dev");
	});
});
