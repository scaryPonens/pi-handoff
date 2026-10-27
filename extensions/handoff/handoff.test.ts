import assert from "node:assert/strict";
import test from "node:test";
import { resolveHandoffCompaction } from "./compact.ts";
import { buildHandoffUserContent, classifyGeneration, HANDOFF_SYSTEM_PROMPT, validateHandoff } from "./prompt.ts";
import { handoffToken, HandoffState, isHandoffCompaction } from "./state.ts";

const VALID = `## Goal
Ship the handoff command.

## Constraints & Preferences
- Do not invent missing facts.

## Progress
### Done
- Registered the command.

### In Progress
- Compaction hook.

### Pending
- Smoke test.

## Key Decisions
- Commit the summary in place.

## Critical Context
- extensions/handoff/index.ts

## Next Steps
- Run /handoff on a compactable session.
`;

test("accepts a complete handoff and strips a wrapping fence", () => {
	const validated = validateHandoff(`\`\`\`markdown\n${VALID}\`\`\``);
	assert.equal(validated.ok, true);
	if (validated.ok) assert.equal(validated.markdown.startsWith("## Goal"), true);
});

test("rejects an empty, truncated, or mistitled handoff", () => {
	assert.equal(validateHandoff("").ok, false);
	assert.equal(validateHandoff("Here is the handoff:\n\n" + VALID).ok, false);
	assert.equal(validateHandoff(VALID.replace("## Key Decisions", "## Decisions")).ok, false);
	assert.equal(validateHandoff(VALID.replace("### Pending", "### Later")).ok, false);
});

test("classifies aborted and incomplete generations as non-committable", () => {
	assert.equal(classifyGeneration({ text: VALID, stopReason: "aborted" }).ok, false);
	assert.equal(classifyGeneration({ text: VALID, stopReason: "length" }).ok, false);
	assert.equal(classifyGeneration({ text: "", stopReason: "stop" }).ok, false);
	const ok = classifyGeneration({ text: VALID, stopReason: "stop" });
	assert.equal(ok.ok, true);
});

test("prompt keeps the operator focus without replacing the transcript", () => {
	const content = buildHandoffUserContent({
		focus: "Focus on solver tests",
		previousSummary: "Earlier: parser landed.",
		conversationText: "user: fix solver",
		readFiles: ["solver.ts"],
		modifiedFiles: ["solver.test.ts"],
	});
	assert.match(content, /Focus on solver tests/);
	assert.match(content, /Earlier: parser landed\./);
	assert.match(content, /user: fix solver/);
	assert.match(content, /solver\.test\.ts/);
	assert.match(HANDOFF_SYSTEM_PROMPT, /Still retain every other fact required to continue safely/);
	assert.match(HANDOFF_SYSTEM_PROMPT, /Do not invent/);
});

import { assessHistory } from "./history.ts";

test("short and already compacted sessions are refused before compaction", () => {
	assert.match(assessHistory([], 20_000, () => 1).message ?? "", /no conversation/);
	assert.match(
		assessHistory([{ type: "message", message: {} }], 20_000, () => 10).message ?? "",
		/retention window/,
	);
	assert.match(
		assessHistory([{ type: "compaction", summary: "done" }], 20_000, () => 1).message ?? "",
		/already compacted/,
	);
	assert.equal(
		assessHistory([{ type: "message", message: {} }, { type: "message", message: {} }], 10, () => 8).ok,
		true,
	);
	assert.match(
		assessHistory(
			[
				{ type: "compaction", summary: "x".repeat(40) },
				{ type: "message", message: {} },
			],
			20,
			() => 1,
		).message ?? "",
		/retention window/,
	);
});

test("state rejects a second handoff and clears focus after the first settles", () => {
	const state = new HandoffState();
	const first = state.begin({ id: "1", sessionFile: "/tmp/a.jsonl", focus: "solver tests" });
	assert.ok(first);
	assert.equal(state.begin({ id: "2", sessionFile: "/tmp/a.jsonl", focus: "other" }), undefined);
	state.record("1", { status: "committed", message: "done" });
	assert.deepEqual(state.clear("1"), { status: "committed", message: "done" });
	assert.equal(state.current(), undefined);
	const second = state.begin({ id: "2", sessionFile: "/tmp/a.jsonl", focus: "" });
	assert.equal(second?.focus, "");
});

test("session invalidation cancels the pending request without dropping it before the hook", () => {
	const state = new HandoffState();
	const request = state.begin({ id: "1", sessionFile: "/tmp/a.jsonl", focus: "" });
	assert.ok(request);
	state.invalidate("Handoff cancelled because the session changed.");
	assert.equal(state.current()?.invalidated, true);
	assert.equal(request.abort.signal.aborted, true);
	assert.equal(isHandoffCompaction(handoffToken("1"), state.current()), true);
});

test("ordinary compaction is left alone", async () => {
	const state = new HandoffState();
	const decision = await resolveHandoffCompaction({
		state,
		customInstructions: "focus on tests",
		sessionFile: "/tmp/a.jsonl",
		signal: new AbortController().signal,
		prepared: prepared(),
		generate: async () => {
			throw new Error("should not generate");
		},
	});
	assert.equal(decision, undefined);
});

test("a matching handoff commits Pi's retention boundary and records focus", async () => {
	const state = new HandoffState();
	state.begin({ id: "req", sessionFile: "/tmp/a.jsonl", focus: "Focus on solver tests" });
	let seenFocus = "";
	const decision = await resolveHandoffCompaction({
		state,
		customInstructions: handoffToken("req"),
		sessionFile: "/tmp/a.jsonl",
		signal: new AbortController().signal,
		prepared: prepared(),
		generate: async (request) => {
			seenFocus = request.focus;
			return { text: VALID, stopReason: "stop", usage: { input: 3, output: 4 } };
		},
	});
	assert.equal(seenFocus, "Focus on solver tests");
	assert.ok(decision && "compaction" in decision);
	if (decision && "compaction" in decision) {
		assert.equal(decision.compaction.firstKeptEntryId, "keep-me");
		assert.equal(decision.compaction.tokensBefore, 42);
		assert.match(decision.compaction.summary, /## Goal/);
	}
	assert.equal(state.current()?.outcome?.status, "committed");
});

test("failed, empty, and aborted generation cancel instead of falling back", async () => {
	for (const generated of [
		{ text: "", stopReason: "stop" },
		{ text: VALID, stopReason: "length" },
		{ text: VALID, stopReason: "aborted" },
	]) {
		const state = new HandoffState();
		state.begin({ id: "req", sessionFile: "/tmp/a.jsonl", focus: "" });
		const decision = await resolveHandoffCompaction({
			state,
			customInstructions: handoffToken("req"),
			sessionFile: "/tmp/a.jsonl",
			signal: new AbortController().signal,
			prepared: prepared(),
			generate: async () => generated,
		});
		assert.deepEqual(decision, { cancel: true });
		assert.notEqual(state.current()?.outcome?.status, "committed");
	}
});

test("a session change does not apply the handoff", async () => {
	const state = new HandoffState();
	state.begin({ id: "req", sessionFile: "/tmp/old.jsonl", focus: "solver" });
	let generated = false;
	const decision = await resolveHandoffCompaction({
		state,
		customInstructions: handoffToken("req"),
		sessionFile: "/tmp/new.jsonl",
		signal: new AbortController().signal,
		prepared: prepared(),
		generate: async () => {
			generated = true;
			return { text: VALID, stopReason: "stop" };
		},
	});
	assert.equal(generated, false);
	assert.deepEqual(decision, { cancel: true });
	assert.equal(state.current()?.outcome?.status, "cancelled");
});

test("an API failure cancels and leaves the request clearable", async () => {
	const state = new HandoffState();
	state.begin({ id: "req", sessionFile: undefined, focus: "" });
	const decision = await resolveHandoffCompaction({
		state,
		customInstructions: handoffToken("req"),
		sessionFile: undefined,
		signal: new AbortController().signal,
		prepared: prepared(),
		generate: async () => {
			throw new Error("connection reset");
		},
	});
	assert.deepEqual(decision, { cancel: true });
	assert.match(state.clear("req")?.message ?? "", /connection reset/);
	assert.equal(state.current(), undefined);
});

function prepared() {
	return {
		firstKeptEntryId: "keep-me",
		tokensBefore: 42,
		conversationText: "user: continue",
		readFiles: [],
		modifiedFiles: [],
	};
}
