import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isOpaqueId } from "./transport.js";

/** Consumer-local policy and run state. Not a pelaggio `.dev` register. */
export const LOCAL_POLICY_DIR = ".pelaggio";
export const LOCAL_CONFIG_FILE = "pelaggio.yml";

export function policyDir(cwd: string): string {
	return join(cwd, LOCAL_POLICY_DIR);
}

export function configPath(cwd: string): string {
	return join(policyDir(cwd), LOCAL_CONFIG_FILE);
}

/** State names must retain their physical identity: aliases may target another run or host path. */
export function checkedStatePath(cwd: string, ...parts: string[]): string {
	const root = realpathSync(cwd);
	const base = resolve(root, LOCAL_POLICY_DIR);
	const target = resolve(base, ...parts);
	if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("path escapes local run state");
	let current = root;
	for (const part of relative(root, target).split(sep)) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`local run state path is a symlink: ${current}; state preserved; remove the alias before retrying`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return target;
}

export function runsDir(cwd: string): string {
	return checkedStatePath(cwd, "runs");
}

export function runDir(cwd: string, runId: string): string {
	return checkedStatePath(cwd, "runs", opaque(runId, "runId"));
}

export function eventsPath(cwd: string, runId: string): string {
	return checkedStatePath(cwd, "runs", opaque(runId, "runId"), "events.jsonl");
}

export function leasePath(cwd: string, runId: string): string {
	return checkedStatePath(cwd, "runs", opaque(runId, "runId"), "lease");
}

export function requestIndexDir(cwd: string): string {
	return checkedStatePath(cwd, "runs", "by-request");
}

export function requestIndexPath(cwd: string, requestId: string): string {
	return checkedStatePath(cwd, "runs", "by-request", opaque(requestId, "requestId"));
}

export function requestLockPath(cwd: string, digest: string): string {
	return checkedStatePath(cwd, "runs", "request-locks", opaque(digest, "request digest"));
}

function opaque(id: string, label: string): string {
	if (!isOpaqueId(id)) throw new Error(`${label} is not an opaque id`);
	return id;
}
