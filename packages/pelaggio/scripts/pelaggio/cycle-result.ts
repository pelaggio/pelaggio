import { A } from "./tui.js";
import type { CycleResult } from "./types.js";

export function resultIcon(r: CycleResult): string {
	if (r.completed && r.bookkeepingWarnings?.length) return A.yellow("⚠");
	if (r.completed) return A.green("✓");
	if (r.error === "parked") return A.yellow("⏸");
	if (r.error === "plan needs rethink") return A.yellow("↻");
	if (r.disposition === "quarantine-and-continue") return A.yellow("⊘");
	return A.red("✗");
}

export function resultStatus(r: CycleResult): "done" | "warning" | "skipped" | "failed" | "parked" | "quarantined" {
	if (r.completed && r.bookkeepingWarnings?.length) return "warning";
	if (r.completed) return "done";
	if (r.error === "parked") return "parked";
	if (r.error === "plan needs rethink") return "skipped";
	if (r.disposition === "quarantine-and-continue") return "quarantined";
	return "failed";
}

export function resultDetail(r: CycleResult): string {
	if (r.completed && r.bookkeepingWarnings?.length) return `shipped — bookkeeping incomplete: ${r.bookkeepingWarnings.join("; ")}`;
	return r.detail ?? r.error ?? "";
}
