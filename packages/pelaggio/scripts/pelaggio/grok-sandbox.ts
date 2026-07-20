import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "./file-lock.js";

export const GROK_SANDBOX_PROFILE = "pelaggio-worktree-v1";
export const GROK_SANDBOX_BEGIN = "# BEGIN PELAGGIO MANAGED GROK SANDBOX";
export const GROK_SANDBOX_END = "# END PELAGGIO MANAGED GROK SANDBOX";
export const GROK_SANDBOX_BLOCK = `${GROK_SANDBOX_BEGIN}\n[profiles.${GROK_SANDBOX_PROFILE}]\nextends = "strict"\nrestrict_network = true\n${GROK_SANDBOX_END}`;

const LOCK_OPTIONS = { label: "Grok sandbox profile lock", staleMs: 10_000, acquireTimeoutMs: 5_000 } as const;

export interface InstallGrokSandboxProfileOptions {
	home?: string;
	configPath?: string;
}

export interface BuildGrokArgsOptions {
	model?: string;
	reasoningEffort: "low" | "medium" | "high";
	sandbox?: boolean;
}

export function buildGrokArgs(options: BuildGrokArgsOptions): string[] {
	return [...(options.sandbox === false ? [] : ["--sandbox", GROK_SANDBOX_PROFILE]), "--disable-web-search", ...(options.model ? ["-m", options.model] : []), "--reasoning-effort", options.reasoningEffort, "agent", "stdio"];
}

function markerCount(content: string, marker: string): number {
	return content.split(marker).length - 1;
}

function renderConfig(content: string): string {
	const begins = markerCount(content, GROK_SANDBOX_BEGIN);
	const ends = markerCount(content, GROK_SANDBOX_END);
	if (begins !== ends || begins > 1) throw new Error("Grok sandbox config has malformed or duplicate Pelaggio managed markers");

	const profileDeclaration = `[profiles.${GROK_SANDBOX_PROFILE}]`;
	let outside = content;
	if (begins === 1) {
		const start = content.indexOf(GROK_SANDBOX_BEGIN);
		const endMarker = content.indexOf(GROK_SANDBOX_END, start + GROK_SANDBOX_BEGIN.length);
		if (endMarker < 0) throw new Error("Grok sandbox config has malformed Pelaggio managed markers");
		const end = endMarker + GROK_SANDBOX_END.length;
		outside = content.slice(0, start) + content.slice(end);
	}
	if (outside.includes(profileDeclaration)) throw new Error(`Grok sandbox profile ${GROK_SANDBOX_PROFILE} is already user-owned`);

	if (begins === 1) {
		const start = content.indexOf(GROK_SANDBOX_BEGIN);
		const end = content.indexOf(GROK_SANDBOX_END, start) + GROK_SANDBOX_END.length;
		return content.slice(0, start) + GROK_SANDBOX_BLOCK + content.slice(end);
	}
	if (!content) return `${GROK_SANDBOX_BLOCK}\n`;
	return `${content}${content.endsWith("\n") ? "" : "\n"}\n${GROK_SANDBOX_BLOCK}\n`;
}

export async function installGrokSandboxProfile(options: InstallGrokSandboxProfileOptions = {}): Promise<string> {
	const home = options.home?.trim();
	if (!home && !options.configPath) throw new Error("Grok sandbox profile requires a non-empty HOME");
	const configPath = options.configPath ?? join(home as string, ".grok", "sandbox.toml");
	const lockPath = `${configPath}.pelaggio.lock`;

	await withFileLock(
		lockPath,
		async () => {
			await mkdir(dirname(configPath), { recursive: true });
			let content = "";
			let mode = 0o600;
			try {
				const stat = await lstat(configPath);
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Grok sandbox config is not a regular file: ${configPath}`);
				mode = stat.mode & 0o777;
				content = await readFile(configPath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}

			const rendered = renderConfig(content);
			if (rendered === content) return;
			const temporaryPath = `${configPath}.pelaggio-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
			try {
				const file = await open(temporaryPath, "wx", mode);
				try {
					await file.writeFile(rendered, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				await chmod(temporaryPath, mode);
				await rename(temporaryPath, configPath);
			} finally {
				await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		},
		LOCK_OPTIONS,
	);
	return GROK_SANDBOX_PROFILE;
}
