# Decisions

Status values are `default-taken`, `resolved`, or `resolved→ADR-nnnn`. Source is an item, pull request, or review-note reference.

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| How to prevent a shipped-but-open item from being claimed again after `markDone` fails | default-taken | retain the existing git-native feature branch claim (locally and remotely) while cleaning only the worktree | make tracker failure fatal and withhold the verified merge push; infer shipped state from commit history in every roadmap adapter; introduce a separate tombstone/claims registry | https://github.com/pelaggio/pelaggio/issues/205 | 2026-07-21 |
<!-- decision:5f152192226652a6 -->
| Whether the inline `/ship` skill cleanup must match the bookkeeping gate | default-taken | yes — gate branch delete on mark-done success in `.claude/skills/ship/SKILL.md` step 9 | leave skill divergent (pipeline-only fix); document skill as intentionally out of scope | https://github.com/pelaggio/pelaggio/issues/205 | 2026-07-21 |
<!-- decision:28eb13daf55f317a -->
| How to prevent a shipped-but-open item from being claimed again after `markDone` fails | default-taken | retain the existing git-native feature branch claim locally and remotely while cleaning only the worktree | withhold the verified merge push; infer shipped state from history in every adapter; introduce a tombstone/claims registry | https://github.com/pelaggio/pelaggio/issues/205 | 2026-07-21 |
<!-- decision:bd869aa49224375f -->
| configuration surface for pooled assignment | default-taken | allow models.profiles.<name>.providers.<authoring-or-review-step> to be either the existing provider scalar or an ordered, non-empty provider list | add a separate top-level assignment block; replace scalar provider settings outright | https://github.com/pelaggio/pelaggio/issues/245 | 2026-07-20 |
<!-- decision:af49a5313053cb76 -->
| meaning of availability within this item | default-taken | cycle-local eligibility from an injected availability predicate evaluated before assignment, plus configured candidates minus the output author and already-selected review seats; the production predicate initially reflects provider configuration/driver readiness and tests can supply changing availability | fail over after a provider has begun an artifact; persist quota/cooldown state across cycles as #246 | https://github.com/pelaggio/pelaggio/issues/245 | 2026-07-20 |
<!-- decision:9df96e1088a51025 -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| Cross-model review split for 305 | resolved | Human adjudication required | proceed or block | .dev/review-records/cycle-1-305.json | 2026-07-21 |
<!-- decision:9f96f68e9b6f217d -->
<!-- review-escalation:eyJlc2NhbGF0aW9uIjp7ImtpbmQiOiJyZXZpZXctZXNjYWxhdGlvbiIsIml0ZW1JZCI6IjMwNSIsInN0ZXAiOiJzaGFrZWRvd24tY29kZSIsInJldmlld2VkU2hhIjoiYzAwMmUzZjIyYmEyNWM4MDAzYWJmNDRlOTA1YmEzNjc2M2UxM2RjNCIsImV2aWRlbmNlRmluZ2VycHJpbnQiOiI1MzJmMGVkNzIwYzBkMDdiNDJkZDA0MmJkZTNjYzE0NjUzYzc1ZTkzZDUyZmFhZTBhYmU5YTAyZmQ2ODVjMjE2IiwicmV2aWV3UmVjb3JkU291cmNlIjoiLmRldi9yZXZpZXctcmVjb3Jkcy9jeWNsZS0xLTMwNS5qc29uIiwiaGFzU2FmZXR5QmxvY2tlciI6ZmFsc2UsImRyaXZlcnMiOlt7ImlkZW50aXR5Ijp7InJvbGUiOiJyZXZpZXdlciIsInNlYXRJZCI6ImNsYXVkZSIsInByb3ZpZGVyIjoiY2xhdWRlIiwibW9kZWwiOiJjbGF1ZGUtc29ubmV0LTUiLCJzZXNzaW9uSWQiOiJyZXZpZXdlci1jbGF1ZGUtcDEifSwidmVyZGljdCI6ImJsb2NrIiwicmF0aW9uYWxlIjoiRG9jcy1vbmx5IFBSIGNsYXJpZnlpbmcgcHItcmV2aWV3IENMSSBiZWhhdmlvcjsgb25lIG5ldyBzZW50ZW5jZSBtaXNzdGF0ZXMgZXhpdC1jb2RlIHNlbWFudGljcywgY29udHJhZGljdGluZyBib3RoIHRoZSBjb2RlIGFuZCB0aGUgdW5jaGFuZ2VkIHRleHQgYSBmZXcgbGluZXMgYmVsb3cgaXQuIn0seyJpZGVudGl0eSI6eyJyb2xlIjoicmV2aWV3ZXIiLCJzZWF0SWQiOiJncm9rIiwicHJvdmlkZXIiOiJncm9rIiwibW9kZWwiOiJjbGF1ZGUtc29ubmV0LTUiLCJzZXNzaW9uSWQiOiJyZXZpZXdlci1ncm9rLXAxIn0sInZlcmRpY3QiOiJwYXNzIiwicmF0aW9uYWxlIjoiRG9jcy1vbmx5IGNsYXJpZnkgb2YgcHItcmV2aWV3IGFzIG1lcmdlLWdhdGUgQ0xJIGlzIGFjY3VyYXRlIG92ZXJhbGw7IG9uZSBub24tYmxvY2tpbmcgb3ZlcnN0YXRlbWVudCBvZiBleGl0LW9uLWNvbW1lbnQtZmFpbHVyZS4ifV19LCJyZXNvbHV0aW9uIjp7ImRpc3Bvc2l0aW9uIjoicHJvY2VlZCIsImFjdG9yIjoiY2hyaXMiLCJyYXRpb25hbGUiOiJGaW5kaW5nIHZhbGlkOiBhdXRob3Igb3ZlcmNsYWltZWQgZXhpdC1vbi13cml0ZS4gQ29ycmVjdGVkIHRoZSBjbGF1c2UgaW4gYSBmb2xsb3ctdXAgY29tbWl0OyByZS1yZXZpZXdpbmcgdGhlIGZpeGVkIGRvY3MuIiwidGltZXN0YW1wIjoiMjAyNi0wNy0yMVQwMDo0ODoyMC45MTRaIn19 -->
