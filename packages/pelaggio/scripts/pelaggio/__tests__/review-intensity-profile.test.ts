import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { classifyReviewIntensity } from "../review-intensity-profile.js";
import { classifySecurityReviewDiff } from "../security-review-trigger.js";

function patch(path = "docs/guide.md", body = "-old\n+new\n"): string {
	return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
}

describe("review intensity conservative corpus (#757)", () => {
	it("replays real Git patch metadata corpus before reduction is enabled", () => {
		const corpus = JSON.parse(readFileSync(new URL("./fixtures/review-intensity-profile-corpus.json", import.meta.url), "utf8")) as { entries: Array<{ name: string; files: string[]; diff: string; expected: string }> };
		for (const entry of corpus.entries) assert.equal(classifyReviewIntensity(entry.files, entry.diff), entry.expected, entry.name);
	});
	it("positively recognizes ordinary Markdown edits, equivalent hunk spelling and multiple files", () => {
		for (const path of ["docs/guide.md", "docs/examples/guide.md", "README.md", "CHANGELOG.md", "CONTRIBUTING.md"]) assert.equal(classifyReviewIntensity([path], patch(path)), "docs", path);
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch().replace("@@ -1 +1 @@", "@@ -1,1 +1,1 @@ Heading")), "docs");
		assert.equal(classifyReviewIntensity(["README.md", "docs/guide.md"], patch() + patch("README.md")), "docs");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch().replace("@@ -1 +1 @@", "@@ -0,0 +1 @@").replace("-old\n", "")), "docs");
	});
	it("never reduces non-docs, policy and skill paths, mixed or mismatched inventories", () => {
		const paths = [
			"package.json",
			"docs/code.ts",
			"notes.md",
			"AGENTS.md",
			"docs/AGENTS.md",
			"docs/SKILL.md",
			".claude/skills/pr-review/SKILL.md",
			".agents/skills/foo/SKILL.md",
			"docs/agent-context/a.md",
			"docs/decisions/a.md",
			"docs/decision-log/a.md",
			"docs/assurance/a.md",
			"docs/trust/a.md",
			"docs/plans/a.md",
			"docs/archived/a.md",
			"docs/pr-review.md",
			"docs/decisions.md",
			"docs/../README.md",
			"docs/.hidden/a.md",
			"docs//guide.md",
		];
		for (const path of paths) assert.equal(classifyReviewIntensity([path], patch(path)), "full", path);
		for (const files of [[], ["docs/guide.md", "x.ts"], ["README.md"], ["docs/guide.md", "docs/guide.md"]]) assert.equal(classifyReviewIntensity(files, patch()), "full");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch() + patch("x.ts")), "full");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch() + patch()), "full");
	});
	it("never reduces parser-tolerated unknown metadata, rename, mode, binary or malformed changes", () => {
		const changes = [
			"",
			"+docs",
			patch().replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
			patch().replace("index 1111111..2222222 100644\n", ""),
			patch().replace("100644", "120000"),
			patch().replace("100644", "100755"),
			patch().replace("--- a/", "old mode 100644\nnew mode 100755\n--- a/"),
			patch().replace("--- a/", "rename from src.ts\nrename to docs/guide.md\n--- a/"),
			patch().replace("--- a/", "copy from docs/other.md\ncopy to docs/guide.md\n--- a/"),
			patch().replace("--- a/", "new file mode 100644\n--- a/"),
			patch().replace("--- a/", "deleted file mode 100644\n--- a/"),
			patch().replace("--- a/", "Binary files a/docs/guide.md and b/docs/guide.md differ\n--- a/"),
			patch().replace("--- a/", "future metadata unknown\n--- a/"),
			patch() + "unrecognized trailing prose\n",
			"prefix\n" + patch(),
			patch().replace("a/docs/guide.md b/", "a/src.ts b/"),
			patch().replace("--- a/docs/guide.md", "--- a/src.ts"),
			patch().replace("--- a/docs/guide.md", "--- /dev/null"),
			patch().replace("+++ b/docs/guide.md", "+++ /dev/null"),
			patch().replace("@@ -1 +1 @@\n-old\n+new\n", ""),
			patch().replace("-old\n+new", " same"),
		];
		for (const diff of changes) assert.equal(classifyReviewIntensity(["docs/guide.md"], diff), "full", diff);
	});
	it("rejects preserved header and hunk metadata while retaining ordinary content and valid EOF markers", () => {
		const eof = "\\ No newline at end of file\n";
		const malformed = [
			patch() + "\\ unexpected metadata\n",
			patch().replace("--- a/docs/guide.md\n", "--- a/docs/guide.md	unexpected metadata\n"),
			patch().replace("+++ b/docs/guide.md\n", "+++ b/docs/guide.md	2026-09-05\n"),
			patch("docs/guide.md", "\\ unexpected metadata\n-old\n+new\n"),
			patch("docs/guide.md", eof + "-old\n+new\n"),
			patch() + eof + eof,
			patch("docs/guide.md", "-old\n" + eof + "+new\n") + "@@ -3,0 +4 @@\n+extra\n",
			patch() + eof + "@@ -4 +3,0 @@\n-extra\n",
			patch().replace("@@ -1 +1 @@", "@@ -0 +0 @@"),
			patch() + "@@ -1 +1 @@\n-old\n+new\n",
			patch() + "@@ -3 +5 @@\n-old\n+new\n",
			patch() + "@@ -3 +3 @@\n unchanged\n",
			patch("docs/guide.md", "-old\n" + eof + "-more\n+new\n").replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
			patch("docs/guide.md", "-old\n+new\n" + eof + "+more\n").replace("@@ -1 +1 @@", "@@ -1 +1,2 @@"),
			patch() + eof + "@@ -3 +3 @@\n-before\n+after\n",
		];
		for (const diff of malformed) assert.equal(classifyReviewIntensity(["docs/guide.md"], diff), "full", diff);
		for (const body of ["-old\n+new\n", "-old\n" + eof + "+new\n" + eof, "-old\n" + eof + "+new\n", "-old\n+new\n" + eof, "-old\n+\\ unexpected metadata\n", "-old\n+new	data\n"]) {
			assert.equal(classifyReviewIntensity(["docs/guide.md"], patch("docs/guide.md", body)), "docs", body);
		}
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch("docs/guide.md", "-old\n+new\n same\n" + eof).replace("@@ -1 +1 @@", "@@ -1,2 +1,2 @@")), "docs");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch() + "@@ -3 +3 @@\n-before\n+after\n"), "docs");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch("docs/guide.md", "-old\n" + eof + "+new\n") + "@@ -1,0 +2 @@\n+extra\n"), "docs");
		assert.equal(classifyReviewIntensity(["docs/guide.md"], patch("docs/guide.md", "-old\n+new\n+extra\n").replace("@@ -1 +1 @@", "@@ -1 +1,2 @@") + "@@ -3 +4 @@\n-before\n+after\n"), "docs");
	});
	it("self-review covers classifier, profile map and its focused test", () => {
		for (const path of ["packages/pelaggio/scripts/pelaggio/review-intensity-profile.ts", "packages/pelaggio/scripts/pelaggio/__tests__/review-intensity-profile.test.ts"]) {
			assert.equal(classifyReviewIntensity([path], patch(path)), "full");
			assert.equal(classifySecurityReviewDiff([path], patch(path)).triggered, true);
		}
		assert.equal(classifySecurityReviewDiff(["docs/guide.md"], patch()).triggered, false);
	});
	it("replays the immutable #746 historical cohort without reducing unknown or guarantee-bearing candidates", () => {
		const cohort = JSON.parse(readFileSync(new URL("./fixtures/security-review-trigger-cohort.json", import.meta.url), "utf8"));
		for (const entry of cohort.entries) assert.equal(classifyReviewIntensity(entry.files, entry.diff), "full", `PR ${entry.pr}`);
	});
});
