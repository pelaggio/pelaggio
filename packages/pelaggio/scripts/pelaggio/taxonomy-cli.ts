#!/usr/bin/env tsx

/**
 * `pelaggio taxonomy <verify|sign|canonical>` — the operator ritual for the ADR-0016 safety/judgment
 * taxonomy (#294). Pure sign/verify helpers live in `review/taxonomy.ts`; this CLI is a thin shell so the
 * owner can produce a contraction signature without hand-rolling crypto.
 *
 * The signed gate closes the *config-only* shrink: an agent may enlarge the safety floor via
 * `.pelaggio.yml` without a signature, but shrinking it (or seating a new class as judgment) requires a
 * verified Ed25519 signature over the canonical contraction payload against the operator's owner key,
 * supplied out-of-band via the `PELAGGIO_TAXONOMY_PUBKEY` env var (never repo source, so it is outside
 * the agent's write surface).
 *
 *   verify    [--config path]                    loadConfig (verifies against the PELAGGIO_TAXONOMY_PUBKEY key);
 *                                                print the tier table + "ok", or exit 1 on failure.
 *   sign      --private-key <pem> [--config path]  sign the canonical contraction payload; print the
 *                                                signature-b64 to paste into `review.taxonomy.contract`.
 *   canonical [--config path]                    print the exact signed bytes (debug / audit).
 *
 * The private key is only ever an argument to `sign` on a human machine; the pipeline never calls it.
 * Exit codes: 0 ok, 1 failure, 2 usage.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, readTaxonomyOverlay } from "./config.js";
import { canonicalizeContractionPayload, contractionSet, mergeTaxonomyClasses, signContractionPayload } from "./review/taxonomy.js";

function parseConfigFlag(args: string[]): { configPath?: string; rest: string[] } {
	const rest: string[] = [];
	let configPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config") {
			const next = args[i + 1];
			if (!next) throw new Error("--config requires a path");
			configPath = next;
			i++;
		} else {
			rest.push(args[i]);
		}
	}
	return { configPath, rest };
}

export function taxonomyCliMain(argv = process.argv.slice(2)): number {
	const [command, ...rawRest] = argv;
	const { configPath, rest } = parseConfigFlag(rawRest);
	const configOpts = configPath ? { configPath } : {};

	if (command === "verify") {
		const taxonomy = loadConfig(configOpts).review.taxonomy;
		console.log(`owner: ${taxonomy.owner}`);
		console.log(`judgment-default: ${taxonomy.judgmentDefault}`);
		for (const [id, tier] of [...taxonomy.classes].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${id}: ${tier}`);
		console.log(taxonomy.contract ? "ok (signed contraction verified)" : "ok");
		return 0;
	}

	if (command === "canonical") {
		const classes = mergeTaxonomyClasses(readTaxonomyOverlay(configOpts));
		console.log(canonicalizeContractionPayload(classes));
		return 0;
	}

	if (command === "sign") {
		let privateKeyPath: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "--private-key") {
				privateKeyPath = rest[i + 1];
				i++;
			}
		}
		if (!privateKeyPath) throw new Error("usage: pelaggio taxonomy sign --private-key <pem-path> [--config path]");
		const classes = mergeTaxonomyClasses(readTaxonomyOverlay(configOpts));
		if (contractionSet(classes).length === 0) {
			console.log("This config does not contract the safety floor — no signature needed.");
			return 0;
		}
		const payload = canonicalizeContractionPayload(classes);
		const signatureB64 = signContractionPayload(payload, readFileSync(privateKeyPath, "utf-8"));
		console.log("Paste this under `review.taxonomy.contract` in .pelaggio.yml:");
		console.log(`  signature-b64: "${signatureB64}"`);
		return 0;
	}

	throw new Error("usage: pelaggio taxonomy <verify|sign|canonical> [--config path]");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	try {
		process.exitCode = taxonomyCliMain();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = error instanceof Error && /^usage:/.test(error.message) ? 2 : 1;
	}
}
