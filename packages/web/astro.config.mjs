import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const SERVER_URL = process.env.AUTOPILOT_SERVER_URL ?? "http://127.0.0.1:7777";
const PROXY_PATHS = ["/runs", "/repos", "/roadmap", "/stats", "/healthz"];

const proxy = Object.fromEntries(PROXY_PATHS.map((p) => [p, { target: SERVER_URL, changeOrigin: true, ws: true }]));

export default defineConfig({
	output: "static",
	base: "/ui/",
	trailingSlash: "always",
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
		server: { proxy },
	},
});
