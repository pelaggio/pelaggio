import type { ProviderName } from "../types.js";

export type DiscoveryResourceKey = `review:${string}`;

export interface DiscoveryResourceClaim {
	key: DiscoveryResourceKey;
	units: number;
}

export interface DiscoverySchedulingProfile {
	claims: readonly DiscoveryResourceClaim[];
	waitsForProviders: readonly ProviderName[];
}

export interface DiscoveryCellInput<T> {
	key: string;
	group: number;
	provider: ProviderName;
	payload: T;
}

export interface PlannedDiscoveryCell<T> extends DiscoveryCellInput<T> {
	index: number;
	claims: readonly DiscoveryResourceClaim[];
	dependsOn: readonly number[];
}

export interface DiscoveryFleetPlan<T> {
	cells: readonly PlannedDiscoveryCell<T>[];
	capacities: ReadonlyMap<DiscoveryResourceKey, number>;
	maxConcurrent: number;
}

export type DiscoveryFleetSettlement<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown } | { status: "not-started"; reason: "stopped" };

type StartedDiscoverySettlement<T> = Exclude<DiscoveryFleetSettlement<T>, { status: "not-started" }>;

export class DiscoveryFleetPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiscoveryFleetPlanError";
	}
}

function requirePositiveInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new DiscoveryFleetPlanError(`${label} must be a positive safe integer`);
}

export function buildDiscoveryFleetPlan<T>(options: {
	cells: readonly DiscoveryCellInput<T>[];
	profiles: Readonly<Record<ProviderName, DiscoverySchedulingProfile>>;
	capacities: Readonly<Record<DiscoveryResourceKey, number>>;
	maxConcurrent: number;
}): DiscoveryFleetPlan<T> {
	requirePositiveInteger(options.maxConcurrent, "maxConcurrent");
	const capacities = new Map<DiscoveryResourceKey, number>();
	for (const [rawKey, capacity] of Object.entries(options.capacities)) {
		const key = rawKey as DiscoveryResourceKey;
		if (!key.startsWith("review:") || key.length === "review:".length) throw new DiscoveryFleetPlanError(`invalid resource key: ${rawKey}`);
		requirePositiveInteger(capacity, `capacity for ${key}`);
		capacities.set(key, capacity);
	}

	const keyIndexes = new Map<string, number>();
	for (const [index, cell] of options.cells.entries()) {
		if (cell.key.length === 0) throw new DiscoveryFleetPlanError(`cell ${index} has an empty key`);
		if (!Number.isSafeInteger(cell.group) || cell.group < 0) throw new DiscoveryFleetPlanError(`cell ${cell.key} has an invalid group`);
		if (keyIndexes.has(cell.key)) throw new DiscoveryFleetPlanError(`duplicate discovery cell key: ${cell.key}`);
		keyIndexes.set(cell.key, index);
	}

	const cells = options.cells.map((cell, index): PlannedDiscoveryCell<T> => {
		const profile = options.profiles[cell.provider];
		if (!profile) throw new DiscoveryFleetPlanError(`missing scheduling profile for ${cell.provider}`);
		if (profile.claims.length === 0) throw new DiscoveryFleetPlanError(`provider ${cell.provider} declares no review resources`);
		const seenClaims = new Set<DiscoveryResourceKey>();
		for (const claim of profile.claims) {
			if (seenClaims.has(claim.key)) throw new DiscoveryFleetPlanError(`provider ${cell.provider} declares duplicate resource ${claim.key}`);
			seenClaims.add(claim.key);
			requirePositiveInteger(claim.units, `claim for ${claim.key}`);
			const capacity = capacities.get(claim.key);
			if (capacity === undefined) throw new DiscoveryFleetPlanError(`unknown resource ${claim.key} for ${cell.provider}`);
			if (claim.units > capacity) throw new DiscoveryFleetPlanError(`claim for ${claim.key} exceeds capacity`);
		}
		const dependsOn = options.cells.map((candidate, candidateIndex) => (profile.waitsForProviders.includes(candidate.provider) ? candidateIndex : -1)).filter((candidateIndex) => candidateIndex >= 0);
		return { ...cell, index, claims: profile.claims, dependsOn };
	});

	for (const cell of cells) {
		for (const dependency of cell.dependsOn) {
			if (dependency === cell.index) throw new DiscoveryFleetPlanError(`cell ${cell.key} depends on itself`);
		}
	}
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const visit = (index: number): void => {
		if (visited.has(index)) return;
		if (visiting.has(index)) throw new DiscoveryFleetPlanError(`dependency cycle includes ${cells[index]?.key ?? index}`);
		visiting.add(index);
		for (const dependency of cells[index]?.dependsOn ?? []) visit(dependency);
		visiting.delete(index);
		visited.add(index);
	};
	for (const cell of cells) visit(cell.index);

	return { cells, capacities, maxConcurrent: options.maxConcurrent };
}

export async function executeDiscoveryFleet<T, R>(options: {
	plan: DiscoveryFleetPlan<T>;
	launch: (cell: PlannedDiscoveryCell<T>) => Promise<R>;
	shouldStop?: (cell: PlannedDiscoveryCell<T>, result: DiscoveryFleetSettlement<R>) => boolean;
}): Promise<DiscoveryFleetSettlement<R>[]> {
	const results: Array<DiscoveryFleetSettlement<R> | undefined> = Array.from({ length: options.plan.cells.length });
	const active = new Map<number, Promise<{ index: number; result: StartedDiscoverySettlement<R> }>>();
	const used = new Map<DiscoveryResourceKey, number>();
	let stoppedAfterGroup: number | undefined;

	const dependenciesSettled = (cell: PlannedDiscoveryCell<T>): boolean => cell.dependsOn.every((index) => results[index] !== undefined);
	const claimsFit = (cell: PlannedDiscoveryCell<T>): boolean => cell.claims.every((claim) => (used.get(claim.key) ?? 0) + claim.units <= (options.plan.capacities.get(claim.key) ?? 0));
	const claim = (cell: PlannedDiscoveryCell<T>): void => {
		for (const resource of cell.claims) used.set(resource.key, (used.get(resource.key) ?? 0) + resource.units);
	};
	const release = (cell: PlannedDiscoveryCell<T>): void => {
		for (const resource of cell.claims) {
			const remaining = (used.get(resource.key) ?? 0) - resource.units;
			if (remaining < 0) throw new Error(`discovery resource released twice: ${resource.key}`);
			if (remaining === 0) used.delete(resource.key);
			else used.set(resource.key, remaining);
		}
	};
	const start = (cell: PlannedDiscoveryCell<T>): void => {
		claim(cell);
		const settled = (async (): Promise<{ index: number; result: StartedDiscoverySettlement<R> }> => {
			try {
				return { index: cell.index, result: { status: "fulfilled", value: await options.launch(cell) } };
			} catch (reason) {
				return { index: cell.index, result: { status: "rejected", reason } };
			}
		})();
		active.set(cell.index, settled);
	};

	while (results.some((result) => result === undefined)) {
		if (stoppedAfterGroup !== undefined) {
			for (const cell of options.plan.cells) {
				if (cell.group > stoppedAfterGroup && !active.has(cell.index) && results[cell.index] === undefined) results[cell.index] = { status: "not-started", reason: "stopped" };
			}
		}
		let admitted = false;
		for (const cell of options.plan.cells) {
			if (stoppedAfterGroup !== undefined && cell.group > stoppedAfterGroup) continue;
			if (active.size >= options.plan.maxConcurrent) break;
			if (results[cell.index] !== undefined || active.has(cell.index)) continue;
			if (!dependenciesSettled(cell)) continue;
			if (!claimsFit(cell)) continue;
			start(cell);
			admitted = true;
		}

		if (active.size === 0) {
			if (stoppedAfterGroup !== undefined) break;
			if (!admitted) throw new Error("discovery fleet deadlocked after plan validation");
		}
		if (active.size === 0) continue;
		const settled = await Promise.race(active.values());
		const cell = options.plan.cells[settled.index];
		if (!cell) throw new Error(`discovery fleet returned unknown cell index ${settled.index}`);
		active.delete(settled.index);
		release(cell);
		results[settled.index] = settled.result;
		if (options.shouldStop?.(cell, settled.result)) stoppedAfterGroup = Math.min(stoppedAfterGroup ?? cell.group, cell.group);
	}

	return results.map((result) => result ?? { status: "not-started", reason: "stopped" });
}
