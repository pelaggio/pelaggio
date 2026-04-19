import { resolve } from "node:path";

export interface ServerConfig {
	host: string;
	port: number;
	repo: string;
	token: string | undefined;
	statePath: string;
	logDir: string;
}

function required(name: string, value: string | undefined): string {
	if (value === undefined || value === "") {
		throw new Error(`${name} is required`);
	}
	return value;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const host = required("AUTOPILOT_SERVER_HOST", env.AUTOPILOT_SERVER_HOST);
	if (host === "0.0.0.0") {
		throw new Error("AUTOPILOT_SERVER_HOST must be a specific interface (e.g. tailnet IP), not 0.0.0.0");
	}
	const portRaw = required("AUTOPILOT_SERVER_PORT", env.AUTOPILOT_SERVER_PORT);
	const port = Number(portRaw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`AUTOPILOT_SERVER_PORT must be an integer 1-65535; got ${JSON.stringify(portRaw)}`);
	}
	const repo = resolve(required("AUTOPILOT_REPO", env.AUTOPILOT_REPO));
	const statePath = env.AUTOPILOT_SERVER_STATE_PATH ? resolve(env.AUTOPILOT_SERVER_STATE_PATH) : resolve(repo, ".dev", "server-state.json");
	const logDir = env.AUTOPILOT_SERVER_LOG_DIR ? resolve(env.AUTOPILOT_SERVER_LOG_DIR) : resolve(repo, ".dev", "server-logs");
	const token = env.CONTROL_PLANE_TOKEN || undefined;
	return { host, port, repo, token, statePath, logDir };
}
