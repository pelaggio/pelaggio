import { formatPatch, parsePatch } from "diff";

import type { ReviewIntensityProfile } from "./types.js";

const FULL_DOCUMENTS = /^(?:docs\/(?:agent-context|decisions|decision-log|assurance|trust|plans|archived)\/|docs\/(?:pr-review|decisions)\.md$)/;
function ordinaryDocument(path: string): boolean {
	return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/.test(path) && (path.startsWith("docs/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md"].includes(path)) && !/(?:^|\/)(?:AGENTS|SKILL)\.md$/i.test(path) && !FULL_DOCUMENTS.test(path);
}

/** Seat selection only. Unknown paths or patch bytes keep the full configured panel. */
export function classifyReviewIntensity(files: readonly string[], diff: string): ReviewIntensityProfile {
	if (files.length === 0 || new Set(files).size !== files.length || !files.every(ordinaryDocument)) return "full";
	try {
		const patches = parsePatch(diff);
		if (patches.length !== files.length) return "full";
		const paths = new Set<string>();
		for (const patch of patches) {
			const path = patch.oldFileName?.slice(2);
			if (!path || patch.oldFileName !== `a/${path}` || patch.newFileName !== `b/${path}` || !files.includes(path) || paths.has(path)) return "full";
			paths.add(path);
			if (!patch.isGit || patch.isBinary || patch.isRename || patch.isCopy || patch.isCreate || patch.isDelete || patch.oldMode !== undefined || patch.newMode !== undefined || patch.hunks.length === 0) return "full";
			if (patch.oldHeader !== "" || patch.newHeader !== "") return "full";
			// Formatting preserves annotations too. Admit only Git's EOF marker and
			// require that each side actually ends there, across all hunks.
			let oldEnded = false;
			let newEnded = false;
			let oldEnd = 1;
			let newEnd = 1;
			for (const hunk of patch.hunks) {
				if (hunk.oldStart < oldEnd || hunk.newStart < newEnd || hunk.oldStart - oldEnd !== hunk.newStart - newEnd) return "full";
				if ((oldEnded || newEnded) && hunk.oldStart !== oldEnd) return "full";
				if (!hunk.lines.some((line) => line.startsWith("+") || line.startsWith("-"))) return "full";
				oldEnd = hunk.oldStart + hunk.oldLines;
				newEnd = hunk.newStart + hunk.newLines;
				for (const [index, line] of hunk.lines.entries()) {
					if (line === "\\ No newline at end of file") {
						const previous = hunk.lines[index - 1]?.[0];
						if (previous !== " " && previous !== "+" && previous !== "-") return "full";
						oldEnded ||= previous !== "+";
						newEnded ||= previous !== "-";
					} else {
						const operation = line[0];
						if (operation !== " " && operation !== "+" && operation !== "-") return "full";
						if ((operation !== "+" && oldEnded) || (operation !== "-" && newEnded)) return "full";
					}
				}
			}
		}
		// jsdiff tolerates unknown metadata. Require roundtrip byte coverage rather than
		// treating ignored bytes as harmless. Only Git checksum and hunk spelling vary.
		let indexes = 0;
		const normalized = diff
			.replace(/^(diff --git [^\n]+\n)index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64} 100644\n/gm, (_match, header: string) => {
				indexes++;
				return header;
			})
			.replace(
				/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*$/gm,
				(_match, oldStart: string, oldCount: string | undefined, newStart: string, newCount: string | undefined) => `@@ -${oldStart},${oldCount ?? "1"} +${newStart},${newCount ?? "1"} @@`,
			);
		if (indexes !== patches.length || normalized !== patches.map((patch) => formatPatch(patch)).join("")) return "full";
		return "docs";
	} catch {
		return "full";
	}
}
