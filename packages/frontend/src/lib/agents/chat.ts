export const AgentMessageType = {
	CF_AGENT_CHAT_MESSAGES: 'cf_agent_chat_messages',
	CF_AGENT_USE_CHAT_REQUEST: 'cf_agent_use_chat_request',
	CF_AGENT_USE_CHAT_RESPONSE: 'cf_agent_use_chat_response',
	CF_AGENT_CHAT_CLEAR: 'cf_agent_chat_clear',
	CF_AGENT_CHAT_REQUEST_CANCEL: 'cf_agent_chat_request_cancel',
	CF_AGENT_STREAM_RESUMING: 'cf_agent_stream_resuming',
	CF_AGENT_STREAM_RESUME_ACK: 'cf_agent_stream_resume_ack',
	CF_AGENT_STREAM_RESUME_REQUEST: 'cf_agent_stream_resume_request',
	CF_AGENT_STREAM_RESUME_NONE: 'cf_agent_stream_resume_none',
	CF_AGENT_TOOL_RESULT: 'cf_agent_tool_result',
	CF_AGENT_MESSAGE_UPDATED: 'cf_agent_message_updated',
	CF_AGENT_TOOL_APPROVAL: 'cf_agent_tool_approval'
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
	input?: unknown;
	output?: unknown;
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
	data: unknown;
}

export type UIMessagePart = UITextPart | UIReasoningPart | UIToolPart | UIStepStartPart | UIDataPart;

export interface UIChatMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: UIMessagePart[];
	metadata?: Record<string, unknown>;
}

export interface ActiveStreamMessage {
	id: string;
	messageId: string;
	continuation: boolean;
	parts: UIMessagePart[];
	metadata?: Record<string, unknown>;
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
	input: unknown;
	title?: string;
}

export interface ToolOutputAvailableChunk {
	type: 'tool-output-available';
	toolCallId: string;
	output: unknown;
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
	messageMetadata?: Record<string, unknown>;
}

export interface MessageFinishChunk {
	type: 'finish';
	messageMetadata?: Record<string, unknown>;
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
			input?: unknown;
	  }
	| {
			type: 'tool-input-error';
			toolCallId: string;
			toolName: string;
			input: unknown;
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
			messageMetadata: Record<string, unknown>;
	  }
	| {
			type: 'error';
			errorText: string;
	  }
	| UIDataPart;

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
		if (part.type === type && 'id' in part && part.id === id) {
			return part as UIDataPart;
		}
	}
}

export function isToolPart(part: UIMessagePart): part is UIToolPart {
	return part.type.startsWith('tool-');
}

export function cloneParts(parts: UIMessagePart[]): UIMessagePart[] {
	return parts.map((part) => JSON.parse(JSON.stringify(part)) as UIMessagePart);
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
			if (chunk.type.startsWith('data-')) {
				const dataChunk = chunk as UIDataPart;

				if ('id' in chunk && chunk.id) {
					const existing = findDataPartByTypeAndId(parts, dataChunk.type, chunk.id);
					if (existing) {
						existing.data = dataChunk.data;
						return true;
					}
				}

				parts.push({
					type: dataChunk.type,
					...('id' in chunk && chunk.id ? { id: chunk.id } : {}),
					data: dataChunk.data
				});
				return true;
			}

			return false;
	}
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

export function applyLocalToolApproval(
	messages: UIChatMessage[],
	approvalId: string,
	approved: boolean,
	reason?: string
): UIChatMessage[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (!isToolPart(part) || part.state !== 'approval-requested' || part.approval?.id !== approvalId) {
				return part;
			}

			return {
				...part,
				state: 'approval-responded',
				approval: {
					id: approvalId,
					approved,
					...(reason ? { reason } : {})
				}
			};
		})
	}));
}

export function applyLocalToolOutput(
	messages: UIChatMessage[],
	toolCallId: string,
	output: unknown,
	state: 'output-available' | 'output-error' = 'output-available',
	errorText?: string
): UIChatMessage[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (!isToolPart(part) || part.toolCallId !== toolCallId) {
				return part;
			}

			return {
				...part,
				state,
				output,
				...(errorText ? { errorText } : {})
			};
		})
	}));
}
