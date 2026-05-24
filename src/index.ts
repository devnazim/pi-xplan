import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type XPlanMode = "regular" | "steps";
type XPlanPhase = "planning" | "implementing" | "awaiting_review" | "complete";

interface XPlanState {
	active: boolean;
	mode: XPlanMode;
	phase: XPlanPhase;
	task?: string;
	currentStep: number;
	updatedAt: number;
}

const STATE_ENTRY_TYPE = "xplan-state";

const DEFAULT_STATE: XPlanState = {
	active: false,
	mode: "regular",
	phase: "complete",
	currentStep: 0,
	updatedAt: 0,
};

const HELP = `xplan commands:
/xplan [task]             Start regular plan mode
/xplan steps [task]       Start bottom-up step-by-step planning mode
/xplan approve            Approve current plan/current step for implementation
/xplan continue           Continue after manual review/staging
/xplan preview            Print current plan with completed step checkmarks
/xplan complete           Mark xplan session complete
/xplan exit               Exit xplan mode
/xplan status             Show current state
/xplan help               Show this help`;

const SUBCOMMANDS = ["steps", "approve", "continue", "preview", "complete", "exit", "status", "help"];

function cloneState(state: XPlanState): XPlanState {
	return { ...state };
}

function restoreState(ctx: ExtensionContext): XPlanState {
	const entries = ctx.sessionManager.getBranch();
	const restored = [...entries]
		.reverse()
		.find((entry): entry is { type: "custom"; customType: string; data?: Partial<XPlanState> } => {
			return entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE;
		});

	return { ...DEFAULT_STATE, ...restored?.data };
}

function persistState(pi: ExtensionAPI, state: XPlanState): void {
	state.updatedAt = Date.now();
	pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
}

function statusText(state: XPlanState): string {
	if (!state.active) return "xplan: inactive";

	const mode = state.mode === "steps" ? "steps" : "plan";
	const task = state.task ? ` — ${state.task}` : "";
	const step = state.mode === "steps" && state.currentStep > 0 ? `, step ${state.currentStep}` : "";
	return `xplan: ${mode}, ${state.phase}${step}${task}`;
}

function updateStatus(ctx: ExtensionContext, state: XPlanState): void {
	if (!ctx.hasUI) return;

	if (!state.active) {
		ctx.ui.setStatus("xplan", undefined);
		return;
	}

	const label = state.mode === "steps" ? "xplan steps" : "xplan";
	const phase = state.phase.replaceAll("_", " ");
	ctx.ui.setStatus("xplan", ctx.ui.theme.fg("accent", `${label}: ${phase}`));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function sendUserMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(text);
		return;
	}

	pi.sendUserMessage(text, { deliverAs: "followUp" });
	notify(ctx, "xplan message queued after current agent turn", "info");
}

function parseCommand(args: string): { subcommand?: string; task: string } {
	const trimmed = args.trim();
	if (!trimmed) return { task: "" };

	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (SUBCOMMANDS.includes(first)) {
		return { subcommand: first, task: rest.join(" ").trim() };
	}

	return { task: trimmed };
}

function regularPlanPrompt(task: string): string {
	const subject = task ? ` for this task:\n\n${task}` : "";
	return `[xplan] Start regular plan mode${subject}

Discuss and inspect as needed. Build a clear implementation plan, but do not edit files or run mutating commands yet. When the plan is ready, ask me to run /xplan approve before implementation.`;
}

function stepsPlanPrompt(task: string): string {
	const subject = task ? ` for this task:\n\n${task}` : "";
	return `[xplan steps] Start bottom-up step-by-step planning mode${subject}

First build the full feature picture: behavior, data flow, dependencies, integration points, and required code blocks. Then create review-friendly implementation steps from bottom to top. Do not edit files or run mutating commands yet. When the plan is ready, ask me to run /xplan approve to implement the first step.`;
}

function approvePrompt(state: XPlanState): string {
	if (state.mode === "steps") {
		const step = state.currentStep > 0 ? state.currentStep : 1;
		return `[xplan approve] I approve implementation of the current xplan step.

This approves the current bottom-up step plan. Implement only step ${step}. Keep the diff review-friendly. Do not change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state. After implementing this step, stop and ask me to review/stage files manually before /xplan continue.

After this approval, /xplan continue is enough to implement each next pending planned step. Do not ask for /xplan approve again unless the agreed plan/scope changes or you need to rework a completed/reviewed step due to a conflict.`;
	}

	return `[xplan approve] I approve implementation of the current xplan plan.

Implement the approved scope. Do not change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state. Review your changes and fix issues you find before stopping for my manual review.`;
}

function continuePrompt(state: XPlanState): string {
	if (state.mode === "steps") {
		return `[xplan continue] I have reviewed/staged the previous step manually.

The bottom-up step plan is already approved. This /xplan continue command is approval to implement the next pending planned step; do not ask for /xplan approve again merely because the next step edits an existing file or a file touched by an earlier pending/planned step.

Continue the bottom-up step-by-step plan. If there is another planned step, implement only that next step and then stop for manual review/staging again. If the previous step was the last planned implementation step, mark implementation complete, review the full feature, run/check reasonable validation if available, fix issues you find, then summarize and wait for /xplan complete or further plan changes.

Only ask for /xplan approve again if the agreed plan/scope changes or you need to rework a completed/reviewed step due to a conflict.

Never change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state.`;
	}

	return `[xplan continue] I have reviewed the previous implementation manually.

Return to xplan discussion mode. Summarize current status and ask whether to adjust the plan, add follow-up work, or run /xplan complete. Do not make additional changes without /xplan approve.`;
}

function previewPrompt(state: XPlanState): string {
	const stepHint = state.mode === "steps" && state.currentStep > 0 ? ` Current tracked step is ${state.currentStep}.` : "";
	return `[xplan preview] Print the current xplan plan from the conversation context.${stepHint}

Show the whole plan in a compact reviewable format. Use status marks:
- ✅ completed/reviewed steps
- 🟡 implemented but awaiting my review/staging, if any
- ➡️ current or next step
- ☐ pending steps

If the plan has changed, show the latest agreed version. If completed steps conflict with a changed plan, warn clearly. Do not edit files or run mutating commands.`;
}

function activeInstructions(state: XPlanState): string {
	const base = `

XPLAN EXTENSION ACTIVE
Current state: ${statusText(state)}

Hard workflow rules:
- This extension is steering-only: no custom security gate is enforcing these rules, so you must follow them carefully.
- Never run git commands that stage, unstage, commit, push, pull, merge, rebase, stash, reset, restore, checkout files, cherry-pick, or otherwise mutate git history/state.
- The user reviews and stages files manually with git.
- Do not edit files or run mutating commands while xplan is in planning/discussion mode. Wait for /xplan approve.
- After an approved implementation, stop for manual review/staging. Do not continue implementing more scope until /xplan continue or another explicit approval.
- In approved step mode, /xplan continue is explicit approval to implement the next pending planned step. Do not ask for /xplan approve again merely because that pending step edits an existing file.
- If the agreed plan/scope changes after completed/reviewed steps and conflicts with previous work, clearly warn that completed steps have conflicts. Explain what must be resolved and wait for /xplan approve before reworking completed/reviewed files.
`;

	if (state.mode === "regular") {
		return `${base}
Regular xplan mode:
- Discuss and inspect until the implementation plan is clear.
- Produce a concise plan with enough detail to implement safely.
- Ask the user to run /xplan approve before implementation.
- When implementing, stay inside the approved scope and review/fix your changes before stopping.`;
	}

	return `${base}
Xplan steps mode:
- Build the full feature picture first: user-facing behavior, data flow, dependencies, integration points, and required code blocks.
- Split implementation bottom-up so required building blocks come before dependents.
- Prefer steps such as types/models/config, utilities/services, handlers/APIs, client bindings, UI components, page/feature wiring, then polish/tests/docs.
- Keep each step review-friendly: not one tiny variable, not a huge many-file diff.
- Keep the project buildable after each step when practical. If pieces rely on each other and builds would fail separately, group them in one step.
- Implement only one approved step at a time.
- Once the step plan has been approved, treat /xplan continue as approval for the next pending planned step.
- Do not require another /xplan approve unless the agreed plan/scope changes or a completed/reviewed step must be reworked.
- On the last implementation step, review the full changed feature, run/check reasonable validation if available, and fix issues before stopping.`;
}

export default function xplanExtension(pi: ExtensionAPI): void {
	let state: XPlanState = { ...DEFAULT_STATE };

	function setState(ctx: ExtensionContext, patch: Partial<XPlanState>): void {
		state = { ...state, ...patch };
		persistState(pi, state);
		updateStatus(ctx, state);
	}

	pi.registerCommand("xplan", {
		description: "Simple plan and step-by-step planning mode",
		getArgumentCompletions: (prefix) => {
			const filtered = SUBCOMMANDS.filter((command) => command.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((command) => ({ value: command, label: command })) : null;
		},
		handler: async (args, ctx) => {
			const { subcommand, task } = parseCommand(args);

			if (subcommand === "help") {
				notify(ctx, HELP, "info");
				return;
			}

			if (subcommand === "status") {
				notify(ctx, statusText(state), "info");
				return;
			}

			if (subcommand === "complete" || subcommand === "exit") {
				setState(ctx, { active: false, phase: "complete", task: undefined, currentStep: 0 });
				notify(ctx, subcommand === "exit" ? "xplan exited" : "xplan completed", "info");
				return;
			}

			if (subcommand === "approve") {
				if (!state.active) {
					notify(ctx, "No active xplan. Start with /xplan or /xplan steps.", "warning");
					return;
				}

				const currentStep = state.mode === "steps" && state.currentStep === 0 ? 1 : state.currentStep;
				setState(ctx, { phase: "implementing", currentStep });
				sendUserMessage(pi, ctx, approvePrompt({ ...state, phase: "implementing", currentStep }));
				return;
			}

			if (subcommand === "continue") {
				if (!state.active) {
					notify(ctx, "No active xplan. Start with /xplan or /xplan steps.", "warning");
					return;
				}

				const nextStep = state.mode === "steps" ? Math.max(1, state.currentStep + 1) : state.currentStep;
				setState(ctx, { phase: state.mode === "steps" ? "implementing" : "planning", currentStep: nextStep });
				sendUserMessage(pi, ctx, continuePrompt({ ...state, currentStep: nextStep }));
				return;
			}

			if (subcommand === "preview") {
				if (!state.active) {
					notify(ctx, "No active xplan. Start with /xplan or /xplan steps.", "warning");
					return;
				}

				sendUserMessage(pi, ctx, previewPrompt(state));
				return;
			}

			if (subcommand === "steps") {
				setState(ctx, {
					active: true,
					mode: "steps",
					phase: "planning",
					task: task || undefined,
					currentStep: 0,
				});
				if (task) {
					sendUserMessage(pi, ctx, stepsPlanPrompt(task));
				} else {
					notify(ctx, "xplan steps mode enabled. Describe the task when ready.", "info");
				}
				return;
			}

			setState(ctx, {
				active: true,
				mode: "regular",
				phase: "planning",
				task: task || undefined,
				currentStep: 0,
			});
			if (task) {
				sendUserMessage(pi, ctx, regularPlanPrompt(task));
			} else {
				notify(ctx, "xplan plan mode enabled. Describe the task when ready.", "info");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active || state.phase === "complete") return undefined;

		return {
			systemPrompt: event.systemPrompt + activeInstructions(state),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active || state.phase !== "implementing") return;

		state = { ...state, phase: "awaiting_review", updatedAt: Date.now() };
		persistState(pi, state);
		updateStatus(ctx, state);
		notify(ctx, "xplan implementation step finished. Review/stage manually, then use /xplan continue or /xplan complete.", "info");
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		updateStatus(ctx, state);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("xplan", undefined);
	});
}
