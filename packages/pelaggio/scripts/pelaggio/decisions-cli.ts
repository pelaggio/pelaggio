import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./config.js";
import { archiveResolvedDecisions, resolveDecision } from "./decisions.js";

export async function decisionsCliMain(args = process.argv.slice(2), repo = REPO, now = new Date()): Promise<number> {
	const [command, ...rest] = args;
	if (command === "resolve") {
		const id = rest[0];
		if (!id) throw new Error("usage: pelaggio decisions resolve <row-id> [--adr ADR-nnnn]");
		const adrAt = rest.indexOf("--adr");
		if (rest.length > 1 && adrAt < 0) throw new Error("unknown resolve arguments");
		const adr = adrAt >= 0 ? rest[adrAt + 1] : undefined;
		if (adrAt >= 0 && !adr) throw new Error("--adr requires an ADR-nnnn value");
		await resolveDecision(repo, id, { ...(adr ? { adr } : {}), now });
		console.log(`Resolved decision ${id}`);
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
