import { classifyGeneration, type GenerationResult } from "./prompt.ts";
import { type HandoffRequest, type HandoffState, isHandoffCompaction } from "./state.ts";

export interface HandoffCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	usage?: unknown;
}

export type BeforeCompactDecision = { cancel: true } | { compaction: HandoffCompactionResult } | undefined;

export interface PreparedHandoffContext {
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary?: string;
	conversationText: string;
	readFiles: string[];
	modifiedFiles: string[];
}

export async function resolveHandoffCompaction(input: {
	state: HandoffState;
	customInstructions: string | undefined;
	sessionFile: string | undefined;
	signal: AbortSignal;
	prepared: PreparedHandoffContext;
	generate: (request: HandoffRequest, signal: AbortSignal) => Promise<GenerationResult & { usage?: unknown }>;
}): Promise<BeforeCompactDecision> {
	const request = input.state.current();
	if (!isHandoffCompaction(input.customInstructions, request) || !request) {
		return undefined;
	}

	if (input.signal.aborted || request.abort.signal.aborted || request.invalidated) {
		input.state.record(request.id, { status: "cancelled", message: request.outcome?.message ?? "Handoff cancelled." });
		return { cancel: true };
	}

	if (input.sessionFile !== request.sessionFile) {
		input.state.record(request.id, {
			status: "cancelled",
			message: "Handoff cancelled because the session changed.",
		});
		return { cancel: true };
	}

	const signal = linkSignals([input.signal, request.abort.signal]);
	let generated: GenerationResult & { usage?: unknown };
	try {
		generated = await input.generate(request, signal);
	} catch (error) {
		if (signal.aborted || isAbortError(error)) {
			input.state.record(request.id, { status: "cancelled", message: request.outcome?.message ?? "Handoff cancelled." });
			return { cancel: true };
		}
		const message = error instanceof Error ? error.message : String(error);
		input.state.record(request.id, { status: "failed", message: `Handoff failed: ${message}` });
		return { cancel: true };
	}

	if (input.sessionFile !== request.sessionFile || request.invalidated || signal.aborted) {
		const sessionChanged = input.sessionFile !== request.sessionFile || request.invalidated;
		input.state.record(request.id, {
			status: "cancelled",
			message:
				request.outcome?.message ??
				(sessionChanged ? "Handoff cancelled because the session changed." : "Handoff cancelled."),
		});
		return { cancel: true };
	}

	const classified = classifyGeneration(generated);
	if (!classified.ok) {
		input.state.record(request.id, { status: classified.status, message: classified.message });
		return { cancel: true };
	}

	input.state.record(request.id, {
		status: "committed",
		message: "Handoff committed. This session continues with that summary as its compaction context.",
	});
	return {
		compaction: {
			summary: classified.markdown,
			firstKeptEntryId: input.prepared.firstKeptEntryId,
			tokensBefore: input.prepared.tokensBefore,
			usage: generated.usage,
		},
	};
}

function linkSignals(signals: AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
