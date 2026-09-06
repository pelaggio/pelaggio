import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeSse } from "../lib/sse.js";

const MAX_LINES = 500;

interface LogStreamProps {
	id: string;
}

interface State {
	lines: string[];
	exitCode: number | undefined;
	closed: boolean;
	error: string | undefined;
}

const initialState: State = { lines: [], exitCode: undefined, closed: false, error: undefined };

export function LogStream({ id }: LogStreamProps) {
	const [state, setState] = useState<State>(initialState);
	const [stickToBottom, setStickToBottom] = useState(true);
	const [retryNonce, setRetryNonce] = useState(0);
	const preRef = useRef<HTMLPreElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is the explicit re-subscribe trigger
	useEffect(() => {
		const ctrl = new AbortController();
		setState(initialState);
		void subscribeSse(`/runs/${encodeURIComponent(id)}/log`, {
			signal: ctrl.signal,
			onLine: (line) => {
				setState((s) => {
					const next = s.lines.length >= MAX_LINES ? s.lines.slice(s.lines.length - MAX_LINES + 1) : s.lines.slice();
					next.push(line);
					return { ...s, lines: next };
				});
			},
			onEnd: (exitCode) => {
				setState((s) => ({ ...s, closed: true, exitCode }));
			},
			onError: (err) => {
				setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
			},
		});
		return () => ctrl.abort();
	}, [id, retryNonce]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: lineCount drives the auto-scroll on each new line
	useEffect(() => {
		const pre = preRef.current;
		if (pre && stickToBottom) pre.scrollTop = pre.scrollHeight;
	}, [state.lines.length, stickToBottom]);

	const onScroll = () => {
		const pre = preRef.current;
		if (!pre) return;
		setStickToBottom(pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20);
	};

	const retry = useCallback(() => {
		setRetryNonce((n) => n + 1);
	}, []);

	const showRetry = state.closed && state.exitCode === undefined;

	return (
		<div>
			<pre ref={preRef} onScroll={onScroll} className="max-h-[min(60vh,32rem)] min-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-foam">
				{state.lines.length === 0 ? <span className="text-mist">Waiting for log…</span> : state.lines.join("\n")}
			</pre>
			<div className="mt-3 font-mono text-2xs tracking-label text-mist uppercase">
				{state.closed && state.exitCode !== undefined && <span>Stream ended (exit {state.exitCode})</span>}
				{showRetry && (
					<>
						<span className="text-fail">Connection lost.</span>{" "}
						<button type="button" onClick={retry} className="btn-inline text-foam normal-case tracking-normal">
							Retry
						</button>
					</>
				)}
				{state.error && <span className="text-fail"> {state.error}</span>}
				{!stickToBottom && <span> (paused — scroll to bottom to resume tail)</span>}
			</div>
		</div>
	);
}
