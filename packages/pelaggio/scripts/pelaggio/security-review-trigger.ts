/**
 * Deterministic red-team seat selector (L2 domain policy). Pure — no fs, git, or crypto.
 *
 * Decides whether a PR diff is security-sensitive enough to spend a second review
 * session. This is additive seat selection, never content-based gate tiering: the
 * extra label is omitted or convened; findings and verdicts are judged elsewhere.
 *
 * Two evidence classes only: a change to a module that holds a named security
 * guarantee, or a structured guard-config delta (including self-modification of
 * this selector). There is no free-text keyword scan.
 */

export interface SecurityDiffSignal {
	triggered: boolean;
	reasons: string[];
}

export const SECURITY_REASON_LIMIT = 8;

const TRIGGER_MODULE = "packages/pelaggio/scripts/pelaggio/security-review-trigger.ts";
const TRIGGER_TEST = "packages/pelaggio/scripts/pelaggio/__tests__/security-review-trigger.test.ts";
const TRIGGER_OWNED_PATHS = new Set([TRIGGER_MODULE, TRIGGER_TEST]);
const SELF_TRIGGER_REASON = "guard:security-review-trigger";

/** The charter's guarantee-holding paths; this selector changes seats, never verdicts. */
const SECURITY_PATHS: readonly RegExp[] = [
	/^ci\/__tests__\/shadow-assurance\.test\.ts$/,
	/^ci\/assurance-observations\.ts$/,
	/^\.github\/workflows\//,
	/^infra\//,
	/^lefthook\.yml$/,
	/^ci\/guards-staged\.sh$/,
	/^packages\/server\/src\/(?:auth|app|config)\.ts$/,
	/^packages\/server\/scripts\//,
	/^packages\/pelaggio\/scripts\/pelaggio\/confinement\//,
	/^packages\/pelaggio\/scripts\/pelaggio\/providers\/claude\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/(?:registers|pr-review-gate)\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/review\/findings\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/ship\//,
	/^packages\/pelaggio\/scripts\/pelaggio\/__tests__\/module-layering\.test\.ts$/,
	/^\.claude\/skills\/(?:pr-review|pr-verify|ship|implement)\/SKILL\.md$/,
];

/**
 * Guard config whose *entries* the review must see changed, not merely touched — the layer table
 * (what may import what) and the register table (what seats may write). A loosening is a
 * 3-line diff in a 100-line table; rendering it as `guard:layer text.ts L0→L4` makes it salient
 * to reviewers and to the red-team pass. Under autonomous cycles the harness's author is the
 * guarded party (CON-0027 applied to construction), so review — not a fence — owns these files;
 * this is what makes that review honest. Keys and values are matched by closed regexes, so no
 * free diff text reaches a prompt.
 */
const GUARD_CONFIG: readonly { label: string; path: RegExp; entry: RegExp; value: (m: RegExpMatchArray) => string }[] = [
	{
		label: "layer",
		path: /^packages\/pelaggio\/scripts\/pelaggio\/__tests__\/module-layering\.test\.ts$/,
		entry: /^"([\w./-]+\.ts)":\s*([0-5]),?\s*(?:\/\/.*)?$/,
		value: (m) => `L${m[2]}`,
	},
	{
		label: "register",
		path: /^packages\/pelaggio\/scripts\/pelaggio\/registers\.ts$/,
		entry: /^\{\s*name:\s*"([\w.-]+)",\s*kind:\s*"(harness|agent|seat-tree)"(?:,\s*shape:\s*"([\w-]+)")?(?:,\s*agentReads:\s*(true|false))?\s*\},?/,
		// kind/shape[+agentReads]: shape matters too — dir→file narrows a write denial from a tree to one path.
		value: (m) => `${m[2]}${m[3] ? `/${m[3]}` : ""}${m[4] === "true" ? "+agentReads" : ""}`,
	},
];

/** `guard:<label> <key> <before>→<after>` / `added <after>` / `removed` for every changed guard-config entry. */
export function guardConfigDelta(diff: string): string[] {
	const out: string[] = [];
	let spec: (typeof GUARD_CONFIG)[number] | undefined;
	let inHunk = false;
	let removed = new Map<string, string>();
	let added = new Map<string, string>();
	const flush = (): void => {
		if (!spec) return;
		for (const key of new Set([...removed.keys(), ...added.keys()]).values()) {
			const before = removed.get(key);
			const after = added.get(key);
			if (before !== undefined && after !== undefined) {
				if (before !== after) out.push(`guard:${spec.label} ${key} ${before}→${after}`);
			} else if (after !== undefined) out.push(`guard:${spec.label} ${key} added ${after}`);
			else out.push(`guard:${spec.label} ${key} removed`);
		}
		removed = new Map();
		added = new Map();
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			flush();
			const file = line.slice("diff --git ".length).split(" ")[0]?.replace(/^a\//, "") ?? "";
			spec = GUARD_CONFIG.find((g) => g.path.test(file));
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!spec || !inHunk || !(line.startsWith("+") || line.startsWith("-"))) continue;
		const m = line.slice(1).trim().match(spec.entry);
		if (!m) continue;
		(line.startsWith("-") ? removed : added).set(m[1] as string, spec.value(m));
	}
	flush();
	// Register deltas before layer deltas; changes and removals before additions — so under the
	// reason cap a PR that adds many modules cannot crowd out the loosening that matters.
	const rank = (r: string): string => `${r.startsWith("guard:register") ? 0 : 1}${/ added /.test(r) ? 2 : / removed$/.test(r) ? 1 : 0}${r}`;
	return out.sort((a, b) => rank(a).localeCompare(rank(b)));
}

/**
 * Deterministic switch for the extra adversarial PR-review pass. This is not a
 * scanner; it only decides whether the diff is security-sensitive enough to
 * spend a second model session.
 */
export function classifySecurityReviewDiff(files: readonly string[], diff: string): SecurityDiffSignal {
	const reasons: string[] = [];
	const seen = new Set<string>();
	const addReason = (reason: string): void => {
		if (seen.has(reason) || reasons.length >= SECURITY_REASON_LIMIT) return;
		seen.add(reason);
		reasons.push(reason);
	};

	if (files.some((file) => TRIGGER_OWNED_PATHS.has(file))) addReason(SELF_TRIGGER_REASON);
	for (const reason of guardConfigDelta(diff)) addReason(reason);
	for (const file of files) {
		if (TRIGGER_OWNED_PATHS.has(file)) continue;
		if (SECURITY_PATHS.some((re) => re.test(file))) addReason(`path:${file}`);
	}

	return { triggered: reasons.length > 0, reasons };
}
