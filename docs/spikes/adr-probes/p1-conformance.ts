#!/usr/bin/env tsx

/**
 * P1 — Step-contract conformance probe (throwaway spike scaffolding).
 *
 * Mechanically extracts the SHAPE of the production step contract so the P1 ledger can be
 * re-derived rather than re-read by hand. It parses source text deliberately (no TS compiler API):
 * the probe is measuring what a maintainer sees, and a heavier tool would imply a permanence this
 * scaffolding must not acquire.
 *
 * Run: npx tsx docs/spikes/adr-probes/p1-conformance.ts [--json]
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => readFileSync(resolve(root, "packages/pelaggio/scripts/pelaggio", rel), "utf8");

/** Fields of an exported interface, with optionality and the doc-comment's first line. */
function fields(source: string, name: string): { field: string; optional: boolean; note: string }[] {
	const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
	const out: { field: string; optional: boolean; note: string }[] = [];
	let note = "";
	// Depth guard: only top-level members count. `StepResult.effectsError` carries an inline object
	// type whose members would otherwise be reported as fields of StepResult itself.
	let depth = 0;
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			const text = trimmed.replace(/^\/\*+|^\*+\/?|\*\/$/g, "").trim();
			if (text && !note) note = text;
			continue;
		}
		const match = /^([a-zA-Z][\w]*)(\??):/.exec(trimmed);
		if (match && depth === 0) {
			out.push({ field: match[1], optional: match[2] === "?", note });
			note = "";
		}
		depth += (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
		if (trimmed === "") note = "";
	}
	return out;
}

const config = src("config.ts");
const stepNames = src("step-names.ts");
const stepRunner = src("step-runner.ts");
const types = src("types.ts");
const pipeline = src("pipeline.ts");

const pipelineSteps = /export const STEPS = \[([^\]]*)\]/.exec(stepNames)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
const extraSteps = /export type Step = PipelineStep \| ([^;]*);/.exec(stepNames)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
const stepIndexedMaps = [...config.matchAll(/^\t*(?:readonly )?(\w+): (?:Readonly<)?(?:Partial<)?Record<(?:string, (?:Partial<)?)?Record<Step,|^\t*(\w+): (?:Partial<)?Record<Step,/gm)].map((m) => m[1] ?? m[2]);
const perStepBranches = (pipeline.match(/step === "|name === "|stepName === "/g) ?? []).length;

const opts = fields(stepRunner, "RunStepOpts");
const result = fields(types, "StepResult");

const report = {
	activities: { pipeline: pipelineSteps, nonPipeline: extraSteps, total: pipelineSteps.length + extraSteps.length },
	stepIndexedConfigMaps: [...new Set(stepIndexedMaps)],
	perStepBranchesInPipeline: perStepBranches,
	optionsBag: /Record<string, unknown>|\[key: string\]/.test(new RegExp("export interface RunStepOpts \\{[\\s\\S]*?\\n\\}").exec(stepRunner)?.[0] ?? ""),
	runStepOpts: opts,
	stepResult: result,
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`\n  P1 — step-contract conformance\n  ${"-".repeat(72)}`);
	console.log(`  activities through one contract : ${report.activities.total} (${pipelineSteps.join(", ")} + ${extraSteps.join(", ")})`);
	console.log(`  step-indexed config maps        : ${report.stepIndexedConfigMaps.length}`);
	console.log(`  per-step branches in pipeline.ts: ${perStepBranches}`);
	console.log(`  untyped options bag present     : ${report.optionsBag ? "YES — falsifies B" : "no"}`);
	console.log(`\n  RunStepOpts (${opts.filter((f) => f.optional).length}/${opts.length} optional):`);
	for (const f of opts) console.log(`    ${f.optional ? "?" : " "} ${f.field.padEnd(22)} ${f.note.slice(0, 70)}`);
	console.log(`\n  StepResult (${result.filter((f) => f.optional).length}/${result.length} optional):`);
	for (const f of result) console.log(`    ${f.optional ? "?" : " "} ${f.field.padEnd(22)} ${f.note.slice(0, 70)}`);
	console.log();
}
