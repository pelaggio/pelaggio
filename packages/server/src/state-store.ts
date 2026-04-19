import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PersistedRun } from "./types.js";

interface StateFile {
	runs: PersistedRun[];
}

export class StateStore {
	private readonly path: string;
	private state: StateFile;

	constructor(path: string) {
		this.path = path;
		this.state = this.read();
	}

	private read(): StateFile {
		if (!existsSync(this.path)) return { runs: [] };
		try {
			const raw = readFileSync(this.path, "utf-8");
			const parsed = JSON.parse(raw) as StateFile;
			if (!Array.isArray(parsed.runs)) return { runs: [] };
			return parsed;
		} catch {
			return { runs: [] };
		}
	}

	private write(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(this.state, null, 2));
		renameSync(tmp, this.path);
	}

	list(): PersistedRun[] {
		return this.state.runs.slice();
	}

	get(id: string): PersistedRun | null {
		return this.state.runs.find((r) => r.id === id) ?? null;
	}

	upsert(run: PersistedRun): PersistedRun {
		const idx = this.state.runs.findIndex((r) => r.id === run.id);
		if (idx >= 0) this.state.runs[idx] = run;
		else this.state.runs.push(run);
		this.write();
		return run;
	}

	remove(id: string): void {
		const before = this.state.runs.length;
		this.state.runs = this.state.runs.filter((r) => r.id !== id);
		if (this.state.runs.length !== before) this.write();
	}
}
