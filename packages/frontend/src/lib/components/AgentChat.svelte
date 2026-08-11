<script lang="ts">
	import { tick } from 'svelte';
	import { Send, Loader2, X, Paperclip, Square } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';
	import { resolveWebSocketPath } from '$lib/utils/ws';
	import { apiResponseFetch, getErrorMessage, handleApiError, isApiError } from '$lib/api/errors';
	import { csrfFetch, getCsrfToken, refreshCsrfToken } from '$lib/api/csrf';
	import AskUserQuestionCard from './AskUserQuestionCard.svelte';
	import ToolExecutionCard from './ToolExecutionCard.svelte';
	import MessageContent from './MessageContent.svelte';
	import {
		AgentMessageType,
		applyChunkToParts,
		applyLocalToolOutput,
		cloneParts,
		isToolPart,
		mergeUpdatedMessage,
		type ActiveStreamMessage,
		type UIChatMessage,
		type UIMessagePart,
		type UIStreamChunk
	} from '$lib/agents/chat';

	interface ContentBlock {
		type: 'text' | 'tools';
		text?: string;
		tools?: ToolExecution[];
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string; // For user messages
		blocks?: ContentBlock[]; // For assistant messages with interleaved content
	}

	interface ToolExecution {
		id?: string;
		name: string;
		title?: string;
		input: Record<string, any>;
		status?: 'running' | 'success' | 'error';
		output?: string;
		startTime?: number;
		elapsedTime?: number;
	}

	interface PendingToolInteraction {
		toolCallId: string;
		toolName: string;
		input: Record<string, any>;
	}

	interface RunningToolState {
		toolCallId: string;
		name: string;
		title?: string;
		input: Record<string, any>;
	}

	import type { QuestionOption, UserQuestionPrompt, UserQuestionSubmission } from './AskUserQuestionCard.svelte';

	let {
		projectId,
		onUpdate,
		onBeforeSend
	}: {
		projectId: string;
		onUpdate: () => void;
		onBeforeSend?: () => Promise<boolean> | boolean;
	} = $props();

	let uiMessages = $state<UIChatMessage[]>([]);
	// SS-49: history LOAD FAILURE is a distinct state from "no history". Showing
	// an empty transcript on a transient /get-messages error read as "my
	// conversation was deleted"; instead we surface the error with a retry.
	let historyLoadFailed = $state(false);
	let input = $state('');
	let isLoading = $state(false);
	let isPreparingRequest = $state(false);
	let requestPreparationSequence = 0;
	let messagesContainer: HTMLDivElement;
	let fileInput: HTMLInputElement;
	let currentStatus = $state<string>('');
	let attachedFile = $state<File | null>(null);
	let isUploading = $state(false);
	let socket = $state<WebSocket | null>(null);
	let socketProjectId: string | null = null;
	let socketPromise: Promise<WebSocket> | null = null;
	let socketPromiseProjectId: string | null = null;
	let activeStream = $state<ActiveStreamMessage | null>(null);
	let currentRequestId = $state<string | null>(null);
	let expectingContinuation = $state(false);
	let ignoreNextSocketClose = $state(false);
	let requestStartedAt = $state<number | null>(null);
	let clockNow = $state(Date.now());
	let toolStartTimes = $state<Record<string, number>>({});
	// SS-9: request ids the user explicitly cancelled. Late CF_AGENT_USE_CHAT_RESPONSE
	// frames for these ids must be dropped rather than resuming a stopped stream.
	let cancelledRequestIds = $state<Set<string>>(new Set());
	// SS-11: guard so we refresh the CSRF cookie at most once per reconnect cycle
	// (a stale-token handshake 403 closes the socket before OPEN; refreshing once
	// before the next attempt avoids a refresh-storm while still self-healing).
	let csrfRefreshedThisCycle = false;
	const MUTATING_TOOLS = new Set([
		'codemode',
		'write_file',
		'edit_file',
		'rename_file',
		'delete_file',
		'scaffold_template',
		'add_page'
	]);

	function generateId(): string {
		return crypto.randomUUID();
	}

	function getTextFromParts(parts: UIMessagePart[]): string {
		return parts
			.filter((part): part is Extract<UIMessagePart, { type: 'text' }> => part.type === 'text')
			.map((part) => part.text)
			.join('');
	}

	function serializeToolOutput(output: unknown, errorText?: string, toolName?: string): string {
		if (typeof output === 'string' && output.trim().length > 0) {
			return output;
		}

		if (output && typeof output === 'object') {
			const record = output as Record<string, unknown>;

			if (toolName === 'codemode' && record.result !== undefined) {
				const summaryLines: string[] = [];
				const result = record.result;

				if (result && typeof result === 'object') {
					const resultRecord = result as Record<string, unknown>;
					if (typeof resultRecord.summary === 'string' && resultRecord.summary.trim().length > 0) {
						summaryLines.push(resultRecord.summary.trim());
					}

					const changedFiles = Array.isArray(resultRecord.changedFiles)
						? resultRecord.changedFiles.filter(
								(filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0
							)
						: [];

					if (changedFiles.length > 0) {
						summaryLines.push(`Changed: ${changedFiles.join(', ')}`);
					}
				} else if (typeof result === 'string' && result.trim().length > 0) {
					summaryLines.push(result.trim());
				}

				const logs = Array.isArray(record.logs)
					? record.logs.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
					: [];

				if (logs.length > 0) {
					summaryLines.push(`Logs:\n${logs.join('\n')}`);
				}

				if (summaryLines.length > 0) {
					return summaryLines.join('\n');
				}
			}

			if (typeof record.message === 'string' && record.message.trim().length > 0) {
				return record.message;
			}

			if (typeof record.tree === 'string' && record.tree.trim().length > 0) {
				return record.tree;
			}

			if (typeof record.content === 'string' && record.content.trim().length > 0) {
				return record.content;
			}

			return JSON.stringify(record, null, 2);
		}

		if (errorText) {
			return errorText;
		}

		if (output == null) {
			return '';
		}

		return String(output);
	}

	function toolStatusFromState(state: string | undefined): ToolExecution['status'] {
		if (state === 'output-available') return 'success';
		if (state === 'output-error' || state === 'output-denied') return 'error';
		return 'running';
	}

	function isToolStateRunning(state: string | undefined): boolean {
		return state !== 'output-available' && state !== 'output-error' && state !== 'output-denied';
	}

	function normalizeToolName(name: string): string {
		return name
			.replace(/^mcp[\s_-]+[\w-]+[\s_-]+/, '')
			.replace(/-/g, '_');
	}

	function getToolStatusLabel(name: string): string {
		switch (normalizeToolName(name)) {
			case 'extract_document_text':
				return 'Reading your document...';
			case 'ask_user_question':
				return 'Waiting for your input...';
			case 'read_file':
			case 'search_files':
			case 'list_files':
				return 'Reviewing your site files...';
			case 'write_file':
			case 'edit_file':
			case 'rename_file':
			case 'delete_file':
			case 'add_page':
			case 'scaffold_template':
				return 'Updating your site files...';
			default:
				return 'Working on your site...';
		}
	}

	function formatElapsedTime(milliseconds: number): string {
		const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
		if (totalSeconds < 60) {
			return `${totalSeconds}s`;
		}

		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}

	function trackToolStart(toolCallId: string) {
		if (toolStartTimes[toolCallId]) {
			return;
		}

		toolStartTimes = {
			...toolStartTimes,
			[toolCallId]: Date.now()
		};
	}

	function resetRequestState() {
		isLoading = false;
		currentStatus = '';
		currentRequestId = null;
		activeStream = null;
		expectingContinuation = false;
		requestStartedAt = null;
		toolStartTimes = {};
		isReconnecting = false;
	}

	function getRunningToolFromParts(parts: UIMessagePart[]): RunningToolState | null {
		for (let i = parts.length - 1; i >= 0; i -= 1) {
			const part = parts[i];
			if (isToolPart(part) && isToolStateRunning(part.state)) {
				return {
					toolCallId: part.toolCallId,
					name: part.toolName,
					title: part.title,
					input: ((part.input as Record<string, any>) || {}) as Record<string, any>
				};
			}
		}

		return null;
	}

	function getCurrentRunningTool(
		stream: ActiveStreamMessage | null,
		messages: UIChatMessage[]
	): RunningToolState | null {
		if (stream) {
			const toolFromStream = getRunningToolFromParts(stream.parts);
			if (toolFromStream) {
				return toolFromStream;
			}
		}

		const lastAssistant = findLastAssistantMessage(messages);
		if (!lastAssistant) {
			return null;
		}

		return getRunningToolFromParts(lastAssistant.parts);
	}

	function getActivityTarget(tool: RunningToolState | null): string {
		if (!tool) return '';

		const { input } = tool;
		const pathValue =
			typeof input.file_path === 'string'
				? input.file_path
				: typeof input.path === 'string'
					? input.path
					: typeof input.directory_path === 'string'
						? input.directory_path
						: typeof input.oldPath === 'string'
							? input.oldPath
							: typeof input.page_name === 'string'
								? input.page_name
								: '';

		if (!pathValue) return '';

		const parts = pathValue.split('/');
		return parts[parts.length - 1] || pathValue;
	}

	function getActivitySummary(
		tool: RunningToolState | null,
		status: string,
		elapsedMs: number
	): { headline: string; detail: string } {
		const headline = status || 'Thinking...';

		if (!tool) {
			if (headline === 'Responding...') {
				return {
					headline,
					detail: 'Writing the response back into the chat.'
				};
			}

			return {
				headline,
				detail:
					elapsedMs > 20000
						? 'Still working through the next step. Larger requests can take a bit.'
						: 'Still working on the next step.'
			};
		}

		switch (normalizeToolName(tool.name)) {
			case 'codemode':
				return {
					headline,
					detail:
						elapsedMs < 8000
							? 'Reviewing the current project and planning the next edits.'
							: elapsedMs < 20000
								? 'Editing project files and checking the result.'
								: 'Still working through project changes. Larger site updates can take a bit.'
				};
			case 'extract_document_text':
				return {
					headline,
					detail: 'Reading the uploaded document so the agent can use that content in the site.'
				};
			case 'list_files':
			case 'search_files':
			case 'read_file':
				return {
					headline,
					detail: 'Inspecting the current project files before making changes.'
				};
			case 'write_file':
			case 'edit_file':
			case 'rename_file':
			case 'delete_file':
			case 'add_page':
				return {
					headline,
					detail: 'Updating project files for this request.'
				};
			case 'scaffold_template':
				return {
					headline,
					detail: 'Setting up the requested starting structure.'
				};
			case 'ask_user_question':
				return {
					headline,
					detail: 'The agent is waiting for your answer before it can continue.'
				};
			default:
				return {
					headline,
					detail: 'Running the next step for your request.'
				};
		}
	}

	function toDisplayMessages(
		source: UIChatMessage[],
		startTimes: Record<string, number>,
		nowMs: number
	): Message[] {
		return source.map((message) => {
			if (message.role === 'user') {
				return {
					role: 'user',
					content: getTextFromParts(message.parts)
				};
			}

			const blocks: ContentBlock[] = [];
			let currentText = '';
			let currentTools: ToolExecution[] = [];

			const flushText = () => {
				if (currentText.trim()) {
					blocks.push({ type: 'text', text: currentText });
					currentText = '';
				}
			};

			const flushTools = () => {
				if (currentTools.length > 0) {
					blocks.push({ type: 'tools', tools: [...currentTools] });
					currentTools = [];
				}
			};

			for (const part of message.parts) {
				if (part.type === 'text') {
					flushTools();
					currentText += part.text;
					continue;
				}

				if (isToolPart(part)) {
					flushText();
					const status = toolStatusFromState(part.state);
					const startTime = part.toolCallId ? startTimes[part.toolCallId] : undefined;
					currentTools.push({
						id: part.toolCallId,
						name: part.toolName,
						title: part.title,
						input: (part.input as Record<string, any>) || {},
						status,
						output: serializeToolOutput(part.output, part.errorText, part.toolName),
						startTime,
						elapsedTime:
							status === 'running' && startTime ? (nowMs - startTime) / 1000 : undefined
					});
				}
			}

			flushText();
			flushTools();

			return {
				role: 'assistant',
				content: getTextFromParts(message.parts),
				blocks
			};
		});
	}

	function findLastAssistantMessage(messages: UIChatMessage[]): UIChatMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i].role === 'assistant') {
				return messages[i];
			}
		}
	}

	function getPendingToolInteraction(messages: UIChatMessage[]): PendingToolInteraction | null {
		const lastAssistant = findLastAssistantMessage(messages);
		if (!lastAssistant) return null;

		const questionPart = lastAssistant.parts.find(
			(part) => isToolPart(part) && part.toolName === 'ask_user_question' && part.state === 'input-available'
		);

		if (questionPart && isToolPart(questionPart)) {
			return {
				toolCallId: questionPart.toolCallId,
				toolName: questionPart.toolName,
				input: (questionPart.input as Record<string, any>) || {}
			};
		}

		return null;
	}

	function createStreamState(requestId: string, continuation: boolean): ActiveStreamMessage {
		const lastAssistant = continuation ? findLastAssistantMessage(uiMessages) : undefined;

		return {
			id: requestId,
			messageId: lastAssistant?.id || generateId(),
			continuation,
			parts: lastAssistant ? cloneParts(lastAssistant.parts) : [],
			...(lastAssistant?.metadata ? { metadata: { ...lastAssistant.metadata } } : {})
		};
	}

	function flushActiveStreamToMessages(stream: ActiveStreamMessage) {
		const nextMessage: UIChatMessage = {
			id: stream.messageId,
			role: 'assistant',
			parts: cloneParts(stream.parts),
			...(stream.metadata ? { metadata: { ...stream.metadata } } : {})
		};

		const existingIndex = uiMessages.findIndex((message) => message.id === nextMessage.id);
		if (existingIndex >= 0) {
			uiMessages = uiMessages.map((message, index) => (index === existingIndex ? nextMessage : message));
		} else {
			uiMessages = [...uiMessages, nextMessage];
		}

		scrollToBottom();
	}

	function getCurrentMessagesForRequest(nextUserMessage?: UIChatMessage): UIChatMessage[] {
		return nextUserMessage ? [...uiMessages, nextUserMessage] : [...uiMessages];
	}

	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Bumped by closeSocket() (project switch / unmount). A reconnect attempt
	// that fails AFTER teardown compares its captured epoch and stops instead of
	// scheduling a retry into the next project or a dead component.
	let connectionEpoch = 0;
	// Bumped only when the project prop changes. Async history/CSRF/socket work
	// captures this value so a slow operation from the previous project cannot
	// write into, or connect on behalf of, the next project.
	let projectContextEpoch = 0;
	// SS-10: true while a silent reconnect is pending after a mid-request drop, so
	// we show a transient "reconnecting" state instead of a permanent dead-end
	// error bubble. Cleared when a connection succeeds or the component tears down.
	let isReconnecting = $state(false);

	function closeSocket() {
		connectionEpoch += 1;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		reconnectAttempts = 0;
		isReconnecting = false;
		csrfRefreshedThisCycle = false;

		if (socket) {
			ignoreNextSocketClose = true;
			socket.removeEventListener('message', handleSocketMessage);
			socket.removeEventListener('close', handleSocketClose);
			socket.removeEventListener('error', handleSocketError);
			socket.close();
		}

		socket = null;
		socketProjectId = null;
		socketPromise = null;
		socketPromiseProjectId = null;
	}

	function handleSocketClose(event: Event) {
		// SS-12: a superseded (orphaned) socket must not tear down the current one.
		// If this close came from a socket that is NOT the current `socket` (and a
		// current socket exists to protect), just clean up its own listeners and
		// return — do not null refs or schedule a reconnect. When `socket` is null
		// there is no newer socket to protect, so we proceed normally.
		const closedSocket = event.currentTarget as WebSocket | null;
		if (socket && closedSocket && closedSocket !== socket) {
			closedSocket.removeEventListener('message', handleSocketMessage);
			closedSocket.removeEventListener('close', handleSocketClose);
			closedSocket.removeEventListener('error', handleSocketError);
			return;
		}

		socket = null;
		socketProjectId = null;
		socketPromise = null;
		socketPromiseProjectId = null;

		// Clean up listeners on the closed socket
		if (closedSocket) {
			closedSocket.removeEventListener('message', handleSocketMessage);
			closedSocket.removeEventListener('close', handleSocketClose);
			closedSocket.removeEventListener('error', handleSocketError);
		}

		if (ignoreNextSocketClose) {
			ignoreNextSocketClose = false;
			return;
		}

		scheduleReconnect();
	}

	/**
	 * Shared "connection is gone" tail: keep the SS-10 presentation and schedule
	 * the next bounded-backoff attempt while this project remains mounted.
	 *
	 * Called from handleSocketClose AND from a reconnect attempt whose
	 * ensureSocket() promise rejected without a usable close event. The old code
	 * swallowed that rejection with a comment claiming handleSocketClose would
	 * retry — false in both real failure shapes: a rejected handshake fires
	 * `error` first and the SS-12 cleanup removes the socket's close listener,
	 * and a pre-socket failure (the CSRF fetch rejecting) has no socket at all.
	 * One such failure silently killed the loop — no further attempts, no
	 * surfaced error, isReconnecting stuck true forever.
	 */
	function scheduleReconnect() {
		const willReconnect = !!projectId;

		if (isLoading) {
			if (willReconnect) {
				// SS-10: don't append a permanent dead-end error while a silent
				// reconnect is about to run — show a transient reconnecting state and
				// keep the request "live" so the UI doesn't contradict itself.
				isReconnecting = true;
			} else {
				// No project is active, so there is no connection to recover.
				resetRequestState();
				isReconnecting = false;
				uiMessages = [
					...uiMessages,
					{
						id: generateId(),
						role: 'assistant',
						parts: [{ type: 'text', text: 'The response was interrupted. Send your message again.' }]
					}
				];
			}
		}

		// Attempt reconnection with exponential backoff
		if (willReconnect) {
			const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
			reconnectAttempts++;
			// Clear any prior reconnect timer before scheduling a new one: if
			// handleSocketClose fires more than once (e.g. an orphaned socket also
			// closes) the old timer would otherwise become untracked and survive
			// closeSocket()/unmount — a leaked reconnect that fires later (in tests,
			// into the next file, disrupting it; in prod, after teardown).
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
			const epoch = connectionEpoch;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				ensureSocket().catch(() => {
					// The attempt failed without a close event this component will see
					// (error-first handshake per SS-12, or a pre-socket CSRF failure).
					// Keep the loop alive — unless closeSocket() tore this connection
					// down in the meantime (project switch/unmount), in which case
					// retrying would leak a socket into the next context.
					if (epoch === connectionEpoch) {
						scheduleReconnect();
					}
				});
			}, delay);
		}
	}

	function handleSocketError(event: Event) {
		console.error('WebSocket error:', event);
		// The close handler will fire after error and handle reconnection
	}

	function isCurrentProjectContext(targetProjectId: string, targetEpoch: number): boolean {
		return projectId === targetProjectId && projectContextEpoch === targetEpoch;
	}

	async function ensureSocket(
		targetProjectId = projectId,
		targetEpoch = projectContextEpoch
	): Promise<WebSocket> {
		if (!targetProjectId) {
			throw new Error('Missing project id');
		}

		if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
			throw new Error('Project changed while connecting to the agent');
		}

		if (socket && socketProjectId === targetProjectId && socket.readyState === WebSocket.OPEN) {
			return socket;
		}

		if (socketPromise && socketPromiseProjectId === targetProjectId) {
			return socketPromise;
		}

		// A current-project caller must never inherit a connection created for a
		// different project. This is defensive in addition to the epoch checks:
		// socket ownership remains explicit at every reuse point.
		if (
			(socket && socketProjectId !== targetProjectId) ||
			(socketPromise && socketPromiseProjectId !== targetProjectId)
		) {
			closeSocket();
		}

		// SS-11: on a reconnect (reconnectAttempts > 0) a stale CSRF token is the
		// likely cause of the prior handshake failure, and re-reading the cookie
		// would loop with the same rejected token. Force a fresh /api/csrf round-trip
		// once per reconnect cycle so the next handshake uses a fresh token; the
		// guard prevents a refresh-storm across successive attempts.
		let csrf: string;
		if (reconnectAttempts > 0 && !csrfRefreshedThisCycle) {
			csrfRefreshedThisCycle = true;
			try {
				csrf = await refreshCsrfToken();
			} catch {
				csrf = await getCsrfToken();
			}
		} else {
			csrf = await getCsrfToken();
		}

		if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
			throw new Error('Project changed while connecting to the agent');
		}

		// Awaiting the token yields the event loop, so a concurrent ensureSocket()
		// call may have already started or opened a socket. Re-check before creating
		// a second one.
		if (socket && socketProjectId === targetProjectId && socket.readyState === WebSocket.OPEN) {
			return socket;
		}
		if (socketPromise && socketPromiseProjectId === targetProjectId) {
			return socketPromise;
		}

		const nextSocket = new WebSocket(
			resolveWebSocketPath(`/api/agents/site-builder/${targetProjectId}`, { csrf })
		);
		socket = nextSocket;
		socketProjectId = targetProjectId;

		nextSocket.addEventListener('message', handleSocketMessage);
		nextSocket.addEventListener('close', handleSocketClose);
		nextSocket.addEventListener('error', handleSocketError);

		const nextPromise = new Promise<WebSocket>((resolve, reject) => {
			const onOpen = () => {
				nextSocket.removeEventListener('error', onError);
				if (
					!isCurrentProjectContext(targetProjectId, targetEpoch) ||
					socket !== nextSocket ||
					socketProjectId !== targetProjectId
				) {
					nextSocket.removeEventListener('message', handleSocketMessage);
					nextSocket.removeEventListener('close', handleSocketClose);
					nextSocket.removeEventListener('error', handleSocketError);
					if (socketPromise === nextPromise) {
						socketPromise = null;
						socketPromiseProjectId = null;
					}
					if (socket === nextSocket) {
						socket = null;
						socketProjectId = null;
					}
					nextSocket.close();
					reject(new Error('Project changed while connecting to the agent'));
					return;
				}
				reconnectAttempts = 0; // Reset on successful connection
				csrfRefreshedThisCycle = false; // Fresh cycle next time we need one
				isReconnecting = false; // SS-10: silent reconnect succeeded
				resolve(nextSocket);
			};

			const onError = () => {
				nextSocket.removeEventListener('open', onOpen);
				// SS-12: the failed socket keeps its message/close/error listeners.
				// If we only null the refs, a later close on this orphaned socket
				// would run handleSocketClose against a newer good socket. Remove its
				// listeners so its late events cannot tear down the current socket.
				nextSocket.removeEventListener('message', handleSocketMessage);
				nextSocket.removeEventListener('close', handleSocketClose);
				nextSocket.removeEventListener('error', handleSocketError);
				if (socketPromise === nextPromise) {
					socketPromise = null;
					socketPromiseProjectId = null;
				}
				if (socket === nextSocket) {
					socket = null;
					socketProjectId = null;
				}
				reject(new Error('Unable to connect to the agent'));
			};

			nextSocket.addEventListener('open', onOpen, { once: true });
			nextSocket.addEventListener('error', onError, { once: true });
		});

		socketPromise = nextPromise;
		socketPromiseProjectId = targetProjectId;
		return nextPromise;
	}

	async function loadChatHistory(targetProjectId: string, targetEpoch = projectContextEpoch) {
		if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
			return;
		}
		historyLoadFailed = false;
		try {
			const response = await apiResponseFetch(resolvePath(`/api/agents/site-builder/${targetProjectId}/get-messages`), {
				credentials: 'include'
			});

			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}

			if (!response.ok) {
				// SS-49: a non-ok response is a load FAILURE, not empty history — keep
				// whatever transcript we have and surface a retry affordance instead
				// of rendering a wiped conversation.
				console.error(`Failed to load chat history (${response.status})`);
				historyLoadFailed = true;
				return;
			}

			const data = await response.json();
			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}
			uiMessages = Array.isArray(data) ? (data as UIChatMessage[]) : [];
			await tick();
			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}
			scrollToBottom();
		} catch (error) {
			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}
			if (isApiError(error) && error.statusCode === 401 && error.code === 'authentication_required') {
				return;
			}

			// SS-49: same as above for network/parse failures.
			console.error('Failed to load chat history:', error);
			historyLoadFailed = true;
		}
	}

	function retryLoadChatHistory() {
		if (!projectId) return;
		void loadChatHistory(projectId, projectContextEpoch);
	}

	function sendSocketMessage(payload: Record<string, unknown>) {
		if (!socket || socketProjectId !== projectId || socket.readyState !== WebSocket.OPEN) {
			throw new Error('Agent connection is not open');
		}

		socket.send(JSON.stringify(payload));
	}

	async function refreshAgentCredential(targetProjectId: string, targetEpoch: number): Promise<void> {
		const response = await apiResponseFetch(
			resolvePath(`/api/agents/site-builder/${targetProjectId}/refresh-credential`),
			{ method: 'POST' }
		);
		if (!response.ok) {
			throw new Error(`Unable to refresh the agent connection (${response.status})`);
		}
		if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
			throw new Error('Project changed while refreshing the agent connection');
		}
	}

	async function prepareSocketForModelTurn(
		targetProjectId: string,
		targetEpoch: number
	): Promise<WebSocket> {
		const ws = await ensureSocket(targetProjectId, targetEpoch);
		await refreshAgentCredential(targetProjectId, targetEpoch);
		if (
			!isCurrentProjectContext(targetProjectId, targetEpoch) ||
			socket !== ws ||
			socketProjectId !== targetProjectId ||
			ws.readyState !== WebSocket.OPEN
		) {
			throw new Error('Agent connection closed before the request was sent');
		}
		return ws;
	}

	async function sendChatRequest(
		messagesForRequest: UIChatMessage[],
		targetProjectId: string,
		targetEpoch: number
	) {
		const ws = await prepareSocketForModelTurn(targetProjectId, targetEpoch);
		const requestId = generateId();
		const startedAt = Date.now();

		currentRequestId = requestId;
		requestStartedAt = startedAt;
		clockNow = startedAt;
		toolStartTimes = {};
		currentStatus = 'Thinking...';
		isLoading = true;
		activeStream = null;
		expectingContinuation = false;
		// SS-9: a genuinely new request starts fresh; drop stale cancellation markers.
		cancelledRequestIds = new Set();

		ws.send(
			JSON.stringify({
				type: AgentMessageType.CF_AGENT_USE_CHAT_REQUEST,
				id: requestId,
				init: {
					method: 'POST',
					body: JSON.stringify({
						messages: messagesForRequest,
						trigger: 'submit-message'
					})
				}
			})
		);
	}

	function handleStreamChunk(chunk: UIStreamChunk) {
		if (!activeStream) {
			return;
		}

		if (chunk.type === 'error') {
			activeStream.parts.push({ type: 'text', text: chunk.errorText, state: 'done' });
			flushActiveStreamToMessages(activeStream);
			return;
		}

		const handled = applyChunkToParts(activeStream.parts, chunk);

		if (!handled) {
			if (chunk.type === 'start' && chunk.messageId && !activeStream.continuation) {
				activeStream.messageId = chunk.messageId;
			}

			if (
				(chunk.type === 'start' || chunk.type === 'finish' || chunk.type === 'message-metadata') &&
				chunk.messageMetadata
			) {
				activeStream.metadata = activeStream.metadata
					? { ...activeStream.metadata, ...chunk.messageMetadata }
					: { ...chunk.messageMetadata };
			}
		}

		switch (chunk.type) {
			case 'text-start':
			case 'text-delta':
				currentStatus = 'Responding...';
				break;
			case 'tool-input-start':
			case 'tool-input-available':
				trackToolStart(chunk.toolCallId);
				currentStatus = getToolStatusLabel(chunk.toolName);
				break;
			case 'tool-output-available': {
				const toolPart = activeStream.parts.find(
					(part) => isToolPart(part) && part.toolCallId === chunk.toolCallId
				);

				if (toolPart && isToolPart(toolPart) && MUTATING_TOOLS.has(toolPart.toolName)) {
					onUpdate();
				}
				break;
			}
		}

		flushActiveStreamToMessages(activeStream);
	}

	function parseStreamChunkBody(body: string): UIStreamChunk {
		try {
			return JSON.parse(body) as UIStreamChunk;
		} catch (error) {
			if (!body.startsWith('data:')) {
				throw error;
			}

			const payload = body.slice('data:'.length).replace(/[\r\n]+$/, '');
			return JSON.parse(payload) as UIStreamChunk;
		}
	}

	function handleSocketMessage(event: MessageEvent<string>) {
		if (event.currentTarget !== socket || socketProjectId !== projectId) {
			return;
		}
		if (typeof event.data !== 'string') return;

		let data: any;
		try {
			data = JSON.parse(event.data);
		} catch {
			// Malformed (non-JSON) frame on the agent socket: a transport issue.
			// Still drop the frame, but say so — silent drops made transport
			// corruption invisible.
			console.warn('Dropping malformed (non-JSON) agent-socket frame');
			return;
		}

		switch (data.type) {
			case AgentMessageType.CF_AGENT_CHAT_CLEAR:
				uiMessages = [];
				break;
			case AgentMessageType.CF_AGENT_CHAT_MESSAGES:
				uiMessages = Array.isArray(data.messages) ? (data.messages as UIChatMessage[]) : [];
				// The agent socket just delivered the authoritative history, so a
				// previously failed HTTP history load is moot (SS-49).
				historyLoadFailed = false;
				scrollToBottom();
				break;
			case AgentMessageType.CF_AGENT_MESSAGE_UPDATED:
				uiMessages = mergeUpdatedMessage(uiMessages, data.message as UIChatMessage);
				scrollToBottom();
				break;
			case AgentMessageType.CF_AGENT_STREAM_RESUME_NONE:
				expectingContinuation = false;
				resetRequestState();
				break;
			case AgentMessageType.CF_AGENT_STREAM_RESUMING: {
				const continuation = expectingContinuation;
				expectingContinuation = false;
				currentRequestId = data.id;
				activeStream = createStreamState(data.id, continuation);
				try {
					sendSocketMessage({
						type: AgentMessageType.CF_AGENT_STREAM_RESUME_ACK,
						id: data.id
					});
				} catch (error) {
					console.error('Error acknowledging resumed stream:', error);
				}
				break;
			}
			case AgentMessageType.CF_AGENT_USE_CHAT_RESPONSE: {
				// SS-9: drop frames for a request the user stopped. Without this a late
				// frame would recreate activeStream below and resume appending text.
				if (typeof data.id === 'string' && cancelledRequestIds.has(data.id)) {
					break;
				}

				if (!activeStream || activeStream.id !== data.id) {
					const continuation = data.continuation === true || expectingContinuation;
					activeStream = createStreamState(data.id, continuation);
				}

				if (data.body?.trim()) {
					try {
						handleStreamChunk(parseStreamChunkBody(data.body));
					} catch (error) {
						// Error frames legitimately carry the human-readable error text as a
						// plain (non-JSON) body. Observed live with the CAIL quota message:
						// the transport sends `{error:true, body:"<text>"}` first and then the
						// SAME text as a proper `{"type":"error","errorText":…}` JSON chunk,
						// which handleStreamChunk renders. So rendering the plain body here
						// would show the error twice: recognize the shape and stay quiet.
						// Only a body that looks encoded (broken JSON / SSE framing) is a
						// genuinely malformed frame — warn and surface a visible fallback so
						// the user is not left hanging.
						const bodyText = typeof data.body === 'string' ? data.body.trim() : '';
						const looksLikeProse =
							!!bodyText &&
							!bodyText.startsWith('data:') &&
							!bodyText.startsWith('{') &&
							!bodyText.startsWith('[');
						if (!(data.error && looksLikeProse)) {
							console.warn('Failed to parse stream chunk', error);
							if (data.error && activeStream) {
								activeStream.parts.push({
									type: 'text',
									text: 'Something went wrong while generating this response.',
									state: 'done'
								});
							}
						}
					}
				}

				if (data.done || data.error) {
					if (activeStream) {
						flushActiveStreamToMessages(activeStream);
					}
					resetRequestState();
				}
				break;
			}
		}
	}

	let messages = $derived(toDisplayMessages(uiMessages, toolStartTimes, clockNow));
	let pendingToolInteraction = $derived(getPendingToolInteraction(uiMessages));
	let requestElapsedMs = $derived(requestStartedAt ? Math.max(0, clockNow - requestStartedAt) : 0);
	let requestElapsedLabel = $derived(formatElapsedTime(requestElapsedMs));
	let currentRunningTool = $derived(getCurrentRunningTool(activeStream, uiMessages));
	let activitySummary = $derived(getActivitySummary(currentRunningTool, currentStatus, requestElapsedMs));
	let activeToolTarget = $derived(getActivityTarget(currentRunningTool));

	$effect(() => {
		return () => {
			closeSocket();
		};
	});

	$effect(() => {
		if (!isLoading) {
			return;
		}

		clockNow = Date.now();
		const intervalId = setInterval(() => {
			clockNow = Date.now();
		}, 500);

		return () => {
			clearInterval(intervalId);
		};
	});

	let previousProjectId = $state<string | null>(null);
	$effect(() => {
		if (!projectId || projectId === previousProjectId) {
			return;
		}

		const targetProjectId = projectId;
		projectContextEpoch += 1;
		requestPreparationSequence += 1;
		isPreparingRequest = false;
		const targetEpoch = projectContextEpoch;
		previousProjectId = targetProjectId;
		input = '';
		attachedFile = null;
		resetRequestState();
		uiMessages = [];
		closeSocket();

		void (async () => {
			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}
			await loadChatHistory(targetProjectId, targetEpoch);
			if (!isCurrentProjectContext(targetProjectId, targetEpoch)) {
				return;
			}
			try {
				await ensureSocket(targetProjectId, targetEpoch);
			} catch (error) {
				if (isCurrentProjectContext(targetProjectId, targetEpoch)) {
					console.error('Failed to connect agent socket:', error);
				}
			}
		})();
	});

	function stopRequest() {
		if (!currentRequestId) {
			return;
		}
		requestPreparationSequence += 1;
		isPreparingRequest = false;

		// SS-9: remember the cancelled id so a late CF_AGENT_USE_CHAT_RESPONSE frame
		// for it can't recreate activeStream and resume appending after the stop.
		cancelledRequestIds.add(currentRequestId);

		try {
			sendSocketMessage({
				type: AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
				id: currentRequestId
			});
		} catch (error) {
			console.error('Error stopping request:', error);
		}

		resetRequestState();
	}

	async function uploadFile(file: File, targetProjectId: string): Promise<string> {
		const formData = new FormData();
		formData.append('file', file);

		const response = await csrfFetch(resolvePath(`/api/projects/${targetProjectId}/upload`), {
			method: 'POST',
			body: formData
		});

		if (!response.ok) {
			await handleApiError(response);
		}

		const data = await response.json();
		return data.filename;
	}

	async function ensureReadyForRequest(preparation?: RequestPreparation): Promise<boolean> {
		if (!onBeforeSend) {
			return true;
		}

		try {
			return await onBeforeSend();
		} catch (error) {
			console.error('Error preparing agent request:', error);
			if (!preparation || isCurrentRequestPreparation(preparation)) {
				currentStatus = 'Unable to prepare request.';
			}
			return false;
		}
	}

	interface RequestPreparation {
		id: number;
		projectId: string;
		projectEpoch: number;
	}

	function beginRequestPreparation(allowWhileLoading = false): RequestPreparation | null {
		if ((!allowWhileLoading && isLoading) || isPreparingRequest) return null;

		const preparation = {
			id: ++requestPreparationSequence,
			projectId,
			projectEpoch: projectContextEpoch
		};
		isPreparingRequest = true;
		return preparation;
	}

	function isCurrentRequestPreparation(preparation: RequestPreparation): boolean {
		return (
			preparation.id === requestPreparationSequence &&
			isCurrentProjectContext(preparation.projectId, preparation.projectEpoch)
		);
	}

	function finishRequestPreparation(preparation: RequestPreparation) {
		if (preparation.id === requestPreparationSequence) {
			isPreparingRequest = false;
		}
	}

	async function sendMessage() {
		const userMessage = input.trim();
		if (!userMessage) return;

		const preparation = beginRequestPreparation();
		if (!preparation) return;

		const fileToUpload = attachedFile;
		try {
			const ready = await ensureReadyForRequest(preparation);
			if (!ready || !isCurrentRequestPreparation(preparation)) return;

			input = '';
			attachedFile = null;
			if (fileInput) fileInput.value = '';

			// Upload file FIRST if attached (skip on retry - already uploaded)
			// This ensures we don't show user message if upload fails
			let uploadedFilename: string | undefined;
			if (fileToUpload) {
				isUploading = true;
				uploadedFilename = await uploadFile(fileToUpload, preparation.projectId);
				if (!isCurrentRequestPreparation(preparation)) return;
				onUpdate(); // Refresh preview - uploaded file may be referenced
				isUploading = false;
			}

			// Add user message AFTER successful upload so failed uploads don't create a chat turn
			let messageContent = userMessage;
			if (fileToUpload) {
				messageContent += ` [Attached: ${fileToUpload.name}]`;
			}
			if (uploadedFilename) {
				messageContent += `\n\n[File uploaded: ${uploadedFilename} (${(fileToUpload!.size / 1024).toFixed(1)}KB)]`;
			}
			const nextUserMessage: UIChatMessage = {
				id: generateId(),
				role: 'user',
				parts: [{ type: 'text', text: messageContent }]
			};
			uiMessages = [...uiMessages, nextUserMessage];

			scrollToBottom();
			await sendChatRequest(
				getCurrentMessagesForRequest(nextUserMessage),
				preparation.projectId,
				preparation.projectEpoch
			);
		} catch (error: any) {
			if (!isCurrentRequestPreparation(preparation)) return;
			console.error('Error sending message:', error);
			const message = getErrorMessage(error);
			resetRequestState();
			uiMessages = [
				...uiMessages,
				{
					id: generateId(),
					role: 'assistant',
					parts: [{ type: 'text', text: message }]
				}
			];
		} finally {
			isUploading = false;
			finishRequestPreparation(preparation);
		}
	}

	/**
	 * Programmatically send a message to the agent as if the user typed it.
	 * Exposed via `bind:this` so the editor page can, e.g., ask the agent to fix
	 * accessibility findings. No-ops while a request is already in flight.
	 */
	export async function sendPrompt(text: string) {
		if (isLoading || isPreparingRequest) return;
		input = text;
		await sendMessage();
	}

	async function rejectUserQuestion() {
		const interaction = pendingToolInteraction;
		if (!interaction) return;

		const preparation = beginRequestPreparation(true);
		if (!preparation) return;

		try {
			const ready = await ensureReadyForRequest(preparation);
			if (!ready || !isCurrentRequestPreparation(preparation)) return;
			const ws = await prepareSocketForModelTurn(preparation.projectId, preparation.projectEpoch);
			if (!isCurrentRequestPreparation(preparation)) return;
			const output = {
				answer: '',
				declined: true
			};
			uiMessages = applyLocalToolOutput(uiMessages, interaction.toolCallId, output);
			ws.send(JSON.stringify({
				type: AgentMessageType.CF_AGENT_TOOL_RESULT,
				toolCallId: interaction.toolCallId,
				toolName: interaction.toolName,
				output,
				autoContinue: true
			}));

			const startedAt = Date.now();
			expectingContinuation = true;
			isLoading = true;
			requestStartedAt = startedAt;
			clockNow = startedAt;
			toolStartTimes = {};
			currentStatus = 'Continuing...';
		} catch (error) {
			if (isCurrentRequestPreparation(preparation)) {
				console.error('Error denying tool:', error);
				currentStatus = 'Unable to send response.';
			}
		} finally {
			finishRequestPreparation(preparation);
		}
	}

	function getPendingQuestions(input: Record<string, any>): UserQuestionPrompt[] {
		if (typeof input.question === 'string' && input.question.length > 0) {
			return [
				{
					header: typeof input.context === 'string' ? 'Clarification' : undefined,
					question: input.question,
					options: Array.isArray(input.options)
						? input.options
								.map((option) =>
									typeof option === 'string'
										? { label: option }
										: option && typeof option.label === 'string'
											? option
											: null
								)
								.filter((option): option is QuestionOption => option !== null)
						: undefined,
					placeholder: 'Write your answer'
				}
			];
		}

		if (!Array.isArray(input.questions)) {
			return [];
		}

		return input.questions.filter((question): question is UserQuestionPrompt => {
			return typeof question?.question === 'string' && question.question.length > 0;
		});
	}

	async function submitUserQuestionAnswers({ answers, annotations }: UserQuestionSubmission) {
		const interaction = pendingToolInteraction;
		if (!interaction || !interaction.toolCallId) return;

		const preparation = beginRequestPreparation(true);
		if (!preparation) return;

		try {
			const ready = await ensureReadyForRequest(preparation);
			if (!ready || !isCurrentRequestPreparation(preparation)) return;
			const questions = getPendingQuestions(interaction.input || {});
			const primaryQuestion = questions[0]?.question;
			const answer =
				(primaryQuestion ? answers[primaryQuestion] : undefined) ||
				Object.values(answers)[0] ||
				'';
			const output = {
				...(primaryQuestion ? { question: primaryQuestion } : {}),
				answer,
				...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {})
			};

			const ws = await prepareSocketForModelTurn(preparation.projectId, preparation.projectEpoch);
			if (!isCurrentRequestPreparation(preparation)) return;
			uiMessages = applyLocalToolOutput(uiMessages, interaction.toolCallId, output);
			ws.send(JSON.stringify({
				type: AgentMessageType.CF_AGENT_TOOL_RESULT,
				toolCallId: interaction.toolCallId,
				toolName: interaction.toolName,
				output,
				autoContinue: true
			}));
			const startedAt = Date.now();
			expectingContinuation = true;
			isLoading = true;
			requestStartedAt = startedAt;
			clockNow = startedAt;
			toolStartTimes = {};
			currentStatus = 'Continuing...';
		} catch (error) {
			if (isCurrentRequestPreparation(preparation)) {
				console.error('Error answering question:', error);
				currentStatus = 'Unable to send your answer.';
			}
		} finally {
			finishRequestPreparation(preparation);
		}
	}

	function scrollToBottom() {
		// Use requestAnimationFrame for more reliable scroll timing after DOM updates
		requestAnimationFrame(() => {
			if (messagesContainer) {
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
			}
		});
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function handleFileUpload() {
		fileInput?.click();
	}

	function onFileSelected(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files && target.files.length > 0) {
			attachedFile = target.files[0];
		}
	}

	function removeAttachment() {
		if (isLoading || isPreparingRequest) return;
		attachedFile = null;
		if (fileInput) {
			fileInput.value = '';
		}
	}
</script>

<div class="agent-chat">
	<div class="messages" bind:this={messagesContainer}>
		{#if historyLoadFailed}
			<!-- SS-49: load failure is not "no history" — never show a wiped
			     transcript for a transient error. -->
			<div class="history-error" role="alert">
				<p class="history-error-title">Your chat history could not be loaded.</p>
				<p class="history-error-detail">The conversation is still saved; this is a loading problem.</p>
				<button class="history-error-retry" type="button" onclick={retryLoadChatHistory}>
					Retry loading history
				</button>
			</div>
		{/if}
		{#if messages.length === 0}
			{#if !historyLoadFailed}
				<div class="welcome">
					<h3>Your site</h3>
					<p>Describe what you'd like to create or change.</p>
				</div>
			{/if}
		{:else}
			{#each messages as message}
				<div class="message {message.role}">
					{#if message.blocks && message.blocks.length > 0}
						{#each message.blocks as block}
							{#if block.type === 'text' && block.text}
								<MessageContent content={block.text} role={message.role} />
							{:else if block.type === 'tools' && block.tools}
								<div class="tools-section">
									{#each block.tools as tool}
										<ToolExecutionCard {tool} />
									{/each}
								</div>
							{/if}
						{/each}
					{:else if message.content}
						<!-- Fallback for messages without blocks (user messages, errors) -->
						<MessageContent content={message.content} role={message.role} />
					{/if}
				</div>
			{/each}

		{/if}

		<!-- Pending tool interaction card - {#key} forces re-render on async state changes -->
		{#key pendingToolInteraction}
			{#if pendingToolInteraction}
				<AskUserQuestionCard
					questions={getPendingQuestions(pendingToolInteraction.input || {})}
					busy={isPreparingRequest}
					onSubmit={submitUserQuestionAnswers}
					onReject={rejectUserQuestion}
				/>
			{/if}
		{/key}

		{#if isLoading}
			<div class="active-status-card" aria-live="polite">
				<div class="active-status-header">
					<div class="active-status-heading">
						<div class="active-status-title-row">
							<Loader2 size={16} class="animate-spin" />
							<span class="active-status-title">{activitySummary.headline}</span>
						</div>
						<p class="active-status-detail">{activitySummary.detail}</p>
					</div>
					<span class="active-status-time">{requestElapsedLabel}</span>
				</div>
				{#if activeToolTarget}
					<div class="active-status-meta">
						<span class="status-pill muted">{activeToolTarget}</span>
					</div>
				{/if}
				<div class="active-status-bar" aria-hidden="true">
					<span class="active-status-bar-fill"></span>
				</div>
			</div>
		{/if}
	</div>

	<div class="input-container">
		<div class="input-row">
			<textarea
				bind:value={input}
				onkeydown={handleKeyDown}
				oninput={(e) => {
					const target = e.target as HTMLTextAreaElement;
					target.style.height = 'auto';
					target.style.height = Math.min(target.scrollHeight, 200) + 'px';
				}}
				placeholder={messages.length > 0 ? "Ask a follow-up..." : "Describe what you'd like to build..."}
				aria-label="Message to the assistant"
				disabled={isLoading || isPreparingRequest}
				class="input-field"
				rows="1"
			></textarea>
			{#if isLoading}
				<button
					onclick={stopRequest}
					class="stop-button"
					title="Stop request"
					aria-label="Stop request"
				>
					<Square size={16} />
				</button>
			{:else}
				<button
					onclick={() => sendMessage()}
					disabled={!input.trim() || isPreparingRequest}
					class="send-button"
					title="Send message"
					aria-label="Send message"
				>
					<Send size={18} />
				</button>
			{/if}
		</div>

		<!-- File attachment indicator -->
		{#if attachedFile}
			<div class="attachment-indicator">
				<Paperclip size={14} />
				<span class="filename">{attachedFile.name}</span>
				<span class="filesize">({(attachedFile.size / 1024).toFixed(1)}KB)</span>
				<button
					class="remove-btn"
					disabled={isLoading || isPreparingRequest}
					onclick={removeAttachment}
					title="Remove attachment"
					aria-label={`Remove ${attachedFile.name}`}
				>
					<X size={14} />
				</button>
			</div>
		{/if}

		{#if isUploading}
			<div class="upload-status">
				<Loader2 size={14} class="animate-spin" />
				<span>Uploading file...</span>
			</div>
		{/if}

		<div class="action-buttons">
			<input
				type="file"
				bind:this={fileInput}
				onchange={onFileSelected}
				style="display: none;"
				accept="image/*,.pdf,.txt,.md,.json,.csv"
			/>
			<button
				class="icon-btn"
				disabled={isLoading || isPreparingRequest}
				title="Attach file"
				aria-label="Attach file"
				onclick={handleFileUpload}
			>
				<span class="plus-icon">+</span>
			</button>
		</div>
	</div>
</div>

<style>
	.agent-chat {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-secondary);
	}

	.messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.welcome {
		text-align: center;
		padding: 3rem 2rem;
	}

	.history-error {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-elevated);
	}

	.history-error-title {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.history-error-detail {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.history-error-retry {
		align-self: flex-start;
		margin-top: 0.25rem;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-size: 0.8125rem;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.history-error-retry:hover {
		background: var(--color-bg-tertiary);
	}

	.welcome h3 {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
		color: var(--color-text-primary);
	}

	.welcome p {
		color: var(--color-text-secondary);
		margin-bottom: 0;
		font-size: 0.9375rem;
	}

	.message {
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.message.user {
		align-self: flex-end;
		max-width: 85%;
	}

	.message.user :global(.message-content) {
		background: var(--color-primary-light, #e6f4f4);
		color: var(--color-text-primary, #1f2937);
		padding: 0.625rem 0.875rem;
		border-radius: var(--radius-lg);
		border-bottom-right-radius: var(--radius-sm);
		border-left: 3px solid var(--color-primary, #0d7377);
		font-size: 0.9375rem;
	}

	.message.assistant {
		align-self: flex-start;
		width: 100%;
	}

	.message.assistant :global(.message-content) {
		color: var(--color-text-primary);
		padding: 0.25rem 0;
		font-size: 0.9375rem;
		line-height: 1.6;
	}

	.tools-section {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.25rem;
	}

	.active-status-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 8%, transparent), transparent 55%),
			var(--color-bg-elevated);
		border: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border));
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.active-status-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.active-status-heading {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.active-status-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.active-status-title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.active-status-detail {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.active-status-time {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.active-status-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.status-pill {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-primary) 12%, transparent);
		color: var(--color-primary);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.status-pill.muted {
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
	}

	.active-status-bar {
		height: 0.375rem;
		background: var(--color-bg-secondary);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.active-status-bar-fill {
		display: block;
		width: 32%;
		height: 100%;
		border-radius: inherit;
		background: linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 45%, white));
		animation: status-slide 1.4s ease-in-out infinite;
	}

	.input-container {
		padding: 1rem;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg-elevated);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.input-field {
		flex: 1;
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-primary);
		color: var(--color-text-primary);
		font-size: 0.9375rem;
		font-family: var(--font-sans);
		transition: all 0.15s ease;
		resize: none;
		overflow-y: auto;
		min-height: 42px;
		max-height: 200px;
		line-height: 1.5;
	}

	.input-field:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: var(--shadow-glow-primary);
	}

	.input-field:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.input-field::placeholder {
		color: var(--color-text-muted);
	}

	.send-button {
		width: 42px;
		height: 42px;
		border-radius: var(--radius-lg);
		border: none;
		background: var(--color-primary);
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		flex-shrink: 0;
		cursor: pointer;
	}

	.send-button:hover:not(:disabled) {
		background: var(--color-primary-hover);
		transform: scale(1.02);
	}

	.send-button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.stop-button {
		width: 42px;
		height: 42px;
		border-radius: var(--radius-lg);
		border: none;
		background: var(--color-error);
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		flex-shrink: 0;
		cursor: pointer;
	}

	.stop-button:hover {
		background: var(--color-error-hover, #c53030);
		transform: scale(1.02);
	}

	.attachment-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-primary-light);
		border: 1px solid var(--color-primary);
		border-radius: var(--radius-md);
		font-size: 0.8125rem;
	}

	.attachment-indicator .filename {
		color: var(--color-primary);
		font-weight: 500;
	}

	.attachment-indicator .filesize {
		color: var(--color-text-tertiary);
		font-size: 0.75rem;
	}

	.remove-btn {
		padding: 0.25rem;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		margin-left: auto;
	}

	.remove-btn:hover {
		background: var(--color-bg-secondary);
		color: var(--color-error);
	}

	.upload-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-info-light);
		border: 1px solid var(--color-info);
		border-radius: var(--radius-md);
		font-size: 0.8125rem;
		color: var(--color-info);
	}

	.action-buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.icon-btn {
		width: 34px;
		height: 34px;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.125rem;
		transition: all 0.15s ease;
		cursor: pointer;
	}

	.icon-btn:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
		color: var(--color-text-primary);
	}

	.plan-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		font-size: 0.8125rem;
		font-weight: 500;
		transition: all 0.15s ease;
		cursor: pointer;
	}

	.plan-btn:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
	}

	.plan-btn.active {
		background: var(--color-primary-light);
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.plan-btn.active:hover {
		background: var(--color-primary-lighter);
	}

	.play-icon {
		font-size: 0.625rem;
	}

	.plus-icon {
		font-weight: 400;
		font-size: 1.25rem;
		line-height: 1;
	}

	:global(.animate-spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes status-slide {
		0% {
			transform: translateX(-110%);
		}
		50% {
			transform: translateX(140%);
		}
		100% {
			transform: translateX(320%);
		}
	}
</style>
