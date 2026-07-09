import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
	host: string;
	port: number;
	registryPath: string;
	token: string | undefined;
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

function isLoopbackHost(host: string): boolean {
	// Classify by parsed IP literal, not string prefix. A hostname like
	// "127.example.com" must NOT count as loopback: Node resolves hostnames before
	// binding, so a "127."-prefixed name can map to a routable address. Loopback is
	// a valid 127.0.0.0/8 IPv4 literal, the ::1 IPv6 literal, or the exact host
	// "localhost".
	if (host === "localhost") return true;
	const kind = isIP(host);
	if (kind === 4) return host.startsWith("127.");
	if (kind === 6) return host === "::1";
	return false;
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
	if (host === "0.0.0.0") {
		throw new Error("AUTOPILOT_SERVER_HOST must be a specific interface (e.g. tailnet IP), not 0.0.0.0");
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
	const token = env.CONTROL_PLANE_TOKEN || undefined;
	if (token === undefined && !isLoopbackHost(host)) {
		throw new Error(
			`refusing to start: CONTROL_PLANE_TOKEN is unset and AUTOPILOT_SERVER_HOST=${host} is not loopback. ` +
				`An unauthenticated control plane on a routable interface lets any reachable peer spawn pelaggio runs. ` +
				`Set CONTROL_PLANE_TOKEN, or bind to 127.0.0.1 for local-only use.`,
		);
	}
	const webDistCandidate = env.AUTOPILOT_SERVER_WEB_DIST ? resolve(env.AUTOPILOT_SERVER_WEB_DIST) : webDistDefault;
	const webDist = existsSync(webDistCandidate) ? webDistCandidate : undefined;
	return { host, port, registryPath, token, statePath, logDir, webDist, trustManifestPath };
}
