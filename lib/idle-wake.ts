// Idle wake-up that keeps the harness (issue #1528).
//
// Pi starts an idle `pi.sendMessage(..., { triggerTurn: true })` turn through
// `_runAgentPrompt` directly, without `before_agent_start` (earendil-works/pi#5581,
// still open). Everything an extension adds to the system prompt in
// `before_agent_start` — the whole Gentle harness — is missing on that turn:
// claude-bridge refuses to run it (prompt-capture miss), and other providers
// silently run a turn without the harness.
//
// When the host is idle, the message is queued with `deliverAs: "nextTurn"` and
// the turn is started through `pi.sendUserMessage(" ")`, i.e. the normal
// `prompt()` path: `before_agent_start` runs and the queued message is injected
// alongside that prompt. When the host is running, the original
// `sendMessage(message, options)` is kept unchanged.
//
// Idleness is read from the host (`ctx.isIdle()`, the same run flag
// `sendCustomMessage` routes by). Counting `agent_start`/`agent_end` does not
// work: the host emits that pair once per inner `prompt()`/`continue()` call and
// chains several of them in one run, so a counter reads 0 in the gap before the
// next `continue()` — exactly where completions are flushed on `agent_end`.
// Taking the idle path there queues the message as `nextTurn` while
// `sendUserMessage(" ")` throws "Agent is already processing", stranding the
// message until the next user prompt.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export type WakeOptions = { deliverAs: "steer" | "followUp"; triggerTurn: true };
export type WakeHost = Pick<ExtensionAPI, "on" | "sendMessage" | "sendUserMessage">;

export function createIdleWakeSender(pi: WakeHost): (message: WakeMessage, options: WakeOptions) => void {
	let latest: Pick<ExtensionContext, "isIdle"> | undefined;
	const track = (_event: unknown, ctx: ExtensionContext) => { latest = ctx; };
	pi.on("session_start", track);
	pi.on("agent_start", track);
	pi.on("turn_end", track);
	pi.on("agent_end", track);

	// A missing or stale ctx (after session replacement or reload) is not proof of
	// idleness: fall back to the host's own delivery path, never to "nextTurn",
	// which could strand the message.
	const hostIdle = (): boolean => {
		try { return latest?.isIdle() === true; } catch { return false; }
	};

	return (message, options) => {
		if (hostIdle()) {
			pi.sendMessage(message, { deliverAs: "nextTurn" });
			pi.sendUserMessage(" ");
			return;
		}
		pi.sendMessage(message, options);
	};
}
