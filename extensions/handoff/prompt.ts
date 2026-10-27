export const HANDOFF_SECTIONS = [
	"Goal",
	"Constraints & Preferences",
	"Progress",
	"Key Decisions",
	"Critical Context",
	"Next Steps",
] as const;

export const PROGRESS_SUBSECTIONS = ["Done", "In Progress", "Pending"] as const;

export const HANDOFF_SYSTEM_PROMPT = `You write a handoff that lets another engineer continue the work without the prior transcript.

Rules:
- Output Markdown only. No preamble, no closing note, and no code fence around the document.
- Use these headings, in this order, with this exact text:
  ## Goal
  ## Constraints & Preferences
  ## Progress
  ## Key Decisions
  ## Critical Context
  ## Next Steps
- Under ## Progress, use exactly these subsections, in this order:
  ### Done
  ### In Progress
  ### Pending
- Include only facts present in the conversation, the previous summary, or the file list. If a section has nothing to report, write "None recorded." Do not invent paths, commands, symbols, errors, tests, decisions, or status.
- Keep exact file paths, commands, symbols, error text, and test names when they appear.
- Distinguish completed work from unverified assumptions. Do not mark work done unless the transcript shows it finished.
- Prefer a concise transfer document over a chronological recap.
- An optional operator focus, when provided, decides what to emphasize. Still retain every other fact required to continue safely.
- The document replaces the summarized history as the active compaction context. It must stand on its own.`;

export interface HandoffPromptInput {
	previousSummary?: string;
	conversationText: string;
	focus?: string;
	readFiles?: readonly string[];
	modifiedFiles?: readonly string[];
}

export function buildHandoffUserContent(input: HandoffPromptInput): string {
	const focus = input.focus?.trim();
	const sections = [
		focus
			? `## Operator focus\n\nPrioritize this, without dropping other essential context:\n\n${focus}`
			: "## Operator focus\n\nNone. Cover the whole transferable context.",
		input.previousSummary?.trim()
			? `## Previous compaction summary\n\n${input.previousSummary.trim()}`
			: "## Previous compaction summary\n\nNone.",
		`## Files touched in the summarized history\n\nRead:\n${formatList(input.readFiles)}\n\nModified:\n${formatList(input.modifiedFiles)}`,
		`## Conversation to summarize\n\n${input.conversationText.trim() || "(empty)"}`,
	];
	return sections.join("\n\n");
}

export type HandoffValidation =
	| { ok: true; markdown: string }
	| { ok: false; reason: string };

export function validateHandoff(raw: string): HandoffValidation {
	const markdown = stripWrappingFence(raw).trim();
	if (!markdown) {
		return { ok: false, reason: "Handoff generation returned an empty summary." };
	}

	const lines = markdown.split(/\r?\n/);
	const firstContent = lines.find((line) => line.trim().length > 0);
	if (firstContent?.trim() !== "## Goal") {
		return { ok: false, reason: "Handoff did not start with ## Goal." };
	}

	for (const section of HANDOFF_SECTIONS) {
		if (!lines.some((line) => line.trim() === `## ${section}`)) {
			return { ok: false, reason: `Handoff is missing ## ${section}.` };
		}
	}

	const progressAt = lines.findIndex((line) => line.trim() === "## Progress");
	const afterProgress = lines.findIndex((line, index) => index > progressAt && line.trim().startsWith("## "));
	const progressEnd = afterProgress === -1 ? lines.length : afterProgress;
	const progressBody = lines.slice(progressAt + 1, progressEnd);
	for (const subsection of PROGRESS_SUBSECTIONS) {
		if (!progressBody.some((line) => line.trim() === `### ${subsection}`)) {
			return { ok: false, reason: `Handoff Progress is missing ### ${subsection}.` };
		}
	}

	return { ok: true, markdown };
}

export interface GenerationResult {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

export type ClassifiedGeneration =
	| { ok: true; markdown: string }
	| { ok: false; status: "cancelled" | "failed"; message: string };

export function classifyGeneration(result: GenerationResult): ClassifiedGeneration {
	if (result.stopReason === "aborted") {
		return { ok: false, status: "cancelled", message: "Handoff cancelled." };
	}
	if (result.stopReason === "error") {
		return {
			ok: false,
			status: "failed",
			message: `Handoff failed: ${result.errorMessage || "the model returned an error."}`,
		};
	}
	if (result.stopReason === "length") {
		return {
			ok: false,
			status: "failed",
			message: "Handoff failed: generation hit the token cap and the summary is incomplete.",
		};
	}
	if (result.stopReason && result.stopReason !== "stop") {
		return {
			ok: false,
			status: "failed",
			message: `Handoff failed: unexpected stop reason "${result.stopReason}".`,
		};
	}
	const validated = validateHandoff(result.text);
	if (!validated.ok) {
		return { ok: false, status: "failed", message: validated.reason };
	}
	return { ok: true, markdown: validated.markdown };
}

function formatList(values: readonly string[] | undefined): string {
	if (!values || values.length === 0) return "- None recorded.";
	return values.map((value) => `- ${value}`).join("\n");
}

function stripWrappingFence(raw: string): string {
	const trimmed = raw.trim();
	const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
	return match ? match[1] : raw;
}
