import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { renderMermaid, selectView, type AssuranceGraph, type AssuranceView } from "../assurance-views.ts";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as AssuranceGraph & { relationKinds: Record<string, unknown> };
const catalog = JSON.parse(readFileSync(resolve(repo, "docs/assurance/views.json"), "utf8")) as { views: AssuranceView[] };
const nodeIds = new Set(graph.nodes.map((node) => node.id));
const views = new Map(catalog.views.map((view) => [view.id, view]));

function view(id: string): AssuranceView {
  const value = views.get(id);
  assert.ok(value, `missing assurance view ${id}`);
  return value;
}

describe("assurance question catalog", () => {
  it("has stable unique IDs and only references known graph vocabulary", () => {
    assert.equal(views.size, catalog.views.length, "view IDs must be unique");
    for (const candidate of catalog.views) {
      assert.ok(candidate.question.length > 0, `${candidate.id} needs a question`);
      for (const relation of candidate.relations ?? []) {
        assert.ok(relation in graph.relationKinds, `${candidate.id} references unknown relation ${relation}`);
      }
      for (const seed of candidate.seeds ?? []) assert.ok(nodeIds.has(seed), `${candidate.id} references missing seed ${seed}`);
    }
  });

  it("bakes in the high-value operator questions", () => {
    for (const id of ["architecture", "why", "affected", "debt", "trust", "review", "landing"]) assert.ok(views.has(id), `missing ${id} view`);
    assert.match(view("debt").question, /unsupported|orphaned|stale|contradictory/i);
    assert.match(view("why").question, /why does this node exist/i);
    assert.match(view("affected").question, /what intent/i);
  });

  it("separates semantic queries from presentation concerns", () => {
    const forbidden = new Set(["color", "position", "x", "y", "layout", "icon", "shape", "renderer"]);
    for (const candidate of catalog.views) {
      for (const key of Object.keys(candidate as any)) assert.ok(!forbidden.has(key), `${candidate.id} leaks presentation key ${key} into semantic query definition`);
    }
  });

  it("architecture view is a projection of every durable claim", () => {
    const selected = selectView(graph, view("architecture"));
    const claims = graph.nodes.filter((node) => node.kind === "claim").map((node) => node.id).sort();
    assert.deepEqual(selected.nodes.map((node) => node.id), claims);
    assert.ok(selected.edges.every((edge) => edge.relation === "specializes"));
  });

  it("review view makes strategy, assumption, and surviving intent visible together", () => {
    const selected = selectView(graph, view("review"));
    const selectedIds = new Set(selected.nodes.map((node) => node.id));
    for (const id of ["DEC-0014", "CTR-0003", "ASM-0002", "CLM-0016", "CLM-0009", "CLM-0008"]) {
      assert.ok(selectedIds.has(id), `review view must contain ${id}`);
    }
  });
});

describe("generated GitHub visualizations", () => {
  for (const id of ["architecture", "review"]) {
    it(`${id} Mermaid projection is generated from the corpus`, () => {
      const expected = renderMermaid(graph, view(id));
      const checkedIn = readFileSync(resolve(repo, `docs/assurance/generated/${id}.md`), "utf8");
      assert.equal(checkedIn, expected, `run node --import tsx ci/assurance-views.ts --write after changing ${id}`);
    });
  }
});
