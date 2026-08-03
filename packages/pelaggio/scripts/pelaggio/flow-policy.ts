import type { RoadmapItemStatus } from "./roadmap/types.js";

export interface QuickScopeInput {
	readonly item?: Pick<RoadmapItemStatus, "body" | "labels"> | null;
	readonly summaryText?: string;
}

export interface FlowDependency {
	readonly reference: string;
	readonly satisfied: boolean;
}

export interface FlowCandidate {
	readonly item: RoadmapItemStatus;
	readonly dependencies: readonly FlowDependency[];
	readonly unresolvedDependencies: readonly string[];
	readonly fifoOrdinal: number;
	readonly priority?: number;
}

export type FlowReadiness = { readonly kind: "derived" } | { readonly kind: "native"; readonly readyIds: readonly string[] };

export interface FlowSnapshot {
	readonly candidates: readonly FlowCandidate[];
	readonly readiness: FlowReadiness;
	readonly topic?: string;
}

export type FlowVerdictReason = "eligible" | "status" | "deferred" | "not-native-ready" | "dependency" | "unresolved-dependency" | "topic";

export interface FlowItemVerdict {
	readonly id: string;
	readonly eligible: boolean;
	readonly reason: FlowVerdictReason;
	readonly blockers: readonly string[];
}

export interface FlowEligibleCandidate {
	readonly item: RoadmapItemStatus;
	readonly verdict: FlowItemVerdict;
}

export interface FlowEvaluation {
	readonly candidates: readonly FlowEligibleCandidate[];
	readonly verdicts: readonly FlowItemVerdict[];
}

export interface FlowPolicy {
	evaluate(snapshot: FlowSnapshot): FlowEvaluation;
	isQuickScope(input: QuickScopeInput): boolean;
}

const BODY_STANDARD_SCOPE_RE = /\bscope:\s*(m|l|xl)\b/i;
const BODY_QUICK_SCOPE_RE = /\bscope:\s*(xs|s)\b/i;
const LABEL_SCOPE_RE = /^scope[\s:/-]*(xs|s|m|l|xl)$/i;
const BUG_FIX_RE = /\bbug\b|\bfix:/i;
const DEFAULT_PRIORITY = 0;

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function excludedStatus(status: RoadmapItemStatus["status"]): boolean {
	return status === "done" || status === "blocked" || status === "in-progress";
}

function verdict(candidate: FlowCandidate, snapshot: FlowSnapshot, nativeReadyIds: ReadonlySet<string>): FlowItemVerdict {
	if (excludedStatus(candidate.item.status)) {
		return { id: candidate.item.id, eligible: false, reason: "status", blockers: [candidate.item.status] };
	}
	// Deferred is curated backlog (not dependency failure). After status so done/blocked/
	// in-progress deferred items still surface as `status` for explicit-pick display.
	if (candidate.item.deferred === true) {
		return { id: candidate.item.id, eligible: false, reason: "deferred", blockers: [] };
	}
	if (snapshot.readiness.kind === "native" && !nativeReadyIds.has(normalize(candidate.item.id))) {
		return { id: candidate.item.id, eligible: false, reason: "not-native-ready", blockers: [] };
	}
	if (snapshot.readiness.kind === "derived") {
		const unmet = candidate.dependencies.filter((dependency) => !dependency.satisfied).map((dependency) => dependency.reference);
		if (unmet.length > 0) return { id: candidate.item.id, eligible: false, reason: "dependency", blockers: unmet };
		if (candidate.unresolvedDependencies.length > 0) {
			return { id: candidate.item.id, eligible: false, reason: "unresolved-dependency", blockers: [...candidate.unresolvedDependencies] };
		}
	}
	const topic = normalize(snapshot.topic ?? "");
	if (topic && !normalize(`${candidate.item.id} ${candidate.item.title} ${candidate.item.sourceRef}`).includes(topic)) {
		return { id: candidate.item.id, eligible: false, reason: "topic", blockers: [] };
	}
	return { id: candidate.item.id, eligible: true, reason: "eligible", blockers: [] };
}

export class FifoPolicy implements FlowPolicy {
	evaluate(snapshot: FlowSnapshot): FlowEvaluation {
		const nativeReadyIds = new Set(snapshot.readiness.kind === "native" ? snapshot.readiness.readyIds.map(normalize) : []);
		const evaluated = snapshot.candidates.map((candidate) => ({ candidate, verdict: verdict(candidate, snapshot, nativeReadyIds) }));
		const candidates = evaluated
			.filter((entry) => entry.verdict.eligible)
			.sort((a, b) => (a.candidate.priority ?? DEFAULT_PRIORITY) - (b.candidate.priority ?? DEFAULT_PRIORITY) || a.candidate.fifoOrdinal - b.candidate.fifoOrdinal || a.candidate.item.id.localeCompare(b.candidate.item.id))
			.map(({ candidate, verdict: itemVerdict }) => ({ item: candidate.item, verdict: itemVerdict }));
		return { candidates, verdicts: evaluated.map((entry) => entry.verdict) };
	}

	isQuickScope(input: QuickScopeInput): boolean {
		const item = input.item ?? null;
		const labels = item?.labels ?? [];
		const body = item?.body ?? "";
		const labelScopes = labels.map((label) => label.match(LABEL_SCOPE_RE)?.[1]?.toLowerCase()).filter((scope): scope is string => Boolean(scope));
		if (BODY_STANDARD_SCOPE_RE.test(body) || labelScopes.some((scope) => scope === "m" || scope === "l" || scope === "xl")) return false;
		if (BODY_QUICK_SCOPE_RE.test(body) || labelScopes.some((scope) => scope === "xs" || scope === "s")) return true;
		if (labels.some((label) => label.toLowerCase() === "bug") || BUG_FIX_RE.test(body)) return true;
		const summaryText = input.summaryText ?? "";
		return BODY_QUICK_SCOPE_RE.test(summaryText) || BUG_FIX_RE.test(summaryText);
	}
}

export const DEFAULT_FLOW_POLICY: FlowPolicy = new FifoPolicy();
