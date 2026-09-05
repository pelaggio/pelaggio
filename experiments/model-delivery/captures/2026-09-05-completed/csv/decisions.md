# Decision log — ITEM-1

Status values are `default-taken`, `resolved`, or `resolved→ADR-nnnn`. Source is an item, pull request, or review-note reference.

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| CSV status-query semantics | default-taken | preserve the list endpoint’s exact-match semantics; missing or empty selects all, unknown values produce a header-only 200 response | reject unknown statuses with 400, introducing a different filtering contract | ITEM-1 | 2026-09-05 |
<!-- decision:d2ff16e9-f820-4ed0-bce3-5656d5b8df7e -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiIxNDZjNTYyM2EwN2JiZWFjNGY1ZWE4YWJlOTU1NDUwOTcxNDc4NDgwNDlhMjU1NDEwNTI5OGQ1Mjk5NTJjZWUwIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTEiLCJzdGVwIjoicGxhbiIsIm9jY3VycmVuY2UiOjB9fQ -->
| CSV status-query semantics | default-taken | preserve the list endpoint's exact-match semantics: missing or empty selects all, unknown values match nothing and produce a header-only 200 response | reject unknown statuses with 400, which would introduce a different filtering contract | ITEM-1 | 2026-09-05 |
<!-- decision:a5c8d73b-4cd2-4838-9fcf-e2a10fa7d15a -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiJhZThmZGU2M2YwZmNmNTYzMzZiOTdjZWNmYjg1Y2E3ZDBmZmRjNjM4ZGQ5NGI3MmJkMWQwN2MzMDJiM2I1NjdlIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTIiLCJzdGVwIjoic2hha2Vkb3duLXBsYW4iLCJvY2N1cnJlbmNlIjowfX0 -->
| CSV field quoting | default-taken | quote every data field; leave the header unquoted | quote a field only when it contains comma, quote, or line break | ITEM-1 | 2026-09-05 |
<!-- decision:4821dfb3-6467-40c2-8ae2-4b2cf61bf0da -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiIwZmM4NDRkYTMyNDFhMTMxNzE4NDk3OGZiOTk3MGU2YWMwZmE4YmU0ZTI0ZGU2YmRjMDlhODA0YjdiNDliYzZjIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTIiLCJzdGVwIjoic2hha2Vkb3duLXBsYW4iLCJvY2N1cnJlbmNlIjoxfX0 -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
