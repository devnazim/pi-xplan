import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type XPlanMode = "regular" | "steps";
type XPlanPhase = "planning" | "implementing" | "implementation_failed" | "awaiting_review" | "complete";
type XPlanTransition =
	| { type: "start"; mode: XPlanMode; task?: string }
	| { type: "approve" }
	| { type: "continue" }
	| { type: "resume_implementation" }
	| { type: "finish_implementation"; outcome: "success" | "failed" }
	| { type: "complete" };

interface XPlanState {
	active: boolean;
	mode: XPlanMode;
	phase: XPlanPhase;
	task?: string;
	currentStep: number;
	updatedAt: number;
}

interface XPlanRestoreResult {
	state: XPlanState;
	restored?: Partial<XPlanState>;
	inferred?: XPlanState;
}

const STATE_ENTRY_TYPE = "xplan-state";
const XPLAN_END_MESSAGE_TYPE = "xplan-ended";
const MUTATING_TOOLS = new Set(["edit", "write"]);
const MUTATING_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bapply_patch\b/i,
	/\bsed\s+-i\b/i,
	/\bperl\s+-pi\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\b(npm|pnpm|yarn)\s+(install|uninstall|update|ci|link|publish|add|remove)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|restore|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
];

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
/xplan approve            Approve implementation or review fixes for the current plan/step
/xplan continue           Accept reviewed work and continue after manual review/staging
/xplan preview            Print current plan with completed step checkmarks
/xplan complete           Mark xplan session complete and clear xplan steering
/xplan exit               Exit xplan mode and stop the current turn if needed
/xplan status             Show current state
/xplan help               Show this help`;

const SUBCOMMANDS = ["steps", "approve", "continue", "preview", "complete", "exit", "status", "help"];

function cloneState(state: XPlanState): XPlanState {
	return { ...state };
}

function stateForLog(state?: Partial<XPlanState>): Partial<XPlanState> | undefined {
	if (!state) return undefined;

	return {
		active: state.active,
		mode: state.mode,
		phase: state.phase,
		task: state.task,
		currentStep: state.currentStep,
		updatedAt: state.updatedAt,
	};
}

let debugLoggingEnabled = false;

function logDebug(event: string, details: Record<string, unknown>): void {
	if (!debugLoggingEnabled) return;

	console.error(`[xplan] ${event} ${JSON.stringify(details)}`);
}

function isRelevantForLog(state?: Partial<XPlanState>): boolean {
	return state?.active === true || (state?.phase !== undefined && state.phase !== "complete");
}

function isXPlanStartPromptText(text: string): boolean {
	return (
		text.startsWith("[xplan] Start regular plan mode") ||
		text.startsWith("[xplan steps] Start bottom-up step-by-step planning mode")
	);
}

function isXPlanEndPromptText(text: string): boolean {
	return text.startsWith("[xplan complete]") || text.startsWith("[xplan exit]");
}

function isXPlanControlPromptText(text: string): boolean {
	return (
		isXPlanStartPromptText(text) ||
		text.startsWith("[xplan approve]") ||
		text.startsWith("[xplan continue]") ||
		text.startsWith("[xplan preview]") ||
		isXPlanEndPromptText(text)
	);
}

function extractTaskFromStartPrompt(text: string): string | undefined {
	if (!isXPlanStartPromptText(text)) return undefined;

	const taskMarker = " for this task:\n\n";
	const taskStart = text.indexOf(taskMarker);
	if (taskStart === -1) return undefined;

	const contentStart = taskStart + taskMarker.length;
	const endMarkers = ["\n\nDiscuss and inspect", "\n\nFirst build the full feature picture"];
	const contentEnd = endMarkers
		.map((marker) => text.indexOf(marker, contentStart))
		.filter((index) => index !== -1)
		.sort((a, b) => a - b)[0];
	const task = text.slice(contentStart, contentEnd).trim();
	return task || undefined;
}

function xplanEndPrompt(subcommand: "complete" | "exit"): string {
	const verb = subcommand === "exit" ? "exited" : "completed";
	return `[xplan ${subcommand}] xplan mode has ${verb}.

xplan is inactive. Ignore earlier [xplan ...] workflow/control prompts in this conversation; they are historical, not active. Treat future user messages normally unless I start a new /xplan or /xplan steps session. Do not ask for /xplan approve or /xplan continue.`;
}

function normalizeState(restored?: Partial<XPlanState>, options: { preserveImplementing?: boolean } = {}): XPlanState {
	const next = { ...DEFAULT_STATE, ...restored };

	// Implementation approval is turn-local. If pi resumes while the persisted
	// state says "implementing", fail closed and require a fresh /xplan continue
	// or /xplan approve before allowing mutations again. Preserve it across hot
	// extension reloads so editing this extension during an approved turn does
	// not relock later tool calls in the same turn.
	if (next.active && next.phase === "implementing" && !options.preserveImplementing) {
		next.phase = "implementation_failed";
	}

	return next;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part !== "object" || part === null || !("text" in part)) return "";
			return typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function textFromEntry(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return "";

	if ("message" in entry) {
		const message = entry.message;
		if (typeof message !== "object" || message === null || !("content" in message)) return "";
		return textFromContent(message.content);
	}

	if ("content" in entry) return textFromContent(entry.content);

	return "";
}

function customTypeFromEntry(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || !("customType" in entry)) return undefined;
	return typeof entry.customType === "string" ? entry.customType : undefined;
}

function sanitizeInactiveContextMessage<T extends { role?: unknown; content?: unknown }>(message: T): T | undefined {
	if (message.role !== "user") return message;

	const text = textFromContent(message.content);
	if (!isXPlanControlPromptText(text)) return message;

	const task = extractTaskFromStartPrompt(text);
	if (!task) return undefined;

	return { ...message, content: `[historical xplan task]\n${task}` } as T;
}

function inferStateFromHistory(entries: readonly unknown[]): XPlanState | undefined {
	let inferred: XPlanState | undefined;

	for (const entry of entries) {
		if (customTypeFromEntry(entry) === XPLAN_END_MESSAGE_TYPE) {
			inferred = { ...DEFAULT_STATE };
			continue;
		}

		const text = textFromEntry(entry);
		if (!text) continue;

		if (isXPlanEndPromptText(text)) {
			inferred = { ...DEFAULT_STATE };
			continue;
		}

		if (text.startsWith("[xplan steps] Start")) {
			inferred = { ...DEFAULT_STATE, active: true, mode: "steps", phase: "planning" };
			continue;
		}

		if (text.startsWith("[xplan] Start regular")) {
			inferred = { ...DEFAULT_STATE, active: true, mode: "regular", phase: "planning" };
			continue;
		}

		if (text.startsWith("[xplan approve]") && inferred) {
			const step = text.match(/Implement only step (\d+)/)?.[1];
			inferred = {
				...inferred,
				phase: "awaiting_review",
				currentStep: step ? Number(step) : inferred.currentStep,
			};
			continue;
		}

		if (text.startsWith("[xplan continue]") && inferred) {
			inferred = {
				...inferred,
				phase: inferred.mode === "steps" ? "awaiting_review" : "planning",
				currentStep: inferred.mode === "steps" ? Math.max(1, inferred.currentStep + 1) : inferred.currentStep,
			};
		}
	}

	return inferred;
}

function restoreState(ctx: ExtensionContext, options: { preserveImplementing?: boolean } = {}): XPlanRestoreResult {
	const entries = ctx.sessionManager.getBranch();
	const restored = [...entries]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) as
		| { data?: Partial<XPlanState> }
		| undefined;
	const inferred = restored ? undefined : inferStateFromHistory(entries);
	const source = restored?.data ?? inferred;

	return {
		state: normalizeState(source, options),
		restored: restored?.data,
		inferred,
	};
}

function persistState(pi: ExtensionAPI, state: XPlanState): void {
	state.updatedAt = Date.now();
	pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
}

function transitionState(state: XPlanState, transition: XPlanTransition): XPlanState {
	switch (transition.type) {
		case "start":
			return {
				active: true,
				mode: transition.mode,
				phase: "planning",
				task: transition.task || undefined,
				currentStep: 0,
				updatedAt: state.updatedAt,
			};
		case "approve": {
			if (!state.active) return state;
			const currentStep = state.mode === "steps" && state.currentStep === 0 ? 1 : state.currentStep;
			return { ...state, phase: "implementing", currentStep };
		}
		case "continue": {
			if (!state.active) return state;
			if (state.phase === "implementation_failed") {
				return { ...state, phase: "implementing", currentStep: Math.max(1, state.currentStep) };
			}
			if (state.mode === "steps") {
				return { ...state, phase: "implementing", currentStep: Math.max(1, state.currentStep + 1) };
			}
			return { ...state, phase: "planning" };
		}
		case "resume_implementation":
			if (!state.active || state.phase !== "implementation_failed") return state;
			return { ...state, phase: "implementing" };
		case "finish_implementation":
			if (!state.active || state.phase !== "implementing") return state;
			return { ...state, phase: transition.outcome === "success" ? "awaiting_review" : "implementation_failed" };
		case "complete":
			return { ...state, active: false, phase: "complete", task: undefined, currentStep: 0 };
	}
}

function statusText(state: XPlanState): string {
	if (!state.active) return "xplan: inactive";

	const mode = state.mode === "steps" ? "steps" : "plan";
	const phase = state.phase.replaceAll("_", " ");
	const task = state.task ? ` — ${state.task}` : "";
	const step = state.mode === "steps" && state.currentStep > 0 ? `, step ${state.currentStep}` : "";
	return `xplan: ${mode}, ${phase}${step}${task}`;
}

function updateStatus(ctx: ExtensionContext, state: XPlanState): void {
	if (!ctx.hasUI) return;

	if (!state.active) {
		ctx.ui.setStatus("xplan", undefined);
		return;
	}

	const label = state.mode === "steps" ? "xplan steps" : "xplan";
	const phase = state.phase.replaceAll("_", " ");
	const color = state.phase === "implementation_failed" ? "error" : "accent";
	ctx.ui.setStatus("xplan", ctx.ui.theme.fg(color, `${label}: ${phase}`));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isBashMutation(command: string): boolean {
	return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function mutatingToolKind(toolName: string, input: unknown): "file" | "shell" | undefined {
	if (MUTATING_TOOLS.has(toolName)) return "file";

	if (toolName !== "bash") return undefined;

	const command = typeof input === "object" && input !== null && "command" in input ? input.command : undefined;
	return typeof command === "string" && isBashMutation(command) ? "shell" : undefined;
}

function implementationFailed(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") continue;
		return "stopReason" in message && (message.stopReason === "error" || message.stopReason === "aborted");
	}

	return true;
}

function mutationBlockReason(
	state: XPlanState,
	toolName: string,
	input: unknown,
	options: { allowFailedImplementationMutations?: boolean } = {},
): string | undefined {
	if (
		!state.active ||
		state.phase === "implementing" ||
		(state.phase === "implementation_failed" && options.allowFailedImplementationMutations)
	) {
		return undefined;
	}

	const hint = state.phase === "awaiting_review"
		? state.mode === "steps"
			? "Use /xplan approve for fixes to the current reviewed step, or /xplan continue only after accepting/staging it to advance."
			: "Use /xplan approve for review fixes, or /xplan continue after accepting the implementation to return to planning."
		: "Use /xplan approve or /xplan continue.";

	const kind = mutatingToolKind(toolName, input);
	if (kind === "file") {
		return `xplan is ${state.phase.replaceAll("_", " ")}; file edits are blocked. ${hint}`;
	}
	if (kind === "shell") {
		return `xplan is ${state.phase.replaceAll("_", " ")}; mutating shell commands are blocked. ${hint}`;
	}

	return undefined;
}

function exitMutationBlockReason(toolName: string, input: unknown): string | undefined {
	const kind = mutatingToolKind(toolName, input);
	if (kind === "file") return "xplan is exiting; file edits are blocked while the current agent turn stops.";
	if (kind === "shell") return "xplan is exiting; mutating shell commands are blocked while the current agent turn stops.";
	return undefined;
}

function sendUserMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(text);
		return;
	}

	pi.sendUserMessage(text, { deliverAs: "followUp" });
	notify(ctx, "xplan message queued after current agent turn", "info");
}

function sendEndMessage(pi: ExtensionAPI, subcommand: "complete" | "exit"): void {
	pi.sendMessage(
		{ customType: XPLAN_END_MESSAGE_TYPE, content: xplanEndPrompt(subcommand), display: false },
		{ triggerTurn: false },
	);
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
		return `[xplan approve] I approve implementation or review fixes for the current xplan step.

This approves the current bottom-up step plan/current step rework. Implement only step ${step}. Keep the diff review-friendly. Do not change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state. After implementing this step, stop and ask me to review/stage files manually. If I request fixes to this same awaiting-review step, ask for /xplan approve; if I accept/stage it and want the next step, ask for /xplan continue.

After this approval, /xplan continue is enough to implement each next pending planned step. Do not ask for /xplan approve again unless I request fixes/rework to the current awaiting-review step, the agreed plan/scope changes, or you need to rework a completed/reviewed step due to a conflict.`;
	}

	return `[xplan approve] I approve implementation or review fixes for the current xplan plan.

Implement or rework the approved scope. Do not change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state. Review your changes and fix issues you find before stopping for my manual review.`;
}

function continuePrompt(state: XPlanState, options: { retry?: boolean } = {}): string {
	if (state.mode === "steps") {
		if (options.retry) {
			return `[xplan continue] The previous implementation attempt for this step failed or was interrupted.

The bottom-up step plan is already approved. Retry step ${state.currentStep}. Keep the diff review-friendly and stay inside this step's approved scope. Do not advance to the next planned step yet.

Never change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state.`;
		}

		return `[xplan continue] I have reviewed/staged the previous step manually.

The bottom-up step plan is already approved. This /xplan continue command is approval to implement the next pending planned step; do not ask for /xplan approve again merely because the next step edits an existing file or a file touched by an earlier pending/planned step.

Continue the bottom-up step-by-step plan. If there is another planned step, implement only that next step and then stop for manual review/staging again. If the previous step was the last planned implementation step, mark implementation complete, review the full feature, run/check reasonable validation if available, fix issues you find, then summarize and wait for /xplan complete or further plan changes.

Only ask for /xplan approve again if the agreed plan/scope changes or you need to rework a completed/reviewed step due to a conflict.

Never change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state.`;
	}

	if (options.retry) {
		return `[xplan continue] The previous implementation attempt failed or was interrupted.

Retry the approved xplan implementation scope. Do not change git stage, commit, push, pull, rebase, stash, reset, or otherwise mutate git history/state. Review your changes and fix issues you find before stopping for my manual review.`;
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

function inactiveInstructions(): string {
	return `

XPLAN EXTENSION INACTIVE
- xplan is not active for this turn.
- Ignore earlier [xplan ...] workflow/control prompts in the conversation history; they are historical, not active.
- Do not ask the user to run /xplan approve or /xplan continue.
- Treat normal user replies as ordinary approval/instructions when appropriate.
- Only use xplan commands after the user starts /xplan or /xplan steps.`;
}

function activeInstructions(state: XPlanState): string {
	const base = `

XPLAN EXTENSION ACTIVE
Current state: ${statusText(state)}

Hard workflow rules:
- xplan blocks built-in edit/write tools and obvious mutating bash commands unless the state is implementing.
- Never run git commands that stage, unstage, commit, push, pull, merge, rebase, stash, reset, restore, checkout files, cherry-pick, or otherwise mutate git history/state.
- The user reviews and stages files manually with git.
- Do not edit files or run mutating commands while xplan is in planning/discussion, implementation-failed, or awaiting-review mode.
- If xplan is awaiting review and the user requests fixes/rework to the just-implemented current step, ask for /xplan approve; do not ask for /xplan continue.
- If implementation failed or was interrupted, /xplan continue retries the same approved scope/step instead of advancing.
- After an approved implementation, stop for manual review/staging. Do not continue implementing more scope until /xplan continue or another explicit approval.
- In approved step mode, /xplan continue means the user accepted/reviewed/staged the previous step and is explicitly approving implementation of the next pending planned step. Do not ask for /xplan approve again merely because that pending step edits an existing file.
- If the agreed plan/scope changes after completed/reviewed steps and conflicts with previous work, clearly warn that completed steps have conflicts. Explain what must be resolved and wait for /xplan approve before reworking completed/reviewed files.
`;

	if (state.mode === "regular") {
		return `${base}
Regular xplan mode:
- Discuss and inspect until the implementation plan is clear.
- Produce a concise plan with enough detail to implement safely.
- Ask the user to run /xplan approve before implementation or review fixes.
- When implementing or reworking review fixes, stay inside the approved scope and review/fix your changes before stopping.`;
	}

	return `${base}
Xplan steps mode:
- Build the full feature picture first: user-facing behavior, data flow, dependencies, integration points, and required code blocks.
- Split implementation bottom-up so required building blocks come before dependents.
- Prefer steps such as types/models/config, utilities/services, handlers/APIs, client bindings, UI components, page/feature wiring, then polish/tests/docs.
- Keep each step review-friendly: not one tiny variable, not a huge many-file diff.
- Keep the project buildable after each step when practical. If pieces rely on each other and builds would fail separately, group them in one step.
- Implement only one approved step at a time.
- Once the step plan has been approved, treat /xplan continue as approval for the next pending planned step only after the user accepts/reviews/stages the previous step.
- If the user gives review feedback for the current awaiting-review step, ask for /xplan approve to rework that same step instead of advancing.
- Do not require another /xplan approve for the next pending planned step unless the agreed plan/scope changes or a completed/reviewed step must be reworked.
- On the last implementation step, review the full changed feature, run/check reasonable validation if available, and fix issues before stopping.`;
}

export default function xplanExtension(pi: ExtensionAPI): void {
	pi.registerFlag("xplan-debug", {
		description: "Enable xplan state-machine debug logging",
		type: "boolean",
		default: false,
	});
	debugLoggingEnabled = pi.getFlag("xplan-debug") === true;

	let state: XPlanState = { ...DEFAULT_STATE };
	let approvedImplementationTurnActive = false;
	let exitInProgress = false;

	let currentTurnIndex: number | undefined;

	function setState(ctx: ExtensionContext, transition: XPlanTransition): void {
		const previousState = cloneState(state);
		state = transitionState(state, transition);

		logDebug("state_transition", {
			transition: transition.type,
			turnIndex: currentTurnIndex,
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			signalActive: ctx.signal !== undefined,
			previousState: stateForLog(previousState),
			nextState: stateForLog(state),
		});

		if (transition.type === "approve" || transition.type === "continue" || transition.type === "resume_implementation") {
			approvedImplementationTurnActive = state.phase === "implementing";
		} else if (transition.type === "start" || transition.type === "complete") {
			approvedImplementationTurnActive = false;
		} else if (transition.type === "finish_implementation" && transition.outcome === "success") {
			approvedImplementationTurnActive = false;
		}

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
				const wasIdle = ctx.isIdle();
				exitInProgress = !wasIdle;
				setState(ctx, { type: "complete" });

				if (!wasIdle) {
					ctx.abort();
					try {
						await ctx.waitForIdle();
					} finally {
						exitInProgress = false;
					}
				}

				sendEndMessage(pi, subcommand);
				const result = subcommand === "exit" ? "exited" : "completed";
				notify(ctx, wasIdle ? `xplan ${result}` : `xplan ${result}; current agent turn stopped`, "info");
				return;
			}

			if (subcommand === "approve") {
				if (!state.active || state.phase === "complete") {
					notify(
						ctx,
						"No active xplan. /xplan approve only applies after starting /xplan or /xplan steps; if you are approving normal work, reply normally instead.",
						"warning",
					);
					return;
				}
				if (!ctx.isIdle()) {
					notify(
						ctx,
						"Wait for the current agent turn to finish, then run /xplan approve so edits are only unlocked for the approved turn.",
						"warning",
					);
					return;
				}

				const approvedState = transitionState(state, { type: "approve" });
				setState(ctx, { type: "approve" });
				sendUserMessage(pi, ctx, approvePrompt(approvedState));
				return;
			}

			if (subcommand === "continue") {
				if (!state.active || state.phase === "complete") {
					notify(
						ctx,
						"No active xplan. Start with /xplan or /xplan steps to use xplan commands; if you are approving normal work, reply normally instead of using /xplan approve.",
						"warning",
					);
					return;
				}
				if (!ctx.isIdle()) {
					notify(
						ctx,
						"Wait for the current agent turn to finish, then run /xplan continue so edits are only unlocked for the approved turn.",
						"warning",
					);
					return;
				}

				const retry = state.phase === "implementation_failed";
				const continuedState = transitionState(state, { type: "continue" });
				setState(ctx, { type: "continue" });
				sendUserMessage(pi, ctx, continuePrompt(continuedState, { retry }));
				return;
			}

			if (subcommand === "preview") {
				if (!state.active || state.phase === "complete") {
					notify(
						ctx,
						"No active xplan. Start with /xplan or /xplan steps to use xplan commands; if you are approving normal work, reply normally instead of using /xplan approve.",
						"warning",
					);
					return;
				}

				sendUserMessage(pi, ctx, previewPrompt(state));
				return;
			}

			if (subcommand === "steps") {
				setState(ctx, { type: "start", mode: "steps", task });
				if (task) {
					sendUserMessage(pi, ctx, stepsPlanPrompt(task));
				} else {
					notify(ctx, "xplan steps mode enabled. Describe the task when ready.", "info");
				}
				return;
			}

			setState(ctx, { type: "start", mode: "regular", task });
			if (task) {
				sendUserMessage(pi, ctx, regularPlanPrompt(task));
			} else {
				notify(ctx, "xplan plan mode enabled. Describe the task when ready.", "info");
			}
		},
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension" || (state.active && state.phase !== "complete")) return;
		if (!isXPlanControlPromptText(event.text)) return;

		logDebug("drop_inactive_xplan_prompt", {
			streamingBehavior: event.streamingBehavior,
			state: stateForLog(state),
		});
		return { action: "handled" };
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active || state.phase === "complete") {
			approvedImplementationTurnActive = false;
			return {
				systemPrompt: event.systemPrompt + inactiveInstructions(),
			};
		}
		if (state.phase === "implementation_failed") {
			approvedImplementationTurnActive = false;
		}

		return {
			systemPrompt: event.systemPrompt + activeInstructions(state),
		};
	});

	pi.on("context", async (event) => {
		if (state.active && state.phase !== "complete") return;

		return {
			messages: event.messages
				.map((message) => sanitizeInactiveContextMessage(message))
				.filter((message): message is (typeof event.messages)[number] => message !== undefined),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const reason = exitInProgress
			? exitMutationBlockReason(event.toolName, event.input)
			: mutationBlockReason(state, event.toolName, event.input, {
					allowFailedImplementationMutations: approvedImplementationTurnActive,
				});
		if ((state.active || exitInProgress) && (reason || MUTATING_TOOLS.has(event.toolName) || event.toolName === "bash")) {
			logDebug("tool_call", {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				turnIndex: currentTurnIndex,
				isIdle: ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				signalActive: ctx.signal !== undefined,
				state: stateForLog(state),
				blocked: reason !== undefined,
				reason,
			});
		}
		if (!reason) return undefined;

		notify(ctx, reason, "warning");
		return { block: true, reason };
	});

	pi.on("turn_start", async (event, ctx) => {
		currentTurnIndex = event.turnIndex;
		if (!state.active) return;
		if (state.phase === "implementation_failed" && approvedImplementationTurnActive) {
			setState(ctx, { type: "resume_implementation" });
		}

		logDebug("turn_start", {
			turnIndex: currentTurnIndex,
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			signalActive: ctx.signal !== undefined,
			state: stateForLog(state),
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!state.active) return;

		logDebug("turn_end", {
			turnIndex: event.turnIndex,
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			signalActive: ctx.signal !== undefined,
			state: stateForLog(state),
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.active) {
			logDebug("agent_end", {
				turnIndex: currentTurnIndex,
				isIdle: ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				signalActive: ctx.signal !== undefined,
				state: stateForLog(state),
			});
		}

		if (state.active && state.phase === "implementing") {
			const failed = implementationFailed(event.messages);
			setState(ctx, { type: "finish_implementation", outcome: failed ? "failed" : "success" });
			if (failed) {
				notify(ctx, "xplan implementation step failed or was interrupted. Fix/retry with /xplan continue when ready.", "warning");
			} else {
				notify(ctx, "xplan implementation step finished. Review/stage manually. Use /xplan approve for review fixes, /xplan continue to accept and move on, or /xplan complete to finish.", "info");
			}
		}

		exitInProgress = false;
		currentTurnIndex = undefined;
	});

	pi.on("session_start", async (event, ctx) => {
		debugLoggingEnabled = pi.getFlag("xplan-debug") === true;
		const previousState = cloneState(state);
		const idle = ctx.isIdle();
		exitInProgress = false;
		const preserveImplementing = event.reason === "reload";
		const restored = restoreState(ctx, { preserveImplementing });
		state = restored.state;

		if (
			event.reason === "reload" ||
			isRelevantForLog(previousState) ||
			isRelevantForLog(restored.restored) ||
			isRelevantForLog(restored.inferred) ||
			isRelevantForLog(state)
		) {
			logDebug("session_start", {
				reason: event.reason,
				isIdle: idle,
				hasPendingMessages: ctx.hasPendingMessages(),
				signalActive: ctx.signal !== undefined,
				preserveImplementing,
				previousState: stateForLog(previousState),
				restoredState: stateForLog(restored.restored),
				inferredState: stateForLog(restored.inferred),
				normalizedState: stateForLog(state),
			});
		}

		updateStatus(ctx, state);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("xplan", undefined);
	});
}
