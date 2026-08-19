import { z } from 'zod';

/** Values produced by the browser's JSON parser. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | JsonRecord;
export type JsonRecord = { [key: string]: JsonValue | undefined };

/** Concrete JSON value contract used by browser transport boundaries. */
export const jsonValueSchema = z.json();

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

const toolQuestionSchema = z.object({
	header: z.string().optional(),
	question: z.string().optional()
});

const toolQuestionOptionSchema = z.object({
	label: z.string().min(1),
	description: z.string().optional(),
	preview: z.string().optional()
});

const toolInputValuesSchema = z.record(z.string(), jsonValueSchema);

function normalizeQuestionOption(value: JsonValue): ToolQuestionOption | null {
	const label = z.string().safeParse(value);
	if (label.success) {
		const trimmed = label.data.trim();
		return trimmed ? { label: trimmed } : null;
	}

	const option = toolQuestionOptionSchema.safeParse(value);
	return option.success ? option.data : null;
}

function normalizeQuestions(value: JsonValue): ToolQuestion[] | undefined {
	const values = z.array(jsonValueSchema).safeParse(value);
	if (!values.success) return undefined;

	const questions = values.data.flatMap((item) => {
		const question = toolQuestionSchema.safeParse(item);
		return question.success ? [question.data] : [];
	});
	return questions.length > 0 ? questions : undefined;
}

/**
 * Validate and normalize a tool input at the protocol boundary.
 *
 * The backend's ask_user_question tool historically emits option labels as
 * strings while the browser card consumes `{ label }` records. Normalize both
 * forms here and drop malformed entries so a bad tool payload cannot crash the
 * transcript or produce unusable buttons.
 */
export function decodeToolInput(value: JsonValue | undefined): ToolInputRecord {
	const parsed = toolInputValuesSchema.safeParse(value ?? {});
	if (!parsed.success) return {};

	const normalized: ToolInputRecord = {};
	for (const [key, item] of Object.entries(parsed.data)) {
		if (key === 'options') {
			const values = z.array(jsonValueSchema).safeParse(item);
			if (values.success) {
				const options = values.data.flatMap((option) => {
					const normalizedOption = normalizeQuestionOption(option);
					return normalizedOption ? [normalizedOption] : [];
				});
				if (options.length > 0) normalized.options = options;
			}
			continue;
		}
		if (key === 'questions') {
			const questions = normalizeQuestions(item);
			if (questions) normalized.questions = questions;
			continue;
		}
		normalized[key] = item;
	}

	return normalized;
}

declare global {
	interface Window {
		showTutorial?: () => void;
		showEditorTutorial?: () => Promise<void>;
	}
}

/** Read a browser global without a `typeof` representation check. */
export function browserWindow(): Window | null {
	return globalThis.window ?? null;
}

/** Read browser storage only when the host provides it (SSR has no storage). */
export function browserStorage(): Storage | null {
	return globalThis.localStorage ?? null;
}
