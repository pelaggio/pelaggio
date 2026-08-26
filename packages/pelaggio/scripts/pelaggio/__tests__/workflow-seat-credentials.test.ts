import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

const workflowDir = resolve(new URL("../../../../../", import.meta.url).pathname, ".github/workflows");

/**
 * Seat-env denial (#554) cannot reach a credential that lives on DISK. `actions/checkout` persists
 * the job token as an `http.<host>.extraheader` in the checkout's `.git/config`, and the Claude seat
 * binds the host root, so a job that spawns seats inside its checkout hands them that token unless it
 * opts out — in `pr-review.yml`'s case a `statuses: write` token capable of forging the very `review`
 * status the gate exists to produce.
 *
 * Enumerated rather than patched per file: this is the third instance of the class (`pelaggio-fix.yml`
 * via #594, `pr-review.yml` here, `pr-review-revise.yml` already correct), which is the
 * `guarded-actions.md` §8.2 signal to hoist. All paths genuinely funnel: a workflow reaches CI only as
 * a file in `.github/workflows`, and this test reads that directory, so a NEW seat-spawning job cannot
 * silently skip the opt-out.
 *
 * Scoped PER JOB, not per file. Several of these workflows carry non-seat jobs that check out
 * legitimately; refusing those would be a false fire, and a guard that cries wolf gets disabled.
 */
const SPAWNS_SEATS = /\b(?:pnpm|npx)\s+pelaggio\b/;

/**
 * Jobs known to still persist credentials, with the item that closes each. May only SHRINK —
 * a new entry is a visible, reviewed edit. Same shape as the Q17 ceiling.
 */
const FROZEN_PERSISTED_JOBS = new Map([["pelaggio-fix.yml:fix", "#594 (PR #602) splits this credential out of the checkout; remove this entry when it lands"]]);

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[] };

function jobsOf(body: string): Array<[string, Job]> {
	const doc = parseYaml(body) as { jobs?: Record<string, Job> } | null;
	return Object.entries(doc?.jobs ?? {});
}

describe("workflow seat credential hygiene (#554)", () => {
	const workflows = readdirSync(workflowDir)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.map((name) => ({ name, body: readFileSync(resolve(workflowDir, name), "utf8") }));

	function seatJobs(): Array<{ id: string; job: Job }> {
		const out: Array<{ id: string; job: Job }> = [];
		for (const { name, body } of workflows) {
			for (const [jobName, job] of jobsOf(body)) {
				if ((job.steps ?? []).some((step) => typeof step.run === "string" && SPAWNS_SEATS.test(step.run))) {
					out.push({ id: `${name}:${jobName}`, job });
				}
			}
		}
		return out;
	}

	it("finds seat-spawning jobs, so a detector that matches nothing cannot pass vacuously", () => {
		assert.ok(workflows.length >= 5, `expected a populated workflow directory, saw ${workflows.length}`);
		const ids = seatJobs().map((entry) => entry.id);
		assert.ok(ids.length >= 2, `expected the seat-spawning jobs to be detected, saw ${JSON.stringify(ids)}`);
	});

	it("every seat-spawning job refuses persisted checkout credentials", () => {
		const offenders: string[] = [];
		for (const { id, job } of seatJobs()) {
			const persisted = (job.steps ?? []).filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout") && step.with?.["persist-credentials"] !== false);
			if (persisted.length && !FROZEN_PERSISTED_JOBS.has(id)) offenders.push(`${id} (${persisted.length} checkout(s) without persist-credentials: false)`);
		}
		assert.deepEqual(
			offenders,
			[],
			`a seat-spawning job checks out with persisted credentials, so a prompt-injected seat can read the token from .git/config: ${offenders.join(", ")}. Add \`persist-credentials: false\` and give the harness a step-scoped GIT_CONFIG_* credential instead.`,
		);
	});

	it("the frozen exception set is live, not stale", () => {
		const ids = new Set(seatJobs().map((entry) => entry.id));
		for (const id of FROZEN_PERSISTED_JOBS.keys()) {
			assert.ok(ids.has(id), `${id} is frozen as a known-persisted seat job but is no longer a seat-spawning job — drop the entry`);
		}
	});
});
