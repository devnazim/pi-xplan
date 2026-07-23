import assert from "node:assert/strict";
import test from "node:test";
import xplanExtension from "../src/index.ts";

function createHarness() {
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const notifications = [];
	const sentUserMessages = [];
	let idle = true;

	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			notify: (message, level = "info") => notifications.push({ message, level }),
		},
		sessionManager: { getBranch: () => entries },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		signal: undefined,
		abort: () => {},
		waitForIdle: async () => {},
	};

	const pi = {
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (name, command) => commands.set(name, command),
		on: (event, handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		appendEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		sendUserMessage: (content, options) => sentUserMessages.push({ content, options }),
		sendMessage: () => {},
	};

	xplanExtension(pi);

	return {
		handlers,
		notifications,
		sentUserMessages,
		setIdle(value) {
			idle = value;
		},
		async command(args) {
			await commands.get("xplan").handler(args, ctx);
		},
		async emit(event, data = {}) {
			let result;
			for (const handler of handlers.get(event) ?? []) {
				const next = await handler({ type: event, ...data }, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
		state() {
			return entries.findLast((entry) => entry.customType === "xplan-state")?.data;
		},
	};
}

async function startLatestInjectedPrompt(harness) {
	const sentPrompt = harness.sentUserMessages.at(-1).content;
	const inputResult = await harness.emit("input", { source: "extension", text: sentPrompt });
	assert.equal(inputResult.action, "transform");
	assert.doesNotMatch(inputResult.text, /xplan-turn:/);
	await harness.emit("before_agent_start", {
		prompt: `${inputResult.text}\n\n[transformed by another extension]`,
		systemPrompt: "",
	});
}

async function startApprovedImplementation(harness) {
	await harness.command("");
	await harness.command("approve");
	assert.equal(harness.state().phase, "planning");
	assert.equal(harness.sentUserMessages.length, 1);
	await startLatestInjectedPrompt(harness);
	assert.equal(harness.state().phase, "implementing");
}

test("waits for agent_settled before completing a retried implementation", async () => {
	const harness = createHarness();
	assert.equal(harness.handlers.has("agent_settled"), true);
	await startApprovedImplementation(harness);

	harness.setIdle(false);
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error" }],
	});
	assert.equal(harness.state().phase, "implementing");
	assert.equal(
		await harness.emit("tool_call", { toolName: "edit", toolCallId: "retry-edit", input: {} }),
		undefined,
	);

	await harness.emit("turn_start", { turnIndex: 1 });
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop" }],
	});
	assert.equal(harness.state().phase, "implementing");

	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.state().phase, "awaiting_review");
	assert.match(harness.notifications.at(-1).message, /implementation step finished/);
	assert.equal(
		(await harness.emit("tool_call", { toolName: "edit", toolCallId: "review-edit", input: {} })).block,
		true,
	);
});

test("keeps mutations locked when an approval prompt fails before agent start", async () => {
	const harness = createHarness();
	await harness.command("");
	await harness.command("approve");
	const inputResult = await harness.emit("input", {
		source: "extension",
		text: harness.sentUserMessages[0].content,
	});

	assert.equal(inputResult.action, "transform");
	assert.equal(harness.state().phase, "planning");
	assert.equal(
		(await harness.emit("tool_call", { toolName: "edit", toolCallId: "preflight-edit", input: {} })).block,
		true,
	);

	await harness.emit("input", { source: "interactive", text: "ordinary follow-up" });
	await harness.emit("before_agent_start", { prompt: "ordinary follow-up", systemPrompt: "" });
	assert.equal(harness.state().phase, "planning");
	await harness.emit("before_agent_start", { prompt: inputResult.text, systemPrompt: "" });
	assert.equal(harness.state().phase, "planning");
});

test("fails closed when reload loses the outcome before settlement", async () => {
	const harness = createHarness();
	await startApprovedImplementation(harness);

	harness.setIdle(false);
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop" }],
	});
	await harness.emit("session_start", { reason: "reload" });
	assert.equal(harness.state().phase, "implementing");

	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.state().phase, "implementation_failed");
	assert.equal(
		(await harness.emit("tool_call", { toolName: "edit", toolCallId: "post-reload-edit", input: {} })).block,
		true,
	);
});

test("marks an implementation failed only after the run fully settles", async () => {
	const harness = createHarness();
	await startApprovedImplementation(harness);

	harness.setIdle(false);
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	assert.equal(harness.state().phase, "implementing");

	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.state().phase, "implementation_failed");
	assert.match(harness.notifications.at(-1).message, /failed or was interrupted/);
	assert.equal(
		(await harness.emit("tool_call", { toolName: "write", toolCallId: "failed-write", input: {} })).block,
		true,
	);

	await harness.command("continue");
	assert.equal(harness.state().phase, "implementation_failed");
	await startLatestInjectedPrompt(harness);
	assert.equal(harness.state().phase, "implementing");
});
