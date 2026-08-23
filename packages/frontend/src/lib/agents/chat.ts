import { jsonValueSchema, type JsonValue } from '$lib/contracts';
import { SITE_STUDIO_CHAT_STREAM_STALL_TIMEOUT_MS } from '../../../../observability-core/src/chat-liveness';
import { z } from 'zod';

export { SITE_STUDIO_CHAT_STREAM_STALL_TIMEOUT_MS } from '../../../../observability-core/src/chat-liveness';

export const AgentMessageType = {
	CF_AGENT_CHAT_MESSAGES: 'cf_agent_chat_messages',
	CF_AGENT_USE_CHAT_REQUEST: 'cf_agent_use_chat_request',
	CF_AGENT_USE_CHAT_RESPONSE: 'cf_agent_use_chat_response',
	CF_AGENT_CHAT_CLEAR: 'cf_agent_chat_clear',
	CF_AGENT_CHAT_REQUEST_CANCEL: 'cf_agent_chat_request_cancel',
	CF_AGENT_STREAM_RESUME_REQUEST: 'cf_agent_stream_resume_request',
	CF_AGENT_STREAM_RESUMING: 'cf_agent_stream_resuming',
	CF_AGENT_STREAM_RESUME_ACK: 'cf_agent_stream_resume_ack',
	CF_AGENT_STREAM_RESUME_NONE: 'cf_agent_stream_resume_none',
	CF_AGENT_STREAM_PENDING: 'cf_agent_stream_pending',
	CF_AGENT_TOOL_RESULT: 'cf_agent_tool_result',
	CF_AGENT_MESSAGE_UPDATED: 'cf_agent_message_updated',
	SITE_STUDIO_CHAT_INVALIDATED: 'site_studio_chat_invalidated',
	SITE_STUDIO_CHAT_LIVENESS: 'site_studio_chat_liveness',
	SITE_STUDIO_CANCEL_TURN: 'site_studio_cancel_turn',
	SITE_STUDIO_CHAT_CANCELLED: 'site_studio_chat_cancelled',
	SITE_STUDIO_CHAT_COMMITTED: 'site_studio_chat_committed'
} as const;

export type ToolPartState =
	| 'input-streaming'
	| 'input-available'
	| 'approval-requested'
	| 'approval-responded'
	| 'output-available'
	| 'output-error'
	| 'output-denied';

export interface UITextPart {
	type: 'text';
	text: string;
	state?: 'streaming' | 'done';
}

export interface UIReasoningPart {
	type: 'reasoning';
	text: string;
	state?: 'streaming' | 'done';
}

/** UI message parts emitted by the AI SDK for citations and generated files. */
export interface UISourceUrlPart {
	type: 'source-url';
	sourceId: string;
	url: string;
	title?: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface UISourceDocumentPart {
	type: 'source-document';
	sourceId: string;
	mediaType: string;
	title: string;
	filename?: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface UIFilePart {
	type: 'file';
	mediaType: string;
	url: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface UIToolPart {
	type: `tool-${string}`;
	toolCallId: string;
	toolName: string;
	state: ToolPartState;
	input?: JsonValue;
	output?: JsonValue;
	errorText?: string;
	approval?: {
		id: string;
		approved?: boolean;
		reason?: string;
	};
	title?: string;
	preliminary?: boolean;
}

export interface UIStepStartPart {
	type: 'step-start';
}

export interface UIDataPart {
	type: `data-${string}`;
	id?: string;
	data: JsonValue;
}

/** A streamed data part may be marked transient and must not enter history. */
export interface UIDataChunk extends UIDataPart {
	transient?: boolean;
}

export type UIMessagePart =
	| UITextPart
	| UIReasoningPart
	| UISourceUrlPart
	| UISourceDocumentPart
	| UIFilePart
	| UIToolPart
	| UIStepStartPart
	| UIDataPart;

export interface UIChatMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: UIMessagePart[];
	metadata?: Record<string, JsonValue>;
}

const toolPartTypeSchema = z.string().refine((value): value is `tool-${string}` => value.startsWith('tool-'));
const dataPartTypeSchema = z.string().refine((value): value is `data-${string}` => value.startsWith('data-'));
const toolStateSchema = z.enum([
	'input-streaming',
	'input-available',
	'approval-requested',
	'approval-responded',
	'output-available',
	'output-error',
	'output-denied'
]);
const metadataSchema = z.record(z.string(), jsonValueSchema);
// These metadata values arrive over JSON, so `undefined` (permitted by the
// SDK's in-memory types) cannot occur on the wire and is intentionally not in
// the boundary type.
const providerMetadataSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema));
const toolMetadataSchema = z.record(z.string(), jsonValueSchema);
const uiMessagePartSchema = z.union([
	z.object({ type: z.literal('text'), text: z.string(), state: z.enum(['streaming', 'done']).optional() }).catchall(jsonValueSchema),
	z.object({ type: z.literal('reasoning'), text: z.string(), state: z.enum(['streaming', 'done']).optional() }).catchall(jsonValueSchema),
	z.object({ type: z.literal('source-url'), sourceId: z.string(), url: z.string(), title: z.string().optional(), providerMetadata: metadataSchema.optional() }).catchall(jsonValueSchema),
	z.object({ type: z.literal('source-document'), sourceId: z.string(), mediaType: z.string(), title: z.string(), filename: z.string().optional(), providerMetadata: metadataSchema.optional() }).catchall(jsonValueSchema),
	z.object({ type: z.literal('file'), mediaType: z.string(), url: z.string(), providerMetadata: metadataSchema.optional() }).catchall(jsonValueSchema),
	z.object({
		type: toolPartTypeSchema,
		toolCallId: z.string(),
		toolName: z.string(),
		state: toolStateSchema,
		input: jsonValueSchema.optional(),
		output: jsonValueSchema.optional(),
		errorText: z.string().optional(),
		approval: z.object({ id: z.string(), approved: z.boolean().optional(), reason: z.string().optional() }).optional(),
		title: z.string().optional(),
		preliminary: z.boolean().optional()
	}).catchall(jsonValueSchema),
	z.object({ type: z.literal('step-start') }).catchall(jsonValueSchema),
	z.object({ type: dataPartTypeSchema, id: z.string().optional(), data: jsonValueSchema }).catchall(jsonValueSchema)
]);
const uiChatMessageSchema = z.object({
	id: z.string().min(1),
	role: z.enum(['user', 'assistant']),
	parts: z.array(uiMessagePartSchema),
	metadata: metadataSchema.optional()
}).catchall(jsonValueSchema);
const uiChatMessagesSchema = z.array(uiChatMessageSchema);

export interface AgentSocketMessage {
	type: string;
	messages?: UIChatMessage[];
	message?: UIChatMessage;
	id?: string;
	requestId?: string;
	probeId?: string;
	streamStallTimeoutMs?: number;
	continuation?: boolean;
	body?: string;
	done?: boolean;
	error?: boolean;
}

const agentSocketMessageSchema = z.object({
	type: z.string(),
	messages: uiChatMessagesSchema.optional(),
	message: uiChatMessageSchema.optional(),
	id: z.string().optional(),
	requestId: z.string().optional(),
	probeId: z.string().optional(),
	continuation: z.boolean().optional(),
	body: z.string().optional(),
	done: z.boolean().optional(),
	error: z.boolean().optional()
}).catchall(jsonValueSchema);

const siteStudioChatCommittedFrameSchema = z.object({
	type: z.literal(AgentMessageType.SITE_STUDIO_CHAT_COMMITTED),
	requestId: z.string().min(1),
	messages: uiChatMessagesSchema
}).strict();

const siteStudioChatInvalidatedFrameSchema = z.object({
	type: z.literal(AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED),
	requestId: z.string().min(1).optional()
}).strict();

const siteStudioChatLivenessFrameSchema = z.object({
	type: z.literal(AgentMessageType.SITE_STUDIO_CHAT_LIVENESS),
	streamStallTimeoutMs: z.number().finite().positive()
}).strict();

export type SiteStudioChatCommittedFrame = z.infer<typeof siteStudioChatCommittedFrameSchema>;

export type SiteStudioChatInvalidatedFrame = z.infer<typeof siteStudioChatInvalidatedFrameSchema>;

export type SiteStudioChatLivenessFrame = z.infer<typeof siteStudioChatLivenessFrameSchema>;

export interface ActiveStreamMessage {
	id: string;
	messageId: string;
	continuation: boolean;
	hadError: boolean;
	errorText?: string;
	parts: UIMessagePart[];
	metadata?: Record<string, JsonValue>;
}

export interface ToolApprovalRequestChunk {
	type: 'tool-approval-request';
	approvalId: string;
	toolCallId: string;
	signature?: string;
}

export interface ToolInputAvailableChunk {
	type: 'tool-input-available';
	toolCallId: string;
	toolName: string;
	input: JsonValue;
	providerExecuted?: boolean;
	providerMetadata?: Record<string, JsonValue>;
	toolMetadata?: Record<string, JsonValue>;
	dynamic?: boolean;
	title?: string;
}

export interface ToolOutputAvailableChunk {
	type: 'tool-output-available';
	toolCallId: string;
	output: JsonValue;
	providerExecuted?: boolean;
	providerMetadata?: Record<string, JsonValue>;
	toolMetadata?: Record<string, JsonValue>;
	dynamic?: boolean;
	preliminary?: boolean;
}

export interface ToolOutputErrorChunk {
	type: 'tool-output-error';
	toolCallId: string;
	errorText: string;
	providerExecuted?: boolean;
	providerMetadata?: Record<string, JsonValue>;
	toolMetadata?: Record<string, JsonValue>;
	dynamic?: boolean;
}

export interface ToolOutputDeniedChunk {
	type: 'tool-output-denied';
	toolCallId: string;
}

export interface TextStartChunk {
	type: 'text-start';
	id: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface TextDeltaChunk {
	type: 'text-delta';
	id: string;
	delta: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface TextEndChunk {
	type: 'text-end';
	id: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface MessageStartChunk {
	type: 'start';
	messageId?: string;
	/** AI SDK v6 types this as unknown; the wire format is JSON. */
	messageMetadata?: JsonValue;
}

export interface MessageFinishChunk {
	type: 'finish';
	finishReason?: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
	/** AI SDK v6 types this as unknown; the wire format is JSON. */
	messageMetadata?: JsonValue;
}

export interface FinishStepChunk {
	type: 'finish-step';
}

export interface SourceUrlChunk {
	type: 'source-url';
	sourceId: string;
	url: string;
	title?: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface SourceDocumentChunk {
	type: 'source-document';
	sourceId: string;
	mediaType: string;
	title: string;
	filename?: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface FileChunk {
	type: 'file';
	mediaType: string;
	url: string;
	providerMetadata?: Record<string, JsonValue>;
}

export interface AbortChunk {
	type: 'abort';
	reason?: string;
}

export type UIStreamChunk =
	| TextStartChunk
	| TextDeltaChunk
	| TextEndChunk
	| ToolInputAvailableChunk
	| ToolApprovalRequestChunk
	| ToolOutputAvailableChunk
	| ToolOutputErrorChunk
	| ToolOutputDeniedChunk
	| MessageStartChunk
	| MessageFinishChunk
	| FinishStepChunk
	| SourceUrlChunk
	| SourceDocumentChunk
	| FileChunk
	| AbortChunk
	| {
			type: 'tool-input-start';
			toolCallId: string;
			toolName: string;
			providerExecuted?: boolean;
			providerMetadata?: Record<string, JsonValue>;
			toolMetadata?: Record<string, JsonValue>;
			dynamic?: boolean;
			title?: string;
	  }
	| {
			type: 'tool-input-delta';
			toolCallId: string;
			inputTextDelta: string;
		}
	| {
			type: 'tool-input-error';
			toolCallId: string;
			toolName: string;
			input: JsonValue;
			providerExecuted?: boolean;
			providerMetadata?: Record<string, JsonValue>;
			toolMetadata?: Record<string, JsonValue>;
			dynamic?: boolean;
			errorText: string;
			title?: string;
	  }
	| {
			type: 'reasoning-start';
			id: string;
	  }
	| {
			type: 'reasoning-delta';
			id: string;
			delta: string;
	  }
	| {
			type: 'reasoning-end';
			id: string;
	  }
	| {
			type: 'start-step';
	  }
	| {
			type: 'step-start';
	  }
	| {
			type: 'message-metadata';
			/** AI SDK v6 permits any metadata value; the app persists objects only. */
			messageMetadata: JsonValue;
	  }
	| {
			type: 'error';
			errorText: string;
	  }
	| UIDataChunk;

const uiStreamChunkSchema = z.union([
	z.object({ type: z.literal('text-start'), id: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('text-delta'), id: z.string(), delta: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('text-end'), id: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({
		type: z.literal('tool-input-start'),
		toolCallId: z.string(),
		toolName: z.string(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema.optional(),
		dynamic: z.boolean().optional(),
		title: z.string().optional()
	}),
	z.object({ type: z.literal('tool-input-delta'), toolCallId: z.string(), inputTextDelta: z.string() }),
	z.object({
		type: z.literal('tool-input-available'),
		toolCallId: z.string(),
		toolName: z.string(),
		input: jsonValueSchema,
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema.optional(),
		dynamic: z.boolean().optional(),
		title: z.string().optional()
	}),
	z.object({
		type: z.literal('tool-input-error'),
		toolCallId: z.string(),
		toolName: z.string(),
		input: jsonValueSchema,
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema.optional(),
		dynamic: z.boolean().optional(),
		errorText: z.string(),
		title: z.string().optional()
	}),
	z.object({ type: z.literal('tool-approval-request'), approvalId: z.string(), toolCallId: z.string(), signature: z.string().optional() }),
	z.object({
		type: z.literal('tool-output-available'),
		toolCallId: z.string(),
		output: jsonValueSchema,
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema.optional(),
		dynamic: z.boolean().optional(),
		preliminary: z.boolean().optional()
	}),
	z.object({
		type: z.literal('tool-output-error'),
		toolCallId: z.string(),
		errorText: z.string(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema.optional(),
		dynamic: z.boolean().optional()
	}),
	z.object({ type: z.literal('tool-output-denied'), toolCallId: z.string() }),
	z.object({ type: z.literal('reasoning-start'), id: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('reasoning-delta'), id: z.string(), delta: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('reasoning-end'), id: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('source-url'), sourceId: z.string(), url: z.string(), title: z.string().optional(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('source-document'), sourceId: z.string(), mediaType: z.string(), title: z.string(), filename: z.string().optional(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('file'), mediaType: z.string(), url: z.string(), providerMetadata: providerMetadataSchema.optional() }),
	z.object({ type: z.literal('start'), messageId: z.string().optional(), messageMetadata: jsonValueSchema.optional() }),
	z.object({
		type: z.literal('finish'),
		finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).optional(),
		messageMetadata: jsonValueSchema.optional()
	}),
	z.object({ type: z.literal('start-step') }),
	z.object({ type: z.literal('step-start') }),
	z.object({ type: z.literal('finish-step') }),
	z.object({ type: z.literal('abort'), reason: z.string().optional() }),
	z.object({ type: z.literal('message-metadata'), messageMetadata: jsonValueSchema }),
	z.object({ type: z.literal('error'), errorText: z.string() }),
	z.object({ type: dataPartTypeSchema, id: z.string().optional(), data: jsonValueSchema, transient: z.boolean().optional() })
]);

/** Parse and validate persisted chat history before it enters component state. */
export function parseUIChatMessages(payload: string): UIChatMessage[] {
	const parsed = uiChatMessagesSchema.safeParse(JSON.parse(payload));
	if (!parsed.success) throw new Error('Invalid chat history payload');
	return parsed.data;
}

/** Parse and validate a server WebSocket frame before dispatching it. */
export function parseAgentSocketMessage(payload: string): AgentSocketMessage {
	const parsed = agentSocketMessageSchema.safeParse(JSON.parse(payload));
	if (!parsed.success) throw new Error('Invalid agent socket payload');
	return parsed.data;
}

/**
 * Parse the post-persistence Site Studio commit frame. A commit can replace
 * the visible transcript, so it must not accept an ambiguous payload.
 */
export function parseSiteStudioChatCommittedFrame(
	payload: AgentSocketMessage
): SiteStudioChatCommittedFrame | null {
	const parsed = siteStudioChatCommittedFrameSchema.safeParse(payload);
	return parsed.success ? parsed.data : null;
}

export function parseSiteStudioChatInvalidatedFrame(
	payload: AgentSocketMessage
): SiteStudioChatInvalidatedFrame | null {
	const parsed = siteStudioChatInvalidatedFrameSchema.safeParse(payload);
	return parsed.success ? parsed.data : null;
}

export function parseSiteStudioChatLivenessFrame(
	payload: AgentSocketMessage
): SiteStudioChatLivenessFrame | null {
	const parsed = siteStudioChatLivenessFrameSchema.safeParse(payload);
	return parsed.success ? parsed.data : null;
}

/** Parse a streamed UI chunk, including the server's optional `data:` prefix. */
export function parseUIStreamChunk(payload: string): UIStreamChunk {
	let value: string = payload;
	try {
		const parsed = uiStreamChunkSchema.safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
	} catch {
		// Retry below for a `data:`-prefixed frame.
	}

	if (!value.startsWith('data:')) throw new Error('Invalid UI stream chunk');
	value = value.slice('data:'.length).replace(/[\r\n]+$/, '');
	const parsed = uiStreamChunkSchema.safeParse(JSON.parse(value));
	if (!parsed.success) throw new Error('Invalid UI stream chunk');
	return parsed.data;
}

function findLastPartByType(parts: UIMessagePart[], type: UIMessagePart['type']): UIMessagePart | undefined {
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		if (parts[i].type === type) {
			return parts[i];
		}
	}
}

function findToolPartByCallId(parts: UIMessagePart[], toolCallId: string): UIToolPart | undefined {
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		const part = parts[i];
		if (isToolPart(part) && part.toolCallId === toolCallId) {
			return part;
		}
	}
}

function findDataPartByTypeAndId(parts: UIMessagePart[], type: string, id: string): UIDataPart | undefined {
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		const part = parts[i];
		if (isDataPart(part) && part.type === type && part.id === id) {
			return part;
		}
	}
}

export function isToolPart(part: UIMessagePart): part is UIToolPart {
	return part.type.startsWith('tool-');
}

function isDataPart(part: UIMessagePart): part is UIDataPart {
	return part.type.startsWith('data-');
}

export function cloneParts(parts: UIMessagePart[]): UIMessagePart[] {
	return parts.map((part) => {
		const parsed = uiMessagePartSchema.safeParse(JSON.parse(JSON.stringify(part)));
		if (!parsed.success) throw new Error('Invalid chat message part');
		return parsed.data;
	});
}

/** Tool inputs must remain JSON objects so the tool cards can inspect them. */
function normalizeToolInput(input: JsonValue): JsonValue {
	const objectInput = z.record(z.string(), jsonValueSchema).safeParse(input);
	if (objectInput.success) return objectInput.data;

	const encodedInput = z.string().safeParse(input);
	if (encodedInput.success && encodedInput.data.trim().startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(encodedInput.data);
			const parsedObject = z.record(z.string(), jsonValueSchema).safeParse(parsed);
			if (parsedObject.success) return parsedObject.data;
		} catch {
			// Invalid partial JSON is expected while a tool call is streaming.
		}
	}

	return {};
}

export function applyChunkToParts(parts: UIMessagePart[], chunk: UIStreamChunk): boolean {
	switch (chunk.type) {
		case 'text-start':
			parts.push({ type: 'text', text: '', state: 'streaming' });
			return true;
		case 'text-delta': {
			const lastTextPart = findLastPartByType(parts, 'text');
			if (lastTextPart?.type === 'text') {
				lastTextPart.text += chunk.delta ?? '';
			} else {
				parts.push({ type: 'text', text: chunk.delta ?? '', state: 'streaming' });
			}
			return true;
		}
		case 'text-end': {
			const lastTextPart = findLastPartByType(parts, 'text');
			if (lastTextPart?.type === 'text') {
				lastTextPart.state = 'done';
			}
			return true;
		}
		case 'reasoning-start':
			parts.push({ type: 'reasoning', text: '', state: 'streaming' });
			return true;
		case 'reasoning-delta': {
			const lastReasoningPart = findLastPartByType(parts, 'reasoning');
			if (lastReasoningPart?.type === 'reasoning') {
				lastReasoningPart.text += chunk.delta ?? '';
			} else {
				parts.push({ type: 'reasoning', text: chunk.delta ?? '', state: 'streaming' });
			}
			return true;
		}
		case 'reasoning-end': {
			const lastReasoningPart = findLastPartByType(parts, 'reasoning');
			if (lastReasoningPart?.type === 'reasoning') {
				lastReasoningPart.state = 'done';
			}
			return true;
		}
		case 'file':
			if (
				parts.some(
					(part): part is UIFilePart =>
						part.type === 'file' && part.mediaType === chunk.mediaType && part.url === chunk.url
				)
			) {
				return true;
			}
			parts.push({
				type: 'file',
				mediaType: chunk.mediaType,
				url: chunk.url,
				providerMetadata: chunk.providerMetadata
			});
			return true;
		case 'source-url':
			if (parts.some((part): part is UISourceUrlPart => part.type === 'source-url' && part.sourceId === chunk.sourceId)) {
				return true;
			}
			parts.push({
				type: 'source-url',
				sourceId: chunk.sourceId,
				url: chunk.url,
				title: chunk.title,
				providerMetadata: chunk.providerMetadata
			});
			return true;
		case 'source-document':
			if (
				parts.some((part): part is UISourceDocumentPart => part.type === 'source-document' && part.sourceId === chunk.sourceId)
			) {
				return true;
			}
			parts.push({
				type: 'source-document',
				sourceId: chunk.sourceId,
				mediaType: chunk.mediaType,
				title: chunk.title,
				filename: chunk.filename,
				providerMetadata: chunk.providerMetadata
			});
			return true;
		case 'tool-input-start':
			if (findToolPartByCallId(parts, chunk.toolCallId)) return true;
			parts.push({
				type: `tool-${chunk.toolName}`,
				toolCallId: chunk.toolCallId,
				toolName: chunk.toolName,
				state: 'input-streaming',
				title: chunk.title
			});
			return true;
		case 'tool-input-delta': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart?.state !== 'input-streaming') return true;

			const previousText = z.string().safeParse(toolPart.input);
			const inputText = `${previousText.success ? previousText.data : ''}${chunk.inputTextDelta}`;
			try {
				const parsed: unknown = JSON.parse(inputText);
				const parsedValue = jsonValueSchema.safeParse(parsed);
				toolPart.input = parsedValue.success ? normalizeToolInput(parsedValue.data) : inputText;
			} catch {
				// Keep the raw fragment until the SDK emits a complete JSON value.
				toolPart.input = inputText;
			}
			return true;
		}
		case 'tool-input-available': {
			const existing = findToolPartByCallId(parts, chunk.toolCallId);
			if (existing) {
				if (existing.state === 'input-streaming') {
					existing.state = 'input-available';
					existing.input = normalizeToolInput(chunk.input);
					if (chunk.title !== undefined) existing.title = chunk.title;
				}
			} else {
				parts.push({
					type: `tool-${chunk.toolName}`,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					state: 'input-available',
					input: normalizeToolInput(chunk.input),
					title: chunk.title
				});
			}
			return true;
		}
		case 'tool-input-error': {
			const existing = findToolPartByCallId(parts, chunk.toolCallId);
			if (existing) {
				if (existing.state === 'output-available' || existing.state === 'output-error' || existing.state === 'output-denied') {
					return true;
				}
				existing.state = 'output-error';
				existing.input = normalizeToolInput(chunk.input);
				existing.errorText = chunk.errorText;
				if (chunk.title !== undefined) existing.title = chunk.title;
			} else {
				parts.push({
					type: `tool-${chunk.toolName}`,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					state: 'output-error',
					input: normalizeToolInput(chunk.input),
					errorText: chunk.errorText,
					title: chunk.title
				});
			}
			return true;
		}
		case 'tool-approval-request': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				if (
					toolPart.state === 'approval-responded' ||
					toolPart.state === 'output-available' ||
					toolPart.state === 'output-error' ||
					toolPart.state === 'output-denied'
				) {
					return true;
				}
				toolPart.state = 'approval-requested';
				toolPart.approval = { id: chunk.approvalId };
			}
			return true;
		}
		case 'tool-output-available': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				if (
					toolPart.state === 'output-error' ||
					toolPart.state === 'output-denied' ||
					(toolPart.state === 'output-available' &&
						!(toolPart.preliminary === true && chunk.preliminary !== true))
				) {
					return true;
				}
				toolPart.state = 'output-available';
				toolPart.output = chunk.output;
				toolPart.preliminary = chunk.preliminary;
			}
			return true;
		}
		case 'tool-output-error': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				if (
					toolPart.state === 'output-error' ||
					toolPart.state === 'output-denied' ||
					(toolPart.state === 'output-available' && toolPart.preliminary !== true)
				) {
					return true;
				}
				toolPart.state = 'output-error';
				toolPart.errorText = chunk.errorText;
				toolPart.preliminary = undefined;
			}
			return true;
		}
		case 'tool-output-denied': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				if (
					toolPart.state === 'approval-responded' ||
					toolPart.state === 'output-error' ||
					toolPart.state === 'output-denied' ||
					(toolPart.state === 'output-available' && toolPart.preliminary !== true)
				) {
					return true;
				}
				toolPart.state = 'output-denied';
				toolPart.preliminary = undefined;
			}
			return true;
		}
		case 'start-step':
		case 'step-start':
			parts.push({ type: 'step-start' });
			return true;
		case 'finish-step':
		case 'abort':
			return true;
		default:
			if (isDataChunk(chunk)) {
				const dataChunk = chunk;
				if (dataChunk.transient) return true;

				if ('id' in chunk && chunk.id) {
					const existing = findDataPartByTypeAndId(parts, dataChunk.type, chunk.id);
					if (existing) {
						existing.data = dataChunk.data;
						return true;
					}
				}

				const dataPart: UIDataPart = { type: dataChunk.type, data: dataChunk.data };
				if (dataChunk.id) dataPart.id = dataChunk.id;
				parts.push(dataPart);
				return true;
			}

			return false;
	}
}

function isDataChunk(chunk: UIStreamChunk): chunk is UIDataChunk {
	return chunk.type.startsWith('data-');
}

export function mergeUpdatedMessage(messages: UIChatMessage[], updatedMessage: UIChatMessage): UIChatMessage[] {
	let index = messages.findIndex((message) => message.id === updatedMessage.id);

	if (index < 0) {
		const updatedToolCallIds = new Set(
			updatedMessage.parts
				.filter((part) => isToolPart(part))
				.map((part) => part.toolCallId)
		);

		if (updatedToolCallIds.size > 0) {
			index = messages.findIndex((message) =>
				message.parts.some((part) => isToolPart(part) && updatedToolCallIds.has(part.toolCallId))
			);
		}
	}

	if (index < 0) {
		return messages;
	}

	const nextMessages = [...messages];
	nextMessages[index] = {
		...updatedMessage,
		id: messages[index].id
	};
	return nextMessages;
}

export function applyLocalToolOutput(
	messages: UIChatMessage[],
	toolCallId: string,
	output: JsonValue,
	state: 'output-available' | 'output-error' = 'output-available',
	errorText?: string
): UIChatMessage[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (!isToolPart(part) || part.toolCallId !== toolCallId) {
				return part;
			}

			const nextPart: UIToolPart = {
				...part,
				state,
				output
			};
			if (errorText) nextPart.errorText = errorText;
			return nextPart;
		})
	}));
}
