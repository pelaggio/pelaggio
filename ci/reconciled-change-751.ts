/**
 * #751 campaign composer / mutation oracle. Not a production workflow engine.
 *
 * usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--publish-to <mainRepo>]
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
const MUTATION_NAMES = ["result-tree", "missing-attachment", "other-subject", "open-finding", "missing-disposition", "wrong-authority"] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];

export interface ComposeArgs {
	out: string;
	cwd: string;
	publishTo?: string;
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
		if (a === "--publish-to") {
			publishTo = argv[++i];
			continue;
		}
		throw new Error(`usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--publish-to <mainRepo>] (unknown: ${a})`);
	}
	if (!out) throw new Error("usage: npx tsx ci/reconciled-change-751.ts --out <dir> [--cwd <repo>] [--publish-to <mainRepo>]");
	return { out: resolve(out), cwd: resolve(cwd), ...(publishTo ? { publishTo: resolve(publishTo) } : {}) };
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
	findings?: DeliveryRecord["findings"];
	subjectBindingTree?: string;
	caseTree?: string;
	human?: DeliveryRecord;
	omitAttachment?: boolean;
}

function publishPacket(dest: string, input: GoldenInput): { caseDigest: string } {
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	const git = input.git;
	const resultTree = input.caseTree ?? git.resultTree;
	const bindingTree = input.subjectBindingTree ?? git.resultTree;
	const { facts: ctxFacts, residuals: ctxResiduals } = contextFacts(process.cwd());
	const att = input.omitAttachment ? undefined : publishAttachment(dest, input.handoff);
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
	const ac = rec({
		id: "ac-706",
		role: "acceptance-claim",
		claims: ["AC-1", "AC-2", "AC-3", "AC-4"],
		subjectBinding: { resultTree: bindingTree, configuration: "automatic-quick" },
		facts: [
			{ key: "AC-1", value: "automatic-quick + committed plan + resume plan does not enter plan/shakedown-plan; entryDecision recorded" },
			{ key: "AC-2", value: "automatic-quick + resume shakedown-plan clamps to implement" },
			{ key: "AC-3", value: "automatic-quick + later resume shakedown-code/ship is not rewound" },
			{ key: "AC-4", value: "standard mode and explicit --profile pins keep existing start semantics" },
		],
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
	const records = [subject, intent, scope, context, ac, review];
	const digests = records.map((r) => publishObject(dest, r));
	const deliveryCase: DeliveryCase = {
		schemaVersion: 1,
		kind: "Case",
		id: "case-751",
		issuedAt: ISSUED,
		issuer: ISSUER,
		subject: { ...git, resultTree },
		admittedRecords: digests,
		obligations: [
			{ id: "intent", group: "intent", recordDigests: [digests[1]], attachmentDigests: att ? [att] : ["0".repeat(64)] },
			{ id: "subject", group: "subject-result-tree", recordDigests: [digests[0]], attachmentDigests: [] },
			{ id: "binding", group: "subject-config-binding", recordDigests: [digests[4]], attachmentDigests: [] },
			{ id: "scope", group: "scope", recordDigests: [digests[2]], attachmentDigests: [] },
			{ id: "context", group: "governing-context", recordDigests: [digests[3]], attachmentDigests: [] },
			{ id: "acceptance", group: "acceptance", recordDigests: [digests[4]], attachmentDigests: [] },
			{ id: "review", group: "review-findings", recordDigests: [digests[5]], attachmentDigests: [] },
		],
		residuals: [...ctxResiduals, "PR-gate records do not yet exist", "Human authorization pending"],
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
	const roots: { schemaVersion: 1; case: string; policyDecision: string; humanDecision?: string } = {
		schemaVersion: 1,
		case: caseDigest,
		policyDecision: policyDigest,
	};
	if (input.human) roots.humanDecision = publishObject(dest, { ...input.human, caseDigest: input.human.caseDigest ?? caseDigest });
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
	const handoff = `#751 authorized intent\nSelected payload: #706 automatic-quick resume clamp.\n`;
	const out = args.out;
	mkdirSync(out, { recursive: true });
	const goldenDir = join(out, "golden");
	const { caseDigest } = publishPacket(goldenDir, { git, handoff });
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
		"result-tree": { git, handoff, caseTree: "0".repeat(40) },
		"missing-attachment": { git, handoff, omitAttachment: true },
		"other-subject": { git, handoff, subjectBindingTree: "e".repeat(40) },
		"open-finding": {
			git,
			handoff,
			findings: [{ id: "blocker", severity: "material", summary: "open material defect", disposition: "open" }],
		},
		"missing-disposition": {
			git,
			handoff,
			findings: [{ id: "needs-call", severity: "material", summary: "material finding without disposition" }],
		},
		"wrong-authority": {
			git,
			handoff,
			human: rec({
				kind: "Decision",
				id: "human-wrong",
				role: "human-authorization",
				authority: "imposter",
				caseDigest: "f".repeat(64),
			}),
		},
	};

	const mutations = {} as ComposeResult["mutations"];
	for (const name of MUTATION_NAMES) {
		const dir = join(out, "mutations", name);
		publishPacket(dir, mutationSpecs[name]);
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
