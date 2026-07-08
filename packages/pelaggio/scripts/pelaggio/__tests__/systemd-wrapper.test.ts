import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveArtifactRoot } from "../artifact-root.js";

const REPO_ROOT = resolveArtifactRoot(import.meta.url);
const WRAPPER = join(REPO_ROOT, "infra/systemd/pelaggio-server-exec.sh");

describe("pelaggio-server-exec.sh", () => {
	const bash = spawnSync("bash", ["--version"]);
	const hasBash = bash.status === 0;

	(hasBash ? it : it.skip)("passes bash -n syntax check", () => {
		const result = spawnSync("bash", ["-n", WRAPPER], { encoding: "utf8" });
		assert.equal(result.status, 0, `bash -n failed:\n${result.stderr}`);
	});
});
