# Decision log — ITEM-1

Status values are `default-taken`, `resolved`, or `resolved→ADR-nnnn`. Source is an item, pull request, or review-note reference.

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| restart identity and progress | default-taken | persisted records indexed by stable id, with complete record equality | source hash and separate checkpoint journal | ITEM-1 | 2026-09-05 |
<!-- decision:7fc6df5e-8986-4b20-a03c-b53f61ae743a -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiJjNGNkMjgwOGZhMzExNWY2NGFiZTAwODIzNGE1MWNkNWI5NWE0Zjg1NWYyMGJkNDllZTNmYzYyMDlhYjJhMWYwIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTEiLCJzdGVwIjoicGxhbiIsIm9jY3VycmVuY2UiOjB9fQ -->
| conflict timing | default-taken | preflight all source and store conflicts before writing | stop at the first conflict during incremental commits | ITEM-1 | 2026-09-05 |
<!-- decision:33ca8fce-465a-4334-9947-0b193600ca86 -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiI2Yzg2YjY5ODBkOTNhZDhlYWE4NDdkODk0MjBjZGM0ZWI2YWE1YmEwNWM5NTFlYmU3MzI0MDJjODI3MTBjNmNkIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTEiLCJzdGVwIjoicGxhbiIsIm9jY3VycmVuY2UiOjF9fQ -->
| pre-existing duplicate ids | default-taken | fail visibly before writes and preserve the store for manual repair | collapse equal duplicates or migrate existing data | ITEM-1 | 2026-09-05 |
<!-- decision:53fe9755-b8dd-43bb-abf3-02f3fba0d998 -->
<!-- decision-meta:eyJjb250ZW50RmluZ2VycHJpbnQiOiIzNThiNmY4OGNhMGYxM2EwMzAxMzg0NTM4OGE3OTc2YWQ2YmNmZGY2NGZmN2VmMjE1YTQwOGI0ZGRlNzgyMDIzIiwiZGVkdXBlIjp7InJ1bklkIjoiY3ljbGUtMS1JVEVNLTEtYTEiLCJzdGVwIjoicGxhbiIsIm9jY3VycmVuY2UiOjJ9fQ -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
