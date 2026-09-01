/**
 * L2 delivery verifier: disposition / lifecycle policy over an already-loaded graph
 * plus an injected git observation. Never runs git, never reads dossier.md or
 * verify.json as evidence, never trusts filenames, unattached objects, or issuer prose.
 */
import { DeliveryBundleError, type LoadedBundle, requireAttachment, requireObject, validateDeliveryCase, validateDeliveryRecord } from "./bundle.js";
import type {
	DeliveryAuthorizationState,
	DeliveryCase,
	DeliveryDisposition,
	DeliveryEffectState,
	DeliveryLocalizedReason,
	DeliveryObligationGroup,
	DeliveryObligationRow,
	DeliveryRecord,
	DeliveryRecordRole,
	DeliverySubject,
	DeliveryVerifyResult,
} from "./types.js";

const HUMAN_AUTHORITIES = new Set(["operator", "human-operator"]);
const REQUIRED_OBLIGATION_ROLES = new Map<DeliveryObligationGroup, DeliveryRecordRole>([
	["intent", "authorized-intent"],
	["subject-result-tree", "subject"],
	["subject-config-binding", "acceptance-claim"],
	["scope", "scope"],
	["governing-context", "governing-context"],
	["acceptance", "acceptance-claim"],
	["review-findings", "review"],
]);

export function renderDossier(result: DeliveryVerifyResult): string {
	const lines: string[] = [
		"# Reconciled change",
		"",
		`Subject: gitDir=${result.subject.gitDir} repository=${result.subject.repository ?? result.subject.repositoryResidual ?? "unknown"} base=${result.subject.baseCommit} base-tree=${result.subject.baseTree} candidate=${result.subject.candidateCommit} result-tree=${result.subject.resultTree} diff=${result.subject.diffTreeDigest}`,
		`Case: ${result.caseDigest}`,
		"",
		`Overall: ${result.overall}`,
		`Case: ${result.caseDisposition}`,
		`Authorization: ${result.authorization}`,
		`Effect: ${result.effect}`,
		"",
		"Obligations:",
	];
	for (const row of result.obligations) {
		lines.push(`- ${row.group} (${row.id}): ${row.state}${row.detail ? ` — ${row.detail}` : ""}`);
	}
	lines.push("", "Residuals:");
	if (result.residuals.length === 0) lines.push("- (none)");
	else for (const r of result.residuals) lines.push(`- ${r}`);
	const material = result.reasons.filter((r) => r.disposition === "REJECTED" || r.disposition === "WITHHOLD" || r.disposition === "rejected");
	lines.push("", "Material residuals / reasons:");
	if (material.length === 0) lines.push("- (none)");
	else for (const r of material) lines.push(`- ${r.group}/${r.code}: ${r.detail}`);
	lines.push(
		"",
		"Authority: local/shadow identities only; no signature or authentication claim.",
		`Evidence availability: objects+attachments reachable from roots; unattached objects cannot strengthen disposition.`,
		"",
		`Inspect: ${result.inspectionCommand}`,
		"",
	);
	return lines.join("\n");
}

export function renderVerifyJson(result: DeliveryVerifyResult): string {
	return `${JSON.stringify(
		{
			overall: result.overall,
			case: result.caseDisposition,
			authorization: result.authorization,
			effect: result.effect,
			caseDigest: result.caseDigest,
			subject: result.subject,
			obligations: result.obligations,
			residuals: result.residuals,
			reasons: result.reasons,
			diagnostics: result.diagnostics,
			inspectionCommand: result.inspectionCommand,
		},
		null,
		2,
	)}\n`;
}

export function renderVerifyText(result: DeliveryVerifyResult): string {
	return [
		`overall ${result.overall}`,
		`case ${result.caseDisposition}`,
		`authorization ${result.authorization}`,
		`effect ${result.effect}`,
		...result.reasons.map((r) => `${r.disposition} ${r.group}/${r.code} ${r.detail}`),
		result.inspectionCommand,
		"",
	].join("\n");
}

function worseCase(current: DeliveryDisposition, next: DeliveryDisposition): DeliveryDisposition {
	if (current === "REJECTED" || next === "REJECTED") return "REJECTED";
	if (current === "WITHHOLD" || next === "WITHHOLD") return "WITHHOLD";
	return "ACCEPTED";
}

function overallDisposition(caseDisposition: DeliveryDisposition, authorization: DeliveryAuthorizationState, effect: DeliveryEffectState): DeliveryDisposition {
	if (caseDisposition === "REJECTED" || effect === "rejected") return "REJECTED";
	if (caseDisposition === "WITHHOLD" || authorization !== "authorized") return "WITHHOLD";
	return "ACCEPTED";
}

export function verifyLoadedBundle(bundle: LoadedBundle, git: DeliverySubject, inspectionCommand: string): DeliveryVerifyResult {
	const reasons: DeliveryLocalizedReason[] = [];
	const diagnostics: string[] = [];
	const obligationRows: DeliveryObligationRow[] = [];
	let caseDisposition: DeliveryDisposition = "ACCEPTED";
	let authorization: DeliveryAuthorizationState = "AWAITING AUTHORIZATION";
	let effect: DeliveryEffectState = "EFFECT UNPROVEN";

	const failCase = (next: DeliveryDisposition, reason: DeliveryLocalizedReason): void => {
		caseDisposition = worseCase(caseDisposition, next);
		reasons.push(reason);
	};

	let deliveryCase: DeliveryCase;
	try {
		const caseObj = requireObject(bundle, bundle.roots.case);
		deliveryCase = validateDeliveryCase(caseObj.value);
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		return {
			overall: "WITHHOLD",
			caseDisposition: "WITHHOLD",
			authorization: "AWAITING AUTHORIZATION",
			effect: "EFFECT UNPROVEN",
			reasons: [{ code: "malformed-graph", group: "graph", disposition: "WITHHOLD", detail }],
			obligations: [],
			residuals: [],
			diagnostics: [],
			subject: git,
			caseDigest: bundle.roots.case,
			inspectionCommand,
		};
	}

	if (deliveryCase.subject.resultTree !== git.resultTree || deliveryCase.subject.candidateCommit !== git.candidateCommit) {
		failCase("REJECTED", {
			code: "subject-result-tree",
			group: "subject-result-tree",
			disposition: "REJECTED",
			detail: `Case result tree ${deliveryCase.subject.resultTree} / candidate ${deliveryCase.subject.candidateCommit} does not match injected git ${git.resultTree} / ${git.candidateCommit}`,
		});
	} else if (deliveryCase.subject.diffTreeDigest !== git.diffTreeDigest || deliveryCase.subject.baseTree !== git.baseTree) {
		failCase("REJECTED", {
			code: "subject-result-tree",
			group: "subject-result-tree",
			disposition: "REJECTED",
			detail: "Case base tree or diff-tree digest does not match injected git observation",
		});
	}

	const admitted = new Map<string, DeliveryRecord>();
	for (const digest of deliveryCase.admittedRecords) {
		try {
			const obj = requireObject(bundle, digest);
			admitted.set(digest, validateDeliveryRecord(obj.value));
		} catch (e) {
			failCase("WITHHOLD", {
				code: "obligation-evidence-missing",
				group: "evidence",
				disposition: "WITHHOLD",
				detail: `admitted record ${digest}: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	for (const record of admitted.values()) {
		if (record.subjectBinding && record.subjectBinding.resultTree !== deliveryCase.subject.resultTree) {
			failCase("WITHHOLD", {
				code: "subject-config-binding",
				group: "subject-config-binding",
				disposition: "WITHHOLD",
				detail: `record ${record.id} binds result tree ${record.subjectBinding.resultTree}, not Case ${deliveryCase.subject.resultTree}`,
			});
		}
	}

	for (const [group] of REQUIRED_OBLIGATION_ROLES) {
		if (deliveryCase.obligations.some((obligation) => obligation.group === group)) continue;
		failCase("WITHHOLD", {
			code: "obligation-evidence-missing",
			group,
			disposition: "WITHHOLD",
			detail: `required obligation group ${group} is missing`,
		});
		obligationRows.push({ id: `required:${group}`, group, state: "open", detail: "required group is missing" });
	}

	for (const obligation of deliveryCase.obligations) {
		const missing: string[] = [];
		if (obligation.recordDigests.length === 0 && obligation.attachmentDigests.length === 0) missing.push("evidence:none");
		if (obligation.group === "intent" && obligation.attachmentDigests.length === 0) missing.push("attachment:required-handoff");
		const referencedAttachments = new Set<string>();
		for (const digest of obligation.recordDigests) {
			const record = admitted.get(digest);
			if (!record) {
				missing.push(`record:${digest}:not-admitted`);
				continue;
			}
			const requiredRole = REQUIRED_OBLIGATION_ROLES.get(obligation.group);
			if (requiredRole && record.role !== requiredRole) missing.push(`record:${digest}:role-${record.role}-not-${requiredRole}`);
			if (obligation.group === "subject-config-binding" && !record.subjectBinding?.configuration) {
				missing.push(`record:${digest}:configuration-missing`);
			}
			for (const attachment of record.attachments ?? []) referencedAttachments.add(attachment.digest);
		}
		for (const digest of obligation.attachmentDigests) {
			if (!referencedAttachments.has(digest)) missing.push(`attachment:${digest}:not-referenced-by-obligation-record`);
			try {
				requireAttachment(bundle, digest);
			} catch (e) {
				const code = e instanceof DeliveryBundleError && e.code === "tampered" ? "obligation-evidence-tampered" : "obligation-evidence-missing";
				failCase("WITHHOLD", {
					code,
					group: obligation.group,
					disposition: "WITHHOLD",
					detail: `obligation ${obligation.id} attachment ${digest}`,
				});
				missing.push(`attachment:${digest}`);
			}
		}
		if (missing.length > 0 && !reasons.some((r) => r.detail.includes(obligation.id))) {
			failCase("WITHHOLD", {
				code: "obligation-evidence-missing",
				group: obligation.group,
				disposition: "WITHHOLD",
				detail: `obligation ${obligation.id} missing ${missing.join(",")}`,
			});
		}
		obligationRows.push({
			id: obligation.id,
			group: obligation.group,
			state: missing.length === 0 ? "closed" : "open",
			detail: missing.length === 0 ? "reachable" : missing.join(","),
		});
	}

	for (const record of admitted.values()) {
		for (const finding of record.findings ?? []) {
			if (finding.severity !== "material") continue;
			if (finding.disposition === "open") {
				failCase("REJECTED", {
					code: "finding-closure",
					group: "review-findings",
					disposition: "REJECTED",
					detail: `open material finding ${finding.id}: ${finding.summary}`,
				});
			} else if (finding.disposition === undefined) {
				failCase("WITHHOLD", {
					code: "finding-disposition-missing",
					group: "review-findings",
					disposition: "WITHHOLD",
					detail: `material finding ${finding.id} has no disposition`,
				});
			}
		}
	}

	if (bundle.roots.humanDecision) {
		try {
			const obj = requireObject(bundle, bundle.roots.humanDecision);
			const decision = validateDeliveryRecord(obj.value);
			if (decision.kind !== "Decision" || decision.role !== "human-authorization") {
				authorization = "AWAITING AUTHORIZATION";
				reasons.push({
					code: "wrong-authority",
					group: "authorization",
					disposition: "AWAITING AUTHORIZATION",
					detail: "humanDecision root is not a human-authorization Decision",
				});
			} else if (decision.caseDigest !== bundle.roots.case) {
				authorization = "AWAITING AUTHORIZATION";
				reasons.push({
					code: "cross-case-decision",
					group: "authorization",
					disposition: "AWAITING AUTHORIZATION",
					detail: `Human Decision refers to Case ${decision.caseDigest ?? "missing"}, not ${bundle.roots.case}`,
				});
			} else if (!decision.authority || !HUMAN_AUTHORITIES.has(decision.authority)) {
				authorization = "AWAITING AUTHORIZATION";
				reasons.push({
					code: "wrong-authority",
					group: "authorization",
					disposition: "AWAITING AUTHORIZATION",
					detail: `Human Decision authority ${decision.authority ?? "missing"} is not an operator authority`,
				});
			} else {
				authorization = "authorized";
			}
		} catch (e) {
			authorization = "AWAITING AUTHORIZATION";
			reasons.push({
				code: "awaiting-authorization",
				group: "authorization",
				disposition: "AWAITING AUTHORIZATION",
				detail: e instanceof Error ? e.message : String(e),
			});
		}
	} else {
		authorization = "AWAITING AUTHORIZATION";
		reasons.push({
			code: "awaiting-authorization",
			group: "authorization",
			disposition: "AWAITING AUTHORIZATION",
			detail: "no Human Decision in roots",
		});
	}

	if (bundle.roots.effects && bundle.roots.effects.length > 0) {
		for (const digest of bundle.roots.effects) {
			try {
				const obj = requireObject(bundle, digest);
				const landing = validateDeliveryRecord(obj.value);
				if (landing.kind !== "Effect" || landing.role !== "landing") {
					effect = "rejected";
					reasons.push({
						code: "landing-tree-mismatch",
						group: "landing",
						disposition: "rejected",
						detail: `effect ${digest} is not a landing Effect`,
					});
					continue;
				}
				if (landing.caseDigest !== bundle.roots.case) {
					effect = "rejected";
					reasons.push({
						code: "cross-case-decision",
						group: "landing",
						disposition: "rejected",
						detail: `landing Effect refers to another Case`,
					});
					continue;
				}
				if (landing.resultTree !== deliveryCase.subject.resultTree) {
					effect = "rejected";
					reasons.push({
						code: "landing-tree-mismatch",
						group: "landing",
						disposition: "rejected",
						detail: `landing Effect tree ${landing.resultTree ?? "missing"} differs from authorized result ${deliveryCase.subject.resultTree}`,
					});
					continue;
				}
				if (effect !== "rejected") effect = "proven";
			} catch (e) {
				effect = "rejected";
				reasons.push({
					code: "landing-tree-mismatch",
					group: "landing",
					disposition: "rejected",
					detail: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}

	for (const extra of bundle.unattachedObjectDigests) {
		diagnostics.push(`unreachable object ${extra} does not strengthen disposition`);
		reasons.push({
			code: "extra-object",
			group: "graph",
			disposition: caseDisposition,
			detail: `unreachable object ${extra}`,
		});
	}

	const overall = overallDisposition(caseDisposition, authorization, effect);

	return {
		overall,
		caseDisposition,
		authorization,
		effect,
		reasons,
		obligations: obligationRows,
		residuals: [...deliveryCase.residuals],
		diagnostics,
		subject: deliveryCase.subject,
		caseDigest: bundle.roots.case,
		inspectionCommand,
	};
}
