import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SeatCorpus } from "../doc-review-corpus.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const corpus = JSON.parse(readFileSync(join(repo, "ci", "doc-review-seat-corpus.json"), "utf8")) as SeatCorpus;

describe("doc-review seat corpus fixture", () => {
	it("is internally consistent and fingerprinted", () => {
		assert.match(corpus.fingerprint, /^\d+:[0-9a-f]{12}$/, "fingerprint is <recordCount>:<sha256 prefix>");
		assert.equal(corpus.seats.length, corpus.seatCount, "seatCount must match the array it counts");
		assert.equal(Number(corpus.fingerprint.split(":")[0]), corpus.recordCount, "fingerprint record count must match recordCount");
		assert.ok(corpus.recordCount > 0 && corpus.seatCount > 0);
	});

	/**
	 * The fixture exists so an item can classify seat readability inside a claim worktree, where
	 * `.dev/` is absent (#677 blocked on exactly that; #685 is the general fix). If a future scoping
	 * pass drops one of these fields the fixture silently stops answering the question it was cut for,
	 * so the classification surface is pinned rather than left to the exporter's discretion.
	 */
	it("carries the fields a readability classification needs", () => {
		for (const seat of corpus.seats) {
			assert.ok(seat.runId, "every seat names its run");
			assert.ok(seat.role === "reviewer" || seat.role === "judge", `unexpected role: ${seat.role}`);
			assert.equal(typeof seat.readable, "boolean", "readability is the harness verdict, never inferred from absence");
		}
		const unreadable = corpus.seats.filter((s) => !s.readable);
		assert.ok(unreadable.length > 0, "a corpus with no unreadable seat cannot exercise the question it was cut for");
		assert.ok(
			unreadable.every((s) => typeof s.diagnostic === "string" && s.diagnostic.length > 0),
			"an unreadable seat without a diagnostic is unclassifiable — the export dropped the discriminator",
		);
	});

	/** Scope guard: seat OUTCOMES only. Document identity and model text must not leak in. */
	it("stays scoped to seat outcomes", () => {
		const forbidden = ["document", "assistantText", "fullText", "digest", "byteLength", "path"];
		for (const seat of corpus.seats as unknown as Record<string, unknown>[]) {
			for (const key of forbidden) assert.ok(!(key in seat), `seat carries out-of-scope field '${key}'`);
		}
		assert.ok(!("document" in (corpus as unknown as Record<string, unknown>)), "corpus must not carry document identity");
	});
});
