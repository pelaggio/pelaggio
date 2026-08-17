/**
 * Identity/permission routes for the layered trust rule (`isTrustedCommentAuthor`,
 * `../github-posting.ts`), shared by review-sweep and revise-sweep tests: `self` answers
 * `gh api user` (absent → exit 1, as with an unauthenticated token), `permissions` answers
 * the collaborator-permission probe per login (absent login → exit 1, the 404 shape).
 * Returns undefined for any other call so tests can layer their own routes behind it.
 */
export function trustRoutes(opts: { self?: string; permissions?: Record<string, string> }): (args: string[]) => { stdout?: string; status?: number } | undefined {
	return (args) => {
		if (args[0] !== "api") return undefined;
		if (args[1] === "user") return opts.self ? { stdout: `${opts.self}\n` } : { status: 1 };
		const login = args[1]?.match(/^repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/)?.[1];
		if (login !== undefined) {
			const permission = opts.permissions?.[decodeURIComponent(login)];
			return permission ? { stdout: JSON.stringify({ permission, role_name: permission }) } : { status: 1 };
		}
		return undefined;
	};
}
