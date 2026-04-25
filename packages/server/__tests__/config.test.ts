import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadServerConfig } from "../src/config.js";

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		AUTOPILOT_SERVER_HOST: "127.0.0.1",
		AUTOPILOT_SERVER_PORT: "7777",
		...extra,
	};
}

describe("loadServerConfig", () => {
	it("registryPath defaults to $XDG_CONFIG_HOME/autopilot-server/repos.yml", () => {
		const xdg = mkdtempSync(join(tmpdir(), "xdg-cfg-"));
		const cfg = loadServerConfig(baseEnv({ XDG_CONFIG_HOME: xdg }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.registryPath, resolve(xdg, "autopilot-server", "repos.yml"));
	});

	it("registryPath defaults to ~/.config/autopilot-server/repos.yml when XDG_CONFIG_HOME unset", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.registryPath, resolve(homedir(), ".config", "autopilot-server", "repos.yml"));
	});

	it("AUTOPILOT_SERVER_REGISTRY overrides defaults", () => {
		const explicit = "/etc/autopilot/repos.yml";
		const cfg = loadServerConfig(baseEnv({ XDG_CONFIG_HOME: "/ignored", AUTOPILOT_SERVER_REGISTRY: explicit }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(cfg.registryPath, explicit);
	});

	it("statePath defaults to $XDG_STATE_HOME/autopilot-server/state.json", () => {
		const xdgState = mkdtempSync(join(tmpdir(), "xdg-state-"));
		const cfg = loadServerConfig(baseEnv({ XDG_STATE_HOME: xdgState }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.statePath, resolve(xdgState, "autopilot-server", "state.json"));
		assert.equal(cfg.logDir, resolve(xdgState, "autopilot-server", "logs"));
	});

	it("statePath defaults to ~/.local/state/autopilot-server/state.json when XDG_STATE_HOME unset", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.statePath, resolve(homedir(), ".local", "state", "autopilot-server", "state.json"));
	});

	it("AUTOPILOT_SERVER_STATE_PATH and AUTOPILOT_SERVER_LOG_DIR overrides", () => {
		const cfg = loadServerConfig(
			baseEnv({
				AUTOPILOT_SERVER_STATE_PATH: "/var/lib/autopilot/state.json",
				AUTOPILOT_SERVER_LOG_DIR: "/var/log/autopilot",
			}),
			{ webDistDefault: join(tmpdir(), "no-such-dist") },
		);
		assert.equal(cfg.statePath, "/var/lib/autopilot/state.json");
		assert.equal(cfg.logDir, "/var/log/autopilot");
	});

	it("webDist is undefined when default path is missing (UI not built)", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.webDist, undefined);
	});

	it("webDist is undefined when explicit AUTOPILOT_SERVER_WEB_DIST does not exist", () => {
		const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_WEB_DIST: join(tmpdir(), "missing-dist") }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(cfg.webDist, undefined);
	});

	it("webDist resolves the explicit env var when the directory exists", () => {
		const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
		const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_WEB_DIST: dist }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.webDist, dist);
	});

	it("rejects AUTOPILOT_SERVER_HOST=0.0.0.0", () => {
		assert.throws(() => loadServerConfig({ AUTOPILOT_SERVER_HOST: "0.0.0.0", AUTOPILOT_SERVER_PORT: "7777" }));
	});
});
