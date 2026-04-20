import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadServerConfig } from "../src/config.js";

function baseEnv(repo: string): NodeJS.ProcessEnv {
	return {
		AUTOPILOT_SERVER_HOST: "127.0.0.1",
		AUTOPILOT_SERVER_PORT: "7777",
		AUTOPILOT_REPO: repo,
	};
}

describe("loadServerConfig", () => {
	it("webDist is undefined when default path is missing (UI not built)", () => {
		const repo = mkdtempSync(join(tmpdir(), "cfg-test-"));
		// Inject a non-existent default so the test is stable whether or not the web package is built.
		const cfg = loadServerConfig(baseEnv(repo), { webDistDefault: join(repo, "dist") });
		assert.equal(cfg.webDist, undefined);
	});

	it("webDist is undefined when explicit AUTOPILOT_SERVER_WEB_DIST does not exist", () => {
		const repo = mkdtempSync(join(tmpdir(), "cfg-test-"));
		const cfg = loadServerConfig({ ...baseEnv(repo), AUTOPILOT_SERVER_WEB_DIST: join(repo, "missing") });
		assert.equal(cfg.webDist, undefined);
	});

	it("webDist resolves the explicit env var when the directory exists", () => {
		const repo = mkdtempSync(join(tmpdir(), "cfg-test-"));
		const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
		const cfg = loadServerConfig({ ...baseEnv(repo), AUTOPILOT_SERVER_WEB_DIST: dist });
		assert.equal(cfg.webDist, dist);
	});
});
