import { describe, expect, it } from 'vitest';
import {
	AgentMessageType,
	isToolPart,
	mergeUpdatedMessage,
	parseAgentSocketMessage,
	parseSiteStudioChatCommittedFrame,
	parseSiteStudioChatInvalidatedFrame,
	parseUIChatMessages,
	type UIChatMessage,
	type UIMessagePart,
	type UIToolPart
} from './chat';

function toolPart(parts: UIMessagePart[], toolCallId: string): UIToolPart {
	const part = parts.find((candidate) => isToolPart(candidate) && candidate.toolCallId === toolCallId);
	if (!part || !isToolPart(part)) throw new Error(`Missing tool part ${toolCallId}`);
	return part;
}

const history = [
	{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build a page' }] },
	{
		id: 'a1',
		role: 'assistant',
		parts: [
			{ type: 'text', text: 'I will build it.', state: 'done' },
			{ type: 'reasoning', text: 'Planning', state: 'done' },
			{ type: 'tool-codemode', toolCallId: 'call-1', toolName: 'codemode', state: 'output-available', input: {}, output: { ok: true } },
			{ type: 'source-url', sourceId: 'source-1', url: 'https://example.test', title: 'Reference' },
			{ type: 'file', mediaType: 'text/plain', url: 'data:text/plain,done' },
			{ type: 'data-status', id: 'status-1', data: { phase: 'done' } }
		]
	}
] satisfies UIChatMessage[];

describe('chat wire boundary', () => {
	it('parses persisted messages without a client-side stream reducer', () => {
		expect(parseUIChatMessages(JSON.stringify(history))).toEqual(history);
	});

	it('rejects malformed history before it enters component state', () => {
		expect(() => parseUIChatMessages(JSON.stringify({ messages: history }))).toThrow('Invalid chat history payload');
		expect(() => parseUIChatMessages(JSON.stringify([{ id: 'bad', role: 'assistant', parts: null }]))).toThrow(
			'Invalid chat history payload'
		);
	});

	it('parses protocol metadata while keeping the transport owner separate', () => {
		const frame = parseAgentSocketMessage(
			JSON.stringify({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: 'request-1',
				body: JSON.stringify({ type: 'text-delta', id: 'text-1', delta: 'hello' }),
				done: false,
				continuation: true
			})
		);
		expect(frame).toMatchObject({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'request-1',
			continuation: true
		});
	});

	it('rejects malformed or non-object socket frames', () => {
		expect(() => parseAgentSocketMessage('not-json')).toThrow('Unexpected token');
		expect(() => parseAgentSocketMessage(JSON.stringify({ type: 4 }))).toThrow('Invalid agent socket payload');
	});

	it('accepts only strict, complete commit frames', () => {
		const frame = {
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId: 'request-1',
			messages: history
		};
		const frameWithExtra = { ...frame, extra: true };
		expect(parseSiteStudioChatCommittedFrame(frame)).toEqual(frame);
		expect(parseSiteStudioChatCommittedFrame(frameWithExtra)).toBeNull();
		expect(parseSiteStudioChatCommittedFrame({ ...frame, requestId: '' })).toBeNull();
	});

	it('accepts invalidation frames with an optional request id and rejects extras', () => {
		expect(parseSiteStudioChatInvalidatedFrame({ type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED })).toEqual({
			type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED
		});
		const invalidatedWithExtra = {
			type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED,
			requestId: 'request-1',
			extra: true
		};
		expect(parseSiteStudioChatInvalidatedFrame(invalidatedWithExtra)).toBeNull();
	});
});

describe('chat message helpers', () => {
	it('recognizes tool parts without maintaining stream state', () => {
		expect(isToolPart({ type: 'tool-codemode', toolCallId: 'a', toolName: 'codemode', state: 'input-available' })).toBe(true);
		expect(isToolPart({ type: 'text', text: 'hello' })).toBe(false);
	});

	it('replaces a message by id and preserves the surrounding transcript', () => {
		const messages: UIChatMessage[] = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
			{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] }
		];
		const updated: UIChatMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'complete' }] };
		const next = mergeUpdatedMessage(messages, updated);
		expect(next).not.toBe(messages);
		expect(next).toEqual([messages[0], updated]);
		expect(messages[1].parts).toEqual([{ type: 'text', text: 'partial' }]);
	});

	it('matches a server update by shared tool call id when message ids differ', () => {
		const messages: UIChatMessage[] = [
			{
				id: 'a1',
				role: 'assistant',
				parts: [{ type: 'tool-codemode', toolCallId: 'call-42', toolName: 'codemode', state: 'input-available' }]
			}
		];
		const updated: UIChatMessage = {
			id: 'server-id',
			role: 'assistant',
			parts: [{ type: 'tool-codemode', toolCallId: 'call-42', toolName: 'codemode', state: 'output-available', output: { ok: true } }]
		};
		const next = mergeUpdatedMessage(messages, updated);
		expect(next[0].id).toBe('a1');
		expect(toolPart(next[0].parts, 'call-42').output).toEqual({ ok: true });
	});

	it('does not append an orphan update', () => {
		const messages: UIChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }];
		expect(
			mergeUpdatedMessage(messages, { id: 'missing', role: 'assistant', parts: [{ type: 'text', text: 'orphan' }] })
		).toBe(messages);
	});
});
