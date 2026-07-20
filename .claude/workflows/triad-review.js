// Reusable adversarial triad review: 3 diverse-lens reviewers + a Judge, with a
// retry-on-stub guard so an occasional placeholder response from a reviewer seat does
// not silently degrade the panel (observed intermittently: a seat returns schema-valid
// but degenerate output such as overall:"test", title:"t").
//
// Dev-only tooling for reviewing pelaggio's own work — NOT shipped to consumers
// (`.claude/workflows/` is absent from the package `files`, `pack-prepare` PACK_TARGETS,
// and `check-publish` ALLOWED_PREFIXES). See ./README.md.
//
// Invoke:
//   Workflow({ name: 'triad-review', args: {
//     title,                 // short label for the thing under review
//     artifact,              // the text/spec/diff under review (or a path to read)
//     grounding?,            // optional: files to read / facts to verify against
//     lenses?,               // optional: [{ key, prompt }] — defaults to fidelity/reuse/adversarial
//     schema?, judgeSchema?, // optional JSON-schema overrides
//   }})

export const meta = {
  name: 'triad-review',
  description: 'Adversarial triad review (3 diverse-lens reviewers + Judge) with a retry-on-stub guard',
  phases: [
    { title: 'Review', detail: '3 diverse-lens reviewers, stub-guarded' },
    { title: 'Judge', detail: 'adjudicate + synthesize' },
  ],
}

const A = args ?? {}
const TITLE = A.title ?? 'artifact under review'
const ARTIFACT = A.artifact ?? ''
const GROUNDING = A.grounding ?? ''
const LENSES =
  Array.isArray(A.lenses) && A.lenses.length
    ? A.lenses
    : [
        { key: 'fidelity', prompt: 'LENS: FIDELITY & INTERNAL CONSISTENCY. Does it faithfully do what it claims — no drift, softening, or over-reach — and hang together internally (cross-refs resolve, no contradictions)?' },
        { key: 'reuse-grounding', prompt: 'LENS: REUSE & REPO-GROUNDING. Verify factual claims against the repo; flag anything that duplicates or contradicts what already exists; prefer borrow over build.' },
        { key: 'adversarial', prompt: 'LENS: ADVERSARIAL SAFETY. Read it as a skeptic trying to defeat it — find the load-bearing hole, the over-claim, the foot-gun.' },
      ]

const FINDINGS_SCHEMA = A.schema ?? {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'overall', 'findings', 'verdict'],
  properties: {
    lens: { type: 'string' },
    overall: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'rationale', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['must-fix', 'should', 'note'] },
          title: { type: 'string' },
          rationale: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['sound', 'revise', 'rethink'] },
  },
}

const JUDGE_SCHEMA = A.judgeSchema ?? {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'decisions', 'must_fix', 'top_risks'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'revise', 'rethink'] },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'disposition', 'rationale'],
        properties: {
          title: { type: 'string' },
          disposition: { type: 'string', enum: ['upheld-must-fix', 'upheld-should', 'downgraded', 'refuted'] },
          rationale: { type: 'string' },
        },
      },
    },
    must_fix: { type: 'array', items: { type: 'string' } },
    top_risks: { type: 'array', items: { type: 'string' } },
  },
}

// --- retry-on-stub guard ------------------------------------------------------
// Schema-agnostic degeneracy check: reject a tiny/placeholder object and re-run.
const STUB_RE = /^(test|todo|tbd|n\/?a|none|null|\.|x|-|t|r)$/i
function isStub(r) {
  if (!r || typeof r !== 'object') return true
  if (JSON.stringify(r).length < 60) return true // near-empty object
  const narrative = String(r.overall ?? r.summary ?? '').trim()
  if (narrative && (narrative.length < 12 || STUB_RE.test(narrative))) return true
  const f = Array.isArray(r.findings) ? r.findings : []
  if (f.length && f.every((x) => String(x.title ?? '').trim().length <= 3)) return true
  return false
}

async function robustAgent(prompt, opts, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const firm = i === 0 ? '' : '\n\nYOUR PREVIOUS RESPONSE WAS A PLACEHOLDER/STUB AND WAS REJECTED. Produce a real, specific review now — no filler, no single-character fields.'
    const label = i === 0 ? opts.label : `${opts.label}:retry${i}`
    const r = await agent(prompt + firm, { ...opts, label })
    if (!isStub(r)) return r
    log(`stub detected on ${opts.label} (attempt ${i + 1}/${tries}) — retrying`)
  }
  log(`stub persisted on ${opts.label} after ${tries} tries — passing the last result through`)
  return await agent(prompt, opts)
}

// --- run ----------------------------------------------------------------------
log(`Triad reviewing: ${TITLE}`)
const reviews = (
  await parallel(
    LENSES.map((l) => () =>
      robustAgent(`You are a reviewer. ${l.prompt}\n\n=== UNDER REVIEW: ${TITLE} ===\n${ARTIFACT}\n\n${GROUNDING}\n\nReturn structured findings; be specific and adversarial. A stub/placeholder is rejected.`, {
        label: `review:${l.key}`,
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
      }).then((r) => (r ? { ...r, key: l.key } : null)),
    ),
  )
).filter(Boolean)
log(`Reviews in: ${reviews.map((r) => `${r.key}=${r.verdict ?? '?'}(${(r.findings ?? []).length})`).join(', ')}`)

const judge = await robustAgent(
  `You are the JUDGE of a triad review of: ${TITLE}. Value diverse perspectives; resolve conflicts on the merits; uphold only real load-bearing findings and downgrade/refute the rest with reasons. Give a verdict + concrete must-fix edits an author can apply directly.\n\n=== UNDER REVIEW ===\n${ARTIFACT}\n\n=== REVIEWER FINDINGS (JSON) ===\n${JSON.stringify(reviews, null, 1)}`,
  { label: 'judge', phase: 'Judge', schema: JUDGE_SCHEMA, effort: 'high' },
)

return { reviews, judge }
