import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `moduleUrl` until a directory is found that contains both
 * `.claude/skills/` and a `package.json`. That directory is the monorepo root
 * during dogfood (skills live at the repo root) and the published-package root
 * after the `prepack` copy. The `package.json` anchor stops the walk at the
 * first package boundary, so a parent directory that happens to contain a
 * `.claude/skills/` fixture won't be mistaken for the artifact root.
 */
export function resolveArtifactRoot(moduleUrl: string): string {
	let dir = dirname(fileURLToPath(moduleUrl));
	while (true) {
		if (existsSync(resolve(dir, ".claude/skills")) && existsSync(resolve(dir, "package.json"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`resolveArtifactRoot: no ancestor of ${fileURLToPath(moduleUrl)} contains both .claude/skills/ and package.json`);
		}
		dir = parent;
	}
}
