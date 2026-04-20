export const STORAGE_KEY = "autopilot-token";

type Resolver = (token: string) => void;
type PromptHandler = () => void;

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

let storage: StorageLike | null = defaultStorage();
let cached: string | null = null;
let cacheLoaded = false;
let handler: PromptHandler | null = null;
let pending: Promise<string> | null = null;
let pendingResolvers: Resolver[] = [];
let lastRejected = false;

function loadCache(): void {
	if (cacheLoaded) return;
	cacheLoaded = true;
	cached = storage?.getItem(STORAGE_KEY) ?? null;
}

export function getToken(): string | null {
	loadCache();
	return cached;
}

export function setToken(token: string): void {
	cacheLoaded = true;
	cached = token;
	storage?.setItem(STORAGE_KEY, token);
	lastRejected = false;
	const resolvers = pendingResolvers;
	pendingResolvers = [];
	pending = null;
	for (const r of resolvers) r(token);
}

export function clearToken(): void {
	cacheLoaded = true;
	cached = null;
	storage?.removeItem(STORAGE_KEY);
}

export function markTokenRejected(): void {
	lastRejected = true;
	clearToken();
}

export function wasLastRejected(): boolean {
	return lastRejected;
}

export function promptForToken(): Promise<string> {
	if (pending) return pending;
	pending = new Promise<string>((resolve) => {
		pendingResolvers.push(resolve);
	});
	if (handler) handler();
	return pending;
}

export function registerPromptHandler(fn: PromptHandler | null): void {
	handler = fn;
	if (fn && pending) fn();
}

export function __setStorageForTests(s: StorageLike | null): void {
	storage = s;
	cached = null;
	cacheLoaded = false;
	handler = null;
	pending = null;
	pendingResolvers = [];
	lastRejected = false;
}
