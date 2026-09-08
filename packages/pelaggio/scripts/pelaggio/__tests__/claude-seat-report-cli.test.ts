import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClaudeSeatPreflight } from "../claude-seat.js";
import { runClaudeSeatReportCli } from "../claude-seat-report-cli.js";

function okPreflight(): ClaudeSeatPreflight {
	return {
		ok: true,
		launcher: { kind: "bubblewrap", path: "/usr/bin/bwrap" },
		report: {
			schemaVersion: 1,
			platform: "linux",
			launcherKind: "bubblewrap",
			preview: false,
			ok: true,
			probes: [
				{ name: "socket-connect", outcome: "pass", detail: "ENOENT" },
				{ name: "worktree-write", outcome: "pass", detail: "ok" },
				{ name: "tty", outcome: "pass", detail: "ENXIO" },
				{ name: "session", outcome: "pass", detail: "detached" },
				{ name: "github-config", outcome: "pass", detail: "ENOENT" },
			],
		},
	};
}

describe("claude-seat-report CLI", () => {
	it("prints usage on --help without running preflight", async () => {
		let called = false;
		let output = "";
		const status = await runClaudeSeatReportCli(["--help"], {
			preflight: async () => {
				called = true;
				return okPreflight();
			},
			stdout: (text) => {
				output += text;
			},
		});
		assert.equal(status, 0);
		assert.equal(called, false);
		assert.match(output, /claude-seat-report/);
		assert.match(output, /Not uploaded/);
	});

	it("prints a scrubbed JSON report and exits 0 on a passing preflight", async () => {
		let output = "";
		const status = await runClaudeSeatReportCli([], {
			preflight: async () => okPreflight(),
			stdout: (text) => {
				output += text;
			},
		});
		assert.equal(status, 0);
		const report = JSON.parse(output) as { ok: boolean; schemaVersion: number };
		assert.equal(report.ok, true);
		assert.equal(report.schemaVersion, 1);
		assert.equal(output.includes("/usr/bin/bwrap"), false);
		assert.equal(output.includes("/tmp/"), false);
	});

	it("prints the report and exits 1 when preflight fails closed", async () => {
		let stderr = "";
		let stdout = "";
		const status = await runClaudeSeatReportCli([], {
			preflight: async () => ({
				ok: false,
				message: "Claude seat isolation socket-connect probe reached the harness socket",
				report: {
					schemaVersion: 1,
					platform: "linux",
					launcherKind: "bubblewrap",
					preview: false,
					ok: false,
					probes: [{ name: "socket-connect", outcome: "fail", detail: "connected" }],
				},
			}),
			stdout: (text) => {
				stdout += text;
			},
			stderr: (text) => {
				stderr += text;
			},
		});
		assert.equal(status, 1);
		assert.match(stderr, /socket-connect probe reached the harness socket/);
		assert.equal(JSON.parse(stdout).ok, false);
	});

	it("rejects unknown options", async () => {
		let stderr = "";
		const status = await runClaudeSeatReportCli(["--upload"], {
			stderr: (text) => {
				stderr += text;
			},
		});
		assert.equal(status, 1);
		assert.match(stderr, /unknown option/);
	});
});
