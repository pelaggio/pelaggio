import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG, resolveProviderBin } from "../config.js";
import { GROK_EGRESS_ENDPOINT, runStep } from "../grok-provider.js";
import { buildGrokArgs, GROK_SANDBOX_BEGIN, GROK_SANDBOX_BLOCK, GROK_SANDBOX_END, GROK_SANDBOX_PROFILE, installGrokSandboxProfile } from "../grok-sandbox.js";

async function temporaryHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pelaggio-grok-sandbox-"));
}

describe("installGrokSandboxProfile", () => {
	it("creates the exact managed profile with mode 0600", async () => {
		const home = await temporaryHome();
		assert.equal(await installGrokSandboxProfile({ home }), GROK_SANDBOX_PROFILE);
		const path = join(home, ".grok", "sandbox.toml");
		assert.equal(await readFile(path, "utf8"), `${GROK_SANDBOX_BLOCK}\n`);
		assert.equal((await lstat(path)).mode & 0o777, 0o600);
	});

	it("preserves unrelated bytes and is byte-idempotent", async () => {
		const home = await temporaryHome();
		const dir = join(home, ".grok");
		const path = join(dir, "sandbox.toml");
		await mkdir(dir);
		const original = '[profiles.mine]\nextends = "permissive"\n';
		await writeFile(path, original, { mode: 0o640 });
		await installGrokSandboxProfile({ home });
		const installed = await readFile(path, "utf8");
		assert.equal(installed, `${original}\n${GROK_SANDBOX_BLOCK}\n`);
		await installGrokSandboxProfile({ home });
		assert.equal(await readFile(path, "utf8"), installed);
		assert.equal((await lstat(path)).mode & 0o777, 0o640);
	});

	it("replaces an obsolete managed block exactly once", async () => {
		const home = await temporaryHome();
		const path = join(home, ".grok", "sandbox.toml");
		await mkdir(join(home, ".grok"));
		await writeFile(path, `before\n${GROK_SANDBOX_BEGIN}\nold = true\n${GROK_SANDBOX_END}\nafter\n`);
		await installGrokSandboxProfile({ home });
		assert.equal(await readFile(path, "utf8"), `before\n${GROK_SANDBOX_BLOCK}\nafter\n`);
	});

	it("fails closed on missing HOME, bad markers, and an outside same-name profile", async () => {
		await assert.rejects(installGrokSandboxProfile(), /HOME/);
		for (const content of [`${GROK_SANDBOX_BEGIN}\n`, `${GROK_SANDBOX_BEGIN}\n${GROK_SANDBOX_END}\n${GROK_SANDBOX_BEGIN}\n${GROK_SANDBOX_END}\n`, `[profiles.${GROK_SANDBOX_PROFILE}]\nextends = "strict"\n`]) {
			const home = await temporaryHome();
			const path = join(home, ".grok", "sandbox.toml");
			await mkdir(join(home, ".grok"));
			await writeFile(path, content);
			await assert.rejects(installGrokSandboxProfile({ home }));
			assert.equal(await readFile(path, "utf8"), content);
		}
	});

	it("rejects symlink and directory destinations without temporary residue", async () => {
		for (const kind of ["symlink", "directory"] as const) {
			const home = await temporaryHome();
			const dir = join(home, ".grok");
			const path = join(dir, "sandbox.toml");
			await mkdir(dir);
			if (kind === "symlink") {
				await writeFile(join(home, "target"), "safe");
				await symlink(join(home, "target"), path);
			} else await mkdir(path);
			await assert.rejects(installGrokSandboxProfile({ home }), /not a regular file/);
			assert.equal(
				(await readdir(dir)).some((name) => name.includes("pelaggio-tmp")),
				false,
			);
		}
	});

	it("leaves the destination intact when publication fails", async () => {
		const home = await temporaryHome();
		const dir = join(home, ".grok");
		const path = join(dir, "sandbox.toml");
		await mkdir(dir);
		await writeFile(path, "original\n");
		await chmod(dir, 0o500);
		try {
			if (process.getuid?.() === 0) return;
			await assert.rejects(installGrokSandboxProfile({ home }));
			assert.equal(await readFile(path, "utf8"), "original\n");
		} finally {
			await chmod(dir, 0o700);
		}
	});
});

describe("buildGrokArgs", () => {
	it("places all global confinement/model flags before agent stdio", () => {
		assert.deepEqual(buildGrokArgs({ model: "grok-4", reasoningEffort: "high" }), ["--sandbox", GROK_SANDBOX_PROFILE, "--disable-web-search", "-m", "grok-4", "--reasoning-effort", "high", "agent", "stdio"]);
		assert.equal(buildGrokArgs({ reasoningEffort: "low" }).includes("-m"), false);
	});
});

describe("live Grok 0.2.103 confinement", () => {
	it("denies outside-worktree access and child egress while locking in-process destinations", { skip: process.env.PELAGGIO_GROK_LIVE_CONFORMANCE !== "1" }, async () => {
		const capturePath = process.env.PELAGGIO_GROK_NETWORK_CAPTURE;
		assert.ok(capturePath, "PELAGGIO_GROK_NETWORK_CAPTURE must name the operator-produced capture artifact from this run");
		const home = process.env.HOME;
		assert.ok(home, "HOME is required");
		await access(join(home, ".grok", "auth.json"));
		const version = execFileSync(resolveProviderBin(CONFIG, "grok", "grok"), ["--version"], { encoding: "utf8" });
		assert.match(version, /\b0\.2\.103\b/, `live confinement is pinned to Grok 0.2.103, got: ${version.trim()}`);
		const root = await temporaryHome();
		const worktree = join(root, "worktree");
		const sibling = join(root, "outside");
		await mkdir(worktree);
		await mkdir(sibling);
		const canary = join(sibling, "canary.txt");
		const outsideWrite = join(sibling, "created.txt");
		await writeFile(canary, "TOP-SECRET-CANARY");
		const events: unknown[] = [];
		const result = await runStep(
			"implement",
			[`Use shell commands to try reading ${canary} and writing ${outsideWrite}.`, `Also try shell-network requests to https://${GROK_EGRESS_ENDPOINT} and https://example.com.`, "Report the command failures and make no other changes."].join(
				"\n",
			),
			{ cwd: worktree, profile: "standard", trace: false, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" } },
			(event) => events.push(event),
		);
		assert.equal(result.ok, true, JSON.stringify(events));
		assert.equal(await readFile(canary, "utf8"), "TOP-SECRET-CANARY");
		await assert.rejects(access(outsideWrite));
		const fixture = JSON.parse(await readFile(new URL("./fixtures/grok-egress-v1.json", import.meta.url), "utf8")) as { destinations: string[] };
		const capture = await readFile(capturePath, "utf8");
		const destinations = [...new Set(capture.toLowerCase().match(/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/g) ?? [])].sort();
		assert.deepEqual(fixture.destinations, [GROK_EGRESS_ENDPOINT]);
		assert.deepEqual(destinations, fixture.destinations);
	});
});
