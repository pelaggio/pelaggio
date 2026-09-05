/** Optional explanatory contents. None of these fields participates in gate disposition. */
export interface ReviewQualification {
	basis: "code" | "contract" | "judgment" | "check";
	reference: string;
	conclusion: string;
	limitation: string;
	recommendation?: string;
}

export interface ReviewQuestion {
	question: string;
	context: string;
	paths: string[];
}

export function qualificationText(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value) || value.length > 8000) throw new Error("invalid qualification text");
	return value.trim();
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("invalid qualification object");
	return value as Record<string, unknown>;
}

export function parseQualification(value: unknown): ReviewQualification {
	const v = object(value, ["basis", "reference", "conclusion", "limitation", "recommendation"]);
	if (v.basis !== "code" && v.basis !== "contract" && v.basis !== "judgment" && v.basis !== "check") throw new Error("invalid qualification basis");
	return {
		basis: v.basis,
		reference: qualificationText(v.reference),
		conclusion: qualificationText(v.conclusion),
		limitation: qualificationText(v.limitation),
		...(v.recommendation === undefined ? {} : { recommendation: qualificationText(v.recommendation) }),
	};
}

export function parseQuestions(value: unknown): ReviewQuestion[] {
	if (!Array.isArray(value) || value.length > 64) throw new Error("invalid questions");
	return value.map((entry) => {
		const v = object(entry, ["question", "context", "paths"]);
		if (!Array.isArray(v.paths) || v.paths.length > 64) throw new Error("invalid question paths");
		const paths = v.paths.map(qualificationText);
		if (paths.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("invalid question path");
		return { question: qualificationText(v.question), context: qualificationText(v.context), paths: [...new Set(paths)].sort() };
	});
}
