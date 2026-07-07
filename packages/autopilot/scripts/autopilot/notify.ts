import { type CycleResult, RECOVERABLE_ERRORS } from "./types.js";

// ── Events & formats ───────────────────────────────────────────────────

export const NOTIFY_EVENTS = ["parked", "failed", "shipped", "pr-opened", "shipwrecked"] as const;
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
 * parked > pr-opened / shipped (completed) > shipwrecked > skip (non-actionable) > failed.
 *
 * A cycle that shipwrecked but recovered classifies as shipped/pr-opened (it did land);
 * the payload still carries `shipwrecked: true`, so no signal is lost. `parked` short-circuits
 * before the `NON_ACTIONABLE` skip even though it lives in that set.
 */
export function classifyEvent(result: CycleResult): NotifyEvent | null {
	if (result.error === "parked") return "parked";
	if (result.completed) return result.awaitingMerge ? "pr-opened" : "shipped";
	if (result.shipwrecked) return "shipwrecked";
	if (result.error && NON_ACTIONABLE.has(result.error)) return null;
	return "failed";
}

// ── Text summary (pure, ANSI-free) ─────────────────────────────────────

/**
 * A one-line, webhook-safe summary (no ANSI escapes). Includes itemId, title, cost, and —
 * for non-happy events — the error; prUrl is appended when present.
 */
export function formatText(p: Omit<NotifyPayload, "text">): string {
	const head = `autopilot: ${p.event} ${p.itemId ?? "?"}`;
	const title = p.title ? ` "${p.title}"` : "";
	const bits: string[] = [`$${p.cost.toFixed(2)}`];
	if (p.prUrl) bits.push(p.prUrl);
	if (p.error && p.event !== "shipped" && p.event !== "pr-opened") bits.push(p.error);
	return `${head}${title} — ${bits.join(" · ")}`;
}

// ── Wire format (pure) ─────────────────────────────────────────────────

const EVENT_TAGS: Record<NotifyEvent, string> = {
	parked: "hourglass_flowing_sand",
	failed: "rotating_light",
	shipped: "white_check_mark",
	"pr-opened": "arrow_heading_up",
	shipwrecked: "boom",
};

const EVENT_TITLES: Record<NotifyEvent, string> = {
	parked: "autopilot parked",
	failed: "autopilot failed",
	shipped: "autopilot shipped",
	"pr-opened": "autopilot PR opened",
	shipwrecked: "autopilot shipwrecked",
};

const HIGH_PRIORITY: ReadonlySet<NotifyEvent> = new Set<NotifyEvent>(["failed", "shipwrecked"]);

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
	/** Best-effort title lookup; wrapped in a bounded race so a hung call can't stall the loop. */
	resolveTitle?: (id: string) => Promise<string | undefined>;
	titleTimeoutMs?: number;
}

async function resolveTitleBounded(resolveTitle: ((id: string) => Promise<string | undefined>) | undefined, id: string | null, timeoutMs: number): Promise<string | undefined> {
	if (!resolveTitle || !id) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([resolveTitle(id), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)))]);
	} catch {
		return undefined;
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
		...(result.error ? { error: result.error } : {}),
		...(result.prUrl ? { prUrl: result.prUrl } : {}),
		shipwrecked: result.shipwrecked ?? false,
		logPath,
		ts: new Date().toISOString(),
	} satisfies Omit<NotifyPayload, "text">;

	const payload: NotifyPayload = { ...base, text: formatText(base) };
	await send(cfg.url, cfg.format, payload);
	return event;
}
