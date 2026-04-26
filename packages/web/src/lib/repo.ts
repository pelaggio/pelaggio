import type { RepoEntry } from "@cdhorne/claude-autopilot-server/types";
import { useSyncExternalStore } from "react";
import { listRepos } from "./api.js";

export const STORAGE_KEY = "autopilot-current-repo";

export type RepoState = { status: "loading" } | { status: "error"; error: string } | { status: "empty"; repos: readonly RepoEntry[] } | { status: "ready"; repos: readonly RepoEntry[]; current: string };

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

type Fetcher = () => Promise<{ repos: RepoEntry[] }>;

function defaultStorage(): StorageLike | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

let storage: StorageLike | null = defaultStorage();
let fetcher: Fetcher = listRepos;
let state: RepoState = { status: "loading" };
let initPromise: Promise<RepoState> | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
	for (const fn of subscribers) fn();
}

export function getSnapshot(): RepoState {
	return state;
}

export function subscribe(fn: () => void): () => void {
	subscribers.add(fn);
	if (initPromise === null) void init();
	return () => {
		subscribers.delete(fn);
	};
}

export async function init(): Promise<RepoState> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		try {
			const { repos } = await fetcher();
			if (repos.length === 0) {
				state = { status: "empty", repos };
			} else {
				const stored = storage?.getItem(STORAGE_KEY) ?? null;
				const match = stored && repos.find((r) => r.slug === stored);
				const current = match ? match.slug : repos[0]!.slug;
				if (current !== stored) storage?.setItem(STORAGE_KEY, current);
				state = { status: "ready", repos, current };
			}
		} catch (err) {
			state = { status: "error", error: err instanceof Error ? err.message : String(err) };
		}
		notify();
		return state;
	})();
	return initPromise;
}

export async function retryInit(): Promise<RepoState> {
	if (state.status !== "error") return state;
	initPromise = null;
	state = { status: "loading" };
	notify();
	return init();
}

export function setCurrentRepo(slug: string): void {
	if (state.status !== "ready") {
		throw new Error(`cannot set repo ${JSON.stringify(slug)} — store not ready`);
	}
	if (!state.repos.some((r) => r.slug === slug)) {
		throw new Error(`unknown repo ${JSON.stringify(slug)}`);
	}
	if (state.current === slug) return;
	state = { ...state, current: slug };
	storage?.setItem(STORAGE_KEY, slug);
	notify();
}

export function useRepos(): RepoState {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCurrentRepo(): string | null {
	const s = useRepos();
	return s.status === "ready" ? s.current : null;
}

export function __setStorageForTests(s: StorageLike | null): void {
	storage = s;
	state = { status: "loading" };
	initPromise = null;
	subscribers.clear();
	fetcher = listRepos;
}

export function __setFetcherForTests(f: Fetcher): void {
	fetcher = f;
}
