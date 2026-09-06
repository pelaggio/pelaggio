import { useEffect, useState } from "react";
import { RunDetail } from "./RunDetail.js";

export function RunDetailFromQuery() {
	const [id, setId] = useState<string | undefined>(undefined);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setId(params.get("id") ?? undefined);
	}, []);

	if (id === undefined) return <p className="wrap pt-10 text-ink-soft">Loading…</p>;
	if (id === "")
		return (
			<p className="wrap pt-10 text-fail">
				Missing run id.{" "}
				<a href="/ui/" className="text-accent">
					Back to runs
				</a>
				.
			</p>
		);
	return <RunDetail id={id} />;
}
