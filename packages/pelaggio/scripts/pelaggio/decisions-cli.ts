import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./config.js";
import { archiveResolvedDecisions, resolveDecision } from "./decisions.js";

export async function decisionsCliMain(args = process.argv.slice(2), repo = REPO, now = new Date()): Promise<number> {
	const [command, ...rest] = args;
	if (command === "resolve") {
		const id = rest[0];
		if (!id) throw new Error("usage: pelaggio decisions resolve <row-id> [--disposition proceed|block --by <actor> --reason <text>] [--adr ADR-nnnn]");
		const values = new Map<string, string>();
		for (let index = 1; index < rest.length; index += 2) {
			const flag = rest[index];
			const value = rest[index + 1];
			if (!["--adr", "--disposition", "--by", "--reason"].includes(flag) || values.has(flag) || !value?.trim()) throw new Error("invalid, duplicate, or incomplete resolve arguments");
			values.set(flag, value);
		}
		const disposition = values.get("--disposition");
		if (disposition !== undefined && disposition !== "proceed" && disposition !== "block") throw new Error("--disposition must be proceed or block");
		await resolveDecision(repo, id, {
			...(values.get("--adr") ? { adr: values.get("--adr") } : {}),
			...(disposition ? { disposition } : {}),
			...(values.get("--by") ? { actor: values.get("--by") } : {}),
			...(values.get("--reason") ? { rationale: values.get("--reason") } : {}),
			now,
		});
		console.log(`Resolved decision ${id}${disposition ? `: ${disposition}` : ""}`);
		return 0;
	}
	if (command === "archive-resolved") {
		if (rest[0] !== "--older-than" || !/^\d+d$/.test(rest[1] ?? "")) throw new Error("usage: pelaggio decisions archive-resolved --older-than <days>d");
		const days = Number.parseInt(rest[1], 10);
		if (days <= 0) throw new Error("--older-than must be a positive day duration");
		const count = await archiveResolvedDecisions(repo, new Date(now.getTime() - days * 86_400_000));
		console.log(`Archived ${count} resolved decision${count === 1 ? "" : "s"}`);
		return 0;
	}
	throw new Error("usage: pelaggio decisions <resolve|archive-resolved>");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	decisionsCliMain().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
