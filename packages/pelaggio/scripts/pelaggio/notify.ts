import { type CycleResult, RECOVERABLE_ERRORS } from "./types.js";

// ── Events & formats ───────────────────────────────────────────────────

export const NOTIFY_EVENTS = ["parked", "failed", "shipped", "pr-opened", "shipwrecked", "review-stranded"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const NOTIFY_FORMATS = ["json", "ntfy"] as const;
export type NotifyFormat = (typeof NOTIFY_FORMATS)[number];

export interface NotifyConfig {
	/** Webhook endpoint. Empty string = notifications disabled (the default). */
	url: string;
	format: NotifyFormat;
	/** Subset of `NOTIFY_EVENTS` to actually send. */
	events: NotifyEvent[];
}

// ── Payload & wire request ─────────────────────────────────────────────

export interface NotifyPayload {
	event: NotifyEvent;
	itemId: string | null;
	/** Best-effort roadmap title; omitted when the lookup fails / times out. */
	title?: string;
	completed: boolean;
	cost: number;
	/** True when `cost` includes a provider-side estimate (not billed USD) — rendered with `~`. */
	costEstimated?: boolean;
	/** The cycle's error string, when it carried one. */
	error?: string;
	prUrl?: string;
	shipwrecked: boolean;
	logPath: string;
	ts: string;
	/** One-line human summary. A Slack incoming webhook reads this; ntfy sends it as the body. */
	text: string;
}

export interface NotifyRequest {
	body: string;
	headers: Record<string, string>;
}

/** Injected transport — must match the global `fetch` signature so a test fake is drop-in. */
export type FetchLike = typeof fetch;

/** Whole-send seam — injected at the orchestrator so tests can spy without a network. */
export type SendNotification = (url: string, format: NotifyFormat, payload: NotifyPayload) => Promise<boolean>;

const TITLE_TIMEOUT_MS = 3_000;
const SEND_TIMEOUT_MS = 5_000;

// ── Classification (pure) ──────────────────────────────────────────────

const NON_ACTIONABLE = new Set<string>([...RECOVERABLE_ERRORS, "aborted"]);

/**
 * One terminal cycle → at most one event, by precedence:
 * parked > pr-opened / shipped (completed) > skip (non-actionable) > shipwrecked > failed.
 *
 * A cycle that shipwrecked but recovered classifies as shipped/pr-opened (it did land);
 * the payload still carries `shipwrecked: true`, so no signal is lost. `parked` short-circuits
 * before the `NON_ACTIONABLE` skip even though it lives in that set. The skip outranks
 * `shipwrecked`: an `aborted` error is always a deliberate interactive Ctrl-C (unattended runs
 * have no keyboard), so paging "shipwrecked" for it would contradict the documented
 * "aborted never pages" rule while the user is sitting at the terminal watching.
 */
export function classifyEvent(result: CycleResult): NotifyEvent | null {
	if (result.error === "parked") return "parked";
	if (result.completed) return result.awaitingMerge ? "pr-opened" : "shipped";
	if (result.error && NON_ACTIONABLE.has(result.error)) return null;
	if (result.shipwrecked) return "shipwrecked";
	return "failed";
}

// ── Text summary (pure, ANSI-free) ─────────────────────────────────────

/**
 * A one-line, webhook-safe summary (no ANSI escapes). Includes itemId, title, cost, and —
 * for non-happy events — the error; prUrl is appended when present.
 */
export function formatText(p: Omit<NotifyPayload, "text">): string {
	const head = `pelaggio: ${p.event} ${p.itemId ?? "?"}`;
	const title = p.title ? ` "${p.title}"` : "";
	const bits: string[] = [`${p.costEstimated ? "~" : ""}$${p.cost.toFixed(2)}`];
	if (p.prUrl) bits.push(p.prUrl);
	// Skip the error when it just restates the event ("parked · parked").
	if (p.error && p.error !== p.event && p.event !== "shipped" && p.event !== "pr-opened") bits.push(p.error);
	return `${head}${title} — ${bits.join(" · ")}`;
}

// ── Wire format (pure) ─────────────────────────────────────────────────

const EVENT_TAGS: Record<NotifyEvent, string> = {
	parked: "hourglass_flowing_sand",
	failed: "rotating_light",
	shipped: "white_check_mark",
	"pr-opened": "arrow_heading_up",
	shipwrecked: "boom",
	"review-stranded": "warning",
};

const EVENT_TITLES: Record<NotifyEvent, string> = {
	parked: "pelaggio parked",
	failed: "pelaggio failed",
	shipped: "pelaggio shipped",
	"pr-opened": "pelaggio PR opened",
	shipwrecked: "pelaggio shipwrecked",
	"review-stranded": "pelaggio review stranded",
};

const HIGH_PRIORITY: ReadonlySet<NotifyEvent> = new Set<NotifyEvent>(["failed", "shipwrecked", "review-stranded"]);

/**
 * Build the POST body + headers for a format. `json` sends the full payload (Slack reads
 * `text`, generic endpoints get the structured fields); `ntfy` sends the `text` summary as a
 * `text/plain` body with ntfy's `Title`/`Tags`/`Priority`/`Click` headers.
 */
export function buildRequest(format: NotifyFormat, payload: NotifyPayload): NotifyRequest {
	if (format === "ntfy") {
		const headers: Record<string, string> = {
			"content-type": "text/plain",
			Title: EVENT_TITLES[payload.event],
			Tags: EVENT_TAGS[payload.event],
			Priority: HIGH_PRIORITY.has(payload.event) ? "high" : "default",
		};
		if (payload.prUrl) headers.Click = payload.prUrl;
		return { body: payload.text, headers };
	}
	return { body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
}

// ── Transport (best-effort) ────────────────────────────────────────────

/**
 * POST the notification. Best-effort: any throw (network, DNS, timeout/`AbortError`) or non-ok
 * status is swallowed and returns `false`. A notification failure can never fail a cycle.
 */
export async function sendNotification(url: string, format: NotifyFormat, payload: NotifyPayload, deps: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<boolean> {
	const doFetch = deps.fetch ?? fetch;
	const { body, headers } = buildRequest(format, payload);
	try {
		const res = await doFetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(deps.timeoutMs ?? SEND_TIMEOUT_MS) });
		return res.ok;
	} catch {
		return false;
	}
}

// ── Cycle emit ─────────────────────────────────────────────────────────

export interface NotifyCycleDeps {
	/** Whole-send override (defaults to `sendNotification`). */
	send?: SendNotification;
	/** Best-effort title lookup, raced against a timeout. Caveat: the race can only
	 *  preempt *async* work — an adapter that blocks synchronously (the gh CLI runs
	 *  via `spawnSync`) is bounded by its own subprocess timeout, not this one. */
	resolveTitle?: (id: string) => Promise<string | undefined>;
	titleTimeoutMs?: number;
}

async function resolveTitleBounded(resolveTitle: ((id: string) => Promise<string | undefined>) | undefined, id: string | null, timeoutMs: number): Promise<string | undefined> {
	if (!resolveTitle || !id) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// The `.catch` keeps a post-timeout rejection of the abandoned racer observed —
		// an unhandled rejection would otherwise crash the process the notification
		// was meant to report on.
		const lookup = resolveTitle(id).catch(() => undefined);
		return await Promise.race([lookup, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)))]);
	} catch {
		return undefined; // resolveTitle threw synchronously
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Classify a terminal cycle and, when notifications are configured and subscribed to the event,
 * send exactly one best-effort webhook. Returns the classified event (or `null` when skipped) —
 * useful for tests. Never throws.
 */
export async function notifyCycle(cfg: NotifyConfig, result: CycleResult, logPath: string, deps: NotifyCycleDeps = {}): Promise<NotifyEvent | null> {
	if (!cfg.url) return null;
	const event = classifyEvent(result);
	if (!event || !cfg.events.includes(event)) return null;

	const send = deps.send ?? sendNotification;
	const title = await resolveTitleBounded(deps.resolveTitle, result.itemId, deps.titleTimeoutMs ?? TITLE_TIMEOUT_MS);

	const base = {
		event,
		itemId: result.itemId,
		...(title ? { title } : {}),
		completed: result.completed,
		cost: result.cost,
		...(result.costEstimated ? { costEstimated: true } : {}),
		...(result.error ? { error: result.error } : {}),
		...(result.prUrl ? { prUrl: result.prUrl } : {}),
		shipwrecked: result.shipwrecked ?? false,
		logPath,
		ts: new Date().toISOString(),
	} satisfies Omit<NotifyPayload, "text">;

	const payload: NotifyPayload = { ...base, text: formatText(base) };
	let delivered = false;
	try {
		delivered = await send(cfg.url, cfg.format, payload);
	} catch {
		// The default `sendNotification` swallows, but an injected sender may throw —
		// the "never throws" contract must hold at this seam, not just the default.
	}
	// One diagnostic line on failure: a typo'd webhook URL must not mean zero
	// notifications AND zero evidence of why (the exact failure this feature exists
	// to prevent). Deliberately not the URL itself — ntfy topics are secret-ish.
	if (!delivered) process.stderr.write(`⚠ notify: ${event} webhook delivery failed\n`);
	return event;
}

export async function notifyStrandedReview(cfg: NotifyConfig, input: { itemId: string; prNumber: number; ghRepo: string; headSha: string; logPath: string }, deps: { send?: SendNotification } = {}): Promise<boolean> {
	const event: NotifyEvent = "review-stranded";
	if (!cfg.url || !cfg.events.includes(event)) return false;
	const prUrl = `https://github.com/${input.ghRepo}/pull/${input.prNumber}`;
	const base = {
		event,
		itemId: input.itemId,
		completed: false,
		cost: 0,
		error: `PR #${input.prNumber} has no local review status for ${input.headSha.slice(0, 12)}`,
		prUrl,
		shipwrecked: false,
		logPath: input.logPath,
		ts: new Date().toISOString(),
	} satisfies Omit<NotifyPayload, "text">;
	const payload: NotifyPayload = { ...base, text: formatText(base) };
	let delivered = false;
	try {
		delivered = await (deps.send ?? sendNotification)(cfg.url, cfg.format, payload);
	} catch {
		delivered = false;
	}
	if (!delivered) process.stderr.write("⚠ notify: review-stranded webhook delivery failed\n");
	return delivered;
}
