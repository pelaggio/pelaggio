export type AuthoringReviewHostDependencyParkReason = "containment-escape" | "invalid-lockfile" | "missing-store-content" | "managed-slot-occupied" | "repair-failed" | "verification-failed" | "lock-unavailable";

export interface AuthoringReviewHostDependencyLink {
	name: string;
	path: string;
	target: string;
}

export type AuthoringReviewHostDependencyRepairResult =
	| { status: "healthy"; repaired: AuthoringReviewHostDependencyLink[] }
	| { status: "repaired"; repaired: AuthoringReviewHostDependencyLink[] }
	| { status: "park"; reason: AuthoringReviewHostDependencyParkReason; detail: string; repaired: AuthoringReviewHostDependencyLink[] };

export type HostDependencyRepairLock = <T>(path: string, fn: () => Promise<T> | T) => Promise<T>;

export interface HostDependencyRepairHooks {
	afterEntryValidation?: (path: string) => void;
	beforeSlotRemoval?: (path: string) => void;
	afterQuarantine?: (path: string) => void;
}

export function managedAuthoringReviewHostDependencyNames(lockfile: unknown): string[];
export function authoringReviewStoreDirname(name: string, resolution: string): string;
export function deriveAuthoringReviewHostDependencyTargets(mainRepo: string): AuthoringReviewHostDependencyLink[];
export function resolveAuthoringReviewMainRepo(repo: string): string;
export function verifyOrRepairAuthoringReviewHostDependencies(mainRepo: string, lock?: HostDependencyRepairLock, hooks?: HostDependencyRepairHooks): Promise<AuthoringReviewHostDependencyRepairResult>;
