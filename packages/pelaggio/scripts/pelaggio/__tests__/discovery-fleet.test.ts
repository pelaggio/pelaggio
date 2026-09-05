import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiscoveryFleetPlan, type DiscoveryCellInput, DiscoveryFleetPlanError, type DiscoveryResourceKey, type DiscoverySchedulingProfile, executeDiscoveryFleet } from "../review/discovery-fleet.js";
import type { ProviderName } from "../types.js";

const capacities: Readonly<Record<DiscoveryResourceKey, number>> = {
	"review:claude": 1,
	"review:codex": 1,
	"review:grok": 1,
	"review:opencode": 1,
};

const profiles = {
	claude: { claims: [{ key: "review:claude", units: 1 }], waitsForProviders: [] },
	codex: { claims: [{ key: "review:codex", units: 1 }], waitsForProviders: [] },
	grok: { claims: [{ key: "review:grok", units: 1 }], waitsForProviders: ["claude"] },
	opencode: { claims: [{ key: "review:opencode", units: 1 }], waitsForProviders: [] },
} satisfies Readonly<Record<ProviderName, DiscoverySchedulingProfile>>;

function cell(key: string, group: number, provider: ProviderName): DiscoveryCellInput<string> {
	return { key, group, provider, payload: key };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("discovery fleet", () => {
	it("overlaps independent resources and serializes cells sharing one", async () => {
		const cells = [cell("standard-codex", 0, "codex"), cell("standard-opencode", 0, "opencode"), cell("red-codex", 1, "codex")];
		const plan = buildDiscoveryFleetPlan({ cells, profiles, capacities, maxConcurrent: 2 });
		const codex = deferred<string>();
		const opencode = deferred<string>();
		const started: string[] = [];
		const running = executeDiscoveryFleet({
			plan,
			launch: ({ key }) => {
				started.push(key);
				return key === "standard-codex" ? codex.promise : key === "standard-opencode" ? opencode.promise : Promise.resolve(key);
			},
		});
		assert.deepEqual(started, ["standard-codex", "standard-opencode"]);
		codex.resolve("standard-codex");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(started, ["standard-codex", "standard-opencode", "red-codex"]);
		opencode.resolve("standard-opencode");
		assert.deepEqual(
			(await running).map((result) => result.status),
			["fulfilled", "fulfilled", "fulfilled"],
		);
	});

	it("keeps every grok cell behind every claude cell while codex overlaps", async () => {
		const cells = [cell("standard-claude", 0, "claude"), cell("standard-grok", 0, "grok"), cell("standard-codex", 0, "codex"), cell("red-claude", 1, "claude"), cell("red-grok", 1, "grok")];
		const plan = buildDiscoveryFleetPlan({ cells, profiles, capacities, maxConcurrent: 3 });
		const standardClaude = deferred<string>();
		const redClaude = deferred<string>();
		const started: string[] = [];
		const running = executeDiscoveryFleet({
			plan,
			launch: ({ key }) => {
				started.push(key);
				if (key === "standard-claude") return standardClaude.promise;
				if (key === "red-claude") return redClaude.promise;
				return Promise.resolve(key);
			},
		});
		assert.deepEqual(started, ["standard-claude", "standard-codex"]);
		standardClaude.resolve("standard-claude");
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(started.includes("red-claude"));
		assert.ok(!started.includes("standard-grok"));
		redClaude.resolve("red-claude");
		await running;
		assert.ok(started.indexOf("standard-grok") > started.indexOf("red-claude"));
		assert.ok(started.indexOf("red-grok") > started.indexOf("red-claude"));
	});

	it("finishes the stopping group, skips later pending groups, and settles started siblings", async () => {
		const cells = [cell("standard-codex", 0, "codex"), cell("standard-opencode", 0, "opencode"), cell("red-codex", 1, "codex")];
		const plan = buildDiscoveryFleetPlan({ cells, profiles, capacities, maxConcurrent: 2 });
		const sibling = deferred<string>();
		const started: string[] = [];
		const settled = await executeDiscoveryFleet({
			plan,
			launch: async ({ key }) => {
				started.push(key);
				if (key === "standard-opencode") return sibling.promise;
				await Promise.resolve();
				sibling.resolve("standard-opencode");
				return key;
			},
			shouldStop: ({ key }) => key === "standard-codex",
		});
		assert.deepEqual(started, ["standard-codex", "standard-opencode"]);
		assert.deepEqual(
			settled.map((result) => result.status),
			["fulfilled", "fulfilled", "not-started"],
		);
	});

	it("captures synchronous throws and preserves stable slots", async () => {
		const cells = [cell("first", 0, "codex"), cell("second", 0, "opencode")];
		const plan = buildDiscoveryFleetPlan({ cells, profiles, capacities, maxConcurrent: 2 });
		const settled = await executeDiscoveryFleet({
			plan,
			launch: ({ key }) => {
				if (key === "first") throw new Error("boom");
				return Promise.resolve(key);
			},
		});
		assert.equal(settled[0]?.status, "rejected");
		assert.deepEqual(settled[1], { status: "fulfilled", value: "second" });
	});

	it("rejects invalid plans before launch", () => {
		const invalidProfiles = {
			...profiles,
			codex: { claims: [{ key: "review:missing" as DiscoveryResourceKey, units: 1 }], waitsForProviders: [] },
		} satisfies Readonly<Record<ProviderName, DiscoverySchedulingProfile>>;
		assert.throws(() => buildDiscoveryFleetPlan({ cells: [cell("only", 0, "codex")], profiles: invalidProfiles, capacities, maxConcurrent: 1 }), DiscoveryFleetPlanError);
	});

	it("rejects dependency cycles and duplicate identities", () => {
		const cyclic = {
			...profiles,
			codex: { claims: profiles.codex.claims, waitsForProviders: ["grok"] },
			grok: { claims: profiles.grok.claims, waitsForProviders: ["codex"] },
		} satisfies Readonly<Record<ProviderName, DiscoverySchedulingProfile>>;
		assert.throws(() => buildDiscoveryFleetPlan({ cells: [cell("codex", 0, "codex"), cell("grok", 0, "grok")], profiles: cyclic, capacities, maxConcurrent: 2 }), /dependency cycle/);
		assert.throws(() => buildDiscoveryFleetPlan({ cells: [cell("same", 0, "codex"), cell("same", 1, "opencode")], profiles, capacities, maxConcurrent: 2 }), /duplicate discovery cell key/);
	});
});
