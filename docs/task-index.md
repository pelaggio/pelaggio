# Task Index

Compact reference for task selection. For full specs, see the linked roadmap section.

**Roadmaps**: [core](roadmap-core.md)

Deps column shows only **unsatisfied** dependencies. `—` means ready to pick. `blocked: X` means waiting on an external factor.

## Open items

| ID | Title | Deps | Plan | Roadmap |
|----|-------|------|------|---------|
| TOOL-1 | Consistency check: task-index ↔ roadmap drift | — | — | core |
| TOOL-2 | Dep graph visualization from roadmap files | — | — | core |
| TOOL-3 | Scope suggestion in /charter from description | — | — | core |
| TOOL-4 | pipeline.ts integration tests via SDK query mock | — | — | core |
| TOOL-5 | Skill body linter (frontmatter validity, rubric references) | — | — | core |
| TOOL-7 | Document in-context vs out-of-context review + add Idioms section to rubric | — | — | core |
| TOOL-8 | `.autopilot.yml` project config file + loader | — | — | core |
| TOOL-9 | RoadmapSource abstraction + MarkdownRoadmap adapter | TOOL-4, TOOL-8 | — | core |
| TOOL-10 | GitHubIssuesRoadmap adapter via gh CLI | TOOL-9 | — | core |
| TOOL-11 | ShipTarget abstraction + DirectPush/PullRequest/AutoMergePR adapters | TOOL-4, TOOL-8 | — | core |
| TOOL-12 | Running totals — token counts + stats JSON + `pnpm autopilot stats` | — | — | core |
| TOOL-13 | Package shape + git-dep consumption + `init` CLI | TOOL-8, TOOL-11 | — | core |
| TOOL-14 | `sync` CLI — upgrade installed skills with diff prompts | TOOL-13 | — | core |
| TOOL-15 | LinearRoadmap adapter | TOOL-9 | — | core |
| TOOL-16 | Split /refit → /bump-models + self-hosted Renovate | — | — | core |
| TOOL-18 | Public-npm publish hardening | TOOL-13 | — | core |

## Recently completed

- TOOL-6 ✓
