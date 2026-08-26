# Successor corpus

The governing knowledge of a hypothetical successor harness, authored once as data. It is
unregistered, cites nothing as authority, and describes a system that does not run.

It began as the experiment recorded in
[`../../corpus-convergence.md`](../../corpus-convergence.md) §5, and is now the living artifact that
RFC is refined against.

| file | what it is |
|---|---|
| `corpus.json` | current state |
| `corpus.p1.json` … `p4.json` | per-pass review snapshots; the diff between them records what each round changed |
| `check_corpus.py` | domain checker — exits non-zero on an invalid corpus |
| `render_corpus.py` | HTML projection; refuses to run unless the checker passes |
| `render_md.py` | Markdown projection, from the same source |
| `corpus.css` | stylesheet for the HTML projection |

## Reproduce

```
python3 check_corpus.py corpus.json
python3 render_md.py corpus.json out.md
python3 render_corpus.py corpus.json out.html
```

Both renderers resolve the checker, and the HTML renderer its stylesheet, relative to the script
rather than the working directory: the "refuses to render on an invalid corpus" guarantee should not
be defeatable by a shadowing file in the caller's cwd.

## What the checker enforces

- Relation domains — source kind, target kind, and target role against a declared contract.
- Every edge endpoint resolves to a corpus node. External references live in a `sources` field and
  are never edge targets.
- Every constraint names the party it binds, and only `harness` is admitted. A bound on a callee is
  either already impossible or is a bound on the caller that granted it; a rule about the corpus
  belongs in this checker; a design choice belongs in a decision. Each rejection names the
  destination.
- Every assumption carries exactly one of `wrongIf` or `revisitIf`. The first is a counterexample
  that settles the claim; the second is a trigger to look again. Most things worth assuming only
  ever get the second, and requiring one of the two stops a bet being written as a refutation.
- Causal-outcome language appears only on an assumption, because the corpus admits no node kind for
  a thesis.
- No hand-written prose names a node the corpus does not contain. The scan walks this directory
  and the corpus's own text rather than naming files, because the set of places prose can cite an
  id is open — an earlier version listed the two renderers and missed the checker itself.

An invariant no decision implements draws a warning. Nothing warns that an invariant has no
constraint: a bound may be established by construction, and asking every invariant for a constraint
is a standing invitation to add one.

## Caveats

- Review records are unbound review records, not attestations.
- One pass ran with a softened diversity guarantee (a reviewer seat did not complete) and two had an
  invalid Judge block; those passes are weaker evidence than the two that were clean.
- The snapshots predate the current checker and do not pass it. Rendering one correctly refuses.
  They are frozen history, not inputs.
- The causal-language rule over-fires, and has refused the author's own prose more than once. Each
  was reworded rather than answered by loosening the rule.

Interpretation — what the passes cost, what the reductions bought, and what any of it implies — is
in #670, not here.
