/**
 * CI entry for the `.github/workflows/pr-review-revise.yml` "Fetch review findings" step:
 * selects the PR-review findings comment through the canonical trusted path
 * (`fetchReviewFindingsOutcome` → `isTrustedCommentAuthor` in
 * `packages/pelaggio/scripts/pelaggio/github-posting.ts`) instead of a raw jq scrape, so the
 * workflow's marker-trust rule can never drift from the CLI's — one rule at every consumption
 * site (#508). Marker text is not authority: any PR participant can copy it into a comment,
 * and an unfiltered "last marker comment" scrape would let that copy become the durable CI
 * revise prompt.
 *
 * usage: node --import tsx ci/fetch-review-findings.ts <owner/repo> <pr-number> <out-path>
 * exit 0: a trusted findings comment was written to <out-path>
 * exit 1: no trusted findings comment exists — the selector's clean TRUST VERDICT
 *         (the workflow parks "nothing to act on")
 * exit 2: the selector could not decide — usage error, a gh/parse/fs tool failure, or an
 *         unexpected throw (the workflow parks "tool failure, not a trust decision")
 */
import { resolve } from "node:path";
import { fetchReviewFindingsOutcome } from "../packages/pelaggio/scripts/pelaggio/revise-sweep.js";
import { defaultGhRun } from "../packages/pelaggio/scripts/pelaggio/roadmap/github-issues.js";

const [ghRepo, prRaw, outPath] = process.argv.slice(2);
if (!ghRepo || !outPath || !prRaw || !/^\d+$/.test(prRaw)) {
	console.error("usage: node --import tsx ci/fetch-review-findings.ts <owner/repo> <pr-number> <out-path>");
	process.exit(2);
}
try {
	const outcome = fetchReviewFindingsOutcome(defaultGhRun, ghRepo, Number(prRaw), resolve(outPath));
	if (outcome === "error") console.error("findings selector hit a gh/parse/fs failure — a tool failure, not a trust decision");
	process.exitCode = outcome === "written" ? 0 : outcome === "no-trusted-comment" ? 1 : 2;
} catch (e) {
	console.error(`findings selector threw: ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 2;
}
