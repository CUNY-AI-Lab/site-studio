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
		// Real WebSocket events carry `currentTarget`; the component relies on it to
		// distinguish the current socket from an orphaned/superseded one (SS-12).
		try {
			Object.defineProperty(ev, 'currentTarget', { value: this, configurable: true });
			Object.defineProperty(ev, 'target', { value: this, configurable: true });
		} catch {
			// Some Event impls make these read-only accessors; fall back to assignment.
			(ev as any).currentTarget = this;
		}
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
	/** Push a raw (possibly non-JSON) frame, bypassing serialization. */
	serverRawMessage(data: string) {
		this.emit('message', { data } as MessageEvent);
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
		vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
		// The component fetches a CSRF token before connecting, and loadChatHistory
		// hits GET /get-messages. The token is delivered via Set-Cookie (rule 3),
		// so the /api/csrf stub sets document.cookie; empty history otherwise.
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			return new Response('[]', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		invalidateCsrfToken();
		document.cookie = 'cail_csrf_sitestudio=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
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

	it('routes authentication_required history responses through the login redirect path', async () => {
		const locationImplSymbol = Object.getOwnPropertySymbols(window.location).find(
			(symbol) => symbol.toString() === 'Symbol(impl)'
		);
		expect(locationImplSymbol).toBeDefined();
		const locationImpl = (window.location as any)[locationImplSymbol as symbol] as {
			assign: (url: string) => void;
		};
		const assignSpy = vi.spyOn(locationImpl, 'assign').mockImplementation(() => {});
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/api/csrf')) {
				document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/get-messages')) {
				return new Response(
					JSON.stringify({ error: 'authentication_required', login_url: '/login' }),
					{ status: 401, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('[]', { status: 200 });
		});

		mount();

		await waitFor(() =>
			expect(assignSpy).toHaveBeenCalledWith('/login?rt=%2F')
		);
	});

	// SS-49: a failed history load must be distinguishable from an empty
	// conversation. The old behavior set uiMessages = [] on any non-ok/catch,
	// rendering a wiped transcript for a transient error.
	it('surfaces a retryable error when history loading fails, not an empty transcript (SS-49)', async () => {
		let historyRequests = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
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
		expect(screen.queryByText("Let's Build Your Site")).not.toBeInTheDocument();

		// Retrying recovers the real history and clears the error state.
		screen.getByRole('button', { name: /retry loading history/i }).click();
		await waitFor(() => expect(screen.getByText('Recovered message')).toBeInTheDocument());
		expect(screen.queryByText(/chat history could not be loaded/i)).not.toBeInTheDocument();
	});

	it('shows the welcome empty state (no error) for genuinely empty history (SS-49)', async () => {
		mount(); // default fetch stub returns [] for /get-messages
		await waitFor(() => expect(screen.getByText("Let's Build Your Site")).toBeInTheDocument());
		expect(screen.queryByText(/chat history could not be loaded/i)).not.toBeInTheDocument();
	});

	it('a network failure loading history also surfaces the error state (SS-49)', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
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
		expect(screen.queryByText("Let's Build Your Site")).not.toBeInTheDocument();
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

	it('parses SSE-framed stream chunks', async () => {
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'sse-stream',
			body: `data: ${JSON.stringify({ type: 'error', errorText: 'Usage limit reached.' })}\n\n`,
			done: true,
			error: true
		});
		await settle();

		expect(screen.getByText('Usage limit reached.')).toBeInTheDocument();
	});

	it('handles a plain-text error frame body (CAIL quota) without noise or duplication', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		const quotaText =
			"You've reached your AI usage limit for now. Try again in about 3600 seconds.";

		// Real frame sequence captured live (2026-07-10): the transport sends the
		// error text as a PLAIN body on an error frame, then the SAME text as a
		// proper JSON error chunk, then an empty done frame.
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'quota-stream',
			body: quotaText,
			done: false,
			error: true
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'quota-stream',
			body: JSON.stringify({ type: 'error', errorText: quotaText }),
			done: false
		});
		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'quota-stream',
			body: '',
			done: true
		});
		await settle();

		// Rendered exactly once (from the persisted message), no generic fallback,
		// and no "Failed to parse stream chunk" console noise for this known shape.
		expect(screen.getAllByText(quotaText)).toHaveLength(1);
		expect(
			screen.queryByText('Something went wrong while generating this response.')
		).not.toBeInTheDocument();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('shows a visible fallback when an error frame body is malformed', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mount();
		await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
		const ws = FakeWebSocket.last();
		ws.open();

		ws.serverMessage({
			type: AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE,
			id: 'broken-stream',
			body: 'data: definitely-not-json\n\n',
			done: true,
			error: true
		});
		await settle();

		expect(warn).toHaveBeenCalled();
		expect(
			screen.getByText('Something went wrong while generating this response.')
		).toBeInTheDocument();
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

		function chunk(body: unknown, done = false) {
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
		expect(screen.getByText('Before stop')).toBeInTheDocument();

		// User stops the request.
		const stopButton = screen.getByTitle('Stop request');
		stopButton.click();
		await settle();

		// A cancel frame was sent, and the loading state cleared.
		const sentTypes = ws.sent.map((raw) => JSON.parse(raw).type);
		expect(sentTypes).toContain(AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
		expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument();

		// A late frame for the same (now cancelled) id arrives — it must be ignored.
		chunk({ type: 'text-delta', id: 't1', delta: ' AFTER STOP' });
		await settle();

		expect(screen.queryByText(/AFTER STOP/)).not.toBeInTheDocument();
		expect(screen.getByText('Before stop')).toBeInTheDocument();
		// Still not loading — no active status card / stop button reappeared.
		expect(screen.queryByTitle('Stop request')).not.toBeInTheDocument();
	});

	// SS-11: a stale-CSRF handshake closes the socket before OPEN; the reconnect
	// must force a fresh /api/csrf round-trip so the next handshake uses a new token,
	// and must not infinite-loop.
	it('refreshes the CSRF token before reconnecting after a pre-OPEN close (SS-11)', async () => {
		// Rotate the delivered token on each /api/csrf hit so we can prove the
		// reconnect used a freshly-fetched one rather than the cached original.
		let csrfHits = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
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

	// SS-11 (cont.): the recovery must not refresh-storm or spawn unbounded sockets —
	// after MAX_RECONNECT_ATTEMPTS the reconnect loop gives up.
	it('stops reconnecting after MAX_RECONNECT_ATTEMPTS (SS-11 no infinite loop)', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
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
			// Every new socket also fails pre-OPEN; drive the full backoff schedule.
			for (let i = 0; i < 10; i += 1) {
				const current = FakeWebSocket.last();
				if (current.readyState !== FakeWebSocket.CLOSED) {
					current.serverClose();
					flushSync();
				}
				await vi.advanceTimersByTimeAsync(20000);
				flushSync();
				await vi.advanceTimersByTimeAsync(0);
				flushSync();
			}
			// 1 initial + at most MAX_RECONNECT_ATTEMPTS (5) reconnect sockets.
			expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(6);
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
	it('keeps reconnecting when a reconnect attempt errors instead of closing', async () => {
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
			FakeWebSocket.last().serverError();
			flushSync();
			await vi.advanceTimersByTimeAsync(20000);
			flushSync();
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(FakeWebSocket.instances.length).toBe(3);
		} finally {
			vi.useRealTimers();
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

	// SS-10: dropping the socket mid-request must NOT append a permanent dead-end
	// error while a reconnect is pending (transient reconnecting state instead);
	// once reconnect attempts are exhausted, the error IS surfaced.
	it('shows no dead-end error while reconnecting, surfaces it when exhausted (SS-10)', async () => {
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
			expect(screen.queryByText(/Connection lost while the agent was responding/)).not.toBeInTheDocument();

			// Exhaust reconnect attempts: each new socket also drops pre-OPEN.
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

		// After the reconnect budget is spent, the permanent error is surfaced.
		expect(screen.getByText(/Connection lost while the agent was responding/)).toBeInTheDocument();
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
