import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const svg = readFileSync(join(publicDir, "icon.svg"));
const maskable = readFileSync(join(publicDir, "icon-maskable.svg"));

const targets: Array<{ file: string; width: number; source: Buffer }> = [
	{ file: "icon-192.png", width: 192, source: svg },
	{ file: "icon-512.png", width: 512, source: maskable },
	{ file: "apple-touch-icon.png", width: 180, source: svg },
	{ file: "mark.png", width: 512, source: svg },
];

for (const { file, width, source } of targets) {
	const png = new Resvg(source, { fitTo: { mode: "width", value: width } }).render().asPng();
	writeFileSync(join(publicDir, file), png);
	console.log(`gen-icons: wrote ${file} (${width}x${width})`);
}
