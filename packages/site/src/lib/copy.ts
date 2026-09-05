export const REPO_URL = "https://github.com/pelaggio/pelaggio";

export const PIPELINE_STEPS = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"] as const;

export const INIT_COMMAND = "npx pelaggio init";

export const RUN_COMMAND = "npx pelaggio run --cycles 1 --verbose";

export const FIT_PROMPT =
	"Fit Pelaggio to this repository. Fill the quality rubric from the actual codebase, especially Correct and Verification. Point .pelaggio.yml at this project's agent and check commands. Replace the sample roadmap with the next real work item. Write AGENTS.md if it is missing. Do not start a cycle.";

export const META_DESCRIPTION = "Pelaggio is a CLI that runs each work item through a fixed pipeline — plan, implement, review, ship — in its own git worktree. Bring your own agent.";

export const TAGLINE = "Extend how much one developer can ship.";
