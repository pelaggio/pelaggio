import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadRegistry, Registry, RegistryError } from "../src/registry.js";

function tmpFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "registry-"));
	const file = join(dir, "repos.yml");
	writeFileSync(file, contents);
	return file;
}

describe("loadRegistry — parse", () => {
	it("valid map of slug → absolute path", () => {
		const file = tmpFile("repos:\n  foo: /tmp/a\n  bar: /tmp/b\n");
		const registry = loadRegistry(file);
		assert.deepEqual(registry.entries(), [
			{ slug: "foo", path: "/tmp/a" },
			{ slug: "bar", path: "/tmp/b" },
		]);
	});

	it("relative paths are resolved to absolute", () => {
		const file = tmpFile("repos:\n  foo: ./relative\n");
		const registry = loadRegistry(file);
		const entry = registry.entries()[0];
		assert.ok(entry?.path.startsWith("/"), `expected absolute path, got ${entry?.path}`);
	});

	it("missing file → throws with path and example hint", () => {
		const dir = mkdtempSync(join(tmpdir(), "registry-"));
		const missing = join(dir, "no-such-file.yml");
		assert.throws(
			() => loadRegistry(missing),
			(err: Error) => err.message.includes(missing) && err.message.includes("infra/autopilot-server/repos.yml.example"),
		);
	});

	it("empty file → throws", () => {
		const file = tmpFile("");
		assert.throws(() => loadRegistry(file), /empty file/);
	});

	it("malformed YAML → throws with file path", () => {
		const file = tmpFile("repos:\n  foo: /tmp/a\n bad indent\n");
		assert.throws(
			() => loadRegistry(file),
			(err: Error) => err.message.includes(file),
		);
	});

	it("top-level not a map → throws", () => {
		const file = tmpFile("- foo\n- bar\n");
		assert.throws(() => loadRegistry(file), /map at the top level/);
	});

	it("missing `repos:` key → throws", () => {
		const file = tmpFile("other: 1\n");
		assert.throws(() => loadRegistry(file), /missing `repos:` key/);
	});

	it("`repos:` value not a map → throws", () => {
		const file = tmpFile("repos: not-a-map\n");
		assert.throws(() => loadRegistry(file), /`repos` must be a map/);
	});

	it("entry value not a string → throws naming the slug", () => {
		const file = tmpFile("repos:\n  foo: 42\n");
		assert.throws(() => loadRegistry(file), /repos\.foo/);
	});

	it("basename collision warns once per collision but constructs successfully", (t) => {
		const file = tmpFile("repos:\n  prod: /a/foo\n  staging: /b/foo\n");
		const warn = t.mock.method(console, "warn");
		const registry = loadRegistry(file);
		assert.equal(registry.entries().length, 2);
		assert.equal(warn.mock.callCount(), 1);
		const msg = String(warn.mock.calls[0]?.arguments[0] ?? "");
		assert.match(msg, /"prod"/);
		assert.match(msg, /"staging"/);
		assert.match(msg, /"foo"/);
	});

	it("entries() preserves insertion order", () => {
		const file = tmpFile("repos:\n  z: /tmp/z\n  a: /tmp/a\n  m: /tmp/m\n");
		const registry = loadRegistry(file);
		assert.deepEqual(
			registry.entries().map((e) => e.slug),
			["z", "a", "m"],
		);
	});
});

describe("Registry — lookup", () => {
	it("path(known) returns absolute path", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		assert.equal(registry.path("main"), "/tmp/main");
	});

	it("path(unknown) throws RegistryError with code unknown-slug", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		assert.throws(
			() => registry.path("missing"),
			(err: unknown) => err instanceof RegistryError && err.code === "unknown-slug",
		);
	});

	it("has() reflects known/unknown slugs", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		assert.equal(registry.has("main"), true);
		assert.equal(registry.has("nope"), false);
	});
});
