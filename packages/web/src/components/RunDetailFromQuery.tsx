import { useEffect, useState } from "react";
import { RunDetail } from "./RunDetail.js";

export function RunDetailFromQuery() {
	const [id, setId] = useState<string | undefined>(undefined);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setId(params.get("id") ?? undefined);
	}, []);

	if (id === undefined) return <p className="text-slate-500">Loading…</p>;
	if (id === "")
		return (
			<p className="text-red-700">
				Missing run id. <a href="/ui/">Back to runs</a>.
			</p>
		);
	return <RunDetail id={id} />;
}
