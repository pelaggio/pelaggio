# Successor corpus

Artifacts from the four-pass experiment recorded in
[`../../corpus-convergence.md`](../../corpus-convergence.md) §5. **This corpus is a result, not a
proposal.** It describes a hypothetical successor harness, is unregistered, cites nothing as
authority, and did not converge.

| file | what it is |
|---|---|
| `corpus.json` | final state after four passes (47 nodes, 44 edges) |
| `corpus.p1.json` … `p4.json` | per-pass snapshots; the diff between them is the record of what each round changed |
| `check_corpus.py` | domain checker — exits non-zero on an invalid corpus |
| `render_corpus.py` | HTML projection; refuses to run unless the checker passes |
| `render_md.py` | Markdown projection, from the same source |

## Reproduce

```
python3 check_corpus.py corpus.json      # 0 errors, 0 warnings expected
python3 render_md.py corpus.json out.md 4
```

## Finding trajectory

| pass | findings | nodes | invariants | constraints |
|---|---|---|---|---|
| 1 | 17 | 39 | 11 | 13 |
| 2 | 15 | 42 | 12 | 15 |
| 3 | 13 | 46 | 12 | 19 |
| 4 | 17 | 47 | 12 | 19 |

Twenty nodes never changed across all four passes; twenty-one were edited. The five most-edited
(`INV-2` 3×, `CON-3` 3×, `CON-7` 2×, `CON-1` 2×, `ASM-1` 2×) all belong to one idea, which also
produced the plurality of findings in passes 3 and 4.

Nothing was ever removed. Monotonic growth under review pressure is the observation §5.3 turns on.

## Caveats

- Review records are unbound review records, not attestations.
- One pass ran with a softened diversity guarantee (a reviewer seat did not complete) and two had an
  invalid Judge block; those passes are weaker evidence than the two that were clean.
- The checker's causal-language rule over-fires. It refused one of the author's own sentences during
  pass 4, which was a false positive.
