---
title: "ADR-0007: Publish = signed tag + provenance on a self-hosted runner"
status: accepted
date: 2026-07-07
claims: ["TC-005"]
---

# ADR-0007 — Publish = signed tag + provenance on a self-hosted runner

## Context
A published package's provenance must be verifiable, and the pipeline that produces it must itself be trustworthy — an unsigned artifact from an opaque builder gives a consumer nothing to verify against.

## Decision
Publish only from a **signed git tag** with build **provenance attestation**, produced on a **self-hosted runner** under operator control. Signature + provenance + a trusted builder are the chain a consumer verifies.

## Alternatives not taken
- Unsigned publish — nothing to verify the artifact against.
- Publishing from an untrusted / general hosted runner — weakens the provenance chain at its most sensitive point.

## Consequences
- (+) Consumers can verify a signed tag and provenance back to a controlled builder.
- (−) Requires maintaining self-hosted runner infrastructure and key custody for signing.
