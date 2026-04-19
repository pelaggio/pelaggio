#!/usr/bin/env tsx
/**
 * Copies `.claude/skills/` and `.claude-templates/` from the monorepo root into
 * this package, so they're included in the published tarball. The package's
 * `prepack` lifecycle invokes this; `postpack` invokes the companion
 * `pack-cleanup.ts`. Both paths are listed in `packages/autopilot/.gitignore`.
 *
 * `check-publish.ts` imports `copySkillsIn` / `cleanSkillsOut` directly so its
 * `npm pack --dry-run` invocation can use `--ignore-scripts` (avoiding npm's
 * lifecycle, where `postpack` would delete the files before content scanning
 * runs) while still producing a tarball-equivalent file tree.
 */
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE_ROOT, "../..");

export const PACK_TARGETS = [".claude/skills", ".claude-templates"] as const;

export function copySkillsIn(packageRoot: string = PACKAGE_ROOT, repoRoot: string = ROOT): void {
	for (const rel of PACK_TARGETS) {
		const dest = resolve(packageRoot, rel);
		rmSync(dest, { recursive: true, force: true });
		cpSync(resolve(repoRoot, rel), dest, { recursive: true });
	}
}

export function cleanSkillsOut(packageRoot: string = PACKAGE_ROOT): void {
	for (const rel of PACK_TARGETS) {
		rmSync(resolve(packageRoot, rel), { recursive: true, force: true });
	}
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
	copySkillsIn();
}
