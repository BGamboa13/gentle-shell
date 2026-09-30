import assert from "node:assert/strict";
import test from "node:test";
import { createIdleWakeSender, WAKE_RESERVATION_MS, type WakeHost } from "../lib/idle-wake.ts";

// An idle wake-up must go through prompt() so before_agent_start runs
// (issue #1528, earendil-works/pi#5581); a running host keeps the original
// sendMessage call.

type Call = [string, unknown];

function host(now: () => number = () => 0) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const calls: Call[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage: (_message: unknown, options: unknown) => { calls.push(["sendMessage", options]); },
		sendUserMessage: (content: unknown) => { calls.push(["sendUserMessage", content]); },
	} as unknown as WakeHost;
	const emit = (event: string, ctx: unknown) => { for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx); };
	return { send: createIdleWakeSender(pi, now), emit, calls };
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

test("two wakes while the first prompt is still being prepared submit one prompt", () => {
	// prompt() awaits input and before_agent_start handlers before the run is
	// active, so the host keeps reading idle; a second prompt would be rejected
	// and its settlement would clear the active-run flag under the first run.
	const h = host();
	h.emit("session_start", ctx(true));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	h.send(message, { deliverAs: "followUp", triggerTurn: true });
	assert.deepEqual(h.calls, [
		["sendMessage", { deliverAs: "nextTurn" }],
		["sendUserMessage", " "],
		["sendMessage", { deliverAs: "nextTurn" }],
	], "the second message rides the pending prompt's nextTurn queue");
});

test("the reservation ends when the woken run starts", () => {
	const h = host();
	let idle = true;
	const live = { isIdle: () => idle };
	h.emit("session_start", live);
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	idle = false;
	h.emit("agent_start", live);
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	idle = true;
	h.emit("agent_end", live);
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls, [
		["sendMessage", { deliverAs: "nextTurn" }],
		["sendUserMessage", " "],
		["sendMessage", { deliverAs: "steer", triggerTurn: true }],
		["sendMessage", { deliverAs: "nextTurn" }],
		["sendUserMessage", " "],
	]);
});

test("session replacement releases a pending reservation", () => {
	const h = host();
	h.emit("session_start", ctx(true));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	h.emit("session_start", ctx(true));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls.filter(([name]) => name === "sendUserMessage").length, 2);
});

test("a wake prompt that never starts stops blocking after WAKE_RESERVATION_MS", () => {
	// The host reports a failed extension prompt only to its error channel; the
	// queued messages stay in nextTurn and the next wake submits a new prompt.
	let clock = 0;
	const h = host(() => clock);
	h.emit("session_start", ctx(true));
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	clock = WAKE_RESERVATION_MS - 1;
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	clock = WAKE_RESERVATION_MS;
	h.send(message, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(h.calls.map(([name]) => name), ["sendMessage", "sendUserMessage", "sendMessage", "sendMessage", "sendUserMessage"]);
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
