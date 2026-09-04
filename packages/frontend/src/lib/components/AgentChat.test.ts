import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, tick } from 'svelte';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { UIMessageChunk } from 'ai';
import AgentChat from './AgentChat.svelte';
import {
	AgentMessageType,
	type UIChatMessage
} from '$lib/agents/chat';
import { invalidateCsrfToken } from '$lib/api/csrf';
import type { JsonValue } from '$lib/contracts';
import { toasts } from '$lib/toast.svelte';

interface AgentChatTestProps {
	projectId?: string;
	onUpdate?: () => void;
	onBeforeSend?: () => Promise<boolean> | boolean;
}

interface FakeSocketMessage {
	type: string;
	id?: string;
	requestId?: string;
	probeId?: string;
	messages?: UIChatMessage[];
	body?: string;
	done?: boolean;
	error?: boolean;
}

declare global {
	interface Location {
		[symbol: symbol]: { assign: (url: string) => void } | undefined;
	}
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.toString();
	return input;
}

function uploadResponseForTest(path: string, filename: string, size: number): Response {
	return new Response(
		JSON.stringify({
			success: true,
			filename,
			path,
			size,
			message: `Uploaded ${filename}`
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

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
	private listeners: Record<string, Set<(event: Event) => void>> = {};

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, cb: (event: Event) => void) {
		(this.listeners[type] ??= new Set()).add(cb);
	}
	removeEventListener(type: string, cb: (event: Event) => void) {
		this.listeners[type]?.delete(cb);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = FakeWebSocket.CLOSED;
	}

	private emit(type: string, event: Event) {
		// Real WebSocket events carry `currentTarget`; the component relies on it to
		// distinguish the current socket from an orphaned/superseded one (SS-12).
		Object.defineProperty(event, 'currentTarget', { value: this, configurable: true });
		Object.defineProperty(event, 'target', { value: this, configurable: true });
		this.listeners[type]?.forEach((cb) => cb(event));
	}

	// --- test controls ---
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.emit('open', new Event('open'));
	}
	serverMessage(payload: FakeSocketMessage) {
		this.emit('message', new MessageEvent('message', { data: JSON.stringify(payload) }));
	}
	/** Push a raw (possibly non-JSON) frame, bypassing serialization. */
	serverRawMessage(data: string) {
		this.emit('message', new MessageEvent('message', { data }));
	}
	serverClose() {
		this.readyState = FakeWebSocket.CLOSED;
		this.emit('close', new CloseEvent('close'));
	}
	// Fire an `error` event (e.g. a failed handshake) without closing, mirroring a
	// real socket that errors before OPEN.
	serverError() {
		this.emit('error', new Event('error'));
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
		// The csrf client caches its token in module state and reads it from the
		// delivery cookie; clear both so each test re-derives against the stub.
		invalidateCsrfToken();
		document.cookie = 'cail_csrf_sitestudio=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
		vi.stubGlobal('WebSocket', FakeWebSocket);
		// The component fetches a CSRF token before connecting, and loadChatHistory
		// hits GET /get-messages. The token is delivered via Set-Cookie (rule 3),
		// so the /api/csrf stub sets document.cookie; empty history otherwise.
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		toasts.splice(0);
		invalidateCsrfToken();
		document.cookie = 'cail_csrf_sitestudio=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
		vi.unstubAllGlobals();
	});

	function mount(props: AgentChatTestProps = {}) {
		const onUpdate = vi.fn();
		const result = render(AgentChat, { props: { projectId: 'proj1', onUpdate, ...props } });
		return { ...result, onUpdate };
	}

	it('opens a WebSocket to the site-builder path with the csrf token param', async () => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const url = FakeWebSocket.last().url;
		expect(url).toContain('/api/agents/site-builder/proj1');
		// The token is appended as a query param (parsed via URLSearchParams).
		expect(new URL(url).searchParams.get('csrf')).toBe('test-csrf-token');
	});

	it('ignores a stale history response after switching projects', async () => {
		let resolveProjectAHistory!: (response: Response) => void;
		const projectAHistory = new Promise<Response>((resolve) => {
			resolveProjectAHistory = resolve;
		});
		let projectAHistoryRequested = false;
		const onUpdate = vi.fn();

		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.includes('/proj-a/get-messages')) {
				projectAHistoryRequested = true;
				return projectAHistory;
			}
			if (url.includes('/proj-b/get-messages')) {
				return new Response(
					JSON.stringify([
						{ id: 'b1', role: 'assistant', parts: [{ type: 'text', text: 'Project B history' }] }
					]),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});

		const result = render(AgentChat, { props: { projectId: 'proj-a', onUpdate } });
		await waitFor(() => expect(projectAHistoryRequested).toBe(true));

		await result.rerender({ projectId: 'proj-b', onUpdate });
		await waitFor(() => expect(screen.getByText('Project B history')).toBeInTheDocument());

		resolveProjectAHistory(
			new Response(
				JSON.stringify([
					{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Stale project A history' }] }
				]),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		await settle();

		expect(screen.queryByText('Stale project A history')).not.toBeInTheDocument();
		expect(screen.getByText('Project B history')).toBeInTheDocument();
	});

	it('never reuses an in-flight socket connection for a different project', async () => {
		let resolveCsrf!: (response: Response) => void;
		const csrfResponse = new Promise<Response>((resolve) => {
			resolveCsrf = resolve;
		});
		let csrfRequested = false;
		const onUpdate = vi.fn();

		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				csrfRequested = true;
				return csrfResponse;
			}
			return new Response('[]', { status: 200 });
		});

		const result = render(AgentChat, { props: { projectId: 'proj-a', onUpdate } });
		await waitFor(() => expect(csrfRequested).toBe(true));

		await result.rerender({ projectId: 'proj-b', onUpdate });
		document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
		resolveCsrf(new Response(null, { status: 204 }));

		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const socket = FakeWebSocket.instances[0];
		expect(socket.url).toContain('/api/agents/site-builder/proj-b');
		expect(socket.url).not.toContain('/api/agents/site-builder/proj-a');

		socket.open();
		await settle();
		await result.component.sendPrompt('Update project B');
		await settle();

		const request = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
	});

	it('drops a malformed (non-JSON) socket frame with a console.warn, not silently', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			mount();
			await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
			const socket = FakeWebSocket.last();
			socket.open();
			await settle();

			socket.serverRawMessage('not-json{{{');
			await settle();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('malformed (non-JSON) agent-socket frame')
			);

			// The frame is still dropped: a subsequent valid frame is processed normally.
			socket.serverMessage({
				type: AgentMessageType.CF_AGENT_CHAT_MESSAGES,
				messages: [
					{
						id: 'm1',
						role: 'assistant',
						parts: [{ type: 'text', text: 'hello after malformed frame' }]
					}
				]
			});
			await settle();
			expect(screen.getByText('hello after malformed frame')).toBeTruthy();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it.each([
		['an object', '{}'],
		['null', 'null'],
		['a malformed message', JSON.stringify([{ id: 'm1', role: 'assistant', parts: null }])]
	])('fails closed when history is %s', async (_label, body) => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) return new Response(body, { status: 200 });
			return new Response('[]', { status: 200 });
		});

		mount();
		await waitFor(() => expect(screen.getByText('Your chat history could not be loaded.')).toBeInTheDocument());
		expect(screen.queryByText('Project history')).not.toBeInTheDocument();
	});

	it('drops a JSON socket frame with malformed message data', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			mount();
			await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
			const socket = FakeWebSocket.last();
			socket.open();
			socket.serverRawMessage(JSON.stringify({ type: AgentMessageType.CF_AGENT_CHAT_MESSAGES, messages: {} }));
			await settle();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('malformed (non-JSON) agent-socket frame')
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('routes authentication_required history responses through the login redirect path', async () => {
		const locationImplSymbol = Object.getOwnPropertySymbols(window.location).find(
			(symbol) => symbol.description === 'impl'
		);
		if (!locationImplSymbol) throw new Error('JSDOM location implementation symbol is unavailable');
		const locationImpl = window.location[locationImplSymbol];
		if (!locationImpl) throw new Error('JSDOM location implementation is unavailable');
		const assignSpy = vi.spyOn(locationImpl, 'assign').mockImplementation(() => {});
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				return new Response(
					JSON.stringify({
						error: {
							code: 'authentication_required',
							message: 'Please sign in to continue.',
							launch: '/launch/site-studio'
						}
					}),
					{ status: 401, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});

		mount();

		await waitFor(() =>
				expect(assignSpy).toHaveBeenCalledWith('https://tools.ailab.gc.cuny.edu/launch/site-studio')
		);
	});

	// SS-49: a failed history load must be distinguishable from an empty
	// conversation. The old behavior set uiMessages = [] on any non-ok/catch,
	// rendering a wiped transcript for a transient error.
	it('surfaces a retryable error when history loading fails, not an empty transcript (SS-49)', async () => {
		let historyRequests = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyRequests += 1;
				if (historyRequests === 1) {
					return new Response('oops', { status: 500 });
				}
				return new Response(
					JSON.stringify([
						{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Recovered message' }] }
					]),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});

		mount();

		// The failure is surfaced as an error state with a retry affordance...
		await waitFor(() =>
			expect(screen.getByText(/chat history could not be loaded/i)).toBeInTheDocument()
		);
		// ...and NOT presented as a fresh, empty conversation.
		expect(screen.queryByText('Your site')).not.toBeInTheDocument();

		// Retrying recovers the real history and clears the error state.
		screen.getByRole('button', { name: /retry loading history/i }).click();
		await waitFor(() => expect(screen.getByText('Recovered message')).toBeInTheDocument());
		expect(screen.queryByText(/chat history could not be loaded/i)).not.toBeInTheDocument();
	});

	it('shows the welcome empty state (no error) for genuinely empty history (SS-49)', async () => {
		mount(); // default fetch stub returns [] for /get-messages
		await waitFor(() => expect(screen.getByText('Your site')).toBeInTheDocument());
		expect(screen.queryByText(/chat history could not be loaded/i)).not.toBeInTheDocument();
	});

	it('does not probe the optional quota endpoint', async () => {
		mount();
		await waitFor(() => expect(screen.getByText('Your site')).toBeInTheDocument());
		expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/quota'))).toBe(false);
	});

	it('a network failure loading history also surfaces the error state (SS-49)', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				throw new TypeError('Failed to fetch');
			}
			return new Response('[]', { status: 200 });
		});

		mount();
		await waitFor(() =>
			expect(screen.getByText(/chat history could not be loaded/i)).toBeInTheDocument()
		);
		expect(screen.queryByText('Your site')).not.toBeInTheDocument();
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

	it('renders the complete persisted history without truncating older messages', async () => {
		const historyTexts = Array.from({ length: 12 }, (_, index) => `History message ${index + 1}`);
		const history: UIChatMessage[] = historyTexts.map((text, index) => ({
			id: `history-${index + 1}`,
			role: 'user',
			parts: [{ type: 'text', text }]
		}));
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				return new Response(JSON.stringify(history), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response('[]', { status: 200 });
		});

		mount();
		await waitFor(() => expect(screen.getByText('History message 12')).toBeInTheDocument());
		for (const text of historyTexts) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
	});

	it('renders streamed assistant text progressively across CF_AGENT_USE_CHAT_RESPONSE chunks', async () => {
		const { component } = mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('stream a greeting');
		await settle();

		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const streamId = request.id;
		function chunk(body: JsonValue, done = false) {
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
		await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

		chunk({ type: 'text-delta', id: 't1', delta: ', world' });
		await settle();
		await waitFor(() => expect(screen.getByText('Hello, world')).toBeInTheDocument());

		chunk({ type: 'text-end', id: 't1' }, true);
		await settle();
		expect(screen.getByText('Hello, world')).toBeInTheDocument();
	});

	it('settles a successful terminal frame without waiting for a custom commit', async () => {
		let historyGets = 0;
		let authoritativeHistory: UIChatMessage[] = [];
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyGets += 1;
				return new Response(JSON.stringify(authoritativeHistory), { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('finish this turn');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const requestBody = JSON.parse(request.init.body);
		const userMessageId = requestBody.messages.at(-1).id;
		authoritativeHistory = [
			{ id: userMessageId, role: 'user', parts: [{ type: 'text', text: 'finish this turn' }] },
			{ id: 'persisted-assistant', role: 'assistant', parts: [{ type: 'text', text: 'persisted answer' }] }
		];

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-start', id: 'text-1' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'text-1', delta: 'stream answer' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-end', id: 'text-1' }),
			done: true
		});

		await waitFor(() => expect(screen.getByText('stream answer')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		await waitFor(() => expect(historyGets).toBeGreaterThanOrEqual(2));
		await waitFor(() => expect(screen.getByText('persisted answer')).toBeInTheDocument());
	});

	it('accepts a matching custom commit after the terminal frame settled the UI', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('repair the saved turn');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const requestBody = JSON.parse(request.init.body);
		const userMessageId = requestBody.messages.at(-1).id;

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-start', id: 'text-2' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'text-2', delta: 'partial answer' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-end', id: 'text-2' }),
			done: true
		});
		await waitFor(() => expect(screen.getByText('partial answer')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());

		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId: request.id,
			messages: [
				{ id: userMessageId, role: 'user', parts: [{ type: 'text', text: 'repair the saved turn' }] },
				{ id: 'persisted-after-late-commit', role: 'assistant', parts: [{ type: 'text', text: 'saved answer' }] }
			]
		});
		await waitFor(() => expect(screen.getByText('saved answer')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('repairs an unrelated commit through authenticated history without replacing the active turn', async () => {
		let historyGets = 0;
		let authoritativeHistory: UIChatMessage[] = [];
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyGets += 1;
				return new Response(JSON.stringify(authoritativeHistory), { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('keep this turn visible');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const userMessageId = JSON.parse(request.init.body).messages.at(-1).id;
		authoritativeHistory = [
			{ id: userMessageId, role: 'user', parts: [{ type: 'text', text: 'keep this turn visible' }] },
			{ id: 'current-persisted-assistant', role: 'assistant', parts: [{ type: 'text', text: 'current persisted answer' }] }
		];

		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId: 'other-tab-request',
			messages: [
				{ id: 'other-tab-user', role: 'user', parts: [{ type: 'text', text: 'other tab turn' }] },
				{ id: 'other-tab-assistant', role: 'assistant', parts: [{ type: 'text', text: 'other tab answer' }] }
			]
		});
		await settle();
		expect(screen.queryByText('other tab answer')).not.toBeInTheDocument();
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-start', id: 'current-text' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'current-text', delta: 'current answer' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-end', id: 'current-text' }),
			done: true
		});

		await waitFor(() => expect(screen.getByText('current persisted answer')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		await waitFor(() => expect(historyGets).toBeGreaterThanOrEqual(3));
		expect(screen.queryByText('other tab answer')).not.toBeInTheDocument();
	});

	it.each(['success', 'failure', 'network failure'])('ignores an ordinary history %s after a new turn starts', async (outcome) => {
		const user = userEvent.setup({ delay: null });
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		let release!: (response: Response) => void;
		let reject!: (error: Error) => void;
		const heldHistory = new Promise<Response>((resolve, fail) => {
			release = resolve;
			reject = fail;
		});
		fetchMock.mockReturnValueOnce(heldHistory);
		ws.serverMessage({ type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED });
		await settle();
		await user.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'new ordinary turn');
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(screen.getByText('new ordinary turn')).toBeInTheDocument());
		if (outcome === 'network failure') reject(new Error('old network failure'));
		else release(new Response('[]', { status: outcome === 'success' ? 200 : 500 }));
		await settle();
		expect(screen.getByText('new ordinary turn')).toBeInTheDocument();
		expect(screen.queryByText(/chat history could not be loaded/i)).not.toBeInTheDocument();
	});

	it('keeps the visible prompt when initial socket history arrives during connection preparation', async () => {
		const user = userEvent.setup({ delay: null });
		let release!: (response: Response) => void;
		const initialHistory = new Promise<Response>((resolve) => { release = resolve; });
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			if (requestUrl(input).endsWith('/get-messages')) return initialHistory;
			document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
			return new Response(null, { status: 204 });
		});
		mount();
		await user.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'send before history loads');
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const ws = FakeWebSocket.last();
		ws.open();
		ws.serverMessage({ type: AgentMessageType.CF_AGENT_CHAT_MESSAGES, messages: [] });
		await settle();
		expect(screen.getByText('send before history loads')).toBeInTheDocument();
		await waitFor(() => {
			const request = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
			expect(request).toBeDefined();
			expect(JSON.parse(request.init.body).messages.at(-1).parts).toEqual([{ type: 'text', text: 'send before history loads' }]);
		});
		release(new Response('[]'));
		await settle();
		expect(screen.getByText('send before history loads')).toBeInTheDocument();
	});

	it.each(['read', 'broadcast'])('keeps newer history from a %s when an older read completes', async (source) => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		let release!: (response: Response) => void;
		fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
		ws.serverMessage({ type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED });
		await settle();
		const messages: UIChatMessage[] = [
			{ id: 'new-history', role: 'assistant', parts: [{ type: 'text', text: 'newer history' }] }
		];
		if (source === 'read') {
			fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(messages)));
			ws.serverMessage({ type: AgentMessageType.SITE_STUDIO_CHAT_INVALIDATED });
		} else {
			ws.serverMessage({ type: AgentMessageType.CF_AGENT_CHAT_MESSAGES, messages });
		}
		await waitFor(() => expect(screen.getByText('newer history')).toBeInTheDocument());
		release(new Response('[]'));
		await settle();
		expect(screen.getByText('newer history')).toBeInTheDocument();
	});

	it('does not let a delayed completed-turn history read erase a newer request', async () => {
		let historyGets = 0;
		let oldHistoryRequested = false;
		let resolveOldHistory!: (response: Response) => void;
		const oldHistory = new Promise<Response>((resolve) => {
			resolveOldHistory = resolve;
		});
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyGets += 1;
				if (historyGets === 2) {
					oldHistoryRequested = true;
					return oldHistory;
				}
				return new Response('[]', { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('finish before the next turn');
		await settle();
		const firstRequest = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(firstRequest).toBeTruthy();
		const firstBody = JSON.parse(firstRequest.init.body);
		const firstUserMessageId = firstBody.messages.at(-1).id;
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: firstRequest.id,
			body: JSON.stringify({ type: 'text-start', id: 'first-text' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: firstRequest.id,
			body: JSON.stringify({ type: 'text-delta', id: 'first-text', delta: 'first answer' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: firstRequest.id,
			body: JSON.stringify({ type: 'text-end', id: 'first-text' }),
			done: true
		});
		await waitFor(() => expect(oldHistoryRequested).toBe(true));

		// The user can start another turn as soon as the terminal frame settles the
		// visible stream. Admit it before the old reconciliation response resolves.
		await component.sendPrompt('new turn stays visible');
		await waitFor(() => expect(screen.getByText('new turn stays visible')).toBeInTheDocument());
		resolveOldHistory(
			new Response(
				JSON.stringify([
					{ id: firstUserMessageId, role: 'user', parts: [{ type: 'text', text: 'finish before the next turn' }] },
					{ id: 'first-assistant', role: 'assistant', parts: [{ type: 'text', text: 'stale historical overwrite' }] }
				]),
				{ status: 200 }
			)
		);
		await settle();

		expect(screen.getByText('new turn stays visible')).toBeInTheDocument();
		expect(screen.queryByText('stale historical overwrite')).not.toBeInTheDocument();
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();
	});

	it('does not let a delayed completed-turn read erase a client-tool continuation', async () => {
		let historyGets = 0;
		let oldHistoryRequested = false;
		let resolveOldHistory!: (response: Response) => void;
		const oldHistory = new Promise<Response>((resolve) => {
			resolveOldHistory = resolve;
		});
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyGets += 1;
				if (historyGets === 2) {
					oldHistoryRequested = true;
					return oldHistory;
				}
				return new Response('[]', { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('answer the project question');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: 'question-1',
				toolName: 'ask_user_question',
				input: { question: 'Continue?', options: ['Yes'] }
			})
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'finish-step' }),
			done: true
		});
		await waitFor(() => expect(oldHistoryRequested).toBe(true));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());

		// Skip is a client-tool continuation of the same assistant turn. It must
		// invalidate the old reconciliation before its delayed response resolves.
		screen.getByRole('button', { name: 'Skip' }).click();
		await waitFor(() =>
			expect(
				ws.sent
					.map((raw) => JSON.parse(raw))
					.filter((message) => message.type === AgentMessageType.CF_AGENT_TOOL_RESULT)
			).toHaveLength(1)
		);
		resolveOldHistory(
			new Response(
				JSON.stringify([
					{ id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'answer the project question' }] },
					{ id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', text: 'stale continuation history' }] }
				]),
				{ status: 200 }
			)
		);
		await settle();

		expect(screen.getByTitle('Stop request')).toBeInTheDocument();
		expect(screen.queryByText('stale continuation history')).not.toBeInTheDocument();
	});

	it('drops duplicate terminal and late stream frames after a successful turn', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('ignore duplicate frames');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-start', id: 'text-3' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'text-3', delta: 'only once' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-end', id: 'text-3' }),
			done: true
		});
		await waitFor(() => expect(screen.getByText('only once')).toBeInTheDocument());

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: '',
			done: true
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'text-3', delta: ' after done' })
		});
		await settle();

		expect(screen.getAllByText('only once')).toHaveLength(1);
		expect(screen.queryByText(/after done/)).not.toBeInTheDocument();
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('repairs a malformed stream with the matching persisted commit without reload', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('run the project edits');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: 'tool-1',
				toolName: 'codemode',
				input: { code: 'return {}' }
			})
		});
		// This malformed provider/output chunk is dropped and no terminal frame
		// arrives. The commit below is the repair authority.
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: 'data: not-json\n\n'
		});
		await settle();

		const committed: UIChatMessage[] = [
			{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'run the project edits' }] },
			{
				id: 'assistant-1',
				role: 'assistant',
				parts: [{
					type: 'tool-codemode',
					toolCallId: 'tool-1',
					toolName: 'codemode',
					state: 'output-available',
					input: { code: 'return {}' },
					output: { ok: true, changedFiles: ['index.html'] }
				}]
			}
		];
		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId: request.id,
			messages: committed
		});
		await settle();

		await waitFor(() => expect(screen.getByText('Finished')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('refreshes the editor after a generated image is saved', async () => {
		const { component, onUpdate } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('Add a hero image');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: 'image-call',
				toolName: 'generate_image',
				input: { prompt: 'A hero image' }
			})
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({
				type: 'tool-output-available',
				toolCallId: 'image-call',
				output: { ok: true, path: 'images/hero.png' }
			})
		});
		await settle();

		await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
	});

	it('ignores a stale SSE body and continues with the JSON UI stream contract', async () => {
		const { component } = mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('use the JSON stream');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: 'data: not-json\n\n',
			done: false
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-start', id: 'json-text' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-delta', id: 'json-text', delta: 'JSON works' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'text-end', id: 'json-text' }),
			done: true
		});
		await settle();

		await waitFor(() => expect(screen.getByText('JSON works')).toBeInTheDocument());
	});

	it('ends an aborted stream instead of leaving the request stuck in Working', async () => {
		const { component } = mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('stop this response');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: 'The response stopped partway. Send your message again.',
			error: true,
			done: true
		});
		await settle();

		await waitFor(() => expect(screen.getByText('The response stopped partway. Send your message again.')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('settles an abort immediately when no done frame follows', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('trigger an upstream abort');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		await waitFor(() => expect(screen.getByTitle('Stop request')).toBeInTheDocument());
		screen.getByTitle('Stop request').click();
		await settle();

		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('renders the official tool stream as Finished instead of Needs attention', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('run the official tool stream');
		await settle();

		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const requestId = request.id;
		const sendChunk = (chunk: UIMessageChunk) => {
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: requestId,
				body: JSON.stringify(chunk),
				done: false
			});
		};
		sendChunk({ type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'codemode' });
		sendChunk({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"co' });
		sendChunk({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: 'de":"return {}"}' });
		sendChunk({
			type: 'tool-input-available',
			toolCallId: 'tool-1',
			toolName: 'codemode',
			input: { code: 'return {}' }
		});
		sendChunk({ type: 'tool-output-available', toolCallId: 'tool-1', output: { ok: true } });
		sendChunk({ type: 'finish-step' });
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: requestId,
			body: '',
			done: true
		});
		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId,
			messages: [{
				id: 'assistant-1',
				role: 'assistant',
				parts: [{
					type: 'tool-codemode',
					toolCallId: 'tool-1',
					toolName: 'codemode',
					state: 'output-available',
					input: { code: 'return {}' },
					output: { ok: true }
				}]
			}]
		});
		await settle();

		await waitFor(() => expect(screen.getByText('Finished')).toBeInTheDocument());
		expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
	});

	it('shows the tool card without a duplicate large status card while a tool runs', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('inspect the project');
		await settle();

		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'tool-input-start', toolCallId: 'read-1', toolName: 'read_file' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: 'read-1',
				toolName: 'read_file',
				input: { path: 'index.html' }
			})
		});

		await waitFor(() => {
			expect(
				screen.getByRole('button', { name: /Reading file.*index\.html.*Working/ })
			).toBeInTheDocument();
			expect(screen.getAllByText(/^Working(?:\.\.\.)?$/)).toHaveLength(1);
		});
	});

	it('uses one neutral status while the model continues after a tool result', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('inspect the project');
		await settle();

		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();
		const sendChunk = (body: JsonValue) => {
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: request.id,
				body: JSON.stringify(body)
			});
		};
		sendChunk({ type: 'tool-input-start', toolCallId: 'read-2', toolName: 'read_file' });
		sendChunk({
			type: 'tool-input-available',
			toolCallId: 'read-2',
			toolName: 'read_file',
			input: { path: 'index.html' }
		});
		sendChunk({
			type: 'tool-output-available',
			toolCallId: 'read-2',
			toolName: 'read_file',
			output: { ok: true, path: 'index.html', content: '<h1>Site</h1>', truncated: false }
		});

		await waitFor(() => expect(screen.getByText('Working...')).toBeInTheDocument());
		expect(screen.queryByText('Writing the response back into the chat.')).not.toBeInTheDocument();
		expect(screen.queryByText(/Still working|Inspecting the current project/)).not.toBeInTheDocument();
	});

	it('handles a plain-text error frame body (CAIL quota) without noise or duplication', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { component } = mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('check quota');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		const quotaText =
			"You've reached your AI usage limit for now. Try again in about 3600 seconds.";

		// Real frame sequence captured live (2026-07-10): the transport sends the
		// error text as a PLAIN body on an error frame, then the SAME text as a
		// proper JSON error chunk, then an empty done frame.
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: quotaText,
			done: false,
			error: true
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: JSON.stringify({ type: 'error', errorText: quotaText }),
			done: false
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: '',
			done: true
		});
		await settle();

		// Rendered exactly once, no generic fallback,
		// and no "Failed to parse stream chunk" console noise for this known shape.
		await waitFor(() => expect(screen.getAllByText(quotaText)).toHaveLength(1));
		expect(
			screen.queryByText('Something went wrong while generating this response.')
		).not.toBeInTheDocument();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('renders a sole plain-text error frame instead of clearing the request silently', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('trigger a provider error');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		const errorText = 'The provider returned a temporary error.';
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: errorText,
			done: true,
			error: true
		});
		await settle();

		await waitFor(() => expect(screen.getByText(errorText)).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('shows a visible fallback when an error frame body is malformed', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { component } = mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();
		await component.sendPrompt('handle malformed error');
		await settle();
		const request = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(request).toBeTruthy();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: request.id,
			body: 'data: definitely-not-json\n\n',
			done: true,
			error: true
		});
		await settle();

		await waitFor(() => expect(screen.getByText('data: definitely-not-json')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
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

	it('admits only one turn while an asynchronous pre-send save is pending', async () => {
		let resolvePreparation!: (ready: boolean) => void;
		const onBeforeSend = vi.fn(
			() => new Promise<boolean>((resolve) => {
				resolvePreparation = resolve;
			})
		);
		const { component } = renderExposed({ onBeforeSend });
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		const first = component.sendPrompt('first');
		const duplicate = component.sendPrompt('second');
		expect(onBeforeSend).toHaveBeenCalledOnce();
		resolvePreparation(true);
		await Promise.all([first, duplicate]);
		await settle();

		const requests = ws.sent
			.map((raw) => JSON.parse(raw))
			.filter((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(requests).toHaveLength(1);
		expect(requests[0].init.body).toContain('first');
		expect(requests[0].init.body).not.toContain('second');
	});

	it('drops a prepared turn when its project changes before the save finishes', async () => {
		let resolvePreparation!: (ready: boolean) => void;
		const onBeforeSend = vi.fn(
			() => new Promise<boolean>((resolve) => {
				resolvePreparation = resolve;
			})
		);
		const result = renderExposed({ projectId: 'proj-a', onBeforeSend });
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const projectASocket = FakeWebSocket.last();
		projectASocket.open();
		await settle();

		const pending = result.component.sendPrompt('change the old project');
		expect(onBeforeSend).toHaveBeenCalledOnce();
		await result.rerender({ projectId: 'proj-b', onUpdate: result.onUpdate, onBeforeSend });
		resolvePreparation(true);
		await pending;
		await settle();

		expect(
			projectASocket.sent.some(
				(raw) => JSON.parse(raw).type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST
			)
		).toBe(false);
		expect(screen.queryByText('change the old project')).not.toBeInTheDocument();
	});

	it('keeps the draft and attachment when an upload fails without adding a chat turn', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/projects/proj1/upload')) {
				return new Response(
					JSON.stringify({ error: 'file_too_large', message: 'This file is too large.' }),
					{ status: 413, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});
		const user = userEvent.setup({ delay: null });
		renderExposed();

		const messageInput = screen.getByLabelText('Message to the assistant');
		await user.type(messageInput, 'keep this draft');
		const fileInput = document.querySelector('input[type="file"]');
		if (!(fileInput instanceof HTMLInputElement)) throw new Error('expected attachment input');
		await user.upload(fileInput, new File(['attachment'], 'draft.txt', { type: 'text/plain' }));
		await user.click(screen.getByRole('button', { name: 'Send message' }));

		await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/projects/proj1/upload'))).toBe(true));
		await waitFor(() => expect(messageInput).toHaveValue('keep this draft'));
		expect(screen.getByText('draft.txt')).toBeInTheDocument();
		expect(screen.queryByText(/File uploaded:/)).not.toBeInTheDocument();
		expect(toasts).toContainEqual(
			expect.objectContaining({
				kind: 'error',
				message: "Couldn't upload file. This file is too large."
			})
		);
		expect(
			FakeWebSocket.instances.some((ws) =>
				ws.sent.some((raw) => JSON.parse(raw).type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST)
			)
		).toBe(false);
	});

	it('keeps the draft and attachment when request preparation is declined', async () => {
		const onBeforeSend = vi.fn().mockResolvedValue(false);
		const user = userEvent.setup({ delay: null });
		renderExposed({ onBeforeSend });

		const messageInput = screen.getByLabelText('Message to the assistant');
		await user.type(messageInput, 'prepare this later');
		const fileInput = document.querySelector('input[type="file"]');
		if (!(fileInput instanceof HTMLInputElement)) throw new Error('expected attachment input');
		await user.upload(fileInput, new File(['attachment'], 'later.txt', { type: 'text/plain' }));
		await user.click(screen.getByRole('button', { name: 'Send message' }));

		await waitFor(() => expect(onBeforeSend).toHaveBeenCalledOnce());
		expect(messageInput).toHaveValue('prepare this later');
		expect(screen.getByText('later.txt')).toBeInTheDocument();
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/projects/proj1/upload'))).toBe(false);
		expect(screen.queryByText(/File uploaded:/)).not.toBeInTheDocument();
		expect(toasts).toContainEqual(
			expect.objectContaining({ kind: 'error', message: 'Could not prepare your message. Try again.' })
		);
	});

	it('reuses a completed upload after a later connection failure', async () => {
		let credentialAttempts = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/projects/proj1/upload')) {
				return new Response(
					JSON.stringify({
						success: true,
						filename: 'retry.txt',
						path: 'retry.txt',
						size: 8,
						message: 'Uploaded retry.txt'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			if (url.endsWith('/refresh-credential')) {
				credentialAttempts += 1;
				if (credentialAttempts === 1) {
					return new Response(JSON.stringify({ error: 'temporary', message: 'Try the connection again.' }), {
						status: 503,
						headers: { 'Content-Type': 'application/json' }
					});
				}
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});
		const user = userEvent.setup({ delay: null });
		renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const socket = FakeWebSocket.last();
		socket.open();
		await settle();

		const messageInput = screen.getByLabelText('Message to the assistant');
		await user.type(messageInput, 'retry this upload');
		const fileInput = document.querySelector('input[type="file"]');
		if (!(fileInput instanceof HTMLInputElement)) throw new Error('expected attachment input');
		await user.upload(fileInput, new File(['retry me'], 'retry.txt', { type: 'text/plain' }));
		await user.click(screen.getByRole('button', { name: 'Send message' }));

		await waitFor(() => expect(credentialAttempts).toBe(1));
		await waitFor(() => expect(messageInput).toHaveValue('retry this upload'));
		expect(screen.getByText('retry.txt')).toBeInTheDocument();
		expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/projects/proj1/upload'))).toHaveLength(1);

		await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(credentialAttempts).toBe(2));
		await waitFor(() => expect(messageInput).toHaveValue(''));
		expect(screen.queryByText('retry.txt')).not.toBeInTheDocument();
		expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/projects/proj1/upload'))).toHaveLength(1);
	});

	it('recovers after stopping a turn that included an upload', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/projects/proj1/upload')) {
				return uploadResponseForTest('stop.txt', 'stop.txt', 8);
			}
			if (url.endsWith('/refresh-credential')) {
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});
		const user = userEvent.setup({ delay: null });
		renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const socket = FakeWebSocket.last();
		socket.open();
		await settle();

		const messageInput = screen.getByLabelText('Message to the assistant');
		await user.type(messageInput, 'stop after upload');
		const fileInput = document.querySelector('input[type="file"]');
		if (!(fileInput instanceof HTMLInputElement)) throw new Error('expected attachment input');
		await user.upload(fileInput, new File(['stop me'], 'stop.txt', { type: 'text/plain' }));
		await user.click(screen.getByRole('button', { name: 'Send message' }));

		await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/projects/proj1/upload'))).toBe(true));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Stop request' })).toBeInTheDocument());
		screen.getByRole('button', { name: 'Stop request' }).click();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop request' })).not.toBeInTheDocument());

		await user.type(messageInput, 'recover after stop');
		await user.upload(fileInput, new File(['new file'], 'new.txt', { type: 'text/plain' }));
		expect(screen.getByText('new.txt')).toBeInTheDocument();
	});

	it('drops an upload completion when the project changes, even after returning to it', async () => {
		let resolveUpload!: (response: Response) => void;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/projects/proj-a/upload')) {
				return new Promise<Response>((resolve) => {
					resolveUpload = resolve;
				});
			}
			return new Response('[]', { status: 200 });
		});
		const user = userEvent.setup({ delay: null });
		const result = renderExposed({ projectId: 'proj-a' });
		const messageInput = screen.getByLabelText('Message to the assistant');
		await user.type(messageInput, 'old project draft');
		const fileInput = document.querySelector('input[type="file"]');
		if (!(fileInput instanceof HTMLInputElement)) throw new Error('expected attachment input');
		await user.upload(fileInput, new File(['old bytes'], 'old.txt', { type: 'text/plain' }));
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/projects/proj-a/upload'))).toBe(true));

		await result.rerender({ projectId: 'proj-b', onUpdate: result.onUpdate });
		await result.rerender({ projectId: 'proj-a', onUpdate: result.onUpdate });
		resolveUpload(uploadResponseForTest('old.txt', 'old.txt', 9));
		await settle();

		expect(messageInput).toHaveValue('');
		expect(screen.queryByText('old.txt')).not.toBeInTheDocument();
		expect(
			FakeWebSocket.instances.some((ws) =>
				ws.sent.some((raw) => JSON.parse(raw).type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST)
			)
		).toBe(false);
	});

	it('stops an old turn before switching projects so its late finish cannot reset the new project', async () => {
		let projectBHistoryRequested = false;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/proj-b/get-messages')) {
				projectBHistoryRequested = true;
				return new Response(
					JSON.stringify([
						{ id: 'project-b-history', role: 'assistant', parts: [{ type: 'text', text: 'Project B history' }] }
					]),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});

		const result = renderExposed({ projectId: 'proj-a' });
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const projectASocket = FakeWebSocket.last();
		projectASocket.open();
		await settle();

		await result.component.sendPrompt('project A turn');
		await settle();
		const projectARequest = projectASocket.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(projectARequest).toBeTruthy();
		projectASocket.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: projectARequest.id,
			body: JSON.stringify({ type: 'text-start', id: 'project-a-text' })
		});
		projectASocket.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: projectARequest.id,
			body: JSON.stringify({ type: 'text-delta', id: 'project-a-text', delta: 'Project A partial' })
		});
		await waitFor(() => expect(screen.getByText('Project A partial')).toBeInTheDocument());

		await result.rerender({ projectId: 'proj-b', onUpdate: result.onUpdate });
		await waitFor(() => expect(projectBHistoryRequested).toBe(true));
		await waitFor(() => expect(screen.getByText('Project B history')).toBeInTheDocument());
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
		const projectBSocket = FakeWebSocket.last();
		projectBSocket.open();
		await settle();

		await result.component.sendPrompt('project B turn');
		await settle();
		const projectBRequest = projectBSocket.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(projectBRequest).toBeTruthy();

		// The old transport stream still owns A's listener. A late close must not
		// invoke Chat's finish callback against B's reset/new-turn state.
		projectASocket.serverClose();
		await settle();
		await waitFor(() => expect(screen.getByTitle('Stop request')).toBeInTheDocument());

		expect(screen.getByText('Project B history')).toBeInTheDocument();
		expect(screen.getByText('project B turn')).toBeInTheDocument();
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();

		projectBSocket.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: projectBRequest.id,
			body: JSON.stringify({ type: 'text-start', id: 'project-b-text' })
		});
		projectBSocket.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: projectBRequest.id,
			body: JSON.stringify({ type: 'text-delta', id: 'project-b-text', delta: 'Project B answer' })
		});
		await waitFor(() => expect(screen.getByText('Project B answer')).toBeInTheDocument());
	});

	it('waits for the credential refresh before sending a new chat frame', async () => {
		let resolveRefresh!: (response: Response) => void;
		let refreshRequested = false;
		fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/refresh-credential')) {
				expect(init?.method).toBe('POST');
				refreshRequested = true;
				return new Promise<Response>((resolve) => {
					resolveRefresh = resolve;
				});
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		const pending = component.sendPrompt('hello');
		await waitFor(() => expect(refreshRequested).toBe(true));
		expect(ws.sent).toHaveLength(0);

		resolveRefresh(new Response(null, { status: 204 }));
		await pending;
		await settle();
		expect(ws.sent.map((raw) => JSON.parse(raw).type)).toContain(
			AgentMessageType.CF_AGENT_USE_CHAT_REQUEST
		);
	});

	it('sends no model frame when the credential refresh fails', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/refresh-credential')) {
				return new Response(JSON.stringify({ error: 'agent_connection_not_found' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		await component.sendPrompt('hello');
		await settle();
		expect(ws.sent).toHaveLength(0);
		expect(
			screen.getByText('The connection to the assistant expired. Send your message again.')
		).toBeInTheDocument();
	});

	it('refreshes before both auto-continue tool-result frames on the same socket', async () => {
		const events: string[] = [];
		let refreshCount = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/refresh-credential')) {
				refreshCount += 1;
				events.push(`refresh-${refreshCount}`);
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		const originalSend = ws.send.bind(ws);
		ws.send = (raw: string) => {
			events.push(`ws-${JSON.parse(raw).type}`);
			originalSend(raw);
		};
		ws.open();

		await component.sendPrompt('hello');
		await settle();
		expect(refreshCount).toBe(1);
		const initialRequestId: string = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST).id;
		expect(events.indexOf('refresh-1')).toBeLessThan(events.indexOf(`ws-${AgentMessageType.CF_AGENT_USE_CHAT_REQUEST}`));

		function questionFrame(id: string, toolCallId: string) {
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id,
				body: JSON.stringify({
					type: 'tool-input-available',
					toolCallId,
					toolName: 'ask_user_question',
					input: { question: 'Pick a direction', options: ['A', { label: 'B' }, 7, null] }
				})
			});
		}

		questionFrame(initialRequestId, 'tool-1');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());
		const skipButton = screen.getByRole('button', { name: 'Skip' });
		skipButton.click();
		skipButton.click();
		await waitFor(() => expect(refreshCount).toBe(2));
		await settle();

		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_RESUMING, id: 'stream-2' });
		questionFrame('stream-2', 'tool-2');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument());
		screen.getByRole('button', { name: 'A' }).click();
		expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
		await settle();
		const replyButton = screen.getByRole('button', { name: 'Reply' });
		replyButton.click();
		replyButton.click();
		await waitFor(() => expect(refreshCount).toBe(3));
		await settle();

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(ws.sent.map((raw) => JSON.parse(raw).type)).toEqual([
			AgentMessageType.CF_AGENT_USE_CHAT_REQUEST,
			AgentMessageType.CF_AGENT_TOOL_RESULT,
			AgentMessageType.CF_AGENT_STREAM_RESUME_REQUEST,
			AgentMessageType.CF_AGENT_STREAM_RESUME_ACK,
			AgentMessageType.CF_AGENT_TOOL_RESULT,
			AgentMessageType.CF_AGENT_STREAM_RESUME_REQUEST
		]);
		const toolResultEvents = events
			.map((event, index) => (event === `ws-${AgentMessageType.CF_AGENT_TOOL_RESULT}` ? index : -1))
			.filter((index) => index >= 0);
		expect(events.indexOf('refresh-2')).toBeLessThan(toolResultEvents[0]);
		expect(events.indexOf('refresh-3')).toBeLessThan(toolResultEvents[1]);
		expect(events.indexOf('refresh-3')).toBeGreaterThan(events.indexOf('refresh-2'));
	});

	it('cancels a successor after stopping before a tool continuation resumes', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('answer a question');
		await settle();
		const initialRequest = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(initialRequest).toBeTruthy();
		const initialRequestId: string = initialRequest.id;

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: initialRequestId,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: 'question-1',
				toolName: 'ask_user_question',
				input: { question: 'Pick a path', options: ['A', 'B'] }
			})
		});
		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId: initialRequestId,
			messages: [
				{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'answer a question' }] },
				{
					id: 'assistant-1',
					role: 'assistant',
					parts: [
						{
							type: 'tool-ask_user_question',
							toolCallId: 'question-1',
							toolName: 'ask_user_question',
							state: 'input-available',
							input: { question: 'Pick a path', options: ['A', 'B'] }
						}
					]
				}
			]
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());
		screen.getByRole('button', { name: 'Skip' }).click();
		await waitFor(() =>
			expect(
				ws.sent.map((raw) => JSON.parse(raw)).filter(
					(message) => message.type === AgentMessageType.CF_AGENT_TOOL_RESULT
				)
			).toHaveLength(1)
		);
		await settle();

		screen.getByTitle('Stop request').click();
		await settle();
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		expect(
			ws.sent
				.map((raw) => JSON.parse(raw))
				.filter((message) => message.type === AgentMessageType.SITE_STUDIO_CANCEL_TURN)
		).toHaveLength(1);
		ws.serverMessage({ type: AgentMessageType.SITE_STUDIO_CHAT_CANCELLED });
		await settle();
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());

		const successorId = 'continuation-stream';
		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_RESUMING, id: successorId });
		await settle();
		const successorMessages = ws.sent.map((raw) => JSON.parse(raw));
		expect(
			successorMessages.filter(
				(message) =>
					message.type === AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL && message.id === successorId
			)
		).toHaveLength(1);
		expect(
			successorMessages.filter(
				(message) => message.type === AgentMessageType.CF_AGENT_STREAM_RESUME_ACK && message.id === successorId
			)
		).toHaveLength(0);

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: successorId,
			body: JSON.stringify({ type: 'text-delta', id: 'stale', delta: 'stale continuation' })
		});
		await settle();
		expect(screen.queryByText('stale continuation')).not.toBeInTheDocument();

		const laterSuccessorId = 'later-continuation-stream';
		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_RESUMING, id: laterSuccessorId });
		await settle();
		expect(
			ws.sent
				.map((raw) => JSON.parse(raw))
				.filter(
					(message) =>
						message.type === AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL &&
						message.id === laterSuccessorId
				)
		).toHaveLength(1);

		await component.sendPrompt('new task');
		await settle();
		const requestFrames = ws.sent
			.map((raw) => JSON.parse(raw))
			.filter((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(requestFrames).toHaveLength(2);
		expect(requestFrames[1].id).not.toBe(successorId);
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: successorId,
			body: JSON.stringify({ type: 'text-delta', id: 'stale', delta: 'stale after new request' })
		});
		await settle();
		expect(screen.queryByText('stale after new request')).not.toBeInTheDocument();
		screen.getByTitle('Stop request').click();
		await settle();
	});

	it('clears and suppresses a pending continuation stopped in another tab', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('work in this tab');
		await settle();
		const requestId: string = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST).id;
		const questionPart = {
			type: 'tool-ask_user_question' as const,
			toolCallId: 'other-tab-question',
			toolName: 'ask_user_question',
			state: 'input-available' as const,
			input: { question: 'Continue?', options: ['Yes'] }
		};
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: requestId,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: questionPart.toolCallId,
				toolName: questionPart.toolName,
				input: questionPart.input
			})
		});
		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId,
			messages: [
				{ id: 'other-tab-user', role: 'user', parts: [{ type: 'text', text: 'work in this tab' }] },
				{ id: 'other-tab-assistant', role: 'assistant', parts: [questionPart] }
			]
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());
		screen.getByRole('button', { name: 'Skip' }).click();
		await waitFor(() =>
			expect(
				ws.sent.map((raw) => JSON.parse(raw)).filter(
					(message) => message.type === AgentMessageType.CF_AGENT_TOOL_RESULT
				)
			).toHaveLength(1)
		);
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();

		ws.serverMessage({ type: AgentMessageType.SITE_STUDIO_CHAT_CANCELLED });
		await settle();
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());

		const lateSuccessorId = 'other-tab-late-successor';
		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_RESUMING, id: lateSuccessorId });
		await settle();
		expect(
			ws.sent
				.map((raw) => JSON.parse(raw))
				.filter(
					(message) =>
						message.type === AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL &&
						message.id === lateSuccessorId
				)
		).toHaveLength(1);
	});

	// SS-9: after the user hits Stop, a late CF_AGENT_USE_CHAT_RESPONSE frame for the
	// cancelled request id must be dropped — it must not recreate the active stream
	// and resume appending text, and isLoading must stay false.
	it('drops late stream frames for a stopped request (SS-9)', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('build something');
		await settle();

		// The request id is the `id` on the CF_AGENT_USE_CHAT_REQUEST frame the
		// component sent. Grab it so our stream frames match the live request.
		const requestFrame = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(requestFrame).toBeTruthy();
		const streamId: string = requestFrame.id;

		function chunk(body: JsonValue, done = false) {
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: streamId,
				body: JSON.stringify(body),
				done
			});
		}

		chunk({ type: 'text-start', id: 't1' });
		chunk({ type: 'text-delta', id: 't1', delta: 'Before stop' });
		await settle();
		await waitFor(() => expect(screen.getByText('Before stop')).toBeInTheDocument());

		// User stops the request.
		const stopButton = screen.getByTitle('Stop request');
		stopButton.click();
		await settle();

		// A cancel frame was sent, and the loading state cleared.
		const sentTypes = ws.sent.map((raw) => JSON.parse(raw).type);
		expect(sentTypes).toContain(AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());

		// A late frame for the same (now cancelled) id arrives — it must be ignored.
		chunk({ type: 'text-delta', id: 't1', delta: ' AFTER STOP' });
		await settle();

		expect(screen.queryByText(/AFTER STOP/)).not.toBeInTheDocument();
		expect(screen.getByText('Before stop')).toBeInTheDocument();
		// Still not loading — no active status card / stop button reappeared.
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
	});

	it('resends cancellation when a stopped request resumes after disconnect', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		let ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('build something');
		await settle();
		const oldRequestId: string = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST).id;
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: oldRequestId,
			body: JSON.stringify({ type: 'text-start', id: 'old-text' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: oldRequestId,
			body: JSON.stringify({ type: 'text-delta', id: 'old-text', delta: 'Before disconnect' })
		});
		await settle();
		await waitFor(() => expect(screen.getByText('Before disconnect')).toBeInTheDocument());

		vi.useFakeTimers();
		try {
			ws.serverClose();
			flushSync();
			screen.getByTitle('Stop request').click();
			await settle();
			await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());

			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			ws = FakeWebSocket.last();
			ws.open();
			await settle();
			expect(
				ws.sent
					.map((raw) => JSON.parse(raw))
					.filter((message) => message.type === AgentMessageType.SITE_STUDIO_CANCEL_TURN)
			).toHaveLength(1);
			ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_RESUMING, id: oldRequestId });
			await settle();

			const cancelFrames = ws.sent
				.map((raw) => JSON.parse(raw))
				.filter((message) => message.type === AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
			expect(cancelFrames).toHaveLength(1);
			await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
				id: oldRequestId,
				body: JSON.stringify({ type: 'text-delta', id: 'old-text', delta: ' stale old stream' })
			});
			await settle();
			expect(screen.queryByText(/stale old stream/)).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}

		await component.sendPrompt('new task');
		await settle();
		const newRequestFrames = ws.sent
			.map((raw) => JSON.parse(raw))
			.filter((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(newRequestFrames).toHaveLength(1);
		const newRequestId: string = newRequestFrames[0].id;
		expect(newRequestId).not.toBe(oldRequestId);
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: oldRequestId,
			body: JSON.stringify({ type: 'text-delta', id: 'old-text', delta: ' stale after new request' })
		});
		await settle();
		expect(screen.queryByText(/stale after new request/)).not.toBeInTheDocument();
		screen.getByTitle('Stop request').click();
		await settle();
	});

	// SS-11: a stale-CSRF handshake closes the socket before OPEN; the reconnect
	// must force a fresh /api/csrf round-trip so the next handshake uses a new token,
	// and must not infinite-loop.
	it('refreshes the CSRF token before reconnecting after a pre-OPEN close (SS-11)', async () => {
		// Rotate the delivered token on each /api/csrf hit so we can prove the
		// reconnect used a freshly-fetched one rather than the cached original.
		let csrfHits = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				csrfHits += 1;
				document.cookie = `cail_csrf_sitestudio=token-${csrfHits}`;
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});

		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const first = FakeWebSocket.instances[0];
		// Initial handshake used the first token.
		expect(new URL(first.url).searchParams.get('csrf')).toBe('token-1');
		const csrfHitsAfterInitial = csrfHits;

		vi.useFakeTimers();
		try {
			// Handshake fails before OPEN: the socket closes without ever opening.
			first.serverClose();
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(1);

			// First backoff is 1000ms; the reconnect must refresh CSRF first.
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();

			expect(FakeWebSocket.instances.length).toBe(2);
			// The refresh forced an extra /api/csrf round-trip...
			expect(csrfHits).toBeGreaterThan(csrfHitsAfterInitial);
			// ...and the reconnecting socket carries the fresh token, not the stale one.
			const second = FakeWebSocket.instances[1];
			expect(new URL(second.url).searchParams.get('csrf')).not.toBe('token-1');
		} finally {
			vi.useRealTimers();
		}
	});

	// SS-11 (cont.): recovery remains available for the lifetime of the active
	// project. Backoff is capped, but reconnects do not stop after an arbitrary
	// number of failures.
	it('continues reconnecting with bounded backoff while the project is active', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=rotating-token';
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});

		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));

		vi.useFakeTimers();
		try {
			// Every new socket also fails pre-OPEN; drive eight backoff cycles. The
			// delay reaches its 15s cap after the fourth reconnect.
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const current = FakeWebSocket.last();
				if (current.readyState !== FakeWebSocket.CLOSED) {
					current.serverClose();
					flushSync();
				}
				const delay = Math.min(1000 * 2 ** attempt, 15000);
				await vi.advanceTimersByTimeAsync(delay);
				flushSync();
				await vi.advanceTimersByTimeAsync(0);
				flushSync();
			}
			expect(FakeWebSocket.instances.length).toBe(9);
			expect(screen.queryByText(/The response was interrupted/)).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	// A reconnect attempt can fail without any close event this component sees:
	// real browsers fire `error` before `close` on a rejected handshake, and the
	// SS-12 cleanup removes the failed socket's close listener as soon as the
	// error fires. The old code swallowed that rejection with a comment claiming
	// handleSocketClose would retry — so one error-first failure silently killed
	// the whole reconnect loop. The rejection path must keep retrying with
	// backoff.
	it('keeps reconnecting when a reconnect attempt errors without logging socket details', async () => {
		const socketError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const first = FakeWebSocket.instances[0];
		first.open();
		await settle();

		vi.useFakeTimers();
		try {
			// An unexpected close schedules reconnect attempt #1.
			first.serverClose();
			flushSync();
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(2);

			// Attempt #1 fails with an error event only — no close ever reaches the
			// component. The loop must schedule attempt #2, not die silently.
			const failed = FakeWebSocket.last();
			failed.url = 'wss://site-studio.example/agent?csrf=private-token';
			failed.serverError();
			flushSync();
			expect(socketError).toHaveBeenCalledWith('site_studio.websocket_error');
			expect(socketError.mock.calls).toEqual([['site_studio.websocket_error']]);
			await vi.advanceTimersByTimeAsync(20000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(3);
		} finally {
			vi.useRealTimers();
			socketError.mockRestore();
		}
	});

	// SS-12: a socket that errors on first connect must not, when it later closes,
	// tear down a newer good socket or schedule a spurious reconnect.
	it('an orphaned failed socket cannot tear down the current socket (SS-12)', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		const first = FakeWebSocket.instances[0];

		// First connect errors before OPEN: ensureSocket's promise rejects and its
		// refs are cleared. This is the flaky-first-connect path.
		first.serverError();
		await settle();

		// A subsequent action opens a fresh, good socket (socket #2). ensureSocket
		// creates the socket synchronously but its promise only resolves on OPEN, so
		// don't await sendPrompt — wait for the socket, open it, then let it settle.
		const pending = component.sendPrompt('hello there');
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
		const second = FakeWebSocket.last();
		second.open();
		await pending;
		await settle();
		expect(second.readyState).toBe(FakeWebSocket.OPEN);

		vi.useFakeTimers();
		try {
			const socketsBefore = FakeWebSocket.instances.length;

			// The orphaned first socket now fires a late close. With the SS-12 fix its
			// listeners were already removed on the earlier error, so this is inert;
			// even if a close listener lingered, the currentTarget guard would keep it
			// from nulling the current (second) socket or scheduling a reconnect.
			first.serverClose();
			flushSync();
			await vi.advanceTimersByTimeAsync(15000);
			flushSync();

			// No new socket spawned — the current one survived, no spurious reconnect.
			expect(FakeWebSocket.instances.length).toBe(socketsBefore);
			expect(second.readyState).toBe(FakeWebSocket.OPEN);
		} finally {
			vi.useRealTimers();
		}

		// The current socket is still usable: a stream frame on #2 renders.
		second.serverMessage({
			type: AgentMessageType.CF_AGENT_CHAT_MESSAGES,
			messages: [{ id: 'x1', role: 'assistant', parts: [{ type: 'text', text: 'still alive' }] }]
		});
		await settle();
		expect(screen.getByText('still alive')).toBeInTheDocument();
	});

	// SS-10: dropping the socket mid-request must not append a permanent dead-end
	// error while reconnects continue in the background.
	it('keeps the request live while reconnecting after a mid-request drop (SS-10)', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		let ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('do a big task');
		await settle();

		vi.useFakeTimers();
		try {
			// Socket drops mid-request. A reconnect is pending → no permanent error.
			ws.serverClose();
			flushSync();
			expect(screen.queryByText(/The response was interrupted/)).not.toBeInTheDocument();

			// Each new socket also drops pre-OPEN. The reconnect loop continues without
			// surfacing a terminal error.
			for (let i = 0; i < 8; i += 1) {
				await vi.advanceTimersByTimeAsync(20000);
				flushSync();
				await vi.advanceTimersByTimeAsync(0);
				flushSync();
				const current = FakeWebSocket.last();
				if (current !== ws && current.readyState !== FakeWebSocket.CLOSED) {
					current.serverClose();
					flushSync();
					ws = current;
				}
			}
		} finally {
			vi.useRealTimers();
		}
		await settle();

		// There is no retry budget to exhaust while this project remains active.
		expect(screen.queryByText(/The response was interrupted/)).not.toBeInTheDocument();
	});

	it('reconciles a pending turn when reconnect resume reports no active stream', async () => {
		let historyGets = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				historyGets += 1;
				const history: UIChatMessage[] =
					historyGets === 1
						? []
						: [{ id: 'finished', role: 'assistant', parts: [{ type: 'text', text: 'Finished' }] }];
				return new Response(JSON.stringify(history), { status: 200 });
			}
			return new Response('[]', { status: 200 });
		});

		const { component, onUpdate } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		let ws = FakeWebSocket.last();
		ws.open();
		await settle();
		const initialHistoryGets = historyGets;

		await component.sendPrompt('do a big task');
		await settle();
		const requestFrame = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(requestFrame).toBeTruthy();
		const requestId: string = requestFrame.id;
		const pendingQuestion = {
			type: 'tool-ask_user_question' as const,
			toolCallId: 'reconnect-question',
			toolName: 'ask_user_question',
			state: 'input-available' as const,
			input: { question: 'Continue after reconnect?', options: ['Yes'] }
		};
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: requestId,
			body: JSON.stringify({
				type: 'tool-input-available',
				toolCallId: pendingQuestion.toolCallId,
				toolName: pendingQuestion.toolName,
				input: pendingQuestion.input
			})
		});
		ws.serverMessage({
			type: AgentMessageType.SITE_STUDIO_CHAT_COMMITTED,
			requestId,
			messages: [
				{ id: 'reconnect-user', role: 'user', parts: [{ type: 'text', text: 'do a big task' }] },
				{ id: 'reconnect-assistant', role: 'assistant', parts: [pendingQuestion] }
			]
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());
		screen.getByRole('button', { name: 'Skip' }).click();
		await waitFor(() =>
			expect(
				ws.sent.map((raw) => JSON.parse(raw)).filter(
					(message) => message.type === AgentMessageType.CF_AGENT_TOOL_RESULT
				)
			).toHaveLength(1)
		);
		expect(screen.getByTitle('Stop request')).toBeInTheDocument();

		vi.useFakeTimers();
		try {
			ws.serverClose();
			flushSync();
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(2);

			ws = FakeWebSocket.last();
			ws.open();
			await settle();
			const resumeRequests = ws.sent
				.map((raw) => JSON.parse(raw))
				.filter((message) => message.type === AgentMessageType.CF_AGENT_STREAM_RESUME_REQUEST);
			expect(resumeRequests).toHaveLength(1);
			expect(historyGets).toBe(initialHistoryGets);
			expect(resumeRequests[0].probeId).toEqual(expect.any(String));

			ws.serverMessage({
				type: AgentMessageType.CF_AGENT_STREAM_PENDING,
				id: 'pending-successor'
			});
			await settle();
			expect(screen.getByTitle('Stop request')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_STREAM_RESUME_NONE,
			probeId: 'different-probe'
		});
		await settle();
		expect(historyGets).toBe(initialHistoryGets);

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_STREAM_RESUME_NONE
		});
		await waitFor(() => expect(historyGets).toBe(initialHistoryGets + 1));
		await waitFor(() => expect(screen.getByText('Finished')).toBeInTheDocument());
		await waitFor(() => expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument());
		expect(onUpdate).toHaveBeenCalledTimes(2);
	});

	it('ignores a pending resume frame that arrives after Stop and a fresh request', async () => {
		const { component } = renderExposed();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
		let ws = FakeWebSocket.last();
		ws.open();
		await settle();

		await component.sendPrompt('first request');
		await settle();
		const firstRequest = ws.sent
			.map((raw) => JSON.parse(raw))
			.find((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST);
		expect(firstRequest).toBeTruthy();

		vi.useFakeTimers();
		try {
			ws.serverClose();
			flushSync();
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			ws = FakeWebSocket.last();
			ws.open();
			await settle();
			expect(
				ws.sent
					.map((raw) => JSON.parse(raw))
					.filter((message) => message.type === AgentMessageType.CF_AGENT_STREAM_RESUME_REQUEST)
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}

		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_PENDING, id: 'other-tab-request' });
		await settle();
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_STREAM_RESUMING,
			id: 'other-tab-request'
		});
		await settle();
		expect(
			ws.sent
				.map((raw) => JSON.parse(raw))
				.filter(
					(message) =>
						message.type === AgentMessageType.CF_AGENT_STREAM_RESUME_ACK &&
						message.id === 'other-tab-request'
				)
		).toHaveLength(1);

		vi.useFakeTimers();
		try {
			ws.serverClose();
			flushSync();
			await vi.advanceTimersByTimeAsync(1000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			ws = FakeWebSocket.last();
			ws.open();
			await settle();
		} finally {
			vi.useRealTimers();
		}

		await waitFor(() => expect(screen.getByTitle('Stop request')).toBeInTheDocument());
		screen.getByTitle('Stop request').click();
		await settle();
		expect(
			ws.sent
				.map((raw) => JSON.parse(raw))
				.filter(
					(message) =>
						message.type === AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL &&
						message.id === 'other-tab-request'
				)
		).toHaveLength(1);
		await component.sendPrompt('fresh request');
		await settle();
		const freshRequest = ws.sent
			.map((raw) => JSON.parse(raw))
			.filter((message) => message.type === AgentMessageType.CF_AGENT_USE_CHAT_REQUEST)
			.at(-1);

		ws.serverMessage({ type: AgentMessageType.CF_AGENT_STREAM_PENDING, id: 'stale-request' });
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: freshRequest.id,
			body: JSON.stringify({ type: 'text-start', id: 'fresh-text' })
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: freshRequest.id,
			body: JSON.stringify({ type: 'text-delta', id: 'fresh-text', delta: 'fresh response' })
		});
		await waitFor(() => expect(screen.getByText('fresh response')).toBeInTheDocument());
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
function renderExposed(props: AgentChatTestProps = {}) {
	const onUpdate = vi.fn();
	const result = render(AgentChat, { props: { projectId: 'proj1', onUpdate, ...props } });
	return { ...result, onUpdate };
}
