import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export type EgressAuth = { kind: "key"; env: string; header: "authorization" | "x-api-key"; scheme?: "Bearer" } | { kind: "transparent" };

export interface EgressRoute {
	id: string;
	method: string;
	path: string;
	models: readonly string[];
	body: "json" | "none";
	modelField: string;
	maxOutputTokensField: string;
	inputUsageField: readonly string[];
	outputUsageField: readonly string[];
	inputMicroUsdPerToken: Readonly<Record<string, number>>;
	outputMicroUsdPerToken: Readonly<Record<string, number>>;
}

export interface EgressLimits {
	requestBodyBytes: number;
	responseBodyBytes: number;
	requestsPerWindow: number;
	windowMs: number;
	requestsPerRun: number;
	inputTokens: number;
	outputTokens: number;
	spendMicroUsd: number;
}

export interface EgressPolicy {
	id: string;
	upstreamOrigin: string;
	routes: readonly EgressRoute[];
	limits: EgressLimits;
}

export interface EgressDecision {
	timestamp: number;
	method: string;
	path: string;
	rule?: string;
	outcome: "allowed" | "denied" | "fatal";
	status: number;
	requestBytes: number;
	responseBytes: number;
	inputTokens: number;
	outputTokens: number;
	spendMicroUsd: number;
}

export interface OutboundResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

export type EgressRequester = (options: RequestOptions, body: Buffer, limit: number) => Promise<OutboundResponse>;

export interface EgressBrokerHandle {
	ready: Promise<void>;
	decisions: readonly EgressDecision[];
	fatal: Promise<Error>;
	close(): Promise<void>;
}

export interface StartEgressBrokerOptions {
	socketPath: string;
	policy: EgressPolicy;
	auth: EgressAuth;
	key?: string;
}

export interface EgressBrokerDependencies {
	request?: EgressRequester;
	now?: () => number;
}

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const SENSITIVE_RESPONSE_HEADERS = new Set(["authorization", "proxy-authorization", "set-cookie", "set-cookie2"]);
const REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent"]);

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export function validateEgressPolicy(policy: EgressPolicy): void {
	const origin = new URL(policy.upstreamOrigin);
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("egress upstream must be an HTTPS origin");
	const limits = policy.limits;
	for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);
	const routes = new Set<string>();
	if (policy.routes.length === 0) throw new Error("egress policy requires a route");
	for (const route of policy.routes) {
		if (!/^[A-Z]+$/.test(route.method) || !route.path.startsWith("/") || route.path.includes("*") || route.path.includes("?") || route.path.includes("#")) throw new Error(`invalid egress route ${route.id}`);
		const key = `${route.method} ${route.path}`;
		if (routes.has(key)) throw new Error(`duplicate egress route ${key}`);
		routes.add(key);
		if (route.models.length === 0 || new Set(route.models).size !== route.models.length) throw new Error(`route ${route.id} requires unique models`);
		for (const model of route.models) {
			positiveInteger(route.inputMicroUsdPerToken[model], `${model} input price`);
			positiveInteger(route.outputMicroUsdPerToken[model], `${model} output price`);
		}
		if (!route.modelField || !route.maxOutputTokensField || route.inputUsageField.length === 0 || route.outputUsageField.length === 0) throw new Error(`route ${route.id} has incomplete accounting fields`);
	}
}

function nested(value: unknown, path: readonly string[]): unknown {
	let cursor = value;
	for (const part of path) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}

async function defaultRequester(options: RequestOptions, body: Buffer, limit: number): Promise<OutboundResponse> {
	return await new Promise((resolve, reject) => {
		const request = httpsRequest(options, (response) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > limit) request.destroy(new Error("upstream response body exceeds cap"));
				else chunks.push(chunk);
			});
			response.once("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		request.once("error", reject);
		request.end(body);
	});
}

function genericError(response: ServerResponse, status: number): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end('{"error":"egress request denied"}');
}

export async function startEgressBroker(options: StartEgressBrokerOptions, deps: EgressBrokerDependencies = {}): Promise<EgressBrokerHandle> {
	validateEgressPolicy(options.policy);
	if (options.auth.kind === "key" && !options.key) throw new Error(`missing key from ${options.auth.env}`);
	if (options.auth.kind === "transparent" && options.key !== undefined) throw new Error("transparent auth cannot receive a key");
	const now = deps.now ?? Date.now;
	const requester = deps.request ?? defaultRequester;
	const decisions: EgressDecision[] = [];
	let sealed = false;
	let requests = 0;
	let reservedInput = 0;
	let reservedOutput = 0;
	let reservedSpend = 0;
	let windowStarts: number[] = [];
	let fatalResolve!: (error: Error) => void;
	const fatal = new Promise<Error>((resolve) => {
		fatalResolve = resolve;
	});
	const signalFatal = (error: Error): void => {
		if (sealed) return;
		sealed = true;
		fatalResolve(error);
	};
	const record = (request: IncomingMessage, path: string, outcome: EgressDecision["outcome"], status: number, values: Partial<EgressDecision> = {}): void => {
		decisions.push(Object.freeze({ timestamp: now(), method: request.method ?? "", path, outcome, status, requestBytes: 0, responseBytes: 0, inputTokens: 0, outputTokens: 0, spendMicroUsd: 0, ...values }));
	};
	const server = createServer(async (request, response) => {
		let path = "<invalid>";
		try {
			if (sealed) return genericError(response, 503);
			const rawUrl = request.url ?? "";
			if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("#")) return genericError(response, 400);
			const parsedUrl = new URL(rawUrl, "http://unix");
			path = parsedUrl.pathname;
			const route = options.policy.routes.find((candidate) => candidate.method === request.method && candidate.path === path);
			const lengths: string[] = [];
			for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === "content-length") lengths.push(request.rawHeaders[index + 1] ?? "");
			if (!route || request.headers["transfer-encoding"] || lengths.length > 1 || request.headers.upgrade || Array.isArray(request.headers.authorization)) {
				record(request, path, "denied", 400);
				return genericError(response, 400);
			}
			const chunks: Buffer[] = [];
			let bodyBytes = 0;
			for await (const value of request) {
				const chunk = Buffer.from(value);
				bodyBytes += chunk.length;
				if (bodyBytes > options.policy.limits.requestBodyBytes) {
					record(request, path, "denied", 413, { rule: route.id, requestBytes: bodyBytes });
					return genericError(response, 413);
				}
				chunks.push(chunk);
			}
			const body = Buffer.concat(chunks);
			let json: Record<string, unknown>;
			try {
				json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
			} catch {
				record(request, path, "denied", 400, { rule: route.id, requestBytes: bodyBytes });
				return genericError(response, 400);
			}
			const model = json[route.modelField];
			const maxOutput = json[route.maxOutputTokensField];
			if (typeof model !== "string" || !route.models.includes(model) || !Number.isSafeInteger(maxOutput) || (maxOutput as number) <= 0 || json.stream === true) {
				record(request, path, "denied", 403, { rule: route.id, requestBytes: bodyBytes });
				return genericError(response, 403);
			}
			const input = bodyBytes;
			const output = maxOutput as number;
			const spend = input * route.inputMicroUsdPerToken[model] + output * route.outputMicroUsdPerToken[model];
			const time = now();
			windowStarts = windowStarts.filter((stamp) => time - stamp < options.policy.limits.windowMs);
			const cap =
				requests + 1 > options.policy.limits.requestsPerRun ||
				windowStarts.length + 1 > options.policy.limits.requestsPerWindow ||
				reservedInput + input > options.policy.limits.inputTokens ||
				reservedOutput + output > options.policy.limits.outputTokens ||
				reservedSpend + spend > options.policy.limits.spendMicroUsd;
			if (cap) {
				record(request, path, "fatal", 429, { rule: route.id, requestBytes: bodyBytes, inputTokens: input, outputTokens: output, spendMicroUsd: spend });
				signalFatal(new Error("egress hard cap exceeded"));
				return genericError(response, 429);
			}
			requests += 1;
			windowStarts.push(time);
			reservedInput += input;
			reservedOutput += output;
			reservedSpend += spend;
			const headers: Record<string, string> = { "content-length": String(body.length) };
			for (const [name, value] of Object.entries(request.headers)) if (REQUEST_HEADERS.has(name) && typeof value === "string") headers[name] = value;
			if (options.auth.kind === "key") headers[options.auth.header] = `${options.auth.scheme ? `${options.auth.scheme} ` : ""}${options.key}`;
			else if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
			const upstream = new URL(options.policy.upstreamOrigin);
			const result = await requester(
				{ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: route.method, path: `${upstream.pathname === "/" ? "" : upstream.pathname}${path}${parsedUrl.search}`, headers },
				body,
				options.policy.limits.responseBodyBytes,
			);
			if (result.body.length > options.policy.limits.responseBodyBytes || (result.status >= 300 && result.status < 400)) throw new Error("unsafe upstream response");
			let usage: unknown;
			try {
				usage = JSON.parse(result.body.toString("utf8"));
			} catch {
				usage = undefined;
			}
			const actualInput = nested(usage, route.inputUsageField);
			const actualOutput = nested(usage, route.outputUsageField);
			if (
				result.status >= 200 &&
				result.status < 300 &&
				(!Number.isSafeInteger(actualInput) || !Number.isSafeInteger(actualOutput) || (actualInput as number) < 0 || (actualOutput as number) < 0 || (actualInput as number) > input || (actualOutput as number) > output)
			)
				throw new Error("unaccountable upstream usage");
			const safeHeaders: Record<string, string | readonly string[]> = {};
			for (const [name, value] of Object.entries(result.headers)) if (!HOP_HEADERS.has(name) && !SENSITIVE_RESPONSE_HEADERS.has(name) && value !== undefined) safeHeaders[name] = value;
			response.writeHead(result.status, safeHeaders);
			response.end(result.body);
			record(request, path, "allowed", result.status, { rule: route.id, requestBytes: bodyBytes, responseBytes: result.body.length, inputTokens: Number(actualInput) || 0, outputTokens: Number(actualOutput) || 0, spendMicroUsd: spend });
		} catch {
			record(request, path, "fatal", 502);
			signalFatal(new Error("egress accounting or upstream failure"));
			if (!response.headersSent) genericError(response, 502);
			else response.destroy();
		}
	});
	const ready = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => resolve());
	});
	await ready;
	await chmod(options.socketPath, 0o666);
	return {
		ready,
		get decisions() {
			return Object.freeze([...decisions]);
		},
		fatal,
		async close(): Promise<void> {
			sealed = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(options.socketPath, { force: true });
		},
	};
}
