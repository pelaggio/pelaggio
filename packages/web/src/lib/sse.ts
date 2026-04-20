import { getToken, markTokenRejected, promptForToken } from "./token.js";

export interface SseHandlers {
	onLine: (line: string) => void;
	onEnd?: (exitCode: number | undefined) => void;
	onError?: (err: unknown) => void;
	signal?: AbortSignal;
	headers?: HeadersInit;
}

interface ParsedEvent {
	event: string | undefined;
	data: string;
}

function parseEvent(block: string): ParsedEvent | null {
	let event: string | undefined;
	const dataLines: string[] = [];
	for (const raw of block.split("\n")) {
		if (raw === "" || raw.startsWith(":")) continue;
		const idx = raw.indexOf(":");
		const field = idx === -1 ? raw : raw.slice(0, idx);
		const value = idx === -1 ? "" : raw.slice(idx + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") dataLines.push(value);
	}
	if (event === undefined && dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

export async function subscribeSse(url: string, handlers: SseHandlers): Promise<void> {
	const { onLine, onEnd, onError, signal, headers } = handlers;
	const openStream = async (): Promise<Response> => {
		const token = getToken();
		return fetch(url, {
			signal,
			headers: {
				Accept: "text/event-stream",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(headers ?? {}),
			},
		});
	};
	try {
		let res = await openStream();
		if (res.status === 401) {
			markTokenRejected();
			await promptForToken();
			res = await openStream();
		}
		if (!res.ok || !res.body) {
			onError?.(new Error(`SSE ${url} → ${res.status}`));
			onEnd?.(undefined);
			return;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let endedExitCode: number | undefined;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const block = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const ev = parseEvent(block);
				if (ev) {
					if (ev.event === "end") {
						try {
							const parsed = JSON.parse(ev.data) as { exitCode?: number };
							endedExitCode = parsed.exitCode;
						} catch {
							endedExitCode = undefined;
						}
					} else if (ev.data !== "") {
						onLine(ev.data);
					}
				}
				sep = buffer.indexOf("\n\n");
			}
		}
		onEnd?.(endedExitCode);
	} catch (err) {
		if ((err as { name?: string }).name === "AbortError") {
			onEnd?.(undefined);
			return;
		}
		onError?.(err);
		onEnd?.(undefined);
	}
}
