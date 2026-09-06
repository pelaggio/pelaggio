import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { registerPromptHandler, setToken, wasLastRejected } from "../lib/token.js";

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
		<dialog ref={dialogRef} onCancel={(e) => e.preventDefault()} className="rounded-btn border border-foam-line bg-foam p-0 text-ink backdrop:bg-abyss/50">
			<form onSubmit={submit} className="w-80 space-y-3 p-5">
				<h2 className="font-display text-lg font-medium tracking-tight">Control-plane token</h2>
				<p className="text-sm text-ink-soft">Paste the bearer token from the operator's env file.</p>
				{rejected && <p className="border border-fail/30 bg-fail/5 p-2 text-sm text-fail">Token rejected — try again.</p>}
				<input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Control-plane token" />
				<button type="submit" className="btn-primary w-full">
					Save
				</button>
			</form>
		</dialog>
	);
}
