import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import type { Digest, TaskInput, WorkContract } from "./types.js";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function digestOf(value: string): Digest {
	return { algorithm: "sha256", value: sha256Hex(value) };
}

function titleFromBody(body: string): string {
	const line = body.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "untitled task";
	return line.trim().slice(0, 200);
}

export function canonicalizeWorkContractIdentity(input: { title: string; body: string; sourceKind: WorkContract["source"]["kind"] }): string {
	return JSON.stringify({ title: input.title, body: input.body, sourceKind: input.sourceKind });
}

export function buildWorkContract(task: TaskInput, opts: { now?: string; readStdin?: () => string } = {}): WorkContract {
	let body: string;
	let source: WorkContract["source"];
	if ("text" in task) {
		body = task.text;
		source = { kind: "text" };
	} else if ("file" in task) {
		body = readFileSync(task.file, "utf8");
		source = { kind: "file", uri: task.file };
	} else {
		body = (opts.readStdin ?? (() => readFileSync(0, "utf8")))();
		source = { kind: "stdin" };
	}
	const title = titleFromBody(body);
	const createdAt = opts.now ?? new Date().toISOString();
	return {
		schemaVersion: 1,
		workContractId: ulid(),
		title,
		body,
		source,
		digest: digestOf(canonicalizeWorkContractIdentity({ title, body, sourceKind: source.kind })),
		createdAt,
	};
}
