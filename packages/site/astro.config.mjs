import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	trailingSlash: "never",
	site: process.env.SITE_ORIGIN || "https://pelaggio.com",
	base: process.env.SITE_BASE || "/",
	vite: {
		plugins: [tailwindcss()],
	},
});
