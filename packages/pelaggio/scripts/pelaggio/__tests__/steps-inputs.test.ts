/**
 * Step modules take plain value inputs (plan step 9 as designed): no shared cycle-state view exists,
 * and every `<Step>Input` is an explicit interface — never a `Pick` of a catalogue. A step that needs
 * one more binding widens its own interface, so the coupling stays visible per step.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const STEPS = join(dirname(fileURLToPath(import.meta.url)), "..", "steps");

describe("step inputs", () => {
	const files = readdirSync(STEPS).filter((f) => f.endsWith(".ts"));

	it("no cycle-state view type exists", () => {
		for (const f of files) assert.doesNotMatch(readFileSync(join(STEPS, f), "utf8"), /\bCycleContext\b/, f);
	});

	it("every step declares its Input as an explicit interface of values, and its Deps as a Pick of CycleHelpers", () => {
		for (const f of files) {
			if (f === "context.ts") continue;
			const src = readFileSync(join(STEPS, f), "utf8");
			assert.match(src, /export interface \w+Input \{/, `${f}: Input must be an explicit interface`);
			assert.doesNotMatch(src, /\w+Input = Pick</, `${f}: Input must not be a Pick of a catalogue`);
			assert.match(src, /export type \w+Deps = Pick<CycleHelpers,/, `${f}: Deps must Pick from CycleHelpers`);
			const iface = src.match(/export interface \w+Input \{([\s\S]*?)\n\}/)?.[1] ?? "";
			assert.doesNotMatch(iface.replace(/\/\*\*[\s\S]*?\*\//g, ""), /=>/, `${f}: Input must not carry functions`);
		}
	});
});
