/**
 * Out-of-process evidence signer (#511, Design A — isolated signing oracle).
 *
 * The harness must NEVER hold the Ed25519 private key. Workers run same-UID with
 * an allow-all shell and no OS isolation, so a prompt-injected step can walk /proc
 * to a harness ancestor's `environ` and steal any key kept there — forging the very
 * evidence this item makes unforgeable. Env-scrubbing the *child* copy does not help:
 * the attacker reads the HARNESS process's own `environ`.
 *
 * The fix: the private key lives ONLY in a SEPARATE-UID signer process, reachable
 * over a unix domain socket. That separate UID is what stops a same-UID socket peer
 * from ptracing/reading the signer's memory or env — operator/daemon responsibility
 * (see docs/server.md). The signer signs ONLY a canonical, domain-bound evidence
 * payload it reconstructs itself via `buildReviewEvidencePayload`, so a caller can
 * never get arbitrary bytes signed. Socket reachability is not sufficient: every
 * request must present a shared authenticator. The harness loads that token from a
 * 0400 file into memory and unlinks the file, so the value is never in harness
 * `environ` (a token kept there would be the same /proc theft as the private key).
 * Verification stays in-harness (public key, not secret). Dependency-free:
 * `node:net` + `node:crypto` + the pure protocol module.
 *
 * Wire protocol (one connection = one request line + one response line, each a
 * single UTF-8 JSON object terminated by `\n`):
 *   request : {"v":1,"auth":"<token>","identity":{repository,prNumber,itemId,
 *               reviewedSha,fleetRecordSha256,adjudicationSourceSha256}}
 *   response: {"v":1,"ok":true,"signature":"<base64url>"}   // 64-byte Ed25519 sig
 *           | {"v":1,"ok":false,"error":"<reason>"}         // fail-closed
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { buildReviewEvidencePayload, REVIEW_EVIDENCE_SIGNER_SOCKET_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV, type ReviewEvidenceIdentity, signReviewEvidence } from "./gate-attestation.js";

export { REVIEW_EVIDENCE_SIGNER_SOCKET_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV };

/** Wire protocol version. Bump only if the request/response shape changes. */
export const SIGNER_PROTOCOL_VERSION = 1;

/** A canonical identity is a few hundred bytes; refuse anything pathologically large. */
const MAX_REQUEST_BYTES = 8192;

/** Default client wait before treating the signer as unavailable (→ fail-closed adjudication). */
const DEFAULT_CLIENT_TIMEOUT_MS = 5000;

/** Short tokens are guessable; `openssl rand -hex 32` is the documented generator. */
export const MIN_SIGNER_AUTH_TOKEN_LENGTH = 32;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface SignerRequest {
	v: number;
	auth: string;
	identity: ReviewEvidenceIdentity;
}

export type SignerResponse = { v: number; ok: true; signature: string } | { v: number; ok: false; error: string };

/** Refuse a token that is too short to be an authenticator. Used by the CLI and the server. */
export function requireSignerAuthToken(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length < MIN_SIGNER_AUTH_TOKEN_LENGTH) {
		throw new Error(`signer auth token must be at least ${MIN_SIGNER_AUTH_TOKEN_LENGTH} characters`);
	}
	return trimmed;
}

function authTokensEqual(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

/** One handled request → the JSON response line (no trailing newline) plus an `ok` flag
 *  for diagnostics. Never throws: a malformed request, a missing/wrong authenticator, a
 *  non-canonical identity, or a signing error all become a fail-closed `{ ok:false }`.
 *  Auth is checked before the identity is inspected. The identity is then re-validated
 *  and re-canonicalized (`buildReviewEvidencePayload` binds the domain and rejects extra
 *  keys / malformed hex), so the oracle only ever signs a canonical evidence payload
 *  for an authenticated caller. */
export function handleSignerRequestLine(line: string, privateKeyPem: string, authToken: string): { line: string; ok: boolean } {
	const fail = (error: string): { line: string; ok: boolean } => ({ line: JSON.stringify({ v: SIGNER_PROTOCOL_VERSION, ok: false, error } satisfies SignerResponse), ok: false });
	let req: unknown;
	try {
		req = JSON.parse(line);
	} catch {
		return fail("malformed request json");
	}
	if (typeof req !== "object" || req === null || (req as { v?: unknown }).v !== SIGNER_PROTOCOL_VERSION) {
		return fail("unsupported protocol version");
	}
	const provided = (req as { auth?: unknown }).auth;
	if (typeof provided !== "string" || !authTokensEqual(provided, authToken)) {
		// Same diagnostic for missing, wrong, or non-string — do not leak which.
		return fail("unauthorized");
	}
	let payload: string;
	try {
		// Reconstruct + validate server-side: a caller cannot substitute arbitrary bytes or a
		// foreign domain — the payload is always the canonical, domain-bound evidence string.
		payload = buildReviewEvidencePayload((req as { identity?: unknown }).identity as ReviewEvidenceIdentity);
	} catch (e) {
		return fail(`non-canonical evidence identity: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		const signature = signReviewEvidence(payload, privateKeyPem);
		return { line: JSON.stringify({ v: SIGNER_PROTOCOL_VERSION, ok: true, signature } satisfies SignerResponse), ok: true };
	} catch (e) {
		return fail(`signing failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export interface EvidenceSignerHandle {
	socketPath: string;
	server: Server;
	close(): Promise<void>;
}

/**
 * Start the signing oracle on a unix domain socket. The `privateKeyPem` and
 * `authToken` are held only in this process's memory — run it as a SEPARATE UID
 * from the harness/workers so no same-UID peer can read them. `onDiagnostic`
 * never receives the key, the token, or the signature.
 */
export function serveEvidenceSigner(opts: { socketPath: string; privateKeyPem: string; authToken: string; onDiagnostic?: (msg: string) => void }): Promise<EvidenceSignerHandle> {
	const authToken = requireSignerAuthToken(opts.authToken);
	const server = createServer((socket) => {
		let buf = "";
		let done = false;
		socket.setEncoding("utf8");
		const respond = (line: string): void => {
			if (done) return;
			done = true;
			socket.end(`${line}\n`);
		};
		socket.on("data", (chunk: string) => {
			if (done) return;
			buf += chunk;
			if (buf.length > MAX_REQUEST_BYTES) {
				respond(JSON.stringify({ v: SIGNER_PROTOCOL_VERSION, ok: false, error: "request too large" } satisfies SignerResponse));
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const outcome = handleSignerRequestLine(buf.slice(0, nl), opts.privateKeyPem, authToken);
			opts.onDiagnostic?.(outcome.ok ? "signed a canonical evidence payload" : "refused a request (fail-closed)");
			respond(outcome.line);
		});
		// A peer reset mid-exchange is not the signer's problem; never crash the server.
		socket.on("error", () => {});
	});
	return new Promise((resolve, reject) => {
		const onError = (err: Error): void => reject(err);
		server.once("error", onError);
		server.listen(opts.socketPath, () => {
			server.removeListener("error", onError);
			resolve({
				socketPath: opts.socketPath,
				server,
				close: () => new Promise<void>((res) => server.close(() => res())),
			});
		});
	});
}

/** Read the configured signer socket path (trimmed; blank ⇒ absent). */
export function resolveReviewEvidenceSignerSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[REVIEW_EVIDENCE_SIGNER_SOCKET_ENV];
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	return trimmed !== "" ? trimmed : undefined;
}

/**
 * Load a harness request token from `filePath`: refuse group/other access, require
 * the documented minimum length, then unlink the file. Unlink is load-bearing —
 * leaving a same-UID-readable copy would let a worker steal the authenticator
 * the way `/proc/.../environ` would steal a harness env value. Once a token file
 * is explicitly configured, every validation/load/unlink failure throws so harness
 * initialization aborts before any same-UID worker can inspect the leftover file.
 */
export function loadHarnessSignerAuthToken(filePath: string): string {
	const abs = resolve(filePath);
	let mode: number;
	try {
		mode = statSync(abs).mode;
	} catch (e) {
		throw new Error(`could not stat configured review-evidence signer token file ${abs}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if ((mode & 0o077) !== 0) throw new Error(`configured review-evidence signer token file ${abs} must not grant group or other access`);
	let raw: string;
	try {
		raw = readFileSync(abs, "utf8");
	} catch (e) {
		throw new Error(`could not read configured review-evidence signer token file ${abs}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const token = raw.trim();
	if (token.length < MIN_SIGNER_AUTH_TOKEN_LENGTH) {
		throw new Error(`configured review-evidence signer token file ${abs} must contain at least ${MIN_SIGNER_AUTH_TOKEN_LENGTH} characters`);
	}
	try {
		unlinkSync(abs);
	} catch (e) {
		throw new Error(`could not unlink configured review-evidence signer token file ${abs}: ${e instanceof Error ? e.message : String(e)}`);
	}
	return token;
}

let processEnvTokenLoaded = false;
let processEnvToken: string | undefined;

/**
 * Resolve the harness request token from `PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN_FILE`.
 * Never reads `PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN` — that env name is signer-only;
 * a value in harness `environ` would recreate the /proc theft this item closes.
 * Results from `process.env` are cached so a later sign in the same process still
 * works after the one-shot file is unlinked.
 */
export function resolveReviewEvidenceSignerAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromProcessEnv = env === process.env;
	if (fromProcessEnv && processEnvTokenLoaded) return processEnvToken;
	const raw = env[REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV];
	const path = typeof raw === "string" ? raw.trim() : "";
	const token = path === "" ? undefined : loadHarnessSignerAuthToken(path);
	if (fromProcessEnv) {
		processEnvTokenLoaded = true;
		processEnvToken = token;
	}
	return token;
}

/** Test seam: drop the process-env token cache. */
export function resetReviewEvidenceSignerAuthTokenCacheForTests(): void {
	processEnvTokenLoaded = false;
	processEnvToken = undefined;
}

function parseSignerResponse(line: string): string | undefined {
	let res: unknown;
	try {
		res = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof res !== "object" || res === null) return undefined;
	const r = res as { ok?: unknown; signature?: unknown };
	if (r.ok !== true || typeof r.signature !== "string" || !B64URL_RE.test(r.signature)) return undefined;
	try {
		if (Buffer.from(r.signature, "base64url").length !== 64) return undefined;
	} catch {
		return undefined;
	}
	return r.signature;
}

/**
 * Client seam: ask the signer to sign `identity` and return the base64url signature,
 * or `undefined` when the signer is UNAVAILABLE (socket absent, refused, malformed,
 * unauthenticated, or slow). The harness holds no private key, so an unavailable
 * signer degrades to no signed evidence — `pr-adjudicate`'s fail-closed path then
 * refuses (manual operator adjudication). Never falls back to in-harness signing.
 * A missing `authToken` does not connect (no unauthenticated attempt).
 */
export function signReviewEvidenceViaSigner(identity: ReviewEvidenceIdentity, socketPath: string, opts: { timeoutMs?: number; authToken?: string } = {}): Promise<string | undefined> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
	const authToken = typeof opts.authToken === "string" ? opts.authToken.trim() : "";
	if (authToken.length < MIN_SIGNER_AUTH_TOKEN_LENGTH) return Promise.resolve(undefined);
	return new Promise((resolvePromise) => {
		let settled = false;
		let buf = "";
		const socket = createConnection(socketPath);
		socket.setEncoding("utf8");
		const finish = (sig: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolvePromise(sig);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		timer.unref?.();
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ v: SIGNER_PROTOCOL_VERSION, auth: authToken, identity } satisfies SignerRequest)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_REQUEST_BYTES) {
				finish(undefined);
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			finish(parseSignerResponse(buf.slice(0, nl)));
		});
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}
