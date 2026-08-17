import { readFile } from "node:fs/promises";

export const GROK_SANDBOX_PROFILE = "pelaggio-worktree-v1";
export const GROK_SANDBOX_BLOCK = `[profiles.${GROK_SANDBOX_PROFILE}]\nextends = "strict"\nrestrict_network = true`;

export interface BuildGrokArgsOptions {
	model?: string;
	reasoningEffort: "low" | "medium" | "high";
	sandbox?: boolean;
	baseUrl?: string;
}

export interface DetectLandlockOptions {
	platform?: NodeJS.Platform;
	lsmPath?: string;
}

/** Grok's custom Linux profiles fail closed unless Landlock is active in the kernel's LSM set. */
export async function detectLandlock(options: DetectLandlockOptions = {}): Promise<boolean> {
	if ((options.platform ?? process.platform) !== "linux") return true;
	try {
		const lsm = await readFile(options.lsmPath ?? "/sys/kernel/security/lsm", "utf8");
		return lsm
			.split(",")
			.map((name) => name.trim())
			.includes("landlock");
	} catch {
		return false;
	}
}

export function buildGrokArgs(options: BuildGrokArgsOptions): string[] {
	return [
		...(options.sandbox === false ? [] : ["--sandbox", GROK_SANDBOX_PROFILE]),
		"--disable-web-search",
		...(options.model ? ["-m", options.model] : []),
		"--reasoning-effort",
		options.reasoningEffort,
		"agent",
		...(options.baseUrl ? ["--cli-chat-proxy-base-url", options.baseUrl] : []),
		"stdio",
	];
}
