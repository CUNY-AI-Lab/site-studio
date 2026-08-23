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
	CF_AGENT_STREAM_PENDING: 'cf_agent_stream_pending',
	CF_AGENT_TOOL_RESULT: 'cf_agent_tool_result',
	CF_AGENT_MESSAGE_UPDATED: 'cf_agent_message_updated',
	SITE_STUDIO_CHAT_INVALIDATED: 'site_studio_chat_invalidated',
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

export type SiteStudioChatCommittedFrame = z.infer<typeof siteStudioChatCommittedFrameSchema>;
export type SiteStudioChatInvalidatedFrame = z.infer<typeof siteStudioChatInvalidatedFrameSchema>;

/** Parse persisted history before it enters component state. */
export function parseUIChatMessages(payload: string): UIChatMessage[] {
	const parsed = uiChatMessagesSchema.safeParse(JSON.parse(payload));
	if (!parsed.success) throw new Error('Invalid chat history payload');
	return parsed.data;
}

/** Parse a server WebSocket frame before dispatching it. */
export function parseAgentSocketMessage(payload: string): AgentSocketMessage {
	const parsed = agentSocketMessageSchema.safeParse(JSON.parse(payload));
	if (!parsed.success) throw new Error('Invalid agent socket payload');
	return parsed.data;
}

/** Parse the post-persistence Site Studio commit frame. */
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

export function isToolPart(part: UIMessagePart): part is UIToolPart {
	return part.type.startsWith('tool-');
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

	if (index < 0) return messages;

	const nextMessages = [...messages];
	nextMessages[index] = {
		...updatedMessage,
		id: messages[index].id
	};
	return nextMessages;
}
