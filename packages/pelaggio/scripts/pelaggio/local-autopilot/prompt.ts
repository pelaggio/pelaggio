import type { UsageMeasurement } from "../usage-measurement.js";
import { measurePromptSafely } from "../usage-measurement.js";
import type { WorkContract } from "./types.js";

/** The exact prompt value handed to a consumer and its best-effort diagnostic measurement. */
export interface MeasuredPrompt {
	text: string;
	usageMeasurement?: UsageMeasurement;
}

export function prepareHarnessPrompt(workContract: WorkContract, verificationFailure?: string): MeasuredPrompt {
	const text = [
		"Implement the following task in this git worktree.",
		"Do not push, open a pull request, merge, release, or deploy.",
		"Stay inside the current working directory.",
		"",
		`# ${workContract.title}`,
		"",
		workContract.body,
		...(verificationFailure ? ["", "The previous verification failed. Repair this exact failure:", verificationFailure] : []),
	].join("\n");
	return { text, usageMeasurement: measurePromptSafely(text, "adapter-assembled") };
}
