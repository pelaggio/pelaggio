import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

interface BrokenLink {
	file: string;
	line: number;
	target: string;
}

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function findMarkdownFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.filter((entry): entry is string => typeof entry === "string" && extname(entry) === ".md")
		.map((entry) => resolve(dir, entry));
}

export function checkFile(file: string, root = repoRoot()): BrokenLink[] {
	const broken: BrokenLink[] = [];
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, index) => {
		for (const match of line.matchAll(LINK)) {
			const target = match[1].trim();
			if (target === "" || EXTERNAL.test(target)) continue;
			const path = target.split("#")[0];
			// A leading slash means repo-root-relative (GitHub's Markdown convention), not filesystem-absolute.
			const resolved = path.startsWith("/") ? resolve(root, path.slice(1)) : resolve(dirname(file), path);
			if (!existsSync(resolved)) {
				broken.push({ file, line: index + 1, target });
			}
		}
	});
	return broken;
}

export function runLinkGate(dir = resolve(repoRoot(), "docs/trust")): number {
	const root = repoRoot();
	const broken = findMarkdownFiles(dir)
		.sort()
		.flatMap((file) => checkFile(file, root));

	console.log(`\n  Pelaggio markdown link gate\n  ${"-".repeat(70)}`);
	if (broken.length === 0) {
		console.log(`  all internal links resolve\n  ${"-".repeat(70)}\n  0 broken links\n`);
		return 0;
	}
	for (const link of broken) {
		console.log(`  ${resolve(link.file).slice(root.length + 1)}:${link.line}  dead link -> ${link.target}`);
	}
	console.log(`  ${"-".repeat(70)}\n  ${broken.length} broken link${broken.length === 1 ? "" : "s"}\n`);
	return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = runLinkGate();
}
