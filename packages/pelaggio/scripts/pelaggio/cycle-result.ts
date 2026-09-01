import { A } from "./tui.js";
import type { CycleResult } from "./types.js";

export function resultIcon(r: CycleResult): string {
	if (r.outcome === "completed" && r.bookkeepingWarnings?.length) return A.yellow("⚠");
	if (r.outcome === "completed") return A.green("✓");
	if (r.outcome === "parked") return A.yellow("⏸");
	if (r.outcome === "failed" && r.error === "plan needs rethink") return A.yellow("↻");
	if (r.disposition === "quarantine-and-continue") return A.yellow("⊘");
	return A.red("✗");
}

export function resultStatus(r: CycleResult): "done" | "warning" | "skipped" | "failed" | "parked" | "quarantined" {
	if (r.outcome === "completed" && r.bookkeepingWarnings?.length) return "warning";
	if (r.outcome === "completed") return "done";
	if (r.outcome === "parked") return "parked";
	if (r.outcome === "failed" && r.error === "plan needs rethink") return "skipped";
	if (r.disposition === "quarantine-and-continue") return "quarantined";
	return "failed";
}

export function resultDetail(r: CycleResult): string {
	if (r.outcome === "completed" && r.bookkeepingWarnings?.length) return `shipped — bookkeeping incomplete: ${r.bookkeepingWarnings.join("; ")}`;
	if (r.detail !== undefined) return r.detail;
	switch (r.outcome) {
		case "completed":
			return "";
		case "parked":
			return r.parkReason ?? "parked";
		case "blocked":
			return r.reason;
		case "failed":
			return r.error;
	}
}

export function cycleDiagnostic(r: CycleResult): string {
	if (r.outcome === "failed") return r.error;
	if (r.outcome === "blocked") return r.reason;
	if (r.outcome === "parked") return r.parkReason ?? "";
	return "";
}
