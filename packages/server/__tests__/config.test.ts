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
		CONTROL_PLANE_TOKEN: "test-token",
		...extra,
	};
}

describe("loadServerConfig", () => {
	it("defaults the roadmap title TTL to 60 seconds and accepts a positive override", () => {
		const defaults = loadServerConfig(baseEnv(), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(defaults.roadmapTitleTtlMs, 60_000);
		const overridden = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_ROADMAP_TITLE_TTL_MS: "2500" }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(overridden.roadmapTitleTtlMs, 2_500);
	});

	it("rejects a non-positive or non-integer roadmap title TTL", () => {
		for (const value of ["0", "-1", "1.5", "nope"]) {
			assert.throws(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_ROADMAP_TITLE_TTL_MS: value }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /AUTOPILOT_SERVER_ROADMAP_TITLE_TTL_MS must be a positive integer/);
		}
	});

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

	it("rejects wildcard bind hosts", () => {
		for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]", "::0", "0::0"]) {
			assert.throws(() => loadServerConfig({ AUTOPILOT_SERVER_HOST: host, AUTOPILOT_SERVER_PORT: "7777" }), /specific interface.*not/, host);
		}
	});

	it("accepts specific IPv6 bind hosts", () => {
		for (const host of ["::1", "2001:db8::1", "fd7a:115c:a1e0::1"]) {
			const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host }), { webDistDefault: join(tmpdir(), "no-such-dist") });
			assert.equal(cfg.host, host);
		}
	});

	it("fails closed when the token is unset, including on loopback", () => {
		for (const host of ["127.0.0.1", "localhost", "::1", "100.64.0.1"]) {
			for (const token of [undefined, ""]) {
				assert.throws(() => loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host, CONTROL_PLANE_TOKEN: token }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /CONTROL_PLANE_TOKEN is required/, host);
			}
		}
	});

	it("trims surrounding whitespace from the token (env-file trailing space must not 401 every request)", () => {
		const cfg = loadServerConfig(baseEnv({ CONTROL_PLANE_TOKEN: " s3cret \n" }), { webDistDefault: join(tmpdir(), "no-such-dist") });
		assert.equal(cfg.token, "s3cret");
	});

	it("whitespace-only token fails closed", () => {
		assert.throws(() => loadServerConfig(baseEnv({ CONTROL_PLANE_TOKEN: "   " }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /CONTROL_PLANE_TOKEN is required/);
	});

	it("missing-token startup error names the operator remediation", () => {
		assert.throws(() => loadServerConfig(baseEnv({ CONTROL_PLANE_TOKEN: undefined }), { webDistDefault: join(tmpdir(), "no-such-dist") }), /CONTROL_PLANE_TOKEN.*~\/\.config\/pelaggio-server\.env.*before starting pelaggio-server/);
	});

	it("token set on a non-loopback host is unchanged (does not throw; token preserved)", () => {
		const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: "100.64.0.1", CONTROL_PLANE_TOKEN: "s3cret" }), {
			webDistDefault: join(tmpdir(), "no-such-dist"),
		});
		assert.equal(cfg.token, "s3cret");
	});

	it("token set on loopback hosts is unchanged", () => {
		for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1"]) {
			const cfg = loadServerConfig(baseEnv({ AUTOPILOT_SERVER_HOST: host }), { webDistDefault: join(tmpdir(), "no-such-dist") });
			assert.equal(cfg.token, "test-token", host);
		}
	});
});
