import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const contentTypes: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};
const base = (process.env.SITE_BASE || "").replace(/\/$/, "");
const server = createServer((request, response) => {
	const requested = new URL(request.url ?? "/", "http://localhost").pathname;
	if (base && requested !== base && !requested.startsWith(`${base}/`)) {
		response.writeHead(404).end();
		return;
	}
	const path = requested.slice(base.length) || "/";
	const relative = path === "/" ? "index.html" : path.slice(1);
	let file = resolve(dist, relative);
	if (!file.startsWith(`${dist}/`)) {
		response.writeHead(403).end();
		return;
	}
	if (!extname(file)) file = existsSync(file + ".html") ? file + ".html" : resolve(file, "index.html");
	try {
		response.setHeader("Content-Type", contentTypes[extname(file)] ?? "text/plain");
		response.end(readFileSync(file));
	} catch {
		response.writeHead(404, { "Content-Type": "text/html" });
		response.end(readFileSync(resolve(dist, "404.html")));
	}
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}${base}`;
const browser = await chromium.launch({ executablePath: process.env.SITE_CHROME_PATH });
try {
	const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
	});
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto(`${origin}/`);
		await page.evaluate(() => document.fonts.ready);
		assert.equal(await page.locator("h1").textContent(), "Let the work run.");
		assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), `${process.env.SITE_ORIGIN || "https://pelaggio.com"}${base}/`);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
		for (const [id, label] of [
			["csv", "CSV export"],
			["import", "Interrupted import"],
		]) {
			await page.getByRole("radio", { name: label, exact: true }).check();
			const panel = page.locator(`[data-scenario="${id}"]`);
			assert.equal(await panel.isVisible(), true);
			assert.equal(await page.locator(`[data-scenario="${id === "csv" ? "import" : "csv"}"]`).isVisible(), false);
			await panel.locator(".envelope summary").click();
			await panel.locator(".plan-detail summary").click();
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${id} expanded overflow at ${width}px`);
			await panel.locator(".envelope summary").click();
			await panel.locator(".plan-detail summary").click();
			if (process.env.SITE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SITE_SCREENSHOT_DIR}/${id}-${width}.png`, fullPage: true });
		}
	}
	const luminance = (rgb: string) => {
		const channels = rgb
			.match(/\d+/g)!
			.slice(0, 3)
			.map(Number)
			.map((value) => value / 255)
			.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
		return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
	};
	const colors = await page.locator(".primary").evaluate((element) => {
		const css = getComputedStyle(element);
		return [css.color, css.backgroundColor];
	});
	const light = colors.map(luminance).sort((a, b) => a - b);
	assert.ok((light[1]! + 0.05) / (light[0]! + 0.05) >= 4.5, "CTA text contrast");
	await page.locator("button.copy-cmd").first().click();
	assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npx pelaggio init");
	await page.goto(`${origin}/limitations`);
	assert.equal(await page.locator("#delivery-records").count(), 1);
	for (const path of ["/og.png", "/apple-touch-icon.png", "/example/receipt.json", "/example/csv/plan.md", "/example/import/plan.md", "/ai-delivery/v0.1/predicate.schema.json"]) {
		assert.equal((await context.request.get(origin + path)).status(), 200, path);
	}
	const receipt = await (await context.request.get(`${origin}/example/receipt.json`)).json();
	for (const artifact of receipt.artifacts) {
		const response = await context.request.get(`${origin}/example/${artifact.path}`);
		assert.equal(response.status(), 200, artifact.path);
		assert.equal(
			createHash("sha256")
				.update(await response.body())
				.digest("hex"),
			artifact.sha256,
		);
	}
	assert.equal((await context.request.get(`${origin}/example/envelope.json`)).status(), 404, "retired illustrative envelope must not remain published");
	assert.equal((await context.request.get(`${origin}/missing-page`)).status(), 404);
	assert.deepEqual(errors, []);
	await context.close();
	const noJs = await browser.newContext({ javaScriptEnabled: false });
	const staticPage = await noJs.newPage();
	await staticPage.goto(`${origin}/`);
	await staticPage.getByRole("radio", { name: "Interrupted import", exact: true }).check();
	assert.equal(await staticPage.locator('[data-scenario="import"]').isVisible(), true);
	assert.equal(await staticPage.locator('[data-scenario="csv"]').isVisible(), false);
	assert.equal(await staticPage.locator("h1").textContent(), "Let the work run.");
	assert.ok((await staticPage.locator("button.copy-cmd code").first().textContent())?.includes("npx pelaggio init"));
	await noJs.close();
	console.log("Site smoke passed: mobile, assets, example, limitations, contrast, clipboard, no-JS, 404.");
} finally {
	await browser.close();
	await new Promise<void>((done) => server.close(() => done()));
}
