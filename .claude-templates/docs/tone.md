# Tone & Voice

Voice rules for {{PROJECT_NAME}}'s user-facing copy — app strings, agent messages, error states, empty states, and brand copy.

*Delete this file if your product has no user-facing voice (tooling, infrastructure, internal-only).*

## Core voice

{{3-5 BULLETS DESCRIBING HOW THE PRODUCT SPEAKS}}

*Prompts:*
- Is the voice warm or clinical? Playful or serious? First-person, second-person, or impersonal?
- What does it never do (avoid jargon? avoid exclamation points? avoid first-person plural "we"?)
- Is there a specific register — conversational, authoritative, instructional?
- Are there words or phrases that are on-brand vs. off-brand?

*Example principles (Fathom's, for reference):*
- Clear, honest, unemotional. No cheerleading.
- Second person ("you") for user-facing copy. First-person plural ("we") only for system actions ("we'll remind you when…")
- No exclamation points in the app. None. They're reserved for marketing.
- No judgment language around money/behavior. "You spent $X" not "You overspent by $X"

## Agent personality

*If the product has an on-device or cloud agent, define its voice separately.*

{{AGENT VOICE RULES}}

*Prompts:*
- Does the agent have a name? Does it refer to itself?
- How does it handle uncertainty — "I think…" vs. "This appears to be…" vs. just stating?
- When it proposes an action, how does it phrase the request for approval?
- What does it refuse to do (opinions? judgments? recommendations outside its scope?)

## App copy rules

| Type | Rule | Example |
|---|---|---|
| Button labels | Verb-first, title case | "Save Changes" not "Changes Saved" |
| Empty states | Explain + next step | "Nothing here yet. Add your first {{thing}}." |
| Errors | User action + recovery | "Couldn't save. Check your connection and try again." |
| Confirmations | Stated outcome | "Saved" not "Success!" or "Saved ✓" |
| Destructive confirmations | Explicit consequence | "Delete this {{thing}}? This can't be undone." |

*Prune or extend as needed.*

## Monetary / quantitative language

*Only relevant if the product deals with money, measurements, or quantities.*

{{RULES FOR HOW NUMBERS APPEAR IN COPY}}

*Examples to adapt:*
- Currency always with locale-aware separator: `$1,234.56` (EN-CA) vs `1 234,56 $` (FR-CA)
- Never show rounded amounts that hide cents — `$12.00` not `$12`
- Use "balance" vs "amount" precisely; they're not synonyms
- Percentages with one decimal: `23.4%` not `23%` or `23.40%`

## Bilingual / localization rules

*If supporting multiple languages, explain how the voice adapts.*

- Tone stays consistent across languages — French should feel like the same product, not a different one
- Formal vs. informal register: {{CHOSE ONE AND STICK WITH IT}}
- Avoid idioms that don't translate (or translate them semantically, not literally)
- Number formatting follows locale conventions (`Intl.NumberFormat`)
- Date formatting follows locale conventions (`Intl.DateTimeFormat`)
- Key parity between languages enforced by test: `keyParity.test.ts`

## Anti-patterns

Things the voice never does. Make this list explicit — easier to catch violations.

- {{ANTI-PATTERN 1}}
- {{ANTI-PATTERN 2}}

*Examples to consider:*
- No "Oops!" or similar fake-friendly error language
- No emoji in error states or destructive confirmations
- No exclamation points outside marketing
- No anthropomorphizing the app ("I'll take care of that for you!")
- No guilt or shame framing around user behavior
