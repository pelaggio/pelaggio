# Pelaggio AI delivery predicate v0.1

This document defines the predicate body identified by `https://pelaggio.dev/ai-delivery/v0.1`. The JSON Schema is normative; **MUST**, **SHOULD**, and **MAY** have their RFC 2119 meanings.

## Envelope and subject

A decoded document MUST be an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/v1.0/spec/v1/statement.md) with `_type` `https://in-toto.io/Statement/v1`, exactly one subject, and this specification's predicate type. The subject MUST name the landed change artifact. Its `digest.sha256` MUST be the lowercase 64-hex SHA-256 produced by the emitter's documented Git hashing procedure; a Git SHA-1 object ID is not a substitute.

A transport envelope MUST follow [DSSE v1](https://github.com/secure-systems-lab/dsse/blob/v1.0.0/envelope.md), set `payloadType` to `application/vnd.in-toto+json`, and base64-encode the exact Statement UTF-8 bytes. `signatures: []` is a signable fixture, not a signed attestation. A signed attestation exists only when a consumer verifies at least one signature and applies its own identity and freshness policy.

## Predicate

[`predicate.schema.json`](./predicate.schema.json) is a strict JSON Schema Draft 2020-12 schema. `deliveryDefinition` declares the change metadata, evaluated policy, and vocabulary pins. `runDetails` records observed authorship attempts, reviews, policy assertions, content-addressed evidence, terminal outcome, and metadata.

Evidence IDs are constrained local references. Evidence identity is its digest; a URI is only a locator. A `pass` assertion MUST reference evidence. A `fail` or `unavailable` assertion MUST use a closed `reasonCode` and MUST NOT be interpreted as pass. Outcome precedence is `shipwrecked`, `parked`, `blocked`, then shipped/completed; a non-success outcome carries a closed `reasonCode` and its `gateSummary` MUST be `failed` or `unavailable`.

The predicate contains no narrative claim fields. Steps, subtypes, actors, reasons, unavailable facts, IDs, versions, and changed paths are enums or constrained code-like values; explanatory material belongs in content-addressed evidence. `trustModel` is mandatory and machine-readable: independence, review verdicts, and authorship status are `self-reported`, while the terminal outcome is `derived` by the harness. These labels describe provenance of a claim, not verification of its truth.

## Standards alignment

The data pins:

- in-toto Statement v1 and DSSE v1.0.0;
- [SLSA Provenance v1.0](https://slsa.dev/spec/v1.0/provenance): `deliveryDefinition` resembles `buildDefinition`, and `runDetails` resembles `runDetails`, but this is a custom predicate and does not claim SLSA predicate conformance;
- [OpenTelemetry semantic conventions 1.37.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.37.0/docs/gen-ai): `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens` retain their vocabulary names. Cache token properties are explicitly Pelaggio extensions. These records are not OTel spans;
- OWASP AISVS 1.0, [Appendix C: AI for Code Generation](https://github.com/OWASP/AISVS/blob/main/1.0/en/0x92-Appendix-C_AI_for_Code_Generation.md) — AC.9 (AI Artifact Origin Validation for Deployment) and AC.10 (Generation Audit Trail Completeness and Validation). AISVS 1.0 is published as the versioned `1.0/` corpus, not a tagged GitHub release; the schema pins the normalized value `version: "1.0.0"` together with the exact referenced control-ID set `AC.9.1`, `AC.9.2`, `AC.9.3`, `AC.10.1`, `AC.10.2`, and `AC.10.3`. Consumers MUST compare both fields, rather than treating an `AC.9` or `AC.10` chapter label as a pin.

### AISVS AC.9 and AC.10 mapping

The table below is exhaustive for the AISVS controls claimed by v0.1; no unlisted AC.9/AC.10 control is implied.

| Pinned version | Exact control ID | Predicate locations | Contract status |
| --- | --- | --- | --- |
| 1.0.0 | `AC.9.1` | `/runDetails/authorship/0/identity`, `/trustModel/authorshipStatus` | Identity is required; its status remains explicitly self-reported. |
| 1.0.0 | `AC.9.2` | `/runDetails/review/0/identity`, `/trustModel/reviewVerdict` | Reviewer identity is required; cryptographic identity may be unavailable. |
| 1.0.0 | `AC.9.3` | `/runDetails/evidence/0/digest`, `/runDetails/policy/assertions/0/evidenceRefs` | Evidence is content-addressed; operational collection is producer work. |
| 1.0.0 | `AC.10.1` | `/runDetails/review/0/independence`, `/trustModel/independence` | Unknown independence is explicit and the claim is self-reported. |
| 1.0.0 | `AC.10.2` | `/runDetails/review/0/verdict`, `/runDetails/review/0/findingRefs` | Verdict and finding references are required but remain self-reported. |
| 1.0.0 | `AC.10.3` | `/runDetails/outcome`, `/runDetails/policy/assertions`, `/trustModel/outcome` | Non-success gates fail closed; enforcement is not shipped here. |

Schema conformance proves only that fields have this shape. It does not prove that an AISVS control operated effectively.

## Privacy and trust boundary

Producers MUST minimize data and MUST NOT embed prompts, model outputs, secrets, credentials, unrestricted logs, or personal seat labels. They SHOULD prefer digests and access-controlled locators. Provider session identifiers SHOULD be omitted unless their disclosure is necessary and approved.

Once correctly signed, this object is an attributable, tamper-evident claim about supplied content. A signature alone does not prove an AI call occurred, reviewers were independent, tests ran, policy was correct, evidence is fresh, or replay is impossible. [ADR-0018](../../decisions/0018-in-toto-attestation-envelope.md) describes target-state deterministic gate assertions. This issue ships their format only; evidence binding and enforcement remain future work.

Signing, transparency logging, and forge upload are transport choices outside v0.1. Consumers MUST verify signature, identity, subject, predicate type, evidence, and freshness for their context.

## Compatibility

All v0.1 objects are closed. Producers MUST NOT add fields, reinterpret values, or weaken requirements under this predicate URI. Any additive or breaking contract change requires a new versioned predicate URI and schema `$id`. Consumers MUST reject unknown fields and unsupported versions. Documentation corrections that do not change accepted data may retain v0.1.

The checked-in [Statement](./examples/pelaggio-cycle.statement.json) and [DSSE envelope](./examples/pelaggio-cycle.dsse.json) are deterministic, unsigned fixtures. Their evidence and subject digests are synthesized test metadata and are not claims about a landed repository object.
