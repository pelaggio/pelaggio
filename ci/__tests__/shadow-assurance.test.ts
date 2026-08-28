import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { type AssuranceGraph, adrMapFromSources, diagnostics } from "../assurance-views.ts";

const repo = resolve(new URL("../..", import.meta.url).pathname);
type ShadowNode = {
	id: string;
	kind: string;
	role?: string;
	visibility?: string;
	slug?: string;
	statement: string;
	status?: string;
	externalId?: string;
	projection?: { status?: string; scope?: string };
	sources?: string[];
	codeEvidence?: string[];
	wrongIf?: string;
};
type ShadowGraph = {
	status: string;
	authority: string;
	nodeKinds: string[];
	propositionRoles: string[];
	relationKinds: Record<string, { from: string[]; to: string[] }>;
	nodes: ShadowNode[];
	edges: Array<{ from: string; relation: string; to: string }>;
	adrMap: Record<string, string[]>;
	sourceGrounding: Array<{ node: string; path: string; anchors: string[] }>;
	invariantIndex: { entries: Array<{ anchor: string; nodes?: string[]; construction?: string }> };
};
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as ShadowGraph;
const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const edges = graph.edges as Array<{ from: string; relation: string; to: string }>;

function node(id: string) {
	const value = nodes.get(id);
	assert.ok(value, `missing node ${id}`);
	return value;
}

function outgoing(id: string, relation?: string) {
	return edges.filter((edge) => edge.from === id && (!relation || edge.relation === relation));
}

function incoming(id: string, relation?: string) {
	return edges.filter((edge) => edge.to === id && (!relation || edge.relation === relation));
}

function mapped(adr: string) {
	const value = graph.adrMap[adr];
	assert.ok(Array.isArray(value), `missing ADR map for ${adr}`);
	return value as string[];
}

describe("shadow assurance graph integrity", () => {
	it("has a minimal base ontology, stable ids, and type-correct edges", () => {
		assert.deepEqual(graph.nodeKinds, ["proposition", "decision", "realization"]);
		assert.deepEqual(graph.propositionRoles, ["invariant", "constraint", "assumption"]);
		assert.equal(nodes.size, graph.nodes.length, "node IDs must be unique");

		for (const value of graph.nodes) {
			assert.ok(graph.nodeKinds.includes(value.kind), `unknown node kind ${value.kind} on ${value.id}`);
			if (value.kind === "proposition") assert.ok(graph.propositionRoles.includes(value.role), `${value.id} needs a valid proposition role`);
		}

		for (const edge of edges) {
			const from = node(edge.from);
			const to = node(edge.to);
			const contract = graph.relationKinds[edge.relation];
			assert.ok(contract, `unknown edge relation ${edge.relation}`);
			assert.ok(contract.from.includes(from.kind), `${edge.relation} cannot originate at ${from.kind} ${from.id}`);
			assert.ok(contract.to.includes(to.kind), `${edge.relation} cannot target ${to.kind} ${to.id}`);
			if (edge.relation === "constrains") assert.equal(from.role, "constraint", `${from.id} constrains but is not a constraint proposition`);
			if (edge.relation === "assumes") assert.equal(to.role, "assumption", `${to.id} is assumed but is not an assumption proposition`);
			if (edge.relation === "projects") assert.equal(from.visibility, "public", `${from.id} projects but is not a public proposition`);
		}
	});

	it("covers every ADR file that exists", () => {
		const adrFiles = readdirSync(resolve(repo, "docs/decisions"))
			.map((name) => name.match(/^(\d{4})-.*\.md$/)?.[1])
			.filter((id): id is string => Boolean(id));
		assert.ok(adrFiles.length > 0, "expected numbered ADR files");
		for (const id of adrFiles) {
			const adr = `ADR-${id}`;
			assert.ok(mapped(adr).length > 0, `${adr} must map to at least one primitive`);
			for (const nodeId of mapped(adr)) assert.ok(nodes.has(nodeId), `${adr} references missing node ${nodeId}`);
		}
	});

	it("adrMap is generated from node sources — a stale stored copy fails, and the generator is the only writer", () => {
		// ADR-0027 decision 9: the ADR -> primitive relation is authored once, on the node's `sources`;
		// `node --import tsx ci/assurance-views.ts --write` regenerates adrMap. A hand edit that disagrees fails.
		assert.deepEqual(graph.adrMap, adrMapFromSources(graph), "run node --import tsx ci/assurance-views.ts --write to regenerate adrMap");
	});

	it("keeps shadow extraction non-authoritative", () => {
		assert.equal(graph.status, "shadow");
		assert.match(graph.authority, /non-authoritative/i);
	});

	it("grounds high-risk semantic cuts in independent source text", () => {
		for (const grounding of graph.sourceGrounding) {
			const path = resolve(repo, grounding.path);
			assert.ok(existsSync(path), `grounding source must exist: ${grounding.path}`);
			const text = readFileSync(path, "utf8");
			for (const anchor of grounding.anchors) {
				assert.ok(text.includes(anchor), `${grounding.node} lost source anchor '${anchor}' in ${grounding.path}`);
			}
		}
	});

	it("does not false-fire source-grounding on intent-preserving edits, and still fires when a unique anchor is removed", () => {
		const table: Record<string, { snippet: string; replacement: string }> = {
			"docs/decisions/0001-worktree-write-confinement.md": {
				snippet: "Enumerated main and sibling roots are in scope",
				replacement: "Main and sibling roots that are enumerated stay in scope",
			},
			"docs/decisions/0012-readiness-computed-not-groomed.md": {
				snippet: "the harness computes readiness on-read and refines by escalation",
				replacement: "the harness computes readiness on-read and refines it by escalation",
			},
			"docs/decisions/0014-mechanism-policy-separation-spine.md": {
				snippet: "they meet only at a typed, fail-closed, capability-denied seam",
				replacement: "they meet only at a typed, fail-closed, capability-denied boundary",
			},
			"docs/decisions/0016-severity-taxonomy-and-owner.md": {
				snippet: "a finding whose class is uncertain is treated as safety-class",
				replacement: "a finding whose class is uncertain is treated as a safety-class finding",
			},
			"docs/decisions/0017-graceful-degradation-rigor-only.md": {
				snippet: "it is still inside the deterministic gate",
				replacement: "it remains inside the deterministic gate",
			},
			"docs/decisions/0022-pipeline-shape-and-review-orchestrators.md": {
				snippet: "outside the mutable `step()` checkpoint/effects lifecycle",
				replacement: "outside the mutable `step()` checkpoint and effects lifecycle",
			},
			"docs/decisions/0024-adversarial-authoring-review-loop.md": {
				snippet: "voids the blind-spot guarantee",
				replacement: "voids the blind-spot promise",
			},
			"docs/decisions/0026-stateful-guards-fence-reconcile-and-gate-disposition.md": {
				snippet: "may reduce contention but cannot replace a fence/reconciler",
				replacement: "may reduce contention but cannot stand in for a fence/reconciler",
			},
			"docs/decisions/0027-machine-readable-architectural-intent-graph.md": {
				snippet: "must not require reconciliation across independent prose registries",
				replacement: "must not need reconciliation across independent prose registries",
			},
			"docs/decisions/0028-delivery-packet-claim-scoped-provenance.md": {
				snippet: "no bolt-on gives an agent-landed, review-excluded file real integrity",
				replacement: "no bolt-on gives an agent-landed, review-excluded file genuine integrity",
			},
			"docs/trust/trust-claims.yml": {
				snippet: "publish.yml verifies an SSH-signed tag",
				replacement: "publish.yml checks an SSH-signed tag",
			},
		};
		const livePaths = [...new Set(graph.sourceGrounding.map((g) => g.path))].sort();
		assert.deepEqual(Object.keys(table).sort(), livePaths, "mutation table must cover every live grounded source, and no others");

		const mutated = new Map<string, string>();
		for (const [path, { snippet, replacement }] of Object.entries(table)) {
			const original = readFileSync(resolve(repo, path), "utf8");
			assert.equal(original.split(snippet).length, 2, `${path}: snippet must occur exactly once`);
			const pathAnchors = graph.sourceGrounding.filter((g) => g.path === path).flatMap((g) => g.anchors);
			for (const anchor of pathAnchors) {
				assert.ok(!snippet.includes(anchor) && !anchor.includes(snippet), `${path}: snippet overlaps live anchor '${anchor}'`);
			}
			assert.ok(original.includes(snippet), `${path}: snippet missing from source`);
			const append = path.endsWith(".yml")
				? "\n# Additional rationale for a construction-only edit that does not change architectural intent.\n"
				: "\n\nThis paragraph records additional rationale for a construction-only edit that does not change architectural intent.\n";
			const next = `${original.replace(snippet, replacement)}${append}`;
			assert.notEqual(next, original, `${path}: mutation must change the source`);
			mutated.set(path, next);
		}

		for (const grounding of graph.sourceGrounding) {
			const text = mutated.get(grounding.path);
			assert.ok(text !== undefined, `mutated map missing ${grounding.path}`);
			for (const anchor of grounding.anchors) {
				assert.ok(text.includes(anchor), `${grounding.node} lost source anchor '${anchor}' after intent-preserving mutation of ${grounding.path}`);
			}
		}

		const readSource = (path: string) => mutated.get(path);
		const env = { sourceGrounding: graph.sourceGrounding, readSource };
		assert.ok(!diagnostics(graph, env).some((d) => d.check === "stale-source-grounding"), "intent-preserving edits must not emit stale-source-grounding");
		assert.deepEqual(adrMapFromSources(graph), graph.adrMap);

		const clone = structuredClone(graph);
		const ctr = clone.nodes.find((n) => n.id === "CTR-0022");
		assert.ok(ctr?.codeEvidence, "CTR-0022 must carry code evidence");
		const evidenceIdx = ctr.codeEvidence.indexOf("ci/assurance-views.ts");
		assert.ok(evidenceIdx >= 0, "CTR-0022 must name ci/assurance-views.ts so the path-change case can retarget a sibling");
		ctr.codeEvidence[evidenceIdx] = "ci/__tests__/assurance-views.test.ts";
		assert.deepEqual(adrMapFromSources(clone), adrMapFromSources(graph), "realization-only codeEvidence path change must not move adrMap");

		const trueFirePath = "docs/decisions/0001-worktree-write-confinement.md";
		const uniqueAnchor = "hard gate on observed effect";
		const trueFireSource = mutated.get(trueFirePath);
		assert.ok(trueFireSource, `mutated map missing ${trueFirePath}`);
		assert.equal(trueFireSource.split(uniqueAnchor).length, 2, `${uniqueAnchor} must be unique in the mutated source`);
		const trueFireText = trueFireSource.replace(uniqueAnchor, "");
		const trueFireRead = (path: string) => (path === trueFirePath ? trueFireText : mutated.get(path));
		assert.ok(
			diagnostics(graph, { sourceGrounding: graph.sourceGrounding, readSource: trueFireRead }).some((d) => d.check === "stale-source-grounding" && d.node === "CLM-0002" && d.message.includes(trueFirePath)),
			"removing a unique live anchor through the same env assembly must emit stale-source-grounding for that grounding",
		);
	});

	it("ties realizations to code/tests without putting code paths on propositions", () => {
		for (const value of graph.nodes) {
			if (value.kind === "realization") {
				assert.ok(Array.isArray(value.codeEvidence) && value.codeEvidence.length > 0, `${value.id} realization needs code evidence`);
				for (const path of value.codeEvidence) assert.ok(existsSync(resolve(repo, path)), `${value.id} code evidence missing: ${path}`);
			} else if (value.kind === "proposition") {
				assert.equal(value.codeEvidence, undefined, `${value.id} proposition must not own brittle code locations`);
			}
		}
	});
});

describe("architectural question tests", () => {
	it("Q1: removing ADR-0022 topology preserves independent evaluation", () => {
		assert.ok(mapped("ADR-0022").includes("CLM-0016"));
		assert.equal(node("CLM-0016").role, "invariant");
		assert.equal(node("CTR-0001").kind, "realization");
		assert.equal(node("CTR-0002").kind, "realization");
		// The topology is a current construction choice, not durable intent: ADR-0022 is accepted and
		// unamended, so the graph may not label it historical or under reconsideration without a source.
		assert.equal(node("DEC-0012").status, "current-construction-choice");
		assert.deepEqual(
			outgoing("DEC-0012", "implements").map((e) => e.to),
			["CLM-0016"],
		);
	});

	it("Q2: N+Judge is strategy resting on an empirical assumption proposition", () => {
		assert.equal(node("DEC-0014").kind, "decision");
		assert.equal(node("CTR-0003").kind, "realization");
		assert.equal(node("ASM-0002").kind, "proposition");
		assert.equal(node("ASM-0002").role, "assumption");
		assert.ok(outgoing("DEC-0014", "implements").some((e) => e.to === "CLM-0016"));
		assert.ok(outgoing("DEC-0014", "assumes").some((e) => e.to === "ASM-0002"));
		assert.match(node("ASM-0002").statement, /justify its incremental cost/i);
	});

	it("Q3: landing authority is constrained by ordering-not-authority and positive completion", () => {
		const constraints = incoming("CLM-0007", "constrains")
			.map((edge) => edge.from)
			.sort();
		assert.ok(constraints.includes("CON-0004"));
		assert.ok(constraints.includes("CON-0009"));
		assert.equal(node("CON-0004").role, "constraint");
		assert.ok(outgoing("CLM-0007", "specializes").some((e) => e.to === "CLM-0006"));
	});

	it("Q4: principal authority is not conflated with deterministic safety enforcement", () => {
		assert.equal(node("CLM-0006").slug, "no-self-authorization");
		assert.equal(node("CLM-0019").slug, "deterministic-safety-floor");
		assert.ok(outgoing("CLM-0019", "specializes").some((e) => e.to === "CLM-0006"));
		assert.match(node("CLM-0006").statement, /authority independent of that worker/i);
		assert.match(node("CLM-0019").statement, /deterministic/i);
	});

	it("Q5: every trust-registry record is a scoped public proposition — enumerated from the registry, not the graph", () => {
		const registry = [...claimAssuranceStatus().keys()];
		assert.ok(registry.length >= 15, "expected the full trust-claims.yml registry");
		for (const id of registry) {
			assert.equal(node(id).kind, "proposition", `${id} is published in trust-claims.yml but absent from the graph`);
			assert.equal(node(id).role, "invariant");
			assert.equal(node(id).visibility, "public");
			assert.equal(node(id).externalId, id);
			assert.equal(node(id).projection?.status, claimAssuranceStatus().get(id), `${id} projection status must mirror the registry`);
		}
		assert.ok(outgoing("TC-005", "projects").some((e) => e.to === "CLM-0008"));
		assert.equal(node("TC-005").projection.status, "best_effort");
		assert.equal(node("TC-013").projection.status, "planned");
		assert.ok(!graph.nodeKinds.includes("external-claim"));
	});

	it("Q6: interruption recovery rejects deterministic LLM replay as a requirement", () => {
		assert.equal(node("CLM-0012").kind, "proposition");
		assert.equal(node("CLM-0012").role, "invariant");
		assert.ok(incoming("CLM-0012", "constrains").some((e) => e.from === "CON-0014"));
		assert.ok(outgoing("DEC-0009", "implements").some((e) => e.to === "CLM-0012"));
	});

	it("Q7: safety degradation and rigor degradation remain distinguishable", () => {
		assert.match(node("CON-0010").statement, /security boundary never silently weakens/i);
		assert.ok(incoming("CLM-0013", "constrains").some((e) => e.from === "CON-0010"));
		assert.ok(incoming("CLM-0002", "constrains").some((e) => e.from === "CON-0010"));
	});

	it("Q8: assumptions are proposition roles rather than policy preferences or base classes", () => {
		const assumptions = graph.nodes.filter((n) => n.kind === "proposition" && n.role === "assumption");
		assert.equal(assumptions.length, 4);
		assert.ok(!graph.nodeKinds.includes("assumption"));
		assert.equal(node("DEC-0017").slug, "rigor-by-consequence");
		assert.equal(node("DEC-0018").slug, "human-value-judgment-at-charter");
		assert.equal(node("CON-0024").role, "assumption", "stable IDs do not encode proposition roles");
		assert.match(node("CON-0024").statement, /kernel can accommodate attributable actors/i);
		assert.match(node("CON-0024").wrongIf ?? "", /first real custody query/i);
		assert.ok(outgoing("DEC-0019", "assumes").some((edge) => edge.to === "CON-0024"));
	});

	it("Q9: N+Judge can disappear without deleting blocker persistence or custody intent", () => {
		const implemented = outgoing("DEC-0014", "implements").map((edge) => edge.to);
		assert.ok(implemented.includes("CLM-0016"));
		assert.ok(implemented.includes("CLM-0009"));
		assert.ok(mapped("ADR-0024").includes("CLM-0008"));
		assert.ok(mapped("ADR-0024").includes("CLM-0009"));
	});

	it("Q10: every realization exists to implement or derive from a decision/proposition", () => {
		const realizations = graph.nodes.filter((n) => n.kind === "realization");
		for (const realization of realizations) {
			const semanticEdges = outgoing(realization.id).filter((e) => e.relation === "implements" || e.relation === "derived-from");
			assert.ok(semanticEdges.length > 0, `${realization.id} is orphan machinery with no articulated purpose`);
		}
	});

	/**
	 * Projection status decides whether a published claim OWES a mechanism. `trust-claims.yml` is the
	 * authority — read, never duplicated here — because a claim published as `planned` or
	 * `best_effort` is honestly saying the mechanism does not fully exist yet. Demanding one anyway
	 * would fire on correct, intentionally-unimplemented state: an over-refusal under the
	 * `guarded-actions.md` §8.1 bar, which requires a gate to refuse the violating dimension only.
	 */
	function claimAssuranceStatus(): Map<string, string> {
		const source = readFileSync(resolve(repo, "docs/trust/trust-claims.yml"), "utf8");
		const status = new Map<string, string>();
		let current = "";
		for (const line of source.split("\n")) {
			const id = line.match(/^\s*-\s+id:\s*(TC-\d+)/);
			if (id) current = id[1];
			const value = line.match(/^\s*status:\s*(\S+)/);
			if (value && current !== "") {
				status.set(current, value[1]);
				current = "";
			}
		}
		return status;
	}

	/**
	 * `guarantee`-status claims that name no implementing realization TODAY. The FROZEN set is the
	 * ceiling: the live list may only lose members (linking a claim removes it) and may never gain one,
	 * so a newly published guarantee with no mechanism fails here and cannot be waved through by
	 * editing the baseline. History: 6 over the eight claims the graph first carried; enumerating the
	 * full registry (Q5) added four guarantees; naming the mechanisms that exist (CTR-0006..0012)
	 * left TC-002 — an absence claim ("no telemetry") with no mechanism to name.
	 */
	const FROZEN_UNLINKED_GUARANTEES = new Set(["TC-002", "TC-003", "TC-017"]);

	it("Q14: a published GUARANTEE names the mechanism that implements it", () => {
		const status = claimAssuranceStatus();
		const published = graph.nodes.filter((n) => n.kind === "proposition" && n.visibility === "public");
		assert.ok(published.length > 0, "expected public trust propositions in the graph");
		let checked = 0;
		const unlinked: string[] = [];
		for (const claim of published) {
			// No false fire: `planned` / `best_effort` claims are honest about an absent mechanism.
			if (status.get(claim.id) !== "guarantee") continue;
			checked++;
			if (incoming(claim.id, "implements").length === 0) unlinked.push(claim.id);
		}
		assert.ok(checked > 0, "no guarantee-status claims were checked — the status parse is broken");
		// Q10 checks realization -> purpose; a proposition with ZERO realizations passes it trivially.
		// This is the inverse direction. The live unlinked set is COMPUTED from the graph; the only
		// constant is the frozen ceiling, so admitting a new unlinked guarantee requires editing that
		// set here — a visible, reviewable diff — rather than passing silently.
		for (const id of unlinked) assert.ok(FROZEN_UNLINKED_GUARANTEES.has(id), `${id} publishes an unconditional guarantee with no implementing realization and is not in the frozen baseline`);
		assert.deepEqual(unlinked, ["TC-002"], "the current unlinked-guarantee set (update when a mechanism is named; it may only shrink)");
		assert.equal(checked, [...status.values()].filter((v) => v === "guarantee").length, "every registry guarantee was checked, not only the ones the graph happened to carry");
	});

	it("Q15: a constraint proposition can bind a mechanism, not only intent", () => {
		// `constrains` reaching realization is what lets a rule about how guards may be BUILT attach to
		// the thing built. Without it CON-0027 could only constrain decisions, losing its actual force.
		assert.ok(graph.relationKinds.constrains.to.includes("realization"), "constrains must be able to target a realization");
		const rule = node("CON-0027");
		assert.equal(rule.role, "constraint");
		const bound = outgoing("CON-0027", "constrains").map((e) => e.to);
		assert.ok(bound.length > 0, "CON-0027 must bind at least one mechanism");
		for (const id of bound) assert.equal(node(id).kind, "realization", `CON-0027 should bind mechanisms; ${id} is not one`);
		// CTR-0004 is the live instance: worktree confinement decides from observed Git porcelain/ref
		// state, which the seat can write, and a `.git/config` rewrite produces no porcelain delta.
		assert.ok(bound.includes("CTR-0004"), "the git-porcelain confinement realization is the motivating instance");
	});

	/**
	 * The ceiling: constraints that name no enforcing realization TODAY. It may only SHRINK — the
	 * membership check below stops a new unenforced constraint slipping in, and the exact pin stops
	 * the set rotting once mechanisms are bound. Admitting a new member is therefore a visible,
	 * reviewer-audited edit here, and binding one is equally visible.
	 *
	 * Bound constraints are deliberately ABSENT: keeping a bound ID in a set named "unenforced" would
	 * make the exact pin lie about the corpus, which is the drift this check exists to prevent. That
	 * is a narrower reading than Q14's FROZEN_UNLINKED_GUARANTEES, which still lists TC-003 / TC-017
	 * after those gained mechanisms; the pin is the stricter of the two and this set follows it.
	 *
	 * #650 reduced this from 29 to 9 by binding 20 constraints — seven to the conformance suite and
	 * thirteen to existing realizations. #680 reduced it from 9 to 8 by correcting one forward-looking
	 * kernel-sufficiency claim to an assumption in ADR-0027 and its shadow node. #681 reduced it from
	 * 8 to 7 by binding CON-0018 to CTR-0022. The 7 that remain each carry a written reason in the
	 * corpus at `extraction.unenforcedConstraints`, pinned against this set below: a reason without a
	 * member, or a member without a reason, fails.
	 */
	const FROZEN_UNENFORCED_CONSTRAINTS: ReadonlySet<string> = new Set(["CON-0004", "CON-0007", "CON-0016", "CON-0025", "CON-0028", "CON-0029", "CON-0030"]);

	it("Q17: unenforced-constraint ceiling", () => {
		const corpus = graph as unknown as AssuranceGraph;
		const live = diagnostics(corpus)
			.filter((d) => d.check === "constraint-without-enforcement")
			.map((d) => d.node);
		for (const id of live) {
			assert.ok(FROZEN_UNENFORCED_CONSTRAINTS.has(id), `${id} names no enforcing realization and is not in the frozen ceiling; bind a realization, or explicitly amend the frozen set`);
		}

		// The other half of the ratchet, and the half that makes the ceiling shrink. The membership
		// check above only stops a NEW unenforced constraint slipping in; on its own it lets the frozen
		// set rot, because binding a mechanism would silently leave a stale member behind. Pinning the
		// computed live set exactly means binding one FAILS here until the ceiling is updated, so the
		// set can only ever get smaller. Same shape as Q14's `deepEqual(unlinked, ...)`.
		// Compared as sorted sets: the pin is about membership, not about the order `graph.nodes`
		// happens to list constraints in, which is not a property this gate should fire on.
		assert.deepEqual([...live].sort(), [...FROZEN_UNENFORCED_CONSTRAINTS].sort(), "the current unenforced-constraint set (update when a mechanism is bound; it may only shrink)");

		// The corpus records WHY each remaining constraint is unbound; that record and this ceiling are
		// two halves of one claim, so they are pinned to each other. Binding a constraint without
		// deleting its reason, or recording a reason for something already bound, fails here.
		type UnenforcedNotes = { extraction?: { unenforcedConstraints?: { entries?: Record<string, string> } } };
		const entries = (graph as UnenforcedNotes).extraction?.unenforcedConstraints?.entries ?? {};
		assert.deepEqual(Object.keys(entries).sort(), [...FROZEN_UNENFORCED_CONSTRAINTS].sort(), "extraction.unenforcedConstraints must name exactly the frozen ceiling");
		for (const [id, reason] of Object.entries(entries)) assert.ok(reason.trim().length >= 40, `${id} needs a written reason, not a placeholder`);

		const injected = structuredClone(corpus);
		injected.nodes.push({ id: "CON-X", kind: "proposition", role: "constraint", slug: "unbound", statement: "s" });
		const injectedLive = new Set(
			diagnostics(injected)
				.filter((d) => d.check === "constraint-without-enforcement")
				.map((d) => d.node),
		);
		assert.ok(injectedLive.has("CON-X"), "an unbound constraint absent from the frozen ceiling must fire");
		assert.ok(!FROZEN_UNENFORCED_CONSTRAINTS.has("CON-X"), "CON-X is the ceiling true-fire: live diagnostic plus absence from the frozen set");
	});

	/**
	 * The always-loaded AGENTS.md invariant index is a channel that can introduce load-bearing intent
	 * with no ADR home (ADR-0027 review, pass 1). Every bullet must resolve to graph primitives or be
	 * explicitly classified as a construction rule; a stale index entry fails too, so the index cannot
	 * rot into a list of anchors nobody re-reads.
	 */
	it("Q16: every AGENTS.md project invariant is covered by the graph or classified as construction", () => {
		const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
		const section = agents.split("## Project Invariants")[1]?.split("\n## ")[0] ?? "";
		const bullets = section
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2));
		assert.ok(bullets.length >= 20, "expected the Project Invariants bullet list");
		const entries = graph.invariantIndex.entries as Array<{ anchor: string; nodes?: string[]; construction?: string }>;
		const matched = new Set<number>();
		for (const bullet of bullets) {
			const hits = entries.map((e, i) => (bullet.includes(e.anchor) ? i : -1)).filter((i) => i >= 0);
			assert.equal(hits.length, 1, `AGENTS.md invariant must match exactly one invariantIndex entry (matched ${hits.length}): ${bullet.slice(0, 90)}`);
			matched.add(hits[0]);
			const entry = entries[hits[0]];
			assert.ok((entry.nodes && entry.nodes.length > 0) !== Boolean(entry.construction), `${entry.anchor}: classify as nodes XOR construction`);
			for (const id of entry.nodes ?? []) assert.ok(nodes.has(id), `${entry.anchor} references missing node ${id}`);
		}
		for (const [i, entry] of entries.entries()) assert.ok(matched.has(i), `stale invariantIndex anchor no longer in AGENTS.md: ${entry.anchor}`);
		const covered = entries.filter((e) => e.nodes).length;
		assert.ok(covered >= 15, `graph-covered invariants may not silently drain into construction (${covered})`);
	});

	it("Q11: stable IDs survive ontology reclassification", () => {
		assert.equal(node("CLM-0006").kind, "proposition");
		assert.equal(node("CON-0004").kind, "proposition");
		assert.equal(node("ASM-0002").kind, "proposition");
		assert.equal(node("CTR-0003").kind, "realization");
	});

	it("Q12: observations cannot directly support or challenge intent before Assessment exists", () => {
		assert.equal(graph.relationKinds.supports, undefined);
		assert.equal(graph.relationKinds.challenges, undefined);
		assert.ok(!edges.some((edge) => edge.relation === "supports" || edge.relation === "challenges"));
		assert.ok(mapped("ADR-0027").includes("CON-0021"));
	});

	it("Q13: consumer-owned graphs remain a first-class future boundary without specifying federation", () => {
		assert.ok(mapped("ADR-0027").includes("CON-0025"));
		assert.match(node("CON-0025").statement, /consumer repository can own and evolve/i);
		assert.match(node("CON-0025").statement, /composition remains deliberately undecided/i);
	});
});
