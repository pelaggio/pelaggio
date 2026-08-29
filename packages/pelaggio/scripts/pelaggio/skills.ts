/** Skill body loading and step-argument assembly (L1). `expandSkill()` strips frontmatter — see AGENTS.md. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveArtifactRoot } from "./artifact-root.js";
import { REPO } from "./config.js";
import type { RoadmapSource } from "./roadmap/types.js";

export function expandSkill(name: string, skillArgs?: string): string {
	return expandSkillFrom(REPO, name, skillArgs);
}

/** Load the package-owned copy of a skill. Merge-gate protocols must not depend
 *  on a consumer having run `pelaggio sync`: a missing or stale consumer copy
 *  must not crash the gate or weaken its current output contract. */
export function expandPackagedSkill(name: string, skillArgs?: string): string {
	return expandSkillFrom(resolveArtifactRoot(import.meta.url), name, skillArgs);
}

function expandSkillFrom(root: string, name: string, skillArgs?: string): string {
	const upper = resolve(root, ".claude", "skills", name, "SKILL.md");
	const lower = resolve(root, ".claude", "skills", name, "skill.md");
	const body = readFileSync(existsSync(upper) ? upper : lower, "utf-8")
		.replace(/^---[\s\S]*?---\n*/, "")
		.trim();
	return skillArgs ? `${body}\n\nArguments: ${skillArgs}` : body;
}

const REVIEW_FINDINGS_MAX = 6000;

/**
 * Build the implement-step preamble that turns a resume into a *revision* of already-shipped
 * code driven by PR-review findings (issue #60). Empty/whitespace input → "" (caller omits the
 * block). Truncated at REVIEW_FINDINGS_MAX with an explicit marker. Pure — unit-tested.
 * Findings are more load-bearing than plan-shakedown text, so the cap is more generous than the
 * 2000-char `shakedownPlanText.slice`.
 */
export function reviewFindingsPreamble(findings: string): string {
	const body = findings.trim();
	if (!body) return "";
	const clipped = body.length > REVIEW_FINDINGS_MAX ? `${body.slice(0, REVIEW_FINDINGS_MAX)}\n...(truncated)` : body;
	return [
		"## Revision pass — fix the review findings",
		"A prior PR review BLOCKED this change. Treat these findings as the primary task.",
		"Inspect the findings first, identify the named files, and edit code/docs to resolve every",
		"blocking issue. The approved plan is historical context only; it must not override the review",
		"findings or turn this into a plan execution pass. After fixing the findings, run the rubric",
		"verification before finishing.",
		"",
		"### Review findings",
		clipped,
	].join("\n");
}

/** Generous cap on the injected item body — the spec is more load-bearing than review findings
 *  (`REVIEW_FINDINGS_MAX`), but a 65 KiB GitHub issue body shouldn't blow the prompt. */
const STEP_BODY_MAX = 16_000;

/**
 * Build a step's skill arguments (#103, #115). Prefixed with the `pelaggio` pipeline-mode gate
 * (plus `mode`, e.g. `plan-review` / `code-review` for shakedown) and the item's requirements
 * fetched in-harness — so a provider whose sandbox can't fetch them (Codex: no network, roadmap CLI
 * dies on tsx-IPC) works against the real issue instead of running `roadmap get` / `gh issue view`
 * itself. Runs for ALL providers (Claude also gets the block and skips its own fetch); load-bearing
 * for sandboxed ones. github-issues carries the full issue `body`; markdown carries its one-line item
 * row (and `sourceRef` still names the locally-readable roadmap file); adapters without either fall
 * back to reading `sourceRef`. `getItem` failure degrades to the bare gate (the model still recovers
 * the id from the branch name per the skill).
 */
export async function buildStepArgs(roadmap: RoadmapSource, itemId: string, mode?: string): Promise<string> {
	const item = await roadmap.getItem(itemId).catch(() => null);
	const lines = [mode ? `pelaggio ${mode}` : "pelaggio"];
	if (item) {
		lines.push("", "## Roadmap item context (provided by the harness — do NOT run `roadmap get` / `gh issue view`)", `ID: ${item.id}`, `Title: ${item.title}`);
		if (item.deps && item.deps !== "—") lines.push(`Depends on: ${item.deps}`);
		lines.push(`sourceRef: ${item.sourceRef}`);
		const body = item.body?.trim();
		if (body) lines.push("", body.length > STEP_BODY_MAX ? `${body.slice(0, STEP_BODY_MAX)}\n…(truncated — read \`${item.sourceRef}\` for the full spec)` : body);
		else lines.push("", "(No body from the adapter — if `sourceRef` names a local file, read it for the full spec.)");
	}
	return lines.join("\n");
}
