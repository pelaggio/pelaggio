import { escapeMarkdown } from "./text.js";

/**
 * Guarantee-authority recurrence policy (L2): aggregate confirmed must-fix
 * observations across PR-review rolls and render a fixed advisory. Pure — no
 * fs, git, or record I/O. Thresholds are mechanism constants, not config.
 */

export const RECURRENCE_DISTINCT_THRESHOLD = 3;
export const RECURRENCE_ROLL_THRESHOLD = 2;

export interface GuaranteeRecurrenceObservation {
	fingerprintDigest: string;
	path?: string;
	findingClass: string;
}

export interface GuaranteeRecurrenceRoll {
	prNumber: number;
	itemId: string;
	headSha: string;
	observations: readonly GuaranteeRecurrenceObservation[];
}

export interface GuaranteeRecurrenceAdvisory {
	path?: string;
	findingClass: string;
	distinctCount: number;
	rollCount: number;
}

/** Map persisted fleet records into detector rolls. v1, operator, and fleet
 *  records that omit `recurrenceFindings` contribute nothing (absent ≠ `[]`). */
export function recurrenceRollsFromRecords(
	records: readonly {
		schemaVersion: number;
		producer?: string;
		prNumber: number;
		itemId: string;
		headSha: string;
		recurrenceFindings?: readonly GuaranteeRecurrenceObservation[];
	}[],
): GuaranteeRecurrenceRoll[] {
	const rolls: GuaranteeRecurrenceRoll[] = [];
	for (const record of records) {
		if (record.schemaVersion !== 2 || record.producer !== "fleet") continue;
		if (record.recurrenceFindings === undefined) continue;
		rolls.push({
			prNumber: record.prNumber,
			itemId: record.itemId,
			headSha: record.headSha,
			observations: record.recurrenceFindings,
		});
	}
	return rolls;
}

function groupKey(observation: GuaranteeRecurrenceObservation): string {
	return observation.path ? `path:${observation.path}\0class:${observation.findingClass}` : `class:${observation.findingClass}`;
}

export function findGuaranteeRecurrenceAdvisory(priorRolls: readonly GuaranteeRecurrenceRoll[], currentRoll: GuaranteeRecurrenceRoll): GuaranteeRecurrenceAdvisory | null {
	const rollsBySha = new Map<string, GuaranteeRecurrenceRoll>();
	for (const roll of priorRolls) {
		if (roll.prNumber !== currentRoll.prNumber || roll.itemId !== currentRoll.itemId) continue;
		rollsBySha.set(roll.headSha, roll);
	}
	rollsBySha.set(currentRoll.headSha, currentRoll);

	const currentKeys = new Set(currentRoll.observations.map(groupKey));
	if (currentKeys.size === 0) return null;

	interface Group {
		path?: string;
		findingClass: string;
		digests: Set<string>;
		shas: Set<string>;
	}
	const groups = new Map<string, Group>();
	for (const roll of rollsBySha.values()) {
		const seenInRoll = new Set<string>();
		for (const observation of roll.observations) {
			if (seenInRoll.has(observation.fingerprintDigest)) continue;
			seenInRoll.add(observation.fingerprintDigest);
			const key = groupKey(observation);
			const existing = groups.get(key);
			if (existing) {
				existing.digests.add(observation.fingerprintDigest);
				existing.shas.add(roll.headSha);
				continue;
			}
			groups.set(key, {
				...(observation.path ? { path: observation.path } : {}),
				findingClass: observation.findingClass,
				digests: new Set([observation.fingerprintDigest]),
				shas: new Set([roll.headSha]),
			});
		}
	}

	const fired: Array<{ key: string; group: Group }> = [];
	for (const [key, group] of groups) {
		if (!currentKeys.has(key)) continue;
		if (group.digests.size < RECURRENCE_DISTINCT_THRESHOLD) continue;
		if (group.shas.size < RECURRENCE_ROLL_THRESHOLD) continue;
		fired.push({ key, group });
	}
	if (fired.length === 0) return null;
	fired.sort((a, b) => b.group.digests.size - a.group.digests.size || b.group.shas.size - a.group.shas.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const winner = fired[0]?.group;
	if (!winner) return null;
	return {
		...(winner.path ? { path: winner.path } : {}),
		findingClass: winner.findingClass,
		distinctCount: winner.digests.size,
		rollCount: winner.shas.size,
	};
}

export function renderGuaranteeRecurrenceAdvisory(advisory: GuaranteeRecurrenceAdvisory): string {
	// Both strings originate in model-authored findings; counts and fixed guidance are harness-owned.
	const location = advisory.path ? ` in ${escapeMarkdown(advisory.path)}` : "";
	return `${advisory.distinctCount} distinct confirmed must-fixes of class ${escapeMarkdown(advisory.findingClass)}${location} recurred across ${advisory.rollCount} rolls. Survivors recur in a class this item may not own — consider re-chartering.`;
}
