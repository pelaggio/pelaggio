/** Roadmap items → the provider-neutral `FlowSnapshot` that `FlowPolicy` strategies evaluate. */
import type { FlowSnapshot } from "./flow-policy.js";
import type { RoadmapItemStatus, Scope } from "./roadmap/types.js";

export function buildFlowSnapshot(items: readonly RoadmapItemStatus[], opts?: { topic?: string; maxScope?: Scope }): FlowSnapshot {
	const known = [...items].sort((a, b) => b.id.length - a.id.length);
	const candidates = items.map((item, fifoOrdinal) => {
		let remainder = item.deps.trim();
		const dependencies: Array<{ reference: string; satisfied: boolean }> = [];
		for (const dependency of known) {
			const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(dependency.id)}(?![A-Za-z0-9])`, "gi");
			if (!pattern.test(remainder)) continue;
			dependencies.push({ reference: dependency.id, satisfied: dependency.status === "done" });
			remainder = remainder.replace(pattern, " ");
		}
		const unresolved = remainder.replace(/[\s,;|()[\]]+/g, " ").trim();
		const unresolvedDependencies = unresolved === "" || unresolved === "—" || /^(?:none|n\/a|-)$/.test(unresolved.toLowerCase()) ? [] : [unresolved];
		const priority = item.priority;
		return {
			item,
			dependencies,
			unresolvedDependencies,
			fifoOrdinal,
			...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
		};
	});
	return { candidates, readiness: { kind: "derived" }, ...(opts?.topic ? { topic: opts.topic } : {}), ...(opts?.maxScope ? { maxScope: opts.maxScope } : {}) };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
