import { execFileSync } from "node:child_process";

/** Repository selection must come from cwd, never inherited Git routing/config overrides. */
export function localGitEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

export function localGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: localGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
