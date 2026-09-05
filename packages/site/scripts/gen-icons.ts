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
