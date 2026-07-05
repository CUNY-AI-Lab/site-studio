import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, tick } from 'svelte';
import { render, screen, waitFor } from '@testing-library/svelte';
import AgentChat from './AgentChat.svelte';
import { AgentMessageType, type UIChatMessage } from '$lib/agents/chat';
import { invalidateCsrfToken } from '$lib/api/csrf';

/**
 * A scriptable fake WebSocket. The component calls `new WebSocket(url)` directly
 * against the global, so we stub the global with this class. Each instance
 * registers itself so a test can grab the live socket and push server messages.
 */
class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];
	static last(): FakeWebSocket {
		return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	}

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	private listeners: Record<string, Set<(ev: any) => void>> = {};

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, cb: (ev: any) => void) {
		(this.listeners[type] ??= new Set()).add(cb);
	}
	removeEventListener(type: string, cb: (ev: any) => void) {
		this.listeners[type]?.delete(cb);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = FakeWebSocket.CLOSED;
	}

	private emit(type: string, ev: any) {
		this.listeners[type]?.forEach((cb) => cb(ev));
	}

	// --- test controls ---
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.emit('open', new Event('open'));
	}
	serverMessage(payload: unknown) {
		this.emit('message', { data: JSON.stringify(payload) } as MessageEvent);
	}
	serverClose() {
		this.readyState = FakeWebSocket.CLOSED;
		this.emit('close', new CloseEvent('close'));
	}
}

async function settle() {
	flushSync();
	await tick();
	flushSync();
}

let fetchMock: ReturnType<typeof vi.fn>;

describe('AgentChat', () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		// The csrf client caches its token in module state; clear it so each test
		// re-fetches against the fresh fetch stub.
		invalidateCsrfToken();
		vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
		// The component fetches a CSRF token before connecting, and loadChatHistory
		// hits GET /get-messages. Serve a token for /api/csrf, empty history otherwise.
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/api/csrf')) {
				return new Response(JSON.stringify({ token: 'test-csrf-token' }), { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		invalidateCsrfToken();
		vi.unstubAllGlobals();
	});

	function mount(props: Record<string, unknown> = {}) {
		const onUpdate = vi.fn();
		render(AgentChat, { props: { projectId: 'proj1', onUpdate, ...props } });
		return { onUpdate };
	}

	it('opens a WebSocket to the site-builder path with the csrf token param', async () => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const url = FakeWebSocket.last().url;
		expect(url).toContain('/api/agents/site-builder/proj1');
		// The token is appended as a query param (parsed via URLSearchParams).
		expect(new URL(url).searchParams.get('csrf')).toBe('test-csrf-token');
	});

	it('populates history from an incoming CF_AGENT_CHAT_MESSAGES message', async () => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		const history: UIChatMessage[] = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Make me a homepage' }] },
			{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Sure, here you go.' }] }
		];
		ws.serverMessage({ type: AgentMessageType.CF_AGENT_CHAT_MESSAGES, messages: history });
		await settle();

		expect(screen.getByText('Make me a homepage')).toBeInTheDocument();
		expect(screen.getByText('Sure, here you go.')).toBeInTheDocument();
	});

	it('renders streamed assistant text progressively across CF_AGENT_USE_CHAT_RESPONSE chunks', async () => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		const streamId = 'stream-1';
		function chunk(body: unknown, done = false) {
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: streamId,
				body: JSON.stringify(body),
				done
			});
		}

		chunk({ type: 'text-start', id: 't1' });
		chunk({ type: 'text-delta', id: 't1', delta: 'Hello' });
		await settle();
		expect(screen.getByText('Hello')).toBeInTheDocument();

		chunk({ type: 'text-delta', id: 't1', delta: ', world' });
		await settle();
		expect(screen.getByText('Hello, world')).toBeInTheDocument();

		chunk({ type: 'text-end', id: 't1' }, true);
		await settle();
		expect(screen.getByText('Hello, world')).toBeInTheDocument();
	});

	it('sendPrompt() no-ops while a request is already in flight', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		// First prompt starts a request (isLoading becomes true, socket.send called).
		await component.sendPrompt('first');
		await settle();
		const sentAfterFirst = ws.sent.length;
		expect(sentAfterFirst).toBeGreaterThan(0);

		// A second prompt while loading must be ignored — no additional send.
		await component.sendPrompt('second');
		await settle();
		expect(ws.sent.length).toBe(sentAfterFirst);
	});

	it('schedules a reconnect with backoff after an unexpected socket close', async () => {
		// Let the initial connection happen under real timers (it awaits the
		// history fetch, a real promise), then switch to fake timers to drive the
		// reconnect backoff deterministically.
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const ws = FakeWebSocket.instances[0];
		ws.open();
		await settle();

		vi.useFakeTimers();
		try {
			// Unexpected close schedules a reconnect; no new socket yet.
			ws.serverClose();
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(1);

			// First backoff is 1000ms.
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

// Helper to render AgentChat and get a handle on the component instance so we
// can call its exported `sendPrompt`. @testing-library/svelte's render returns
// `component` for this purpose.
function renderExposed(props: Record<string, unknown> = {}) {
	const onUpdate = vi.fn();
	const result = render(AgentChat, { props: { projectId: 'proj1', onUpdate, ...props } });
	return { ...result, onUpdate };
}
