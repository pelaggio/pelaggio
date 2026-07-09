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
	it("registryPath defaults to $XDG_CONFIG_HOME/pelaggio-server/repos.yml", () => {
		const xdg = mkdtempSync(join(tmpdir(), "xdg-cfg-"));
		const cfg = loadServerConfig(baseEnv({ XDG_CONFIG_HOME: xdg }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.registryPath, resolve(xdg, "pelaggio-server", "repos.yml"));
	});

	it("registryPath defaults to ~/.config/pelaggio-server/repos.yml when XDG_CONFIG_HOME unset", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.registryPath, resolve(homedir(), ".config", "pelaggio-server", "repos.yml"));
	});

	it("AUTOPILOT_SERVER_REGISTRY overrides defaults", () => {
		const explicit = "/etc/pelaggio/repos.yml";
		const cfg = loadServerConfig(baseEnv({ XDG_CONFIG_HOME: "/ignored", AUTOPILOT_SERVER_REGISTRY: explicit }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(cfg.registryPath, explicit);
	});

	it("statePath defaults to $XDG_STATE_HOME/pelaggio-server/state.json", () => {
		const xdgState = mkdtempSync(join(tmpdir(), "xdg-state-"));
		const cfg = loadServerConfig(baseEnv({ XDG_STATE_HOME: xdgState }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.statePath, resolve(xdgState, "pelaggio-server", "state.json"));
		assert.equal(cfg.logDir, resolve(xdgState, "pelaggio-server", "logs"));
	});

	it("statePath defaults to ~/.local/state/pelaggio-server/state.json when XDG_STATE_HOME unset", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.statePath, resolve(homedir(), ".local", "state", "pelaggio-server", "state.json"));
	});

	it("AUTOPILOT_SERVER_STATE_PATH and AUTOPILOT_SERVER_LOG_DIR overrides", () => {
		const cfg = loadServerConfig(
			baseEnv({
				AUTOPILOT_SERVER_STATE_PATH: "/var/lib/pelaggio/state.json",
				AUTOPILOT_SERVER_LOG_DIR: "/var/log/pelaggio",
			}),
			{ webDistDefault: join(tmpdir(), "no-such-dist") },
		);
		assert.equal(cfg.statePath, "/var/lib/pelaggio/state.json");
		assert.equal(cfg.logDir, "/var/log/pelaggio");
	});

	it("trust manifest path defaults to docs/trust and can be overridden", () => {
		const fallback = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(fallback.trustManifestPath, resolve(process.cwd(), "docs/trust/pelaggio.trust.json"));
		const explicit = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_TRUST_MANIFEST: "/var/lib/pelaggio/trust.json" }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(explicit.trustManifestPath, "/var/lib/pelaggio/trust.json");
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

	it("fails closed: unset token + non-loopback host is refused", () => {
		assert.throws(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: "100.64.0.1" }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /CONTROL_PLANE_TOKEN/);
	});

	it("token set on a non-loopback host is unchanged (does not throw; token preserved)", () => {
		const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: "100.64.0.1", CONTROL_PLANE_TOKEN: "s3cret" }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(cfg.token, "s3cret");
	});

	it("loopback bind without a token is allowed (token undefined)", () => {
		const cfg = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.token, undefined);
	});

	it("loopback aliases without a token are allowed (localhost, ::1)", () => {
		for (const host of ["localhost", "::1"]) {
			assert.doesNotThrow(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host }), { webDistDefault: join(tmpdir(), "no-such-dist") }));
		}
	});

	it("fails closed: 127.*-prefixed hostnames are not loopback (Node resolves them, could bind routable)", () => {
		for (const host of ["127.example.com", "127.0.0.1.example.com", "127."]) {
			assert.throws(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /CONTROL_PLANE_TOKEN/, host);
		}
	});

	it("a valid 127.0.0.0/8 IPv4 literal without a token is allowed", () => {
		for (const host of ["127.0.0.1", "127.1.2.3"]) {
			assert.doesNotThrow(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host }), { webDistDefault: join(tmpdir(), "no-such-dist") }), host);
		}
	});
});
