import assert from "node:assert/strict";
import test from "node:test";
import { createIdleWakeSender, type WakeHost } from "../lib/idle-wake.ts";

// An idle wake-up must go through prompt() so before_agent_start runs
// (issue #1528, earendil-works/pi#5581); a running host keeps the original
// sendMessage call.

type Call = [string, unknown];

function host() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const calls: Call[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage: (_message: unknown, options: unknown) => { calls.push(["sendMessage", options]); },
		sendUserMessage: (content: unknown) => { calls.push(["sendUserMessage", content]); },
	} as unknown as WakeHost;
	const emit = (event: string, ctx: unknown) => { for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx); };
	return { send: createIdleWakeSender(pi), emit, calls };
}

const ctx = (idle: boolean) => ({ isIdle: () => idle });
const message = { customType: "gentle-agents.result", content: "done", display: true };

test("an idle host is woken through prompt() so before_agent_start runs", () => {
	const h = host();
	h.emit("session_start", ctx(true));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls, [["sendMessage", { deliverAs: "nextTurn" }], ["sendUserMessage", " "]]);
});

test("a running host keeps the original steer/followUp delivery", () => {
	const h = host();
	h.emit("session_start", ctx(false));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	h.send(message, { deliverAs: "followUp", triggerTurn: true });
	assert.deepEqual(h.calls, [["sendMessage", { deliverAs: "steer", triggerTurn: true }], ["sendMessage", { deliverAs: "followUp", triggerTurn: true }]]);
});

test("a run that is still active after an inner agent_end is not treated as idle", () => {
	// The host emits agent_start/agent_end per inner prompt()/continue(); a
	// counter would read 0 here and strand the message as nextTurn.
	const h = host();
	const running = ctx(false);
	h.emit("session_start", running);
	h.emit("agent_start", running);
	h.emit("turn_end", running);
	h.emit("agent_end", running);
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls, [["sendMessage", { deliverAs: "steer", triggerTurn: true }]]);
});

test("idleness is read live, not frozen at the last event", () => {
	const h = host();
	let idle = false;
	h.emit("agent_end", { isIdle: () => idle });
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	idle = true;
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls, [
		["sendMessage", { deliverAs: "steer", triggerTurn: true }],
		["sendMessage", { deliverAs: "nextTurn" }],
		["sendUserMessage", " "],
	]);
});

test("a missing or stale ctx falls back to the host path, never to nextTurn", () => {
	const noCtx = host();
	noCtx.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(noCtx.calls, [["sendMessage", { deliverAs: "steer", triggerTurn: true }]]);

	const stale = host();
	stale.emit("session_start", { isIdle: () => { throw new Error("This extension ctx is stale after session replacement or reload."); } });
	stale.send(message, { deliverAs: "followUp", triggerTurn: true });
	assert.deepEqual(stale.calls, [["sendMessage", { deliverAs: "followUp", triggerTurn: true }]]);
});
