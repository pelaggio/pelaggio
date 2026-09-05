import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	trailingSlash: "never",
	site: "https://pelaggio.com",
	vite: {
		plugins: [tailwindcss()],
	},
});
