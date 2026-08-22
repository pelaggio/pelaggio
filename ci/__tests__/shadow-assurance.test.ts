import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const graph = JSON.parse(readFileSync(new URL("../../docs/assurance/shadow-graph.json", import.meta.url), "utf8"));
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
  it("has unique stable ids and resolvable typed edges", () => {
    assert.equal(nodes.size, graph.nodes.length, "node IDs must be unique");
    for (const edge of edges) {
      assert.ok(nodes.has(edge.from), `edge source ${edge.from} must exist`);
      assert.ok(nodes.has(edge.to), `edge target ${edge.to} must exist`);
      assert.ok(graph.edgeKinds.includes(edge.relation), `unknown edge relation ${edge.relation}`);
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
});

describe("architectural question tests", () => {
  it("Q1: removing ADR-0022 topology preserves the independent-evaluation intent", () => {
    const ids = mapped("ADR-0022");
    assert.ok(ids.includes("CLM-0016"), "ADR-0022 must retain independent-evaluation as durable intent");
    assert.equal(node("CLM-0016").kind, "claim");
    assert.equal(node("CTR-0001").kind, "construction");
    assert.equal(node("CTR-0002").kind, "construction");
    assert.equal(node("DEC-0012").status, "historical-topology-under-reconsideration");
    assert.deepEqual(outgoing("DEC-0012", "implements").map((e) => e.to), ["CLM-0016"]);
  });

  it("Q2: N+Judge is a strategy that rests on an explicitly challengeable assumption", () => {
    assert.equal(node("DEC-0014").kind, "decision");
    assert.equal(node("CTR-0003").kind, "construction");
    assert.equal(node("ASM-0002").kind, "assumption");
    assert.ok(outgoing("DEC-0014", "implements").some((e) => e.to === "CLM-0016"));
    assert.ok(outgoing("DEC-0014", "assumes").some((e) => e.to === "ASM-0002"));
    assert.match(node("ASM-0002").statement, /justify its incremental cost/i);
  });

  it("Q3: landing authority is constrained by ordering-not-authority and positive completion", () => {
    const constraints = incoming("CLM-0007", "constrains").map((edge) => edge.from).sort();
    assert.ok(constraints.includes("CON-0004"), "landing must not confuse ordering with authority");
    assert.ok(constraints.includes("CON-0009"), "landing requires positive completion evidence");
    assert.ok(outgoing("CLM-0007", "specializes").some((e) => e.to === "CLM-0006"));
  });

  it("Q4: consequential authority has one normalized claim spanning the formerly duplicated ADR cluster", () => {
    const authority = node("CLM-0006");
    const expected = ["ADR-0004","ADR-0005","ADR-0014","ADR-0015","ADR-0016","ADR-0018","ADR-0025","ADR-0026"];
    for (const adr of expected) assert.ok(authority.sources.includes(adr), `${adr} should contribute to deterministic authority`);
    assert.ok(incoming("CLM-0006", "constrains").some((e) => e.from === "CON-0012"));
  });

  it("Q5: public trust claims are projections/aliases rather than duplicated internal architecture", () => {
    assert.ok(outgoing("TC-011", "aliases").some((e) => e.to === "CLM-0002"));
    assert.ok(outgoing("TC-014", "aliases").some((e) => e.to === "CLM-0003"));
    assert.ok(outgoing("TC-005", "aliases").some((e) => e.to === "CLM-0008"));
    assert.ok(outgoing("TC-012", "derived-from").some((e) => e.to === "DEC-0001"));
  });

  it("Q6: interruption recovery rejects deterministic LLM replay as a requirement", () => {
    assert.equal(node("CLM-0012").kind, "claim");
    assert.ok(incoming("CLM-0012", "constrains").some((e) => e.from === "CON-0014"));
    assert.ok(outgoing("DEC-0009", "implements").some((e) => e.to === "CLM-0012"));
  });

  it("Q7: safety degradation and rigor degradation remain distinguishable", () => {
    const noSilent = node("CON-0010");
    assert.match(noSilent.statement, /security boundary never silently weakens/i);
    assert.ok(incoming("CLM-0013", "constrains").some((e) => e.from === "CON-0010"));
    assert.ok(incoming("CLM-0002", "constrains").some((e) => e.from === "CON-0010"));
  });

  it("Q8: assumptions remain identifiable separately from guarantees", () => {
    const assumptions = graph.nodes.filter((n: any) => n.kind === "assumption");
    assert.ok(assumptions.length >= 4);
    for (const assumption of assumptions) {
      assert.ok(assumption.id.startsWith("ASM-"));
      assert.ok(Array.isArray(assumption.sources) && assumption.sources.length > 0);
    }
    assert.equal(node("ASM-0001").kind, "assumption");
    assert.equal(node("CLM-0014").kind, "claim");
  });
});
