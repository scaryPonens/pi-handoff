import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { resolveHandoffCompaction } from "./compact.ts";
import { assessHistory, fileLists } from "./history.ts";
import { buildHandoffUserContent, HANDOFF_SYSTEM_PROMPT } from "./prompt.ts";
import { handoffToken, HandoffState } from "./state.ts";

const SESSION_CHANGED = "Handoff cancelled because the session changed.";

export default function (pi: ExtensionAPI) {
	const state = new HandoffState();

	const cancelForSessionChange = () => {
		state.invalidate(SESSION_CHANGED);
	};

	pi.on("session_before_switch", cancelForSessionChange);
	pi.on("session_before_fork", cancelForSessionChange);
	pi.on("session_shutdown", cancelForSessionChange);

	pi.on("session_before_compact", async (event, ctx) => {
		const request = state.current();
		const ours = request !== undefined && event.customInstructions === handoffToken(request.id);
		if (!ours) return;

		try {
			const files = fileLists(event.preparation.fileOps);
			const conversationText = serializeConversation(
				convertToLlm([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]),
			);
			return await resolveHandoffCompaction({
				state,
				customInstructions: event.customInstructions,
				sessionFile: ctx.sessionManager.getSessionFile(),
				signal: event.signal,
				prepared: {
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					previousSummary: event.preparation.previousSummary,
					conversationText,
					readFiles: files.readFiles,
					modifiedFiles: files.modifiedFiles,
				},
				generate: async (pending, signal) => {
					const model = ctx.model;
					if (!model) {
						throw new Error("No model selected.");
					}
					const response = await ctx.modelRegistry.complete(
						model,
						{
							systemPrompt: HANDOFF_SYSTEM_PROMPT,
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: buildHandoffUserContent({
												previousSummary: event.preparation.previousSummary,
												conversationText,
												focus: pending.focus,
												readFiles: files.readFiles,
												modifiedFiles: files.modifiedFiles,
											}),
										},
									],
									timestamp: Date.now(),
								},
							],
						},
						{
							maxTokens: 8192,
							signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					);
					const text = response.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return {
						text,
						stopReason: response.stopReason,
						errorMessage: response.errorMessage,
						usage: response.usage,
					};
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.record(request.id, { status: "failed", message: `Handoff failed: ${message}` });
			return { cancel: true };
		}
	});

	pi.registerCommand("handoff", {
		description: "Replace older context in this session with a structured handoff summary",
		handler: async (args, ctx) => {
			const focus = args.trim();
			if (state.current()) {
				notify(ctx, "A handoff is already running.", "warning");
				return;
			}
			if (!ctx.model) {
				notify(ctx, "No model selected. Choose a model, then run /handoff again.", "error");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				notify(ctx, "The agent is busy. Wait until it is idle, then run /handoff again.", "warning");
				return;
			}

			const assessment = assessHistory(
				ctx.sessionManager.getBranch(),
				keepRecentTokens(pi, ctx.model),
				estimateTokens,
			);
			if (!assessment.ok) {
				notify(ctx, assessment.message, "warning");
				return;
			}

			const id = uuidv7();
			const request = state.begin({
				id,
				sessionFile: ctx.sessionManager.getSessionFile(),
				focus,
			});
			if (!request) {
				notify(ctx, "A handoff is already running.", "warning");
				return;
			}

			ctx.compact({
				customInstructions: handoffToken(id),
				onComplete: () => {
					const outcome = state.clear(id);
					notify(
						ctx,
						outcome?.message ??
							"Handoff committed. This session continues with that summary as its compaction context.",
						"info",
					);
				},
				onError: (error) => {
					const outcome = state.clear(id);
					const message = outcome?.message ?? compactErrorMessage(error);
					const warning = outcome?.status !== "failed" && !message.startsWith("Handoff failed:");
					notify(ctx, message, warning ? "warning" : "error");
				},
			});
		},
	});
}

function keepRecentTokens(pi: ExtensionAPI, model: { provider: string; id: string }): number {
	const compaction = pi.getSettings().compaction;
	const override = compaction?.modelOverrides?.[`${model.provider}/${model.id}`];
	return override?.keepRecentTokens ?? compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
}

function compactErrorMessage(error: Error): string {
	if (/Nothing to compact/i.test(error.message)) {
		return "Nothing to hand off. Pi only compacts once older history exceeds the recent-token retention window.";
	}
	if (/Already compacted/i.test(error.message)) {
		return "Nothing new to hand off. This session is already compacted.";
	}
	if (/cancelled/i.test(error.message)) return "Handoff cancelled.";
	return `Handoff failed: ${error.message}`;
}


function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Print mode has no notification UI.
	}
}
