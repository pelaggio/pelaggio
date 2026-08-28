import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isWithinRoot(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function resolveFileWithinRoot(root: string, path: string): string | undefined {
	const candidate = resolve(root, path);
	if (!isWithinRoot(root, candidate)) return undefined;
	try {
		const realRoot = realpathSync(root);
		const realCandidate = realpathSync(candidate);
		if (!isWithinRoot(realRoot, realCandidate) || !statSync(realCandidate).isFile()) return undefined;
		return realCandidate;
	} catch {
		return undefined;
	}
}

export function readSourceWithinRoot(root: string, path: string): string | undefined {
	const file = resolveFileWithinRoot(root, path);
	if (!file) return undefined;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}
