import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { getToken, promptForToken, registerPromptHandler, setToken, wasLastRejected } from "../lib/token.js";

export function TokenPrompt() {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const [value, setValue] = useState("");
	const [rejected, setRejected] = useState(false);

	useEffect(() => {
		registerPromptHandler(() => {
			setRejected(wasLastRejected());
			const dlg = dialogRef.current;
			if (dlg && !dlg.open) dlg.showModal();
		});
		if (typeof window !== "undefined" && !getToken()) {
			void promptForToken();
		}
		return () => registerPromptHandler(null);
	}, []);

	const submit = (e: SyntheticEvent<HTMLFormElement>) => {
		e.preventDefault();
		const token = value.trim();
		if (!token) return;
		setToken(token);
		setValue("");
		setRejected(false);
		dialogRef.current?.close();
	};

	return (
		<dialog ref={dialogRef} onCancel={(e) => e.preventDefault()} className="rounded-lg p-0 backdrop:bg-slate-900/40">
			<form onSubmit={submit} className="w-80 space-y-3 p-5">
				<h2 className="text-lg font-semibold">Control-plane token</h2>
				<p className="text-sm text-slate-600">Paste the bearer token from the operator's env file.</p>
				{rejected && <p className="rounded bg-red-50 p-2 text-sm text-red-800">Token rejected — try again.</p>}
				<input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1 text-sm" aria-label="Control-plane token" />
				<button type="submit" className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white">
					Save
				</button>
			</form>
		</dialog>
	);
}
