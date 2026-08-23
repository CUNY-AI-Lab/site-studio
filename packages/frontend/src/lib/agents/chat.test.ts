import { describe, it, expect } from 'vitest';
import {
	applyChunkToParts,
	mergeUpdatedMessage,
	cloneParts,
	isToolPart,
	parseUIStreamChunk,
	type UIMessagePart,
	type UIToolPart,
	type UITextPart,
	type UIChatMessage,
	type UIStreamChunk,
	type UIDataPart
} from './chat';

/**
 * These tests exercise the WebSocket streaming state machine as pure functions.
 * `applyChunkToParts` mutates the `parts` array in place and returns whether it
 * handled the chunk. `mergeUpdatedMessage` returns a new messages array.
 */

function textPart(parts: UIMessagePart[], index = 0): UITextPart {
	const p = parts.filter((x): x is UITextPart => x.type === 'text')[index];
	if (!p) throw new Error(`Missing text part at index ${index}`);
	return p;
}

function toolPart(parts: UIMessagePart[], toolCallId: string): UIToolPart {
	const p = parts.find((x) => isToolPart(x) && x.toolCallId === toolCallId);
	if (!p || !isToolPart(p)) throw new Error(`Missing tool part ${toolCallId}`);
	return p;
}

describe('isToolPart', () => {
	it('recognizes any part whose type begins with "tool-"', () => {
		expect(isToolPart({ type: 'tool-codemode', toolCallId: 'a', toolName: 'codemode', state: 'input-available' })).toBe(
			true
		);
		expect(isToolPart({ type: 'tool-write_file', toolCallId: 'b', toolName: 'write_file', state: 'output-available' })).toBe(
			true
		);
	});

	it('rejects non-tool parts', () => {
		expect(isToolPart({ type: 'text', text: 'hi' })).toBe(false);
		expect(isToolPart({ type: 'reasoning', text: 'hmm' })).toBe(false);
		expect(isToolPart({ type: 'step-start' })).toBe(false);
		expect(isToolPart({ type: 'data-foo', data: {} })).toBe(false);
	});
});

describe('applyChunkToParts — text lifecycle', () => {
	it('text-start pushes an empty streaming text part', () => {
		const parts: UIMessagePart[] = [];
		const handled = applyChunkToParts(parts, { type: 'text-start', id: 't1' });
		expect(handled).toBe(true);
		expect(parts).toEqual([{ type: 'text', text: '', state: 'streaming' }]);
	});

	it('text-delta appends to the last text part in place', () => {
		const parts: UIMessagePart[] = [{ type: 'text', text: 'Hel', state: 'streaming' }];
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: 'lo' });
		expect(textPart(parts).text).toBe('Hello');
		expect(parts).toHaveLength(1);
	});

	it('text-delta with no prior text part creates one', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: 'Hi' });
		expect(parts).toEqual([{ type: 'text', text: 'Hi', state: 'streaming' }]);
	});

	it('text-delta tolerates a missing delta (treats as empty)', () => {
		const parts: UIMessagePart[] = [{ type: 'text', text: 'x', state: 'streaming' }];
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: '' });
		expect(textPart(parts).text).toBe('x');
	});

	it('text-end marks the last text part done', () => {
		const parts: UIMessagePart[] = [{ type: 'text', text: 'done', state: 'streaming' }];
		applyChunkToParts(parts, { type: 'text-end', id: 't1' });
		expect(textPart(parts).state).toBe('done');
	});

	it('text-end with no text part is a no-op but still handled', () => {
		const parts: UIMessagePart[] = [];
		const handled = applyChunkToParts(parts, { type: 'text-end', id: 't1' });
		expect(handled).toBe(true);
		expect(parts).toEqual([]);
	});
});

describe('applyChunkToParts — reasoning lifecycle', () => {
	it('reasoning-start / delta / end transitions', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'reasoning-start', id: 'r1' });
		applyChunkToParts(parts, { type: 'reasoning-delta', id: 'r1', delta: 'think ' });
		applyChunkToParts(parts, { type: 'reasoning-delta', id: 'r1', delta: 'more' });
		applyChunkToParts(parts, { type: 'reasoning-end', id: 'r1' });
		expect(parts).toEqual([{ type: 'reasoning', text: 'think more', state: 'done' }]);
	});

	it('reasoning-delta with no prior reasoning part creates one', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'reasoning-delta', id: 'r1', delta: 'seed' });
		expect(parts).toEqual([{ type: 'reasoning', text: 'seed', state: 'streaming' }]);
	});
});

describe('applyChunkToParts — tool input lifecycle', () => {
	it('tool-input-start pushes a tool part in input-streaming state', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, {
			type: 'tool-input-start',
			toolCallId: 'c1',
			toolName: 'codemode',
			title: 'Running code'
		});
		expect(parts).toEqual([
			{
				type: 'tool-codemode',
				toolCallId: 'c1',
				toolName: 'codemode',
				state: 'input-streaming',
				title: 'Running code'
			}
		]);
	});

	it('tool-input-delta accumulates official JSON text fragments', () => {
		const parts: UIMessagePart[] = [
			{ type: 'tool-codemode', toolCallId: 'c1', toolName: 'codemode', state: 'input-streaming' }
		];
		applyChunkToParts(parts, { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"co' });
		expect(toolPart(parts, 'c1').input).toBe('{"co');
		applyChunkToParts(parts, { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: 'de":"x"}' });
		expect(toolPart(parts, 'c1').input).toEqual({ code: 'x' });
	});

	it('tool-input-delta for an unknown call id is a handled no-op', () => {
		const parts: UIMessagePart[] = [];
		const handled = applyChunkToParts(parts, { type: 'tool-input-delta', toolCallId: 'nope', inputTextDelta: '{}' });
		expect(handled).toBe(true);
		expect(parts).toEqual([]);
	});

	it('tool-input-available updates an existing tool part', () => {
		const parts: UIMessagePart[] = [
			{ type: 'tool-codemode', toolCallId: 'c1', toolName: 'codemode', state: 'input-streaming' }
		];
		applyChunkToParts(parts, {
			type: 'tool-input-available',
			toolCallId: 'c1',
			toolName: 'codemode',
			input: { code: 'run()' },
			title: 'Final'
		});
		const tp = toolPart(parts, 'c1');
		expect(tp.state).toBe('input-available');
		expect(tp.input).toEqual({ code: 'run()' });
		expect(tp.title).toBe('Final');
		expect(parts).toHaveLength(1);
	});

	it('tool-input-available does not regress a settled tool part', () => {
		const parts: UIMessagePart[] = [
			{
				type: 'tool-codemode',
				toolCallId: 'c1',
				toolName: 'codemode',
				state: 'output-available',
				input: { code: 'run()' },
				output: { ok: true }
			}
		];
		applyChunkToParts(parts, {
			type: 'tool-input-available',
			toolCallId: 'c1',
			toolName: 'codemode',
			input: { code: 'replayed()' }
		});
		expect(toolPart(parts, 'c1')).toMatchObject({
			state: 'output-available',
			input: { code: 'run()' },
			output: { ok: true }
		});
	});

	it('tool-input-available creates a new part when the call id is unseen', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, {
			type: 'tool-input-available',
			toolCallId: 'c2',
			toolName: 'write_file',
			input: { path: 'index.html' },
			title: 'Write'
		});
		expect(parts).toEqual([
			{
				type: 'tool-write_file',
				toolCallId: 'c2',
				toolName: 'write_file',
				state: 'input-available',
				input: { path: 'index.html' },
				title: 'Write'
			}
		]);
	});

	it('tool-input-error updates an existing part to output-error', () => {
		const parts: UIMessagePart[] = [
			{ type: 'tool-codemode', toolCallId: 'c1', toolName: 'codemode', state: 'input-streaming' }
		];
		applyChunkToParts(parts, {
			type: 'tool-input-error',
			toolCallId: 'c1',
			toolName: 'codemode',
			input: { bad: true },
			errorText: 'boom',
			title: 'T'
		});
		const tp = toolPart(parts, 'c1');
		expect(tp.state).toBe('output-error');
		expect(tp.input).toEqual({ bad: true });
		expect(tp.errorText).toBe('boom');
	});

	it('tool-input-error creates a new output-error part when unseen', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, {
			type: 'tool-input-error',
			toolCallId: 'c9',
			toolName: 'codemode',
			input: {},
			errorText: 'nope'
		});
		const tp = toolPart(parts, 'c9');
		expect(tp.state).toBe('output-error');
		expect(tp.errorText).toBe('nope');
	});

	it('tool-input-error does not overwrite a settled output', () => {
		const parts: UIMessagePart[] = [
			{
				type: 'tool-codemode',
				toolCallId: 'c1',
				toolName: 'codemode',
				state: 'output-available',
				input: { code: 'run()' },
				output: { ok: true }
			}
		];
		applyChunkToParts(parts, {
			type: 'tool-input-error',
			toolCallId: 'c1',
			toolName: 'codemode',
			input: { code: 'bad()' },
			errorText: 'late error'
		});
		expect(toolPart(parts, 'c1')).toMatchObject({
			state: 'output-available',
			input: { code: 'run()' },
			output: { ok: true }
		});
	});
});

describe('applyChunkToParts — tool approval + output lifecycle', () => {
	function seededToolPart(): UIMessagePart[] {
		return [
			{
				type: 'tool-codemode',
				toolCallId: 'c1',
				toolName: 'codemode',
				state: 'input-available',
				input: { code: 'x' }
			}
		];
	}

	it('tool-approval-request sets approval-requested and stores the approval id', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, { type: 'tool-approval-request', approvalId: 'ap1', toolCallId: 'c1' });
		const tp = toolPart(parts, 'c1');
		expect(tp.state).toBe('approval-requested');
		expect(tp.approval).toEqual({ id: 'ap1' });
	});

	it('tool-approval-request for an unknown call id is a handled no-op', () => {
		const parts: UIMessagePart[] = [];
		const handled = applyChunkToParts(parts, { type: 'tool-approval-request', approvalId: 'ap1', toolCallId: 'zzz' });
		expect(handled).toBe(true);
		expect(parts).toEqual([]);
	});

	it('tool-output-available sets output + preliminary flag', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, {
			type: 'tool-output-available',
			toolCallId: 'c1',
			output: { ok: true },
			preliminary: true
		});
		const tp = toolPart(parts, 'c1');
		expect(tp.state).toBe('output-available');
		expect(tp.output).toEqual({ ok: true });
		expect(tp.preliminary).toBe(true);
	});

	it('tool-output-error sets errorText and output-error state', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, { type: 'tool-output-error', toolCallId: 'c1', errorText: 'failed' });
		const tp = toolPart(parts, 'c1');
		expect(tp.state).toBe('output-error');
		expect(tp.errorText).toBe('failed');
	});

	it('the first terminal output wins when a replay changes success into an error', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } });
		applyChunkToParts(parts, { type: 'tool-output-error', toolCallId: 'c1', errorText: 'late failure' });
		expect(toolPart(parts, 'c1')).toMatchObject({ state: 'output-available', output: { ok: true } });
	});

	it('the first terminal output wins when a replay changes an error into success', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, { type: 'tool-output-error', toolCallId: 'c1', errorText: 'first failure' });
		applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } });
		expect(toolPart(parts, 'c1')).toMatchObject({ state: 'output-error', errorText: 'first failure' });
	});

	it('a preliminary output can be replaced by the final output', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, {
			type: 'tool-output-available',
			toolCallId: 'c1',
			output: { phase: 'working' },
			preliminary: true
		});
		applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } });
		expect(toolPart(parts, 'c1')).toMatchObject({ state: 'output-available', output: { ok: true } });
		expect(toolPart(parts, 'c1').preliminary).toBeUndefined();
	});

	it('a preliminary output can be replaced by a final error', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, {
			type: 'tool-output-available',
			toolCallId: 'c1',
			output: { phase: 'working' },
			preliminary: true
		});
		applyChunkToParts(parts, { type: 'tool-output-error', toolCallId: 'c1', errorText: 'final failure' });
		expect(toolPart(parts, 'c1')).toMatchObject({ state: 'output-error', errorText: 'final failure' });
	});

	it('a preliminary output can be replaced by an explicit denial', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, {
			type: 'tool-output-available',
			toolCallId: 'c1',
			output: { phase: 'working' },
			preliminary: true
		});
		applyChunkToParts(parts, { type: 'tool-output-denied', toolCallId: 'c1' });
		expect(toolPart(parts, 'c1').state).toBe('output-denied');
	});

	it('tool-output-denied sets output-denied state', () => {
		const parts = seededToolPart();
		applyChunkToParts(parts, { type: 'tool-output-denied', toolCallId: 'c1' });
		expect(toolPart(parts, 'c1').state).toBe('output-denied');
	});

	it('output chunks for an unknown call id are handled no-ops', () => {
		const parts: UIMessagePart[] = [];
		expect(applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'x', output: 1 })).toBe(true);
		expect(applyChunkToParts(parts, { type: 'tool-output-error', toolCallId: 'x', errorText: 'e' })).toBe(true);
		expect(applyChunkToParts(parts, { type: 'tool-output-denied', toolCallId: 'x' })).toBe(true);
		expect(parts).toEqual([]);
	});
});

describe('applyChunkToParts — step markers, data parts, unknown chunks', () => {
	it('parses the AI SDK v6 finish-step and file wire chunks', () => {
		expect(parseUIStreamChunk('{"type":"finish-step"}')).toEqual({ type: 'finish-step' });
		expect(parseUIStreamChunk('{"type":"file","mediaType":"text/plain","url":"data:text/plain,ok"}')).toEqual({
			type: 'file',
			mediaType: 'text/plain',
			url: 'data:text/plain,ok'
		});
	});

	it('start-step and step-start both push a step-start part', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'start-step' });
		applyChunkToParts(parts, { type: 'step-start' });
		expect(parts).toEqual([{ type: 'step-start' }, { type: 'step-start' }]);
	});

	it('finish-step and abort are recognized without changing message parts', () => {
		const parts: UIMessagePart[] = [{ type: 'text', text: 'partial' }];
		expect(applyChunkToParts(parts, { type: 'finish-step' })).toBe(true);
		expect(applyChunkToParts(parts, { type: 'abort', reason: 'cancelled' })).toBe(true);
		expect(parts).toEqual([{ type: 'text', text: 'partial' }]);
	});

	it('source and file chunks are retained as message parts', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'source-url', sourceId: 's1', url: 'https://example.test' });
		applyChunkToParts(parts, { type: 'source-url', sourceId: 's1', url: 'https://example.test' });
		applyChunkToParts(parts, {
			type: 'source-document',
			sourceId: 's2',
			mediaType: 'text/plain',
			title: 'Notes',
			filename: 'notes.txt'
		});
		applyChunkToParts(parts, { type: 'file', mediaType: 'text/plain', url: 'data:text/plain,hello' });
		applyChunkToParts(parts, { type: 'file', mediaType: 'text/plain', url: 'data:text/plain,hello' });
		expect(parts).toEqual([
			{ type: 'source-url', sourceId: 's1', url: 'https://example.test' },
			{ type: 'source-document', sourceId: 's2', mediaType: 'text/plain', title: 'Notes', filename: 'notes.txt' },
			{ type: 'file', mediaType: 'text/plain', url: 'data:text/plain,hello' }
		]);
	});

	it('accepts official metadata values and tool provider fields at the stream boundary', () => {
		expect(parseUIStreamChunk('{"type":"start","messageMetadata":null}')).toEqual({
			type: 'start',
			messageMetadata: null
		});
		expect(
			parseUIStreamChunk(
				JSON.stringify({
					type: 'tool-input-start',
					toolCallId: 'c1',
					toolName: 'codemode',
					providerExecuted: true,
					providerMetadata: { gateway: { trace: 't1' } },
					toolMetadata: { label: 'Code' },
					dynamic: true
				})
			)
		).toMatchObject({
			type: 'tool-input-start',
			providerExecuted: true,
			providerMetadata: { gateway: { trace: 't1' } },
			toolMetadata: { label: 'Code' },
			dynamic: true
		});
	});

	it('transient data chunks do not enter message parts', () => {
		const parts: UIMessagePart[] = [];
		expect(applyChunkToParts(parts, { type: 'data-progress', data: { phase: 'working' }, transient: true })).toBe(true);
		expect(parts).toEqual([]);
	});

	it('replays an official tool input stream into a settled successful tool part', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'tool-input-start', toolCallId: 'c1', toolName: 'codemode' });
		applyChunkToParts(parts, { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"code":"return {}"}' });
		applyChunkToParts(parts, {
			type: 'tool-input-available',
			toolCallId: 'c1',
			toolName: 'codemode',
			input: { code: 'return {}' }
		});
		applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } });
		applyChunkToParts(parts, { type: 'finish-step' });

		expect(toolPart(parts, 'c1')).toMatchObject({
			state: 'output-available',
			input: { code: 'return {}' },
			output: { ok: true }
		});
	});

	it('data-* chunk without id is appended', () => {
		const parts: UIMessagePart[] = [];
		const chunk: UIDataPart = { type: 'data-status', data: { phase: 'a' } };
		applyChunkToParts(parts, chunk);
		expect(parts).toEqual([{ type: 'data-status', data: { phase: 'a' } }]);
	});

	it('data-* chunk with id updates the existing part of the same type+id in place', () => {
		const parts: UIMessagePart[] = [];
		const firstChunk: UIDataPart = { type: 'data-status', id: 's1', data: { phase: 'a' } };
		const secondChunk: UIDataPart = { type: 'data-status', id: 's1', data: { phase: 'b' } };
		applyChunkToParts(parts, firstChunk);
		applyChunkToParts(parts, secondChunk);
		expect(parts).toEqual([{ type: 'data-status', id: 's1', data: { phase: 'b' } }]);
	});

	it('data-* chunks with distinct ids create separate parts', () => {
		const parts: UIMessagePart[] = [];
		const firstChunk: UIDataPart = { type: 'data-status', id: 's1', data: 1 };
		const secondChunk: UIDataPart = { type: 'data-status', id: 's2', data: 2 };
		applyChunkToParts(parts, firstChunk);
		applyChunkToParts(parts, secondChunk);
		expect(parts).toHaveLength(2);
	});

	it('unknown chunk types return false and do not mutate parts', () => {
		const parts: UIMessagePart[] = [{ type: 'text', text: 'x' }];
		const metadataChunk: UIStreamChunk = { type: 'message-metadata', messageMetadata: {} };
		const errorChunk: UIStreamChunk = { type: 'error', errorText: 'e' };
		const startChunk: UIStreamChunk = { type: 'start' };
		const finishChunk: UIStreamChunk = { type: 'finish' };
		expect(applyChunkToParts(parts, metadataChunk)).toBe(false);
		expect(applyChunkToParts(parts, errorChunk)).toBe(false);
		expect(applyChunkToParts(parts, startChunk)).toBe(false);
		expect(applyChunkToParts(parts, finishChunk)).toBe(false);
		expect(parts).toEqual([{ type: 'text', text: 'x' }]);
	});
});

describe('applyChunkToParts — a full assistant turn', () => {
	it('replays message_start → text deltas → tool input → tool output → finish into ordered parts', () => {
		const parts: UIMessagePart[] = [];

		// 'start' is an unknown-to-the-machine chunk (handled by the socket layer),
		// so it should be a no-op here.
		const startChunk: UIStreamChunk = { type: 'start', messageId: 'm1' };
		expect(applyChunkToParts(parts, startChunk)).toBe(false);

		applyChunkToParts(parts, { type: 'text-start', id: 't1' });
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: "I'll " });
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: 'edit the file.' });
		applyChunkToParts(parts, { type: 'text-end', id: 't1' });

		applyChunkToParts(parts, { type: 'tool-input-start', toolCallId: 'c1', toolName: 'write_file', title: 'Write' });
		applyChunkToParts(parts, {
			type: 'tool-input-available',
			toolCallId: 'c1',
			toolName: 'write_file',
			input: { path: 'index.html', content: '<h1>Hi</h1>' }
		});
		applyChunkToParts(parts, { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } });

		const finishChunk: UIStreamChunk = { type: 'finish' };
		expect(applyChunkToParts(parts, finishChunk)).toBe(false);

		expect(parts).toHaveLength(2);
		expect(parts[0]).toEqual({ type: 'text', text: "I'll edit the file.", state: 'done' });
		const tp = toolPart(parts, 'c1');
		expect(tp.type).toBe('tool-write_file');
		expect(tp.state).toBe('output-available');
		expect(tp.output).toEqual({ ok: true });
		expect(tp.input).toEqual({ path: 'index.html', content: '<h1>Hi</h1>' });
	});

	it('keeps text and a second text part separate when a tool interrupts them', () => {
		const parts: UIMessagePart[] = [];
		applyChunkToParts(parts, { type: 'text-start', id: 't1' });
		applyChunkToParts(parts, { type: 'text-delta', id: 't1', delta: 'before' });
		applyChunkToParts(parts, { type: 'tool-input-start', toolCallId: 'c1', toolName: 'codemode' });
		applyChunkToParts(parts, { type: 'text-start', id: 't2' });
		applyChunkToParts(parts, { type: 'text-delta', id: 't2', delta: 'after' });

		const texts = parts.filter((p): p is UITextPart => p.type === 'text');
		expect(texts.map((t) => t.text)).toEqual(['before', 'after']);
		// The delta after the tool must land on the second text part, not the first.
		expect(texts[1].text).toBe('after');
	});
});

describe('cloneParts', () => {
	it('produces a deep, independent copy', () => {
		const parts: UIMessagePart[] = [
			{ type: 'text', text: 'hi', state: 'done' },
			{
				type: 'tool-codemode',
				toolCallId: 'c1',
				toolName: 'codemode',
				state: 'output-available',
				input: { nested: { a: 1 } },
				output: { rows: [1, 2] }
			}
		];
		const copy = cloneParts(parts);
		expect(copy).toEqual(parts);
		expect(copy).not.toBe(parts);
		expect(copy[0]).not.toBe(parts[0]);

		// Mutating the clone must not touch the original.
		toolPart(copy, 'c1').input = { nested: { a: 999 } };
		textPart(copy).text = 'changed';
		expect(toolPart(parts, 'c1').input).toEqual({ nested: { a: 1 } });
		expect(textPart(parts).text).toBe('hi');
	});

	it('returns a new empty array for empty input', () => {
		const parts: UIMessagePart[] = [];
		const copy = cloneParts(parts);
		expect(copy).toEqual([]);
		expect(copy).not.toBe(parts);
	});
});

describe('mergeUpdatedMessage', () => {
	function baseMessages(): UIChatMessage[] {
		return [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
			{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] }
		];
	}

	it('replaces an existing message matched by id, preserving the original id', () => {
		const messages = baseMessages();
		const updated: UIChatMessage = {
			id: 'a1',
			role: 'assistant',
			parts: [{ type: 'text', text: 'complete answer' }]
		};
		const next = mergeUpdatedMessage(messages, updated);
		expect(next).toHaveLength(2);
		expect(next[1].parts).toEqual([{ type: 'text', text: 'complete answer' }]);
		expect(next[1].id).toBe('a1');
		// New array, original untouched.
		expect(next).not.toBe(messages);
		expect(messages[1].parts).toEqual([{ type: 'text', text: 'partial' }]);
	});

	it('matches by shared tool call id when the message id differs, keeping the original id', () => {
		const messages: UIChatMessage[] = [
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{ type: 'tool-codemode', toolCallId: 'call-42', toolName: 'codemode', state: 'input-available' }
				]
			}
		];
		const updated: UIChatMessage = {
			id: 'server-generated-id',
			role: 'assistant',
			parts: [
				{ type: 'tool-codemode', toolCallId: 'call-42', toolName: 'codemode', state: 'output-available', output: { ok: true } }
			]
		};
		const next = mergeUpdatedMessage(messages, updated);
		expect(next[0].id).toBe('a1');
		expect(toolPart(next[0].parts, 'call-42').state).toBe('output-available');
	});

	it('returns the same messages array (append is not performed) when no match is found', () => {
		const messages = baseMessages();
		const updated: UIChatMessage = {
			id: 'does-not-exist',
			role: 'assistant',
			parts: [{ type: 'text', text: 'orphan' }]
		};
		const next = mergeUpdatedMessage(messages, updated);
		expect(next).toBe(messages);
	});

	it('preserves ordering of the surrounding messages', () => {
		const messages: UIChatMessage[] = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q1' }] },
			{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a1' }] },
			{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'q2' }] },
			{ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'a2-partial' }] }
		];
		const updated: UIChatMessage = {
			id: 'a2',
			role: 'assistant',
			parts: [{ type: 'text', text: 'a2-final' }]
		};
		const next = mergeUpdatedMessage(messages, updated);
		expect(next.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(next[3].parts).toEqual([{ type: 'text', text: 'a2-final' }]);
	});
});
