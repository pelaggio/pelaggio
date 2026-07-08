import type { QuickScopeInput } from "./types.js";

const BODY_STANDARD_SCOPE_RE = /\bscope:\s*(m|l|xl)\b/i;
const BODY_QUICK_SCOPE_RE = /\bscope:\s*(xs|s)\b/i;
const LABEL_SCOPE_RE = /^scope[\s:/-]*(xs|s|m|l|xl)$/i;
const BUG_FIX_RE = /\bbug\b|\bfix:/i;

export function isQuickScope(input: QuickScopeInput): boolean {
	const item = input.item ?? null;
	const labels = item?.labels ?? [];
	const body = item?.body ?? "";

	const labelScopes = labels.map((label) => label.match(LABEL_SCOPE_RE)?.[1]?.toLowerCase()).filter((scope): scope is string => Boolean(scope));

	if (BODY_STANDARD_SCOPE_RE.test(body) || labelScopes.some((scope) => scope === "m" || scope === "l" || scope === "xl")) {
		return false;
	}

	if (BODY_QUICK_SCOPE_RE.test(body) || labelScopes.some((scope) => scope === "xs" || scope === "s")) {
		return true;
	}

	if (labels.some((label) => label.toLowerCase() === "bug") || BUG_FIX_RE.test(body)) {
		return true;
	}

	const summaryText = input.summaryText ?? "";
	return BODY_QUICK_SCOPE_RE.test(summaryText) || BUG_FIX_RE.test(summaryText);
}
