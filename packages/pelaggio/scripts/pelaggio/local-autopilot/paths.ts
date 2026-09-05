import { join, resolve } from "node:path";
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

export function runsDir(cwd: string): string {
	return join(policyDir(cwd), "runs");
}

export function runDir(cwd: string, runId: string): string {
	return directChild(runsDir(cwd), runId, "runId");
}

export function eventsPath(cwd: string, runId: string): string {
	return join(runDir(cwd, runId), "events.jsonl");
}

export function leasePath(cwd: string, runId: string): string {
	return join(runDir(cwd, runId), "lease");
}

export function requestIndexDir(cwd: string): string {
	return join(runsDir(cwd), "by-request");
}

export function requestIndexPath(cwd: string, requestId: string): string {
	return directChild(requestIndexDir(cwd), requestId, "requestId");
}

function directChild(base: string, id: string, label: string): string {
	if (!isOpaqueId(id)) throw new Error(`${label} is not an opaque id`);
	const root = resolve(base);
	const target = resolve(root, id);
	if (target === root || !target.startsWith(`${root}/`)) throw new Error(`${label} escapes ${root}`);
	return target;
}
