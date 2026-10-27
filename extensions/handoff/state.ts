export type HandoffStatus = "committed" | "cancelled" | "failed";

export interface HandoffOutcome {
	status: HandoffStatus;
	message: string;
}

export interface HandoffRequest {
	id: string;
	sessionFile: string | undefined;
	focus: string;
	invalidated: boolean;
	outcome?: HandoffOutcome;
	abort: AbortController;
}

export class HandoffState {
	private request: HandoffRequest | undefined;

	current(): HandoffRequest | undefined {
		return this.request;
	}

	begin(input: { id: string; sessionFile: string | undefined; focus: string }): HandoffRequest | undefined {
		if (this.request) return undefined;
		this.request = {
			id: input.id,
			sessionFile: input.sessionFile,
			focus: input.focus,
			invalidated: false,
			abort: new AbortController(),
		};
		return this.request;
	}

	invalidate(message: string): void {
		if (!this.request) return;
		this.request.invalidated = true;
		if (!this.request.outcome) {
			this.request.outcome = { status: "cancelled", message };
		}
		this.request.abort.abort();
	}

	record(id: string, outcome: HandoffOutcome): void {
		if (!this.request || this.request.id !== id || this.request.outcome) return;
		this.request.outcome = outcome;
	}

	clear(id: string): HandoffOutcome | undefined {
		if (!this.request || this.request.id !== id) return undefined;
		const outcome = this.request.outcome;
		this.request = undefined;
		return outcome;
	}
}

export function handoffToken(id: string): string {
	return `pi-handoff:${id}`;
}

export function isHandoffCompaction(customInstructions: string | undefined, request: HandoffRequest | undefined): boolean {
	return request !== undefined && customInstructions === handoffToken(request.id);
}
