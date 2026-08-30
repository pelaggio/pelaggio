/**
 * Step modules take plain value inputs (plan step 9 as designed): no shared cycle-state view exists,
 * every `<Step>Input` is an explicit interface (never a `Pick` of a catalogue), and every Input member
 * is DATA — a type from the allowlist below, none of which declares a callable member. Capabilities
 * (the roadmap adapter, run options with callbacks, the effects seam, cost accounting) are Deps.
 * A step that needs one more binding widens its own interface; a new data type is admitted by
 * adding it here, where its "no callable members" proof is re-checked against its declaration.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const STEPS = join(SRC, "steps");

/** Input member types admitted as data, and (for named types) the file that declares them. */
const DATA_TYPES: Record<string, string | null> = {
	string: null,
	boolean: null,
	number: null,
	Buffer: null,
	"Set<string>": null,
	Flags: "types.ts",
	ParkSignal: "types.ts",
	"readonly StepLog[]": "types.ts",
	"ExecutionReceiptDescriptor[]": "types.ts",
	DriverAssignmentState: "driver-assignment.ts",
};
const LITERAL_UNION = /^"[^"]+"(?: \| "[^"]+")*$/;

function declarationOf(typeName: string, file: string): string {
	const bare = typeName.replace(/^readonly /, "").replace(/\[\]$/, "");
	const src = readFileSync(join(SRC, file), "utf8");
	const m = src.match(new RegExp(`^export (?:interface|type) ${bare}\\b[^\\n]*\\n([\\s\\S]*?)^\\}`, "m"));
	assert.ok(m, `${file} must declare ${bare}`);
	return (m?.[1] ?? "").replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("step inputs", () => {
	const files = readdirSync(STEPS).filter((f) => f.endsWith(".ts"));

	it("no cycle-state view type exists", () => {
		for (const f of files) assert.doesNotMatch(readFileSync(join(STEPS, f), "utf8"), /\bCycleContext\b/, f);
	});

	it("every step declares its Input as an explicit interface and its Deps as a Pick of CycleHelpers", () => {
		for (const f of files) {
			if (f === "context.ts") continue;
			const src = readFileSync(join(STEPS, f), "utf8");
			assert.match(src, /export interface \w+Input \{/, `${f}: Input must be an explicit interface`);
			assert.doesNotMatch(src, /\w+Input = Pick</, `${f}: Input must not be a Pick of a catalogue`);
			assert.match(src, /export type \w+Deps = Pick<CycleHelpers,/, `${f}: Deps must Pick from CycleHelpers`);
		}
	});

	it("every Input member is an allowlisted data type; callables live in Deps", () => {
		for (const f of files) {
			if (f === "context.ts") continue;
			const src = readFileSync(join(STEPS, f), "utf8");
			const iface = src.match(/export interface \w+Input \{([\s\S]*?)\n\}/)?.[1] ?? "";
			const body = iface.replace(/\/\*\*[\s\S]*?\*\//g, "");
			const members = [...body.matchAll(/^\s*readonly (\w+)\??: ([^;]+);/gm)];
			assert.ok(members.length > 0, `${f}: Input declares members`);
			for (const [, name, type] of members) {
				const t = (type ?? "").trim();
				assert.ok(t in DATA_TYPES || LITERAL_UNION.test(t), `${f}: Input.${name} is \`${t}\` — not an allowlisted data type; a capability belongs in Deps`);
			}
		}
	});

	it("allowlisted named data types declare no callable members (checked at their declaration)", () => {
		for (const [type, file] of Object.entries(DATA_TYPES)) {
			if (!file) continue;
			const decl = declarationOf(type, file);
			assert.doesNotMatch(decl, /=>/, `${type} (${file}) declares an arrow-typed member`);
			assert.doesNotMatch(decl, /^\s*\w+\??\s*\(/m, `${type} (${file}) declares a method signature`);
		}
	});

	it("the allowlist is falsifiable: a capability type is refused", () => {
		for (const t of ["RoadmapSource", "PipelineOpts", "(x: string) => void", "typeof foo"]) assert.ok(!(t in DATA_TYPES) && !LITERAL_UNION.test(t), t);
	});
});
