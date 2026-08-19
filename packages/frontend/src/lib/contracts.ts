/** Values produced by the browser's JSON parser. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | JsonRecord;
export type JsonRecord = { [key: string]: JsonValue | undefined };

export interface ToolQuestion extends JsonRecord {
	header?: string;
	question?: string;
}

export interface ToolQuestionOption extends JsonRecord {
	label: string;
	description?: string;
	preview?: string;
}

export interface ToolInputRecord {
	[key: string]: JsonValue | ToolQuestion[] | undefined;
	file_path?: string;
	path?: string;
	directory_path?: string;
	template?: string;
	templateId?: string;
	page_name?: string;
	oldPath?: string;
	questions?: ToolQuestion[];
	options?: ToolQuestionOption[];
	question?: string;
	context?: string;
}

declare global {
	interface Window {
		showTutorial?: () => void;
		showEditorTutorial?: () => Promise<void>;
	}
}

/**
 * Decode a JSON payload once at the transport boundary and give callers the
 * domain contract they requested. JSON.parse already rejects non-JSON input;
 * callers still validate the fields they consume before using them.
 */
export function decodeJson<T>(payload: string): T {
	return JSON.parse(payload);
}

/** Decode a protocol tool input into its named field contract. */
export function decodeToolInput(value: JsonValue | undefined): ToolInputRecord {
	return decodeJson<ToolInputRecord>(JSON.stringify(value ?? {}));
}

/** Read a browser global without a `typeof` representation check. */
export function browserWindow(): Window | null {
	return globalThis.window ?? null;
}

/** Read browser storage only when the host provides it (SSR has no storage). */
export function browserStorage(): Storage | null {
	return globalThis.localStorage ?? null;
}
