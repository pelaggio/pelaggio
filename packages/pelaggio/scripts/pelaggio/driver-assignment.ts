import type { ProviderName } from "./types.js";

export type DriverIdentity = { provider: "codex"; codexModel?: string } | { provider: "claude" | "grok"; model?: string };

export interface DriverAssignmentState {
	cycle: number;
	authoringOrdinal: number;
	authors: Partial<Record<"plan" | "implementation", DriverIdentity>>;
}

export type AssignmentResult = { ok: true; drivers: DriverIdentity[] } | { ok: false; reason: string };

export function createDriverAssignmentState(cycle: number): DriverAssignmentState {
	return { cycle, authoringOrdinal: 0, authors: {} };
}

function rotated<T>(items: readonly T[], offset: number): T[] {
	if (items.length === 0) return [];
	const start = ((offset % items.length) + items.length) % items.length;
	return [...items.slice(start), ...items.slice(0, start)];
}

export function selectAuthor(state: DriverAssignmentState, candidates: readonly DriverIdentity[], isAvailable: (candidate: DriverIdentity) => boolean): AssignmentResult {
	const offset = state.cycle + state.authoringOrdinal;
	state.authoringOrdinal += 1;
	const driver = rotated(candidates, offset).find(isAvailable);
	return driver ? { ok: true, drivers: [driver] } : { ok: false, reason: "no configured author driver is available" };
}

export function selectReviewers(state: DriverAssignmentState, candidates: readonly DriverIdentity[], author: DriverIdentity, count: number, isAvailable: (candidate: DriverIdentity) => boolean): AssignmentResult {
	const seen = new Set<ProviderName>();
	const drivers = rotated(candidates, state.cycle).filter((candidate) => {
		if (candidate.provider === author.provider || seen.has(candidate.provider) || !isAvailable(candidate)) return false;
		seen.add(candidate.provider);
		return true;
	});
	if (drivers.length < count) return { ok: false, reason: `need ${count} distinct non-author review driver(s), found ${drivers.length}` };
	return { ok: true, drivers: drivers.slice(0, count) };
}

export function recordArtifactAuthor(state: DriverAssignmentState, artifact: "plan" | "implementation", author: DriverIdentity): void {
	state.authors[artifact] = author;
}
