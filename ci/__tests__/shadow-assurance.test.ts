import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8"));
const nodes = new Map(graph.nodes.map((node: any) => [node.id, node]));
const edges = graph.edges as Array<{ from: string; relation: string; to: string }>;

function node(id: string) {
  const value = nodes.get(id);
  assert.ok(value, `missing node ${id}`);
  return value as any;
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
  it("has unique stable ids and type-correct edges", () => {
    assert.equal(nodes.size, graph.nodes.length, "node IDs must be unique");
    for (const edge of edges) {
      const from = node(edge.from);
      const to = node(edge.to);
      const contract = graph.relationKinds[edge.relation];
      assert.ok(contract, `unknown edge relation ${edge.relation}`);
      assert.ok(contract.from.includes(from.kind), `${edge.relation} cannot originate at ${from.kind} ${from.id}`);
      assert.ok(contract.to.includes(to.kind), `${edge.relation} cannot target ${to.kind} ${to.id}`);
    }
  });

  it("covers every ADR in the current 0001-0026 corpus", () => {
    for (let i = 1; i <= 26; i++) {
      const adr = `ADR-${String(i).padStart(4, "0")}`;
      assert.ok(mapped(adr).length > 0, `${adr} must map to at least one primitive`);
      for (const id of mapped(adr)) assert.ok(nodes.has(id), `${adr} references missing node ${id}`);
    }
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

  it("ties construction to current code or tests without putting code paths on durable claims", () => {
    for (const value of graph.nodes) {
      if (value.kind === "construction") {
        assert.ok(Array.isArray(value.codeEvidence) && value.codeEvidence.length > 0, `${value.id} construction needs code evidence`);
        for (const path of value.codeEvidence) assert.ok(existsSync(resolve(repo, path)), `${value.id} code evidence missing: ${path}`);
      } else if (value.kind === "claim") {
        assert.equal(value.codeEvidence, undefined, `${value.id} durable claim must not own brittle code locations`);
      }
    }
  });
});

describe("architectural question tests", () => {
  it("Q1: removing ADR-0022 topology preserves independent evaluation", () => {
    const ids = mapped("ADR-0022");
    assert.ok(ids.includes("CLM-0016"));
    assert.equal(node("CTR-0001").kind, "construction");
    assert.equal(node("CTR-0002").kind, "construction");
    assert.equal(node("DEC-0012").status, "historical-topology-under-reconsideration");
    assert.deepEqual(outgoing("DEC-0012", "implements").map((e) => e.to), ["CLM-0016"]);
  });

  it("Q2: N+Judge is strategy resting on an explicitly challengeable empirical assumption", () => {
    assert.equal(node("DEC-0014").kind, "decision");
    assert.equal(node("CTR-0003").kind, "construction");
    assert.equal(node("ASM-0002").kind, "assumption");
    assert.ok(outgoing("DEC-0014", "implements").some((e) => e.to === "CLM-0016"));
    assert.ok(outgoing("DEC-0014", "assumes").some((e) => e.to === "ASM-0002"));
    assert.match(node("ASM-0002").statement, /justify its incremental cost/i);
  });

  it("Q3: landing authority is constrained by ordering-not-authority and positive completion", () => {
    const constraints = incoming("CLM-0007", "constrains").map((edge) => edge.from).sort();
    assert.ok(constraints.includes("CON-0004"));
    assert.ok(constraints.includes("CON-0009"));
    assert.ok(outgoing("CLM-0007", "specializes").some((e) => e.to === "CLM-0006"));
  });

  it("Q4: principal authority is not conflated with deterministic safety enforcement", () => {
    assert.equal(node("CLM-0006").slug, "no-self-authorization");
    assert.equal(node("CLM-0019").slug, "deterministic-safety-floor");
    assert.ok(outgoing("CLM-0019", "specializes").some((e) => e.to === "CLM-0006"));
    assert.match(node("CLM-0006").statement, /authority independent of that worker/i);
    assert.match(node("CLM-0019").statement, /deterministic/i);
  });

  it("Q5: public trust claims are scoped projections, not semantic aliases", () => {
    assert.ok(outgoing("TC-011", "projects").some((e) => e.to === "CLM-0002"));
    assert.ok(outgoing("TC-014", "projects").some((e) => e.to === "CLM-0003"));
    assert.ok(outgoing("TC-005", "projects").some((e) => e.to === "CLM-0008"));
    assert.equal(node("TC-005").projection.status, "best_effort");
    assert.equal(node("TC-013").projection.status, "planned");
    assert.ok(!edges.some((edge) => edge.relation === "aliases"), "semantic aliases are intentionally unsupported");
  });

  it("Q6: interruption recovery rejects deterministic LLM replay as a requirement", () => {
    assert.equal(node("CLM-0012").kind, "claim");
    assert.ok(incoming("CLM-0012", "constrains").some((e) => e.from === "CON-0014"));
    assert.ok(outgoing("DEC-0009", "implements").some((e) => e.to === "CLM-0012"));
  });

  it("Q7: safety degradation and rigor degradation remain distinguishable", () => {
    assert.match(node("CON-0010").statement, /security boundary never silently weakens/i);
    assert.ok(incoming("CLM-0013", "constrains").some((e) => e.from === "CON-0010"));
    assert.ok(incoming("CLM-0002", "constrains").some((e) => e.from === "CON-0010"));
  });

  it("Q8: assumptions are empirical propositions rather than policy preferences", () => {
    const assumptions = graph.nodes.filter((n: any) => n.kind === "assumption");
    assert.equal(assumptions.length, 3);
    assert.ok(assumptions.every((a: any) => a.id.startsWith("ASM-")));
    assert.equal(node("DEC-0017").slug, "rigor-by-consequence");
    assert.equal(node("DEC-0018").slug, "human-value-judgment-at-charter");
  });

  it("Q9: N+Judge can disappear without deleting blocker persistence or custody intent", () => {
    const implemented = outgoing("DEC-0014", "implements").map((edge) => edge.to);
    assert.ok(implemented.includes("CLM-0016"));
    assert.ok(implemented.includes("CLM-0009"));
    assert.ok(mapped("ADR-0024").includes("CLM-0008"));
    assert.ok(mapped("ADR-0024").includes("CLM-0009"));
  });

  it("Q10: every construction exists to implement or derive from a decision/claim", () => {
    const constructions = graph.nodes.filter((n: any) => n.kind === "construction");
    for (const construction of constructions) {
      const semanticEdges = outgoing(construction.id).filter((e) => e.relation === "implements" || e.relation === "derived-from");
      assert.ok(semanticEdges.length > 0, `${construction.id} is orphan machinery with no articulated purpose`);
    }
  });
});
