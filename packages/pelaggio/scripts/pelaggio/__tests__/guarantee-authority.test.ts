import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findGuaranteeRecurrenceAdvisory, type GuaranteeRecurrenceObservation, type GuaranteeRecurrenceRoll, recurrenceRollsFromRecords, renderGuaranteeRecurrenceAdvisory } from "../guarantee-authority.js";
import { escapeMarkdown } from "../text.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../../");
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/guarantee-authority/pr-699.json"), "utf8")) as {
	prNumber: number;
	itemId: string;
	path: string;
	findingClass: string;
	digests: string[];
	heads: string[];
	rolls: Array<{ headSha: string; observations: GuaranteeRecurrenceObservation[] }>;
	dispersed: { headSha: string; observations: GuaranteeRecurrenceObservation[] };
};

function roll(over: Partial<GuaranteeRecurrenceRoll> & { observations: readonly GuaranteeRecurrenceObservation[] }): GuaranteeRecurrenceRoll {
	return {
		prNumber: fixture.prNumber,
		itemId: fixture.itemId,
		headSha: over.headSha ?? fixture.heads[0] ?? "a".repeat(40),
		...over,
	};
}

describe("guarantee-authority policy (AC-1)", () => {
	it("plan outside write-set is flagged; plan inside is not", () => {
		const rubric = readFileSync(resolve(repoRoot, ".claude/skills/_rubric.md"), "utf8");
		assert.match(rubric, /enumerate the inputs each new or widened mechanism asserts a guarantee over/);
		assert.match(rubric, /declared write-set when present, then optional `_project-context\.md` ownership map/);
		assert.match(rubric, /the assurance graph is non-authoritative context only/);
		assert.match(rubric, /Flag every asserted input outside that authority, naming the input and \(when known\) the owning item/);
		assert.match(rubric, /Do \*\*not\*\* flag a plan or diff whose every asserted input is owned/);
		assert.match(rubric, /A findings note that introduces or widens a mechanism must name the acceptance criterion it serves, otherwise it is a re-charter, not a revision/);
	});
});

describe("recurrence detector (AC-2)", () => {
	it("recurrence advisory true-fire and no-false-fire", () => {
		const [r1, r2, r3, r4] = fixture.rolls;
		assert.ok(r1 && r2 && r3 && r4);

		assert.equal(findGuaranteeRecurrenceAdvisory([], roll(r1)), null, "roll 1: two digests, rolls < 2");

		const atRoll2 = findGuaranteeRecurrenceAdvisory([roll(r1)], roll(r2));
		assert.ok(atRoll2, "roll 2: third distinct digest fires");
		assert.equal(atRoll2.path, "src/a.ts");
		assert.equal(atRoll2.findingClass, "correctness-regression");
		assert.equal(atRoll2.distinctCount, 3);
		assert.equal(atRoll2.rollCount, 2);
		assert.match(renderGuaranteeRecurrenceAdvisory(atRoll2), /survivors recur in a class this item may not own — consider re-chartering/i);

		const atRoll3 = findGuaranteeRecurrenceAdvisory([roll(r1), roll(r2)], roll(r3));
		assert.ok(atRoll3);
		assert.equal(atRoll3.distinctCount, 5);
		assert.equal(atRoll3.rollCount, 3);

		const atRoll4 = findGuaranteeRecurrenceAdvisory([roll(r1), roll(r2), roll(r3)], roll(r4));
		assert.ok(atRoll4);
		assert.equal(atRoll4.distinctCount, 8);
		assert.equal(atRoll4.rollCount, 4);

		// ≥3 findings split across different (path, class) pairs.
		assert.equal(
			findGuaranteeRecurrenceAdvisory([roll({ headSha: fixture.heads[0] ?? "", observations: fixture.dispersed.observations.slice(0, 2) })], roll({ headSha: fixture.dispersed.headSha, observations: fixture.dispersed.observations })),
			null,
			"dispersed files/classes do not share a bucket",
		);

		// Repeated copies of one digest count as one.
		const one = r2.observations[0];
		assert.ok(one);
		const dupes: GuaranteeRecurrenceObservation[] = [one, one, one];
		assert.equal(findGuaranteeRecurrenceAdvisory([roll({ headSha: fixture.heads[0] ?? "", observations: dupes })], roll({ headSha: fixture.heads[1] ?? "", observations: dupes })), null, "duplicate digests collapse to one");

		// Three distinct digests in only one roll.
		assert.equal(findGuaranteeRecurrenceAdvisory([], roll(r2)), null, "single roll never fires");

		// Current roll observations [] must not replay history.
		assert.equal(findGuaranteeRecurrenceAdvisory([roll(r1), roll(r2), roll(r3)], roll({ ...r4, observations: [] })), null);

		// Other prNumber / itemId.
		assert.equal(findGuaranteeRecurrenceAdvisory([roll(r1)], roll({ ...r2, prNumber: 1 })), null);
		assert.equal(findGuaranteeRecurrenceAdvisory([roll(r1)], roll({ ...r2, itemId: "other" })), null);

		// Operator records, schema v1, and fleet v2 with the field absent contribute no rolls.
		assert.deepEqual(
			recurrenceRollsFromRecords([
				{ schemaVersion: 1, prNumber: 699, itemId: "699", headSha: fixture.heads[0] ?? "" },
				{
					schemaVersion: 2,
					producer: "operator-adjudication",
					prNumber: 699,
					itemId: "699",
					headSha: fixture.heads[1] ?? "",
					recurrenceFindings: r2.observations,
				},
				{ schemaVersion: 2, producer: "fleet", prNumber: 699, itemId: "699", headSha: fixture.heads[2] ?? "" },
			]),
			[],
		);

		// Unlocated vs located observations do not share a bucket.
		const located = r2.observations;
		const unlocated = located.map(({ fingerprintDigest, findingClass }) => ({ fingerprintDigest, findingClass }));
		assert.equal(findGuaranteeRecurrenceAdvisory([roll({ headSha: fixture.heads[0] ?? "", observations: located })], roll({ headSha: fixture.heads[1] ?? "", observations: unlocated })), null, "unlocated and located partitions never mix");

		// Current SHA replacing a persisted same-SHA record does not count as two rolls.
		assert.equal(findGuaranteeRecurrenceAdvisory([roll(r2)], roll(r2)), null, "retry of the same SHA is one roll");
	});

	it("escapes every model-authored advisory field for public comments", () => {
		const path = "src/<img src=https:example.invalid/pixel>";
		const findingClass = "correctness-*regression*<img src=x>";
		const rendered = renderGuaranteeRecurrenceAdvisory({ path, findingClass, distinctCount: 3, rollCount: 2 });

		assert.ok(rendered.includes(escapeMarkdown(path)));
		assert.ok(rendered.includes(escapeMarkdown(findingClass)));
		assert.doesNotMatch(rendered, /<img/);
		assert.doesNotMatch(rendered, /\*regression\*/);
	});
});
