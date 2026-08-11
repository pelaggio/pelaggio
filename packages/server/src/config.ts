import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
	host: string;
	port: number;
	registryPath: string;
	token: string;
	statePath: string;
	logDir: string;
	webDist: string | undefined;
	trustManifestPath: string;
}

function required(name: string, value: string | undefined): string {
	if (value === undefined || value === "") {
		throw new Error(`${name} is required`);
	}
	return value;
}

// Resolved relative to this file: packages/server/src/ → ../../web/dist = packages/web/dist
const packageRelativeWebDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : resolve(homedir(), ".config");
}

function xdgStateHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : resolve(homedir(), ".local", "state");
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, { webDistDefault = packageRelativeWebDist }: { webDistDefault?: string } = {}): ServerConfig {
	const host = required("AUTOPILOT_SERVER_HOST", env.AUTOPILOT_SERVER_HOST);
	if (host === "0.0.0.0" || host === "::") {
		throw new Error(`AUTOPILOT_SERVER_HOST must be a specific interface (e.g. tailnet IP), not ${host}`);
	}
	const portRaw = required("AUTOPILOT_SERVER_PORT", env.AUTOPILOT_SERVER_PORT);
	const port = Number(portRaw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`AUTOPILOT_SERVER_PORT must be an integer 1-65535; got ${JSON.stringify(portRaw)}`);
	}
	const registryPath = env.AUTOPILOT_SERVER_REGISTRY ? resolve(env.AUTOPILOT_SERVER_REGISTRY) : resolve(xdgConfigHome(env), "pelaggio-server", "repos.yml");
	const stateRoot = resolve(xdgStateHome(env), "pelaggio-server");
	const statePath = env.AUTOPILOT_SERVER_STATE_PATH ? resolve(env.AUTOPILOT_SERVER_STATE_PATH) : resolve(stateRoot, "state.json");
	const logDir = env.AUTOPILOT_SERVER_LOG_DIR ? resolve(env.AUTOPILOT_SERVER_LOG_DIR) : resolve(stateRoot, "logs");
	const trustManifestPath = env.AUTOPILOT_SERVER_TRUST_MANIFEST ? resolve(env.AUTOPILOT_SERVER_TRUST_MANIFEST) : resolve(process.cwd(), "docs/trust/pelaggio.trust.json");
	const token = required("CONTROL_PLANE_TOKEN", env.CONTROL_PLANE_TOKEN);
	const webDistCandidate = env.AUTOPILOT_SERVER_WEB_DIST ? resolve(env.AUTOPILOT_SERVER_WEB_DIST) : webDistDefault;
	const webDist = existsSync(webDistCandidate) ? webDistCandidate : undefined;
	return { host, port, registryPath, token, statePath, logDir, webDist, trustManifestPath };
}
