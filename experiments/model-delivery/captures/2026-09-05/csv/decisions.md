# Decision log — ITEM-1

Status values are `default-taken`, `resolved`, or `resolved→ADR-nnnn`. Source is an item, pull request, or review-note reference.

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| CSV status-query semantics | default-taken | preserve the list endpoint’s exact-match semantics; missing or empty selects all, unknown values produce a header-only 200 response | reject unknown statuses with 400, introducing a different filtering contract | ITEM-1 | 2026-09-05 |
<!-- decision:d2ff16e9-f820-4ed0-bce3-5656d5b8df7e -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiIxNDZjNTYyM2EwN2JiZWFjNGY1ZWE4YWJlOTU1NDUwOTcxNDc4NDgwNDlhMjU1NDEwNTI5OGQ1Mjk5NTJjZWUwIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTEiLCJzdGVwIjoicGxhbiIsIm9jY3VycmVuY2UiOjB9fQ -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
