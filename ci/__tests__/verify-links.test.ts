import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkFile, findMarkdownFiles, runLinkGate } from "../verify-links.js";

describe("markdown link gate", () => {
	it("passes when internal links resolve", () => {
		const root = writeDocs({
			"README.md": "See [target](./target.md) and [reference](./sub/ref.md).",
			"target.md": "target",
			"sub/ref.md": "ref",
		});
		assert.equal(runLinkGate(root), 0);
	});

	it("fails on a dead internal link", () => {
		const root = writeDocs({
			"README.md": "See [missing](./missing.md).",
		});
		assert.equal(runLinkGate(root), 1);
	});

	it("ignores external links, mailto links, and bare anchors", () => {
		const file = writeSingleFile("[site](https://example.com/x) [mail](mailto:a@example.com) [anchor](#section)");
		assert.deepEqual(checkFile(file), []);
	});

	it("resolves a link's fragment against the file on disk", () => {
		const root = writeDocs({
			"README.md": "See [target](./target.md#some-heading).",
			"target.md": "target",
		});
		assert.equal(runLinkGate(root), 0);
	});

	it("resolves a leading-slash link against the repo root, not the filesystem root", () => {
		const root = writeDocs({
			"README.md": "See [target](/sub/target.md).",
			"sub/target.md": "target",
		});
		assert.deepEqual(checkFile(join(root, "README.md"), root), []);
	});

	it("fails a leading-slash link whose repo-root-relative target is missing", () => {
		const root = writeDocs({
			"README.md": "See [missing](/sub/missing.md).",
		});
		const [broken] = checkFile(join(root, "README.md"), root);
		assert.equal(broken.target, "/sub/missing.md");
	});

	it("reports the file and line number of a broken link", () => {
		const root = writeDocs({
			"README.md": "intro\n\nSee [missing](./missing.md).\n",
		});
		const [broken] = checkFile(join(root, "README.md"));
		assert.equal(broken.line, 3);
		assert.equal(broken.target, "./missing.md");
	});

	it("finds markdown files recursively", () => {
		const root = writeDocs({
			"README.md": "top",
			"sub/nested.md": "nested",
		});
		const files = findMarkdownFiles(root)
			.map((file) => file.slice(root.length + 1))
			.sort();
		assert.deepEqual(files, ["README.md", join("sub", "nested.md")]);
	});
});

function writeDocs(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "link-gate-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

function writeSingleFile(content: string): string {
	return join(writeDocs({ "README.md": content }), "README.md");
}
