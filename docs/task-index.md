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
| TOOL-5 | Skill body linter (frontmatter validity, rubric references) | — | — | core |
| TOOL-7 | Document in-context vs out-of-context review + add Idioms section to rubric | — | — | core |
| TOOL-9 | RoadmapSource abstraction + MarkdownRoadmap adapter | — | — | core |
| TOOL-10 | GitHubIssuesRoadmap adapter via gh CLI | TOOL-9 | — | core |
| TOOL-14 | `sync` CLI — upgrade installed skills with diff prompts | TOOL-15 | LinearRoadmap adapter | TOOL-9 | — | core |
| TOOL-16 | Split /refit → /bump-models + self-hosted Renovate | — | — | core |
| TOOL-17 | Pipeline pick-step test coverage (needs REPO injectability) | — | — | core |
| TOOL-18 | Public-npm publish hardening | TOOL-19 | `orchestrate()` test coverage — resume, parallel, park-and-resume | — | — | core |
| TOOL-21 | Tighten `/ship` phantom-guard wording + update `_rubric.md` phantom-guard bullet | — | — | core |

## Recently completed

- TOOL-4 ✓
- TOOL-6 ✓
- TOOL-8 ✓
- TOOL-11 ✓
- TOOL-12 ✓
- TOOL-13 ✓
- TOOL-20 ✓
- TOOL-22 ✓
