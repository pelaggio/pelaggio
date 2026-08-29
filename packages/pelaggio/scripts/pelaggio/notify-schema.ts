/** Notification config schema (L0) — shared by `config.ts` and `notify.ts` without a cycle. */

export const NOTIFY_EVENTS = ["parked", "failed", "shipped", "pr-opened", "shipwrecked", "review-stranded", "decision"] as const;
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
