// Agent Client Protocol (ACP) client over stdio (issue #239).
//
// A minimal JSON-RPC 2.0 client for driving a stdio agent that speaks ACP — the transport
// grok exposes via `grok agent stdio` (see docs/agent-context/acp-grok-protocol.md, pinned to
// the grok 0.2.103 conformance target). This module is deliberately **agent-neutral**: it owns
// framing, request/response correlation, notification + server→client-request routing, and the
// subprocess lifecycle. Agent-specific interpretation of `session/update` events and the
// completion/usage shape belongs to the provider that consumes it (#136 grok-provider).
//
// Framing is newline-delimited JSON (ndjson) — one JSON-RPC message per line — NOT the
// Content-Length framing used by LSP. The reader buffers partial trailing lines across chunks.

import { spawn } from "node:child_process";

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** A server→client request (has an `id` and a `method`): the agent asking the client to do
 *  something — e.g. `session/request_permission`. The handler's return value (or thrown error)
 *  becomes the JSON-RPC response. */
export interface AcpIncomingRequest {
	id: number | string;
	method: string;
	params: unknown;
}

/** A server→client notification (a `method`, no `id`): fire-and-forget progress — e.g.
 *  `session/update`, or grok's `_x.ai/*` extensions. */
export interface AcpNotification {
	method: string;
	params: unknown;
}

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(err: JsonRpcError) {
		super(err.message);
		this.name = "AcpRpcError";
		this.code = err.code;
		this.data = err.data;
	}
}

// Standard JSON-RPC error code for an unroutable server→client request.
const METHOD_NOT_FOUND = -32601;

type PendingResolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type RequestHandler = (req: AcpIncomingRequest) => unknown | Promise<unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The pure protocol engine. It never touches process streams directly: outbound frames go
 * through the injected `send` callback and inbound bytes arrive via `receive()`. That keeps it
 * trivially testable — a test wires two connections' `send`/`receive` together (or feeds crafted
 * lines) with no subprocess. `spawnAcpAgent()` binds it to a real child process.
 */
export class AcpConnection {
	private readonly send: (line: string) => void;
	private readonly onDiagnostic: (message: string) => void;
	private nextId = 1;
	private buf = "";
	private closed = false;
	private readonly pending = new Map<number, PendingResolver>();
	private notificationHandler: ((n: AcpNotification) => void) | undefined;
	private requestHandler: RequestHandler | undefined;

	constructor(opts: { send: (line: string) => void; onDiagnostic?: (message: string) => void }) {
		this.send = opts.send;
		this.onDiagnostic = opts.onDiagnostic ?? (() => {});
	}

	/** Register the sink for server→client notifications (`session/update`, `_x.ai/*`, …). */
	onNotification(handler: (n: AcpNotification) => void): void {
		this.notificationHandler = handler;
	}

	/** Register the handler for server→client requests (e.g. permission prompts). Its resolved
	 *  value is sent back as the JSON-RPC `result`; a thrown error becomes a JSON-RPC `error`.
	 *  Without a handler, such requests are answered with a "method not found" error so the agent
	 *  is never left waiting. */
	onRequest(handler: RequestHandler): void {
		this.requestHandler = handler;
	}

	/** Issue a client→server request and resolve with its `result` (rejects on a JSON-RPC error
	 *  or if the connection fails/closes first). */
	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (this.closed) return Promise.reject(new Error(`ACP connection closed; cannot send ${method}`));
		const id = this.nextId++;
		const frame: Record<string, unknown> = { jsonrpc: "2.0", id, method };
		if (params !== undefined) frame.params = params;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			try {
				this.write(frame);
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Send a client→server notification (fire-and-forget, no `id`, no response awaited). */
	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		const frame: Record<string, unknown> = { jsonrpc: "2.0", method };
		if (params !== undefined) frame.params = params;
		this.write(frame);
	}

	/** Feed raw stdout bytes from the agent. Buffers partial trailing lines across calls and
	 *  dispatches each complete ndjson line. Malformed lines are reported and skipped, never fatal. */
	receive(chunk: string): void {
		this.buf += chunk;
		let nl = this.buf.indexOf("\n");
		while (nl >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.dispatch(line);
			nl = this.buf.indexOf("\n");
		}
	}

	/** Reject every in-flight request and mark the connection closed. Called when the child exits
	 *  or errors so awaiting callers fail deterministically instead of hanging. Idempotent. */
	fail(err: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, p] of this.pending) p.reject(err);
		this.pending.clear();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private write(frame: Record<string, unknown>): void {
		this.send(`${JSON.stringify(frame)}\n`);
	}

	private dispatch(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			this.onDiagnostic(`ACP: dropping non-JSON line: ${line.slice(0, 200)}`);
			return;
		}
		if (!isObject(msg)) {
			this.onDiagnostic("ACP: dropping non-object message");
			return;
		}
		const hasId = msg.id !== undefined && msg.id !== null;
		const isResult = "result" in msg || "error" in msg;
		if (hasId && isResult) {
			this.handleResponse(msg);
		} else if (typeof msg.method === "string" && hasId) {
			this.handleIncomingRequest(msg.id as number | string, msg.method, msg.params);
		} else if (typeof msg.method === "string") {
			this.notificationHandler?.({ method: msg.method, params: msg.params });
		} else {
			this.onDiagnostic("ACP: dropping message with neither a routable method nor a known id");
		}
	}

	private handleResponse(msg: Record<string, unknown>): void {
		const id = msg.id as number;
		const pending = this.pending.get(id);
		if (!pending) {
			this.onDiagnostic(`ACP: response for unknown id ${JSON.stringify(id)} ignored`);
			return;
		}
		this.pending.delete(id);
		if ("error" in msg && msg.error !== undefined) {
			const e = msg.error;
			pending.reject(new AcpRpcError(isObject(e) ? { code: Number(e.code) || 0, message: String(e.message ?? "ACP error"), data: e.data } : { code: 0, message: String(e) }));
		} else {
			pending.resolve(msg.result);
		}
	}

	private handleIncomingRequest(id: number | string, method: string, params: unknown): void {
		const handler = this.requestHandler;
		if (!handler) {
			this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `no handler for server request: ${method}` } });
			return;
		}
		Promise.resolve()
			.then(() => handler({ id, method, params }))
			.then(
				(result) => this.write({ jsonrpc: "2.0", id, result: result ?? {} }),
				(err) => this.write({ jsonrpc: "2.0", id, error: { code: 0, message: err instanceof Error ? err.message : String(err) } }),
			);
	}
}

export interface SpawnAcpOptions {
	/** Executable to spawn (resolve via `resolveProviderBin` at the call site). */
	bin: string;
	/** Arguments — e.g. `["agent", "stdio"]` for grok. */
	args: string[];
	cwd: string;
	/** Child environment. Pass a minimal allowlist for isolation (#237); defaults to inherit. */
	env?: NodeJS.ProcessEnv;
	/** Abort the run (SIGTERM→SIGKILL) when this fires. */
	signal?: AbortSignal;
	/** Hard timeout in ms; on expiry the child is killed and `done` resolves with `timedOut`. */
	timeoutMs?: number;
	/** Diagnostic sink for dropped/odd frames (defaults to no-op). */
	onDiagnostic?: (message: string) => void;
}

export interface SpawnAcpResult {
	conn: AcpConnection;
	/** Resolves when the child exits (or is killed). `stderr` is the accumulated stderr text. */
	done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean; spawnError?: Error }>;
	/** Force-terminate the child (SIGTERM, then SIGKILL after a grace period). */
	kill: () => void;
}

/**
 * Spawn a stdio ACP agent and bind an {@link AcpConnection} to its stdin/stdout. Mirrors the
 * process lifecycle handling in `codex-provider.ts` (SIGTERM→SIGKILL on abort/timeout, stderr
 * capture, spawn-error surfacing) so the two subprocess providers behave consistently.
 */
export function spawnAcpAgent(opts: SpawnAcpOptions): SpawnAcpResult {
	const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
	const conn = new AcpConnection({
		send: (line) => {
			// Writing to a dead pipe throws EPIPE; swallow — `done`/`fail` already surface the exit.
			try {
				child.stdin.write(line);
			} catch {}
		},
		...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
	});

	let stderr = "";
	let timedOut = false;
	let spawnError: Error | undefined;
	let settled = false;

	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => conn.receive(chunk));
	child.stderr.setEncoding("utf-8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.on("error", (err) => {
		spawnError = err;
	});

	const killChild = (): void => {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!settled) child.kill("SIGKILL");
		}, 5_000).unref();
	};

	const timeout =
		opts.timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					killChild();
				}, opts.timeoutMs)
			: undefined;
	timeout?.unref();

	const onAbort = (): void => killChild();
	if (opts.signal) {
		if (opts.signal.aborted) onAbort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean; spawnError?: Error }>((resolve) => {
		child.on("error", (err) => {
			spawnError = err;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			conn.fail(err);
			resolve({ code: null, signal: null, stderr, timedOut, spawnError });
		});
		child.on("close", (code, signal) => {
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			conn.fail(new Error(`ACP agent exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
			resolve({ code, signal, stderr, timedOut, ...(spawnError ? { spawnError } : {}) });
		});
	});

	return { conn, done, kill: killChild };
}
