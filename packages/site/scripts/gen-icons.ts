import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const svg = readFileSync(join(publicDir, "favicon.svg"));

const targets: Array<{ file: string; width: number }> = [
	{ file: "icon-192.png", width: 192 },
	{ file: "icon-512.png", width: 512 },
	{ file: "apple-touch-icon.png", width: 180 },
];

for (const { file, width } of targets) {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	writeFileSync(join(publicDir, file), png);
	console.log(`gen-icons: wrote ${file} (${width}x${width})`);
}

const { TAGLINE } = await import("../src/lib/copy.js");
const escapedTagline = TAGLINE.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#F4F0E6"/><g fill="#071A2E" font-family="DejaVu Sans, sans-serif"><text x="80" y="100" font-size="30">Pelaggio</text><text x="80" y="320" font-size="88" letter-spacing="-4">${escapedTagline}</text><text x="80" y="390" font-size="26">From charter to pull request. With receipts.</text></g><path d="M80 490H1120" stroke="#0A6E60"/><text x="80" y="550" font-size="22" fill="#0A6E60" font-family="DejaVu Sans, sans-serif">pelaggio.com</text></svg>`;
writeFileSync(join(publicDir, "og.png"), new Resvg(og).render().asPng());
