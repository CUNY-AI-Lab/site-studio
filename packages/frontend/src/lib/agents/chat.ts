import { jsonValueSchema, type JsonValue } from '$lib/contracts';
import { z } from 'zod';

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
	CF_AGENT_TOOL_RESULT: 'cf_agent_tool_result',
	CF_AGENT_MESSAGE_UPDATED: 'cf_agent_message_updated',
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

export type UIMessagePart = UITextPart | UIReasoningPart | UIToolPart | UIStepStartPart | UIDataPart;

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
const uiMessagePartSchema = z.union([
	z.object({ type: z.literal('text'), text: z.string(), state: z.enum(['streaming', 'done']).optional() }).catchall(jsonValueSchema),
	z.object({ type: z.literal('reasoning'), text: z.string(), state: z.enum(['streaming', 'done']).optional() }).catchall(jsonValueSchema),
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

export type SiteStudioChatCommittedFrame = z.infer<typeof siteStudioChatCommittedFrameSchema>;

export interface ActiveStreamMessage {
	id: string;
	messageId: string;
	continuation: boolean;
	hadError: boolean;
	parts: UIMessagePart[];
	metadata?: Record<string, JsonValue>;
}

export interface ToolApprovalRequestChunk {
	type: 'tool-approval-request';
	approvalId: string;
	toolCallId: string;
}

export interface ToolInputAvailableChunk {
	type: 'tool-input-available';
	toolCallId: string;
	toolName: string;
	input: JsonValue;
	title?: string;
}

export interface ToolOutputAvailableChunk {
	type: 'tool-output-available';
	toolCallId: string;
	output: JsonValue;
	preliminary?: boolean;
}

export interface ToolOutputErrorChunk {
	type: 'tool-output-error';
	toolCallId: string;
	errorText: string;
}

export interface ToolOutputDeniedChunk {
	type: 'tool-output-denied';
	toolCallId: string;
}

export interface TextStartChunk {
	type: 'text-start';
	id: string;
}

export interface TextDeltaChunk {
	type: 'text-delta';
	id: string;
	delta: string;
}

export interface TextEndChunk {
	type: 'text-end';
	id: string;
}

export interface MessageStartChunk {
	type: 'start';
	messageId?: string;
	messageMetadata?: Record<string, JsonValue>;
}

export interface MessageFinishChunk {
	type: 'finish';
	messageMetadata?: Record<string, JsonValue>;
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
	| {
			type: 'tool-input-start';
			toolCallId: string;
			toolName: string;
			title?: string;
	  }
	| {
			type: 'tool-input-delta';
			toolCallId: string;
			inputTextDelta?: string;
			input?: JsonValue;
	  }
	| {
			type: 'tool-input-error';
			toolCallId: string;
			toolName: string;
			input: JsonValue;
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
			messageMetadata: Record<string, JsonValue>;
	  }
	| {
			type: 'error';
			errorText: string;
	  }
	| UIDataPart;

const uiStreamChunkSchema = z.union([
	z.object({ type: z.literal('text-start'), id: z.string() }),
	z.object({ type: z.literal('text-delta'), id: z.string(), delta: z.string() }),
	z.object({ type: z.literal('text-end'), id: z.string() }),
	z.object({ type: z.literal('tool-input-start'), toolCallId: z.string(), toolName: z.string(), title: z.string().optional() }),
	z.object({ type: z.literal('tool-input-delta'), toolCallId: z.string(), inputTextDelta: z.string().optional(), input: jsonValueSchema.optional() }),
	z.object({ type: z.literal('tool-input-available'), toolCallId: z.string(), toolName: z.string(), input: jsonValueSchema, title: z.string().optional() }),
	z.object({ type: z.literal('tool-input-error'), toolCallId: z.string(), toolName: z.string(), input: jsonValueSchema, errorText: z.string(), title: z.string().optional() }),
	z.object({ type: z.literal('tool-approval-request'), approvalId: z.string(), toolCallId: z.string() }),
	z.object({ type: z.literal('tool-output-available'), toolCallId: z.string(), output: jsonValueSchema, preliminary: z.boolean().optional() }),
	z.object({ type: z.literal('tool-output-error'), toolCallId: z.string(), errorText: z.string() }),
	z.object({ type: z.literal('tool-output-denied'), toolCallId: z.string() }),
	z.object({ type: z.literal('reasoning-start'), id: z.string() }),
	z.object({ type: z.literal('reasoning-delta'), id: z.string(), delta: z.string() }),
	z.object({ type: z.literal('reasoning-end'), id: z.string() }),
	z.object({ type: z.literal('start'), messageId: z.string().optional(), messageMetadata: metadataSchema.optional() }),
	z.object({ type: z.literal('finish'), messageMetadata: metadataSchema.optional() }),
	z.object({ type: z.literal('start-step') }),
	z.object({ type: z.literal('step-start') }),
	z.object({ type: z.literal('message-metadata'), messageMetadata: metadataSchema }),
	z.object({ type: z.literal('error'), errorText: z.string() }),
	z.object({ type: dataPartTypeSchema, id: z.string().optional(), data: jsonValueSchema })
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
		case 'tool-input-start':
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
			if (toolPart) {
				toolPart.input = chunk.input;
			}
			return true;
		}
		case 'tool-input-available': {
			const existing = findToolPartByCallId(parts, chunk.toolCallId);
			if (existing) {
				existing.state = 'input-available';
				existing.input = chunk.input;
				existing.title = chunk.title;
			} else {
				parts.push({
					type: `tool-${chunk.toolName}`,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					state: 'input-available',
					input: chunk.input,
					title: chunk.title
				});
			}
			return true;
		}
		case 'tool-input-error': {
			const existing = findToolPartByCallId(parts, chunk.toolCallId);
			if (existing) {
				existing.state = 'output-error';
				existing.input = chunk.input;
				existing.errorText = chunk.errorText;
				existing.title = chunk.title;
			} else {
				parts.push({
					type: `tool-${chunk.toolName}`,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					state: 'output-error',
					input: chunk.input,
					errorText: chunk.errorText,
					title: chunk.title
				});
			}
			return true;
		}
		case 'tool-approval-request': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				toolPart.state = 'approval-requested';
				toolPart.approval = { id: chunk.approvalId };
			}
			return true;
		}
		case 'tool-output-available': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				toolPart.state = 'output-available';
				toolPart.output = chunk.output;
				toolPart.preliminary = chunk.preliminary;
			}
			return true;
		}
		case 'tool-output-error': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				toolPart.state = 'output-error';
				toolPart.errorText = chunk.errorText;
			}
			return true;
		}
		case 'tool-output-denied': {
			const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
			if (toolPart) {
				toolPart.state = 'output-denied';
			}
			return true;
		}
		case 'start-step':
		case 'step-start':
			parts.push({ type: 'step-start' });
			return true;
		default:
			if (isDataChunk(chunk)) {
				const dataChunk = chunk;

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

function isDataChunk(chunk: UIStreamChunk): chunk is UIDataPart {
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
