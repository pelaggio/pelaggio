/**
 * L0 type-only v1 delivery Case / record / roots / lifecycle types.
 * Runtime validators live in `bundle.ts`; policy lives in `verify.ts`.
 *
 * Prefixed (`DeliveryRecord`, `DeliveryDecision`, `DeliveryEffect`, `DeliveryCase`) so they
 * do not collide with `types.ts` `Decision` / `Effect`. On-disk `kind` remains the four
 * authorized strings plus the harness-issued `"Case"` closure object.
 */

export const DELIVERY_SCHEMA_VERSION = 1 as const;

/** Domain labels for content-addressed objects (`sha256(domain || 0x00 || bytes)`). */
export const DELIVERY_DOMAIN = {
	object: "pelaggio.delivery.object.v1",
	attachment: "pelaggio.delivery.attachment.v1",
} as const;

export type DeliveryRecordKind = "Observation" | "Assessment" | "Decision" | "Effect";
export type DeliveryObjectKind = DeliveryRecordKind | "Case";

export type DeliveryIssuerKind = "harness" | "local" | "shadow";

export interface DeliveryIssuer {
	kind: DeliveryIssuerKind;
	id: string;
}

export type DeliveryRecordRole = "authorized-intent" | "subject" | "scope" | "governing-context" | "acceptance-claim" | "review" | "policy" | "human-authorization" | "landing";

export type DeliveryAttachmentRole = "basis" | "evidence" | "handoff" | "review-record";

export interface DeliveryAttachmentRef {
	digest: string;
	role: DeliveryAttachmentRole;
}

export interface DeliveryFact {
	key: string;
	value: string;
}

export type DeliveryFindingDisposition = "accepted" | "rejected" | "open" | "residual";

export interface DeliveryFinding {
	id: string;
	severity: "material" | "note";
	summary: string;
	disposition?: DeliveryFindingDisposition;
}

export interface DeliverySubjectBinding {
	resultTree: string;
	configuration?: string;
}

/**
 * One Observation / Assessment / Decision / Effect record. Optional fields are omitted
 * rather than nulled; unknown keys are rejected at validation time.
 */
export interface DeliveryRecord {
	schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
	kind: DeliveryRecordKind;
	id: string;
	role: DeliveryRecordRole;
	issuedAt: string;
	issuer: DeliveryIssuer;
	claims?: string[];
	subjectBinding?: DeliverySubjectBinding;
	/** Set on Policy/Human Decisions and landing Effects that *refer to* a Case; never admitted back into it. */
	caseDigest?: string;
	authority?: string;
	attachments?: DeliveryAttachmentRef[];
	facts?: DeliveryFact[];
	findings?: DeliveryFinding[];
	/** Landing Effect: the tree the Effect claims landed. */
	resultTree?: string;
}

export type DeliveryObligationGroup = "intent" | "subject-result-tree" | "subject-config-binding" | "scope" | "governing-context" | "acceptance" | "review-findings" | "evidence";

export interface DeliveryObligation {
	id: string;
	group: DeliveryObligationGroup;
	recordDigests: string[];
	attachmentDigests: string[];
}

export interface DeliverySubject {
	gitDir: string;
	/** `remote.origin.url` when present. */
	repository: string | null;
	/** Residual label when no origin is configured. */
	repositoryResidual: string | null;
	baseCommit: string;
	baseTree: string;
	candidateCommit: string;
	resultTree: string;
	/** SHA-256 of `git diff-tree -r --no-commit-id --raw -z --no-renames` bytes. */
	diffTreeDigest: string;
}

export interface DeliveryCase {
	schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
	kind: "Case";
	id: string;
	issuedAt: string;
	issuer: DeliveryIssuer;
	subject: DeliverySubject;
	admittedRecords: string[];
	obligations: DeliveryObligation[];
	residuals: string[];
}

export interface DeliveryRoots {
	schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
	case: string;
	policyDecision?: string;
	humanDecision?: string;
	effects?: string[];
}

export type DeliveryDisposition = "ACCEPTED" | "WITHHOLD" | "REJECTED";
export type DeliveryAuthorizationState = "authorized" | "rejected" | "AWAITING AUTHORIZATION";
export type DeliveryEffectState = "proven" | "rejected" | "EFFECT UNPROVEN";

export type DeliveryReasonCode =
	| "subject-result-tree"
	| "subject-config-binding"
	| "obligation-evidence-missing"
	| "obligation-evidence-tampered"
	| "finding-closure"
	| "finding-disposition-missing"
	| "policy-unsatisfied"
	| "awaiting-authorization"
	| "wrong-authority"
	| "cross-case-decision"
	| "landing-tree-mismatch"
	| "malformed-graph"
	| "extra-object"
	| "stale-projection";

export interface DeliveryLocalizedReason {
	code: DeliveryReasonCode;
	group: DeliveryObligationGroup | "policy" | "authorization" | "landing" | "graph";
	disposition: DeliveryDisposition | DeliveryAuthorizationState | DeliveryEffectState;
	detail: string;
}

export interface DeliveryObligationRow {
	id: string;
	group: DeliveryObligationGroup;
	state: "closed" | "open";
	detail: string;
}

export interface DeliveryVerifyResult {
	overall: DeliveryDisposition;
	caseDisposition: DeliveryDisposition;
	authorization: DeliveryAuthorizationState;
	effect: DeliveryEffectState;
	reasons: DeliveryLocalizedReason[];
	obligations: DeliveryObligationRow[];
	residuals: string[];
	diagnostics: string[];
	subject: DeliverySubject;
	caseDigest: string;
	inspectionCommand: string;
}

/** Aliases matching the plan's collision-avoiding type names. */
export type DeliveryDecision = DeliveryRecord & { kind: "Decision" };
export type DeliveryEffect = DeliveryRecord & { kind: "Effect" };
