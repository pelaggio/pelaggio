#!/usr/bin/env tsx
/**
 * `pelaggio evidence-signer --socket <path> [--key-file <path>]`
 *
 * The out-of-process Ed25519 signing oracle for harness-attested review evidence
 * (#511, Design A). Loads the private key from its OWN environment
 * (`PELAGGIO_REVIEW_EVIDENCE_PRIVATE_KEY`) or a `--key-file` (mode 0400/0600),
 * and the request token from `--token-file` or `PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN`.
 * Listens on a unix domain socket and returns a detached signature over the
 * canonical, domain-bound evidence payload it reconstructs itself, only for a
 * caller that presents the token.
 *
 * Deploy it as a SEPARATE UID from the harness/workers (operator/daemon
 * responsibility). That separate UID — not env hiding — is what stops a same-UID
 * prompt-injected worker from ptracing this process or reading its `environ` to
 * steal the key or token. The harness never holds the key; it only knows the
 * socket path and a one-shot token file. See docs/server.md for keypair
 * generation, the systemd unit, and pubkey publish.
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requireSignerAuthToken, serveEvidenceSigner } from "./review/evidence-signer.js";
import { REVIEW_EVIDENCE_PRIVATE_KEY_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_ENV, resolveReviewEvidencePrivateKey } from "./review/gate-attestation.js";

const HELP = `
pelaggio evidence-signer --socket <path> [--key-file <path>] [--token-file <path>]

Run the out-of-process review-evidence signing oracle (#511). Deploy as a SEPARATE
UID from the harness/workers so no same-UID peer can read its key or token.

Options:
  --socket <path>     Unix domain socket to listen on (required).
  --key-file <path>   PKCS#8 Ed25519 private-key PEM, mode 0400/0600 (no group/other
                      access). Defaults to the ${REVIEW_EVIDENCE_PRIVATE_KEY_ENV} env.
  --token-file <path> Request authenticator, mode 0400/0600 (no group/other access).
                      Defaults to the ${REVIEW_EVIDENCE_SIGNER_TOKEN_ENV} env.
  -h, --help          Show this help.

Signals: SIGINT/SIGTERM close the socket and unlink the socket file.
`.trim();

/** Load a 0400/0600 secret file (key or token). The signer keeps the file — unlike
 *  the harness token path, this process is a different UID and may restart. */
function loadRestrictedSecretFile(filePath: string, flag: string): { text: string } | { error: string } {
	const abs = resolve(filePath);
	let mode: number;
	try {
		mode = statSync(abs).mode;
	} catch (e) {
		return { error: `cannot stat ${flag} ${abs}: ${e instanceof Error ? e.message : String(e)}` };
	}
	// Refuse a group/other-accessible secret: 0400 or 0600 only (0077 mask must be clear).
	if ((mode & 0o077) !== 0) {
		return { error: `${flag} ${abs} is group/other-accessible (mode ${(mode & 0o777).toString(8)}); chmod 0400 it` };
	}
	let text: string;
	try {
		text = readFileSync(abs, "utf8");
	} catch (e) {
		return { error: `cannot read ${flag} ${abs}: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (text.trim() === "") return { error: `${flag} ${abs} is empty` };
	return { text };
}

/** Load the signing key: --key-file (perms-checked) wins over the env. Returns the PEM,
 *  or an error string the caller prints to stderr before exiting non-zero. */
export function loadSignerKey(keyFile: string | undefined, env: NodeJS.ProcessEnv = process.env): { pem: string } | { error: string } {
	if (keyFile) {
		const loaded = loadRestrictedSecretFile(keyFile, "--key-file");
		if ("error" in loaded) return loaded;
		return { pem: loaded.text };
	}
	const pem = resolveReviewEvidencePrivateKey(env);
	if (!pem) return { error: `no signing key: set ${REVIEW_EVIDENCE_PRIVATE_KEY_ENV} or pass --key-file` };
	return { pem };
}

/** Load the request token: --token-file (perms-checked) wins over the signer-only env. */
export function loadSignerToken(tokenFile: string | undefined, env: NodeJS.ProcessEnv = process.env): { token: string } | { error: string } {
	if (tokenFile) {
		const loaded = loadRestrictedSecretFile(tokenFile, "--token-file");
		if ("error" in loaded) return loaded;
		try {
			return { token: requireSignerAuthToken(loaded.text) };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	}
	const raw = env[REVIEW_EVIDENCE_SIGNER_TOKEN_ENV];
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (trimmed === "") return { error: `no request token: set ${REVIEW_EVIDENCE_SIGNER_TOKEN_ENV} or pass --token-file` };
	try {
		return { token: requireSignerAuthToken(trimmed) };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

export async function evidenceSignerMain(argv: string[]): Promise<number> {
	let values: { socket?: string; "key-file"?: string; "token-file"?: string; help?: boolean };
	try {
		({ values } = parseArgs({ args: argv, options: { socket: { type: "string" }, "key-file": { type: "string" }, "token-file": { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: false }));
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${HELP}\n`);
		return 2;
	}
	if (values.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const socketPath = values.socket;
	if (!socketPath || socketPath.trim() === "") {
		process.stderr.write(`usage: pelaggio evidence-signer --socket <path> [--key-file <path>] [--token-file <path>]\n`);
		return 2;
	}
	const key = loadSignerKey(values["key-file"]);
	if ("error" in key) {
		process.stderr.write(`evidence-signer: ${key.error}\n`);
		return 2;
	}
	const token = loadSignerToken(values["token-file"]);
	if ("error" in token) {
		process.stderr.write(`evidence-signer: ${token.error}\n`);
		return 2;
	}
	// Fail fast if the key is not a usable Ed25519 private key, rather than binding the
	// socket and refusing every request at runtime.
	try {
		createPrivateKey(key.pem);
	} catch (e) {
		process.stderr.write(`evidence-signer: signing key is not a valid PEM private key: ${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}

	const absSocket = resolve(socketPath);
	let handle: Awaited<ReturnType<typeof serveEvidenceSigner>>;
	try {
		handle = await serveEvidenceSigner({ socketPath: absSocket, privateKeyPem: key.pem, authToken: token.token, onDiagnostic: (m) => process.stderr.write(`evidence-signer: ${m}\n`) });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const hint = /EADDRINUSE/.test(msg) ? ` (stale socket? remove ${absSocket} or add \`ExecStartPre=/bin/rm -f ${absSocket}\`)` : "";
		process.stderr.write(`evidence-signer: could not listen on ${absSocket}: ${msg}${hint}\n`);
		return 1;
	}
	process.stderr.write(`evidence-signer: listening on ${absSocket}\n`);

	const shutdown = (): void => {
		void handle.close().finally(() => {
			try {
				unlinkSync(absSocket);
			} catch {}
			process.exit(0);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Run until signalled.
	return await new Promise<number>(() => {});
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	evidenceSignerMain(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((e) => {
			process.stderr.write(`evidence-signer: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(1);
		});
}
