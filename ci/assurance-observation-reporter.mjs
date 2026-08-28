export default async function* assuranceObservationReporter(source) {
	for await (const event of source) {
		if (event.type !== "test:pass" && event.type !== "test:fail") continue;
		const { details, file, name, nesting, skip, testNumber, todo } = event.data;
		yield `${JSON.stringify({ type: event.type, data: { details: { duration_ms: details.duration_ms, type: details.type }, file, name, nesting, skip, testNumber, todo } })}\n`;
	}
}
