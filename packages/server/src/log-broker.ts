import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

export type LogSubscriber = (line: string) => void;

interface RunBroker {
	logPath: string;
	subscribers: Set<LogSubscriber>;
	pending: string;
	bytesWritten: number;
	closed: boolean;
}

/**
 * Per-run log fan-out. Tees a child stream to a file and broadcasts complete
 * lines to subscribers.
 *
 * SSE replay-vs-live race: `attach` registers the subscriber, snapshots
 * `bytesWritten`, replays the file up to that offset, then deletes the
 * snapshot subscriber. Any line emitted between snapshot and replay-end
 * lands at offset >= snapshot, is queued, and gets delivered post-replay.
 * Because `emit()` always appends to disk *before* notifying subscribers,
 * `bytesWritten` is a precise watermark — every line at offset < snapshot
 * is on disk and will be replayed; every queued line is at offset >= snapshot.
 */
export class LogBroker {
	private readonly brokers = new Map<string, RunBroker>();

	tee(runId: string, logPath: string, stream: Readable): void {
		const broker = this.ensure(runId, logPath);
		stream.setEncoding("utf-8");
		stream.on("data", (chunk: string) => this.ingest(broker, chunk));
		stream.on("end", () => {
			if (broker.pending.length > 0) {
				this.emit(broker, broker.pending);
				broker.pending = "";
			}
		});
	}

	private ensure(runId: string, logPath: string): RunBroker {
		let broker = this.brokers.get(runId);
		if (!broker) {
			mkdirSync(dirname(logPath), { recursive: true });
			broker = { logPath, subscribers: new Set(), pending: "", bytesWritten: existsSync(logPath) ? statSync(logPath).size : 0, closed: false };
			this.brokers.set(runId, broker);
		}
		return broker;
	}

	private ingest(broker: RunBroker, chunk: string): void {
		broker.pending += chunk;
		let idx = broker.pending.indexOf("\n");
		while (idx !== -1) {
			const line = broker.pending.slice(0, idx);
			broker.pending = broker.pending.slice(idx + 1);
			this.emit(broker, line);
			idx = broker.pending.indexOf("\n");
		}
	}

	private emit(broker: RunBroker, line: string): void {
		const withNl = `${line}\n`;
		appendFileSync(broker.logPath, withNl);
		broker.bytesWritten += Buffer.byteLength(withNl, "utf-8");
		for (const sub of broker.subscribers) sub(line);
	}

	async attach(runId: string, logPath: string, subscriber: LogSubscriber): Promise<{ unsubscribe: () => void; closed: boolean }> {
		const broker = this.ensure(runId, logPath);
		const queue: string[] = [];
		const buffered: LogSubscriber = (line) => queue.push(line);
		broker.subscribers.add(buffered);
		const snapshot = broker.bytesWritten;

		if (snapshot > 0) {
			await new Promise<void>((res, rej) => {
				const stream = createReadStream(logPath, { start: 0, end: snapshot - 1, encoding: "utf-8" });
				let pending = "";
				stream.on("data", (chunk) => {
					pending += chunk;
					let idx = pending.indexOf("\n");
					while (idx !== -1) {
						subscriber(pending.slice(0, idx));
						pending = pending.slice(idx + 1);
						idx = pending.indexOf("\n");
					}
				});
				stream.on("end", () => {
					if (pending.length > 0) subscriber(pending);
					res();
				});
				stream.on("error", rej);
			});
		}

		// Add real subscriber before removing the buffered one — guarantees no
		// gap where an emit could miss both.
		broker.subscribers.add(subscriber);
		broker.subscribers.delete(buffered);
		for (const line of queue) subscriber(line);

		return {
			unsubscribe: () => {
				broker.subscribers.delete(subscriber);
			},
			closed: broker.closed,
		};
	}

	close(runId: string): void {
		const broker = this.brokers.get(runId);
		if (!broker) return;
		if (broker.pending.length > 0) {
			this.emit(broker, broker.pending);
			broker.pending = "";
		}
		broker.closed = true;
	}
}
