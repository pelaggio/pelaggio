/** Environment inherited by a subprocess operating inside a registered repo. */
export function createRepoChildEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...process.env, ...overrides };
	// Repo-scoped children may invoke provider CLIs or agent-authored code. The
	// control-plane bearer credential belongs only to the daemon authority.
	delete env.CONTROL_PLANE_TOKEN;
	return env;
}
