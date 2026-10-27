export interface HistoryEntry {
	type: string;
	summary?: string;
	message?: unknown;
}

export type HistoryAssessment =
	| { ok: true }
	| { ok: false; message: string };

const TOO_SMALL =
	"Nothing to hand off. Pi only compacts once older history exceeds the recent-token retention window.";
const ALREADY_COMPACTED = "Nothing new to hand off. This session is already compacted.";
const EMPTY = "Nothing to hand off. This session has no conversation yet.";

export function assessHistory(
	branch: readonly HistoryEntry[],
	keepRecentTokens: number,
	estimateMessage: (message: unknown) => number,
): HistoryAssessment {
	const latestCompaction = findLastIndex(branch, (entry) => entry.type === "compaction");
	if (branch.length === 0 || (latestCompaction < 0 && !branch.some((entry) => entry.type === "message"))) {
		return { ok: false, message: EMPTY };
	}
	if (latestCompaction === branch.length - 1) {
		return { ok: false, message: ALREADY_COMPACTED };
	}

	const summary = latestCompaction >= 0 ? branch[latestCompaction]?.summary ?? "" : "";
	const tail = branch.slice(latestCompaction + 1);
	const tokens =
		Math.ceil(summary.length / 4) +
		tail.reduce((sum, entry) => sum + (entry.type === "message" ? estimateMessage(entry.message) : 0), 0);
	if (tokens < keepRecentTokens) {
		return { ok: false, message: TOO_SMALL };
	}
	return { ok: true };
}

export function fileLists(fileOps: {
	read?: Iterable<string>;
	written?: Iterable<string>;
	edited?: Iterable<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
	const modifiedFiles = unique([...(fileOps.written ?? []), ...(fileOps.edited ?? [])]);
	const modified = new Set(modifiedFiles);
	const readFiles = unique([...(fileOps.read ?? [])].filter((file) => !modified.has(file)));
	return { readFiles, modifiedFiles };
}

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
	for (let index = values.length - 1; index >= 0; index--) {
		if (predicate(values[index])) return index;
	}
	return -1;
}
