/**
 * #751 campaign composer / mutation oracle. Not a production workflow engine.
 *
 * usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--matrix-json <path>] [--publish-to <mainRepo>]
 * `--out` is required so a confined worktree never writes MAIN_REPO by default.
 */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle, publishAttachment, publishObject, writeRoots } from "../packages/pelaggio/scripts/pelaggio/delivery/bundle.js";
import { inspectGitSubject, subjectFacts } from "../packages/pelaggio/scripts/pelaggio/delivery/git-subject.js";
import type { DeliveryCase, DeliveryRecord, DeliverySubject } from "../packages/pelaggio/scripts/pelaggio/delivery/types.js";
import { renderDossier, renderVerifyJson, renderVerifyText, verifyLoadedBundle } from "../packages/pelaggio/scripts/pelaggio/delivery/verify.js";
import { registerPath } from "../packages/pelaggio/scripts/pelaggio/registers.js";

const ISSUED = new Date().toISOString();
const ISSUER = { kind: "local" as const, id: "pelaggio-shadow-751" };
const CONTEXT_PATHS = ["AGENTS.md", "docs/agent-context/pipeline.md", "docs/agent-context/testing-and-quality.md"].sort();
const HANDOFF_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "reconciled-change-751-handoff.md");
const PIPELINE_TEST = join("packages", "pelaggio", "scripts", "pelaggio", "__tests__", "pipeline.test.ts");
const ACCEPTANCE_TESTS = [
	{ ac: "AC-1", configuration: "automatic-quick", title: "quick item + committed plan + resume plan skips plan and shakedown-plan" },
	{ ac: "AC-2", configuration: "automatic-quick", title: "quick item + committed plan + resume shakedown-plan clamps to implement" },
	{ ac: "AC-3", configuration: "automatic-quick", title: "quick item + later resume keeps shakedown-code (no rewind)" },
	{ ac: "AC-3", configuration: "automatic-quick", title: "quick item + later resume keeps ship (no rewind)" },
	{ ac: "AC-4", configuration: "standard", title: "standard item + committed plan + resume plan still runs shakedown-plan" },
	{ ac: "AC-4", configuration: "profile-pin", title: "explicit --profile quick with no start still enters plan" },
	{ ac: "AC-4", configuration: "profile-pin", title: "explicit --profile standard on a quick-scoped item is not auto-downgraded" },
] as const;
const MUTATION_NAMES = ["result-tree", "missing-attachment", "other-subject", "open-finding", "missing-disposition", "wrong-authority", "landing-tree"] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];

type AcceptanceStatus = "pass" | "fail" | "missing" | "invalid";

interface AcceptanceObservation {
	ac: (typeof ACCEPTANCE_TESTS)[number]["ac"];
	configuration: (typeof ACCEPTANCE_TESTS)[number]["configuration"];
	title: (typeof ACCEPTANCE_TESTS)[number]["title"];
	status: AcceptanceStatus;
}

interface AcceptanceInput {
	observations: AcceptanceObservation[];
	complete: boolean;
	evidence?: Buffer;
	residuals: string[];
}

export interface ComposeArgs {
	out: string;
	cwd: string;
	matrixJson?: string;
	publishTo?: string;
	/** Test-only schema/oracle mode for hermetic temp repositories. Never exposed by argv. */
	fixtureObservations?: boolean;
}

export interface ComposeResult {
	caseDigest: string;
	out: string;
	mutations: Record<MutationName, { overall: string; caseDisposition: string }>;
	coldPackets: string[];
	sealedMappingPath: string;
	status: "passed" | "withheld" | "falsified";
	inspectionCommand: string;
}

export function parseComposeArgs(argv: string[]): ComposeArgs {
	let out: string | undefined;
	let cwd = process.cwd();
	let matrixJson: string | undefined;
	let publishTo: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out") {
			out = argv[++i];
			continue;
		}
		if (a === "--cwd") {
			cwd = argv[++i] ?? cwd;
			continue;
		}
		if (a === "--matrix-json") {
			matrixJson = argv[++i];
			continue;
		}
		if (a === "--publish-to") {
			publishTo = argv[++i];
			continue;
		}
		throw new Error(`usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--matrix-json <path>] [--publish-to <mainRepo>] (unknown: ${a})`);
	}
	if (!out) throw new Error("usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--matrix-json <path>] [--publish-to <mainRepo>]");
	return {
		out: resolve(out),
		cwd: resolve(cwd),
		...(matrixJson ? { matrixJson: resolve(matrixJson) } : {}),
		...(publishTo ? { publishTo: resolve(publishTo) } : {}),
	};
}

function rec(overrides: Partial<DeliveryRecord>): DeliveryRecord {
	return {
		schemaVersion: 1,
		kind: "Observation",
		id: "r",
		role: "subject",
		issuedAt: ISSUED,
		issuer: ISSUER,
		...overrides,
	};
}

function contextFacts(cwd: string): { facts: { key: string; value: string }[]; residuals: string[] } {
	const facts: { key: string; value: string }[] = [{ key: "resolver", value: "pelaggio-context-v1" }];
	const residuals: string[] = [];
	for (const rel of CONTEXT_PATHS) {
		const path = join(cwd, rel);
		if (!existsSync(path)) {
			residuals.push(`governing-context missing ${rel}`);
			continue;
		}
		facts.push({ key: rel, value: createHash("sha256").update(readFileSync(path)).digest("hex") });
	}
	return { facts, residuals };
}

function loadAcceptanceInput(args: ComposeArgs): AcceptanceInput {
	const evidencePath = join(args.cwd, PIPELINE_TEST);
	const evidence = existsSync(evidencePath) ? readFileSync(evidencePath) : undefined;
	if (args.fixtureObservations) {
		return {
			observations: ACCEPTANCE_TESTS.map((test) => ({ ...test, status: "pass" })),
			complete: true,
			residuals: ["acceptance results are fixture observations for a hermetic schema/oracle run"],
		};
	}

	let matrix: Record<string, unknown> = {};
	const residuals: string[] = [];
	if (!args.matrixJson) {
		residuals.push("acceptance matrix missing: compose requires --matrix-json outside fixture mode");
	} else {
		try {
			const parsed: unknown = JSON.parse(readFileSync(args.matrixJson, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) matrix = parsed as Record<string, unknown>;
			else residuals.push("acceptance matrix must be a JSON object");
		} catch (error) {
			residuals.push(`acceptance matrix unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const observations = ACCEPTANCE_TESTS.map((test): AcceptanceObservation => {
		const value = matrix[test.title];
		const status: AcceptanceStatus = value === "pass" || value === "fail" ? value : value === undefined ? "missing" : "invalid";
		if (status !== "pass") residuals.push(`${test.title}: ${status}`);
		return { ...test, status };
	});
	if (!evidence) residuals.push(`acceptance evidence missing: ${PIPELINE_TEST}`);
	return { observations, complete: observations.every((observation) => observation.status === "pass") && evidence !== undefined, ...(evidence ? { evidence } : {}), residuals };
}

function writeProjections(dir: string, git: DeliverySubject): ReturnType<typeof verifyLoadedBundle> {
	const result = verifyLoadedBundle(loadBundle(dir), git, `npx pelaggio verify --bundle ${dir}`);
	writeFileSync(join(dir, "dossier.md"), renderDossier(result));
	writeFileSync(join(dir, "verify.json"), renderVerifyJson(result));
	writeFileSync(join(dir, "verify.txt"), renderVerifyText(result));
	writeFileSync(join(dir, "INSPECTION.txt"), `npx pelaggio verify --bundle .\n`);
	return result;
}

interface GoldenInput {
	git: DeliverySubject;
	handoff: string;
	acceptance: AcceptanceInput;
	findings?: DeliveryRecord["findings"];
	subjectBindingTree?: string;
	caseTree?: string;
	human?: DeliveryRecord;
	landingTree?: string;
	omitAttachment?: boolean;
}

function publishPacket(dest: string, input: GoldenInput, subjectRoot: string): { caseDigest: string } {
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	const git = input.git;
	const resultTree = input.caseTree ?? git.resultTree;
	const bindingTree = input.subjectBindingTree ?? git.resultTree;
	const { facts: ctxFacts, residuals: ctxResiduals } = contextFacts(subjectRoot);
	const att = input.omitAttachment ? undefined : publishAttachment(dest, input.handoff);
	const acceptanceAtt = input.acceptance.evidence ? publishAttachment(dest, input.acceptance.evidence) : undefined;
	const subject = rec({
		id: "subject-751",
		role: "subject",
		subjectBinding: { resultTree: git.resultTree, configuration: "automatic-quick" },
		facts: subjectFacts(git),
	});
	const intent = rec({
		kind: "Decision",
		id: "intent-751",
		role: "authorized-intent",
		facts: [
			{ key: "campaign", value: "751" },
			{ key: "payload", value: "706" },
		],
		...(att ? { attachments: [{ digest: att, role: "handoff" as const }] } : {}),
	});
	const scope = rec({
		kind: "Assessment",
		id: "scope-751",
		role: "scope",
		subjectBinding: { resultTree: bindingTree, configuration: "automatic-quick" },
		facts: [
			{ key: "accepted", value: "#706 pick clamp + delivery verifier + #751 composer" },
			{ key: "excluded", value: "ADR-0028 ledger/packet accretion, PKI, hosted store" },
			{ key: "residual", value: "PR-gate records and operator cold review" },
		],
	});
	const context = rec({
		id: "context-751",
		role: "governing-context",
		subjectBinding: { resultTree: git.resultTree },
		facts: ctxFacts,
	});
	const acceptanceRecords = ["automatic-quick", "profile-pin", "standard"].map((configuration) => {
		const observations = input.acceptance.observations.filter((observation) => observation.configuration === configuration);
		return rec({
			id: `ac-706-${configuration}`,
			role: "acceptance-claim",
			claims: [...new Set(observations.map((observation) => observation.ac))],
			subjectBinding: { resultTree: bindingTree, configuration },
			...(acceptanceAtt ? { attachments: [{ digest: acceptanceAtt, role: "evidence" as const }] } : {}),
			facts: observations.map((observation) => ({ key: `${observation.ac}:${observation.title}`, value: observation.status })),
		});
	});
	const review = rec({
		kind: "Assessment",
		id: "review-751",
		role: "review",
		subjectBinding: { resultTree: git.resultTree },
		findings: input.findings ?? [
			{ id: "authoring-review", severity: "note", summary: "Authoring-review records from this cycle are the available prospective reviews", disposition: "residual" },
			{ id: "pr-gate", severity: "note", summary: "PR-gate records do not yet exist", disposition: "residual" },
		],
	});
	const records = [subject, intent, scope, context, ...acceptanceRecords, review];
	const digests = records.map((r) => publishObject(dest, r));
	const subjectDigest = digests[0];
	const intentDigest = digests[1];
	const scopeDigest = digests[2];
	const contextDigest = digests[3];
	const acceptanceDigests = digests.slice(4, 4 + acceptanceRecords.length);
	const reviewDigest = digests[4 + acceptanceRecords.length];
	if (!subjectDigest || !intentDigest || !scopeDigest || !contextDigest || acceptanceDigests.length !== 3 || !reviewDigest) {
		throw new Error("campaign record publication was incomplete");
	}
	const acceptanceAttachmentDigests = acceptanceAtt ? [acceptanceAtt] : [];
	if (!input.acceptance.complete) acceptanceAttachmentDigests.push("0".repeat(64));
	const deliveryCase: DeliveryCase = {
		schemaVersion: 1,
		kind: "Case",
		id: "case-751",
		issuedAt: ISSUED,
		issuer: ISSUER,
		subject: { ...git, resultTree },
		admittedRecords: digests,
		obligations: [
			{ id: "intent", group: "intent", recordDigests: [intentDigest], attachmentDigests: att ? [att] : ["0".repeat(64)] },
			{ id: "subject", group: "subject-result-tree", recordDigests: [subjectDigest], attachmentDigests: [] },
			{ id: "binding", group: "subject-config-binding", recordDigests: acceptanceDigests, attachmentDigests: [] },
			{ id: "scope", group: "scope", recordDigests: [scopeDigest], attachmentDigests: [] },
			{ id: "context", group: "governing-context", recordDigests: [contextDigest], attachmentDigests: [] },
			{ id: "acceptance", group: "acceptance", recordDigests: acceptanceDigests, attachmentDigests: acceptanceAttachmentDigests },
			{ id: "review", group: "review-findings", recordDigests: [reviewDigest], attachmentDigests: [] },
		],
		residuals: [...ctxResiduals, ...input.acceptance.residuals, "PR-gate records do not yet exist", "Human authorization pending"],
	};
	const caseDigest = publishObject(dest, deliveryCase);
	const policy = rec({
		kind: "Decision",
		id: "policy-751",
		role: "policy",
		caseDigest,
		authority: "harness-policy",
		facts: [{ key: "over", value: caseDigest }],
	});
	const policyDigest = publishObject(dest, policy);
	const roots: { schemaVersion: 1; case: string; policyDecision: string; humanDecision?: string; effects?: string[] } = {
		schemaVersion: 1,
		case: caseDigest,
		policyDecision: policyDigest,
	};
	if (input.human) roots.humanDecision = publishObject(dest, { ...input.human, caseDigest: input.human.caseDigest ?? caseDigest });
	if (input.landingTree) {
		roots.effects = [publishObject(dest, rec({ kind: "Effect", id: "landing-751", role: "landing", caseDigest, resultTree: input.landingTree }))];
	}
	writeRoots(dest, roots);
	return { caseDigest };
}

function packetHasForbiddenLeak(dir: string): string[] {
	const leaks: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, name.name);
			if (name.isDirectory()) {
				walk(p);
				continue;
			}
			if (/sealed-mapping|expected-answer|pelaggio-log|session/i.test(name.name)) leaks.push(p);
			const text = readFileSync(p, "utf8");
			if (/sealed-mapping|issue discussion|expected answer/i.test(text) && !/INSPECTION|dossier|verify/.test(name.name)) {
				if (/sealed mapping kept out/i.test(text)) leaks.push(p);
			}
		}
	};
	walk(dir);
	return leaks;
}

export function composeReconciledChange751(args: ComposeArgs): ComposeResult {
	const git = inspectGitSubject(args.cwd);
	const handoff = readFileSync(HANDOFF_FIXTURE, "utf8");
	const acceptance = loadAcceptanceInput(args);
	const out = args.out;
	mkdirSync(out, { recursive: true });
	const goldenDir = join(out, "golden");
	const { caseDigest } = publishPacket(goldenDir, { git, handoff, acceptance }, args.cwd);
	const goldenVerify = writeProjections(goldenDir, git);
	if (goldenVerify.caseDisposition !== "ACCEPTED") {
		const payload = { caseDigest, status: "withheld" as const, reason: "golden Case is not ACCEPTED", verify: goldenVerify };
		writeFileSync(join(out, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
		return {
			caseDigest,
			out,
			mutations: {} as ComposeResult["mutations"],
			coldPackets: [],
			sealedMappingPath: join(out, "sealed-mapping.json"),
			status: "withheld",
			inspectionCommand: `npx pelaggio verify --bundle ${goldenDir}`,
		};
	}

	const mutationSpecs: Record<MutationName, GoldenInput> = {
		"result-tree": { git, handoff, acceptance, caseTree: "0".repeat(40) },
		"missing-attachment": { git, handoff, acceptance, omitAttachment: true },
		"other-subject": { git, handoff, acceptance, subjectBindingTree: "e".repeat(40) },
		"open-finding": {
			git,
			handoff,
			acceptance,
			findings: [{ id: "blocker", severity: "material", summary: "open material defect", disposition: "open" }],
		},
		"missing-disposition": {
			git,
			handoff,
			acceptance,
			findings: [{ id: "needs-call", severity: "material", summary: "material finding without disposition" }],
		},
		"wrong-authority": {
			git,
			handoff,
			acceptance,
			human: rec({
				kind: "Decision",
				id: "human-wrong",
				role: "human-authorization",
				authority: "imposter",
				caseDigest: "f".repeat(64),
			}),
		},
		"landing-tree": { git, handoff, acceptance, landingTree: "0".repeat(40) },
	};

	const mutations = {} as ComposeResult["mutations"];
	for (const name of MUTATION_NAMES) {
		const dir = join(out, "mutations", name);
		publishPacket(dir, mutationSpecs[name], args.cwd);
		const result = writeProjections(dir, git);
		mutations[name] = { overall: result.overall, caseDisposition: result.caseDisposition };
	}

	const coldDir = join(out, "cold");
	mkdirSync(coldDir, { recursive: true });
	const names = [`pkt-${randomBytes(8).toString("hex")}`, `pkt-${randomBytes(8).toString("hex")}`];
	const validFirst = randomBytes(1)[0] % 2 === 0;
	const validName = validFirst ? names[0] : names[1];
	const mutName = validFirst ? names[1] : names[0];
	cpSync(goldenDir, join(coldDir, validName), { recursive: true });
	cpSync(join(out, "mutations", "result-tree"), join(coldDir, mutName), { recursive: true });
	const mapping = {
		valid: validName,
		mutation: mutName,
		mutationKind: "result-tree",
		order: validFirst ? [validName, mutName] : [mutName, validName],
	};
	const sealedMappingPath = join(out, "sealed-mapping.json");
	writeFileSync(sealedMappingPath, `${JSON.stringify(mapping, null, 2)}\n`);

	if (args.publishTo) {
		const dest = registerPath(args.publishTo, "delivery-cases", "by-tree", git.resultTree);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(goldenDir, dest, { recursive: true });
	}

	const status = "withheld" as const;
	const resultPayload = {
		caseDigest,
		mutations,
		coldPackets: [join(coldDir, names[0]), join(coldDir, names[1])],
		sealedMapping: sealedMappingPath,
		status,
		note: "Operator cold review is withheld; the implementer must not grade the packets.",
		inspectionCommand: `npx pelaggio verify --bundle ${join(coldDir, validName)}`,
	};
	writeFileSync(join(out, "result.json"), `${JSON.stringify(resultPayload, null, 2)}\n`);
	return {
		caseDigest,
		out,
		mutations,
		coldPackets: resultPayload.coldPackets,
		sealedMappingPath,
		status,
		inspectionCommand: resultPayload.inspectionCommand,
	};
}

export { packetHasForbiddenLeak };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		const result = composeReconciledChange751(parseComposeArgs(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify({ caseDigest: result.caseDigest, status: result.status, out: result.out }, null, 2)}\n`);
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(2);
	}
}
