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
//
// One wake at a time. `prompt()` awaits input handlers, auth, compaction and
// `before_agent_start` before it marks the run active, so the host still reads
// idle while a wake prompt is being prepared. A second `sendUserMessage(" ")` in
// that window would reach `Agent.prompt()` while the first runs and be rejected,
// and its settlement would clear the active-run flag under the first run. The
// first wake therefore reserves the turn synchronously; later idle messages are
// only queued as `nextTurn`. They are carried by the pending prompt: the host
// takes the `nextTurn` queue and marks the run active in one synchronous step,
// so while the host still reads idle, the pending prompt has not taken it yet.
// The reservation ends when the run starts or the session is replaced. The host
// reports a failed extension prompt only to its error channel, so a reservation
// also expires after WAKE_RESERVATION_MS; the queued messages stay in `nextTurn`
// and the next wake (or user prompt) carries them.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export type WakeOptions = { deliverAs: "steer" | "followUp"; triggerTurn: true };
export type WakeHost = Pick<ExtensionAPI, "on" | "sendMessage" | "sendUserMessage">;

/** How long a submitted wake prompt may stay unstarted before another wake may submit a new one. */
export const WAKE_RESERVATION_MS = 60_000;

export function createIdleWakeSender(pi: WakeHost, now: () => number = Date.now): (message: WakeMessage, options: WakeOptions) => void {
	let latest: Pick<ExtensionContext, "isIdle"> | undefined;
	let wakeReservedAt: number | undefined;
	const track = (_event: unknown, ctx: ExtensionContext) => { latest = ctx; };
	const trackAndRelease = (_event: unknown, ctx: ExtensionContext) => { latest = ctx; wakeReservedAt = undefined; };
	pi.on("session_start", trackAndRelease);
	pi.on("agent_start", trackAndRelease);
	pi.on("turn_end", track);
	pi.on("agent_end", track);

	// A missing or stale ctx (after session replacement or reload) is not proof of
	// idleness: fall back to the host's own delivery path, never to "nextTurn",
	// which could strand the message.
	const hostIdle = (): boolean => {
		try { return latest?.isIdle() === true; } catch { return false; }
	};

	return (message, options) => {
		if (!hostIdle()) {
			pi.sendMessage(message, options);
			return;
		}
		pi.sendMessage(message, { deliverAs: "nextTurn" });
		if (wakeReservedAt !== undefined && now() - wakeReservedAt < WAKE_RESERVATION_MS) return;
		wakeReservedAt = now();
		pi.sendUserMessage(" ");
	};
}
