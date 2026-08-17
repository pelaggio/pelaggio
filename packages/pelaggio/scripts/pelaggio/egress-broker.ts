import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export type EgressAuth = { kind: "key"; env: string; header: "authorization" | "x-api-key"; scheme?: "Bearer" } | { kind: "transparent" };

interface EgressRouteBase {
	id: string;
	method: string;
	path: string;
	requestHeaders: readonly string[];
}

export interface FixedEgressRoute extends EgressRouteBase {
	kind: "fixed";
	body: "json" | "none";
}

export interface AccountedEgressRoute extends EgressRouteBase {
	kind: "accounted";
	body: "json";
	models: readonly string[];
	modelField: string;
	maxOutputTokensField: string;
	streamField: string;
	stream: boolean;
	response: { kind: "json" } | { kind: "sse"; terminalEvent: string };
	inputUsageField: readonly string[];
	outputUsageField: readonly string[];
	inputMicroUsdPerToken: Readonly<Record<string, number>>;
	outputMicroUsdPerToken: Readonly<Record<string, number>>;
}

export type EgressRoute = FixedEgressRoute | AccountedEgressRoute;

export interface EgressLimits {
	requestBodyBytes: number;
	responseBodyBytes: number;
	requestsPerWindow: number;
	windowMs: number;
	// Consecutive rate-limit (requestsPerWindow) breaches tolerated before the soft throttle
	// escalates to a hard seal+kill — bounds a client that ignores Retry-After forever.
	rateLimitRetryBudget: number;
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

export type EgressFatalReason = "rate_limit" | "budget" | "integrity";

export class EgressFatalError extends Error {
	constructor(
		message: string,
		readonly reason: EgressFatalReason,
	) {
		super(message);
		this.name = "EgressFatalError";
	}
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
const SENSITIVE_RESPONSE_HEADERS = new Set(["authorization", "location", "proxy-authorization", "set-cookie", "set-cookie2"]);
const SAFE_REQUEST_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"content-type",
	"user-agent",
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
]);

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function modelPrice(prices: Readonly<Record<string, number>>, model: string): number {
	const price = prices[model];
	if (price === undefined) throw new Error(`missing price for ${model}`);
	return price;
}

export function validateEgressPolicy(policy: EgressPolicy): void {
	const origin = new URL(policy.upstreamOrigin);
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("egress upstream must be an HTTPS origin");
	const limits = policy.limits;
	for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);
	const routes = new Set<string>();
	if (policy.routes.length === 0) throw new Error("egress policy requires a route");
	for (const route of policy.routes) {
		if (
			(route.method !== "GET" && route.method !== "POST") ||
			!route.path.startsWith("/") ||
			route.path.includes("*") ||
			route.path.includes("?") ||
			route.path.includes("#") ||
			route.path.split("/").some((part) => part === "." || part === "..")
		) {
			throw new Error(`invalid egress route ${route.id}`);
		}
		const key = `${route.method} ${route.path}`;
		if (routes.has(key)) throw new Error(`duplicate egress route ${key}`);
		routes.add(key);
		if (new Set(route.requestHeaders).size !== route.requestHeaders.length || route.requestHeaders.some((header) => header !== header.toLowerCase() || !SAFE_REQUEST_HEADERS.has(header))) {
			throw new Error(`route ${route.id} has unsafe request headers`);
		}
		if (route.kind === "fixed") continue;
		if (route.models.length === 0 || new Set(route.models).size !== route.models.length) throw new Error(`route ${route.id} requires unique models`);
		for (const model of route.models) {
			positiveInteger(modelPrice(route.inputMicroUsdPerToken, model), `${model} input price`);
			positiveInteger(modelPrice(route.outputMicroUsdPerToken, model), `${model} output price`);
		}
		if (!route.modelField || !route.maxOutputTokensField || !route.streamField || route.inputUsageField.length === 0 || route.outputUsageField.length === 0) throw new Error(`route ${route.id} has incomplete accounting fields`);
		if (route.response.kind === "sse" && !route.response.terminalEvent) throw new Error(`route ${route.id} has no terminal SSE event`);
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

function genericError(response: ServerResponse, status: number, headers: OutgoingHttpHeaders = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end('{"error":"egress request denied"}');
}

function parseJson(body: Buffer): unknown {
	return JSON.parse(body.toString("utf8"));
}

function parseUsage(route: AccountedEgressRoute, body: Buffer): { input: unknown; output: unknown } {
	if (route.response.kind === "json") {
		const value = parseJson(body);
		return { input: nested(value, route.inputUsageField), output: nested(value, route.outputUsageField) };
	}
	let terminal: unknown;
	for (const frame of body.toString("utf8").split(/\r?\n\r?\n/)) {
		let event = "";
		const data: string[] = [];
		for (const line of frame.split(/\r?\n/)) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
		}
		if (data.length === 0 || data.join("\n") === "[DONE]") continue;
		const value = parseJson(Buffer.from(data.join("\n")));
		const type = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).type : undefined;
		if (event === route.response.terminalEvent || type === route.response.terminalEvent) terminal = value;
	}
	if (terminal === undefined) throw new Error("missing terminal SSE usage event");
	return { input: nested(terminal, route.inputUsageField), output: nested(terminal, route.outputUsageField) };
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
	let rateLimitStrikes = 0;
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
			if (`${parsedUrl.pathname}${parsedUrl.search}` !== rawUrl) return genericError(response, 400);
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
			let json: Record<string, unknown> | undefined;
			try {
				if (route.body === "none") {
					if (body.length !== 0) throw new Error("body forbidden");
				} else {
					const value = parseJson(body);
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
					json = value as Record<string, unknown>;
				}
			} catch {
				record(request, path, "denied", 400, { rule: route.id, requestBytes: bodyBytes });
				return genericError(response, 400);
			}
			let model: string | undefined;
			let input = 0;
			let output = 0;
			let spend = 0;
			if (route.kind === "accounted") {
				model = json?.[route.modelField] as string | undefined;
				const maxOutput = json?.[route.maxOutputTokensField];
				// The OpenAI-compatible Responses API documents `stream` to default to false when
				// omitted, so an absent field compares as false against the route's pinned mode; a
				// present value must still equal it exactly (null/non-boolean stays denied). The
				// model and max-output fields stay required: neither has a finite API default the
				// broker could price or reserve output budget against.
				const stream = json && Object.hasOwn(json, route.streamField) ? json[route.streamField] : false;
				if (typeof model !== "string" || !route.models.includes(model) || !Number.isSafeInteger(maxOutput) || (maxOutput as number) <= 0 || stream !== route.stream) {
					record(request, path, "denied", 403, { rule: route.id, requestBytes: bodyBytes });
					return genericError(response, 403);
				}
				input = bodyBytes;
				output = maxOutput as number;
				spend = input * modelPrice(route.inputMicroUsdPerToken, model) + output * modelPrice(route.outputMicroUsdPerToken, model);
			}
			const time = now();
			windowStarts = windowStarts.filter((stamp) => time - stamp < options.policy.limits.windowMs);
			const hardCapExceeded =
				requests + 1 > options.policy.limits.requestsPerRun ||
				reservedInput + input > options.policy.limits.inputTokens ||
				reservedOutput + output > options.policy.limits.outputTokens ||
				reservedSpend + spend > options.policy.limits.spendMicroUsd;
			if (hardCapExceeded) {
				record(request, path, "fatal", 429, { rule: route.id, requestBytes: bodyBytes, inputTokens: input, outputTokens: output, spendMicroUsd: spend });
				signalFatal(new EgressFatalError("egress hard cap exceeded", "budget"));
				return genericError(response, 429);
			}
			if (windowStarts.length + 1 > options.policy.limits.requestsPerWindow) {
				rateLimitStrikes += 1;
				const oldestStart = windowStarts[0] ?? time;
				const retryAfterSeconds = Math.max(1, Math.ceil((oldestStart + options.policy.limits.windowMs - time) / 1000));
				if (rateLimitStrikes > options.policy.limits.rateLimitRetryBudget) {
					record(request, path, "fatal", 429, { rule: route.id, requestBytes: bodyBytes, inputTokens: input, outputTokens: output, spendMicroUsd: spend });
					signalFatal(new EgressFatalError("egress rate limit retry budget exceeded", "rate_limit"));
					return genericError(response, 429);
				}
				record(request, path, "denied", 429, { rule: route.id, requestBytes: bodyBytes });
				return genericError(response, 429, { "retry-after": String(retryAfterSeconds) });
			}
			rateLimitStrikes = 0;
			requests += 1;
			windowStarts.push(time);
			reservedInput += input;
			reservedOutput += output;
			reservedSpend += spend;
			const headers: Record<string, string> = { "content-length": String(body.length) };
			for (const [name, value] of Object.entries(request.headers)) if (route.requestHeaders.includes(name) && typeof value === "string") headers[name] = value;
			if (options.auth.kind === "key") headers[options.auth.header] = `${options.auth.scheme ? `${options.auth.scheme} ` : ""}${options.key}`;
			else if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
			const upstream = new URL(options.policy.upstreamOrigin);
			const result = await requester(
				{ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: route.method, path: `${upstream.pathname === "/" ? "" : upstream.pathname}${path}${parsedUrl.search}`, headers },
				body,
				options.policy.limits.responseBodyBytes,
			);
			if (result.body.length > options.policy.limits.responseBodyBytes || (result.status >= 300 && result.status < 400)) throw new Error("unsafe upstream response");
			const usage = route.kind === "accounted" && result.status >= 200 && result.status < 300 ? parseUsage(route, result.body) : { input: 0, output: 0 };
			const actualInput = usage.input;
			const actualOutput = usage.output;
			if (
				route.kind === "accounted" &&
				result.status >= 200 &&
				result.status < 300 &&
				(!Number.isSafeInteger(actualInput) || !Number.isSafeInteger(actualOutput) || (actualInput as number) < 0 || (actualOutput as number) < 0 || (actualInput as number) > input || (actualOutput as number) > output)
			)
				throw new Error("unaccountable upstream usage");
			let actualSpend = spend;
			if (route.kind === "accounted" && result.status >= 200 && result.status < 300 && model) {
				const reconciledInput = Number(actualInput);
				const reconciledOutput = Number(actualOutput);
				actualSpend = reconciledInput * modelPrice(route.inputMicroUsdPerToken, model) + reconciledOutput * modelPrice(route.outputMicroUsdPerToken, model);
				reservedInput += reconciledInput - input;
				reservedOutput += reconciledOutput - output;
				reservedSpend += actualSpend - spend;
			}
			response.statusCode = result.status;
			for (const [name, value] of Object.entries(result.headers)) if (!HOP_HEADERS.has(name) && !SENSITIVE_RESPONSE_HEADERS.has(name) && name !== "content-length" && value !== undefined) response.setHeader(name, value);
			response.end(result.body);
			record(request, path, "allowed", result.status, { rule: route.id, requestBytes: bodyBytes, responseBytes: result.body.length, inputTokens: Number(actualInput) || 0, outputTokens: Number(actualOutput) || 0, spendMicroUsd: actualSpend });
		} catch {
			record(request, path, "fatal", 502);
			signalFatal(new EgressFatalError("egress accounting or upstream failure", "integrity"));
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
