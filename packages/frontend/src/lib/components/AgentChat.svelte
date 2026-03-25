<script lang="ts">
	import { tick } from 'svelte';
	import { Send, Loader2, X, Paperclip, Square } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';
	import { resolveWebSocketPath } from '$lib/utils/ws';
	import { getErrorMessage } from '$lib/api/errors';
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
		tools?: ToolExecution[]; // Deprecated, keeping for backwards compat
	}

	interface ToolExecution {
		id?: string;
		name: string;
		input: Record<string, any>;
		status?: 'running' | 'success' | 'error';
		output?: string;
	}

	interface PendingToolInteraction {
		toolCallId: string;
		toolName: string;
		input: Record<string, any>;
	}

	import type { QuestionOption, UserQuestionPrompt, UserQuestionSubmission } from './AskUserQuestionCard.svelte';

	let {
		projectId,
		onUpdate
	}: {
		projectId: string;
		onUpdate: () => void;
	} = $props();

	let uiMessages = $state<UIChatMessage[]>([]);
	let input = $state('');
	let isLoading = $state(false);
	let messagesContainer: HTMLDivElement;
	let fileInput: HTMLInputElement;
	let currentStatus = $state<string>('');
	let attachedFile = $state<File | null>(null);
	let isUploading = $state(false);
	let socket = $state<WebSocket | null>(null);
	let socketPromise: Promise<WebSocket> | null = null;
	let activeStream = $state<ActiveStreamMessage | null>(null);
	let currentRequestId = $state<string | null>(null);
	let expectingContinuation = $state(false);
	let ignoreNextSocketClose = $state(false);

	const MAX_DISPLAYED_MESSAGES = 10;
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

	function toDisplayMessages(source: UIChatMessage[]): Message[] {
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
					currentTools.push({
						id: part.toolCallId,
						name: part.toolName,
						input: (part.input as Record<string, any>) || {},
						status: toolStatusFromState(part.state),
						output: serializeToolOutput(part.output, part.errorText, part.toolName)
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
	const MAX_RECONNECT_ATTEMPTS = 5;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	function closeSocket() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		reconnectAttempts = 0;

		if (socket) {
			ignoreNextSocketClose = true;
			socket.removeEventListener('message', handleSocketMessage);
			socket.removeEventListener('close', handleSocketClose);
			socket.removeEventListener('error', handleSocketError);
			socket.close();
		}

		socket = null;
		socketPromise = null;
	}

	function handleSocketClose() {
		const closedSocket = socket;
		socket = null;
		socketPromise = null;

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

		if (isLoading) {
			isLoading = false;
			currentStatus = '';
			currentRequestId = null;
			activeStream = null;
			expectingContinuation = false;

			uiMessages = [
				...uiMessages,
				{
					id: generateId(),
					role: 'assistant',
					parts: [{ type: 'text', text: 'Connection lost while the agent was responding.' }]
				}
			];
		}

		// Attempt reconnection with exponential backoff
		if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && projectId) {
			const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
			reconnectAttempts++;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				ensureSocket().catch(() => {
					// Reconnection failed, will retry via handleSocketClose
				});
			}, delay);
		}
	}

	function handleSocketError(event: Event) {
		console.error('WebSocket error:', event);
		// The close handler will fire after error and handle reconnection
	}

	async function ensureSocket(targetProjectId = projectId): Promise<WebSocket> {
		if (!targetProjectId) {
			throw new Error('Missing project id');
		}

		if (socket && socket.readyState === WebSocket.OPEN) {
			return socket;
		}

		if (socketPromise) {
			return socketPromise;
		}

		const nextSocket = new WebSocket(resolveWebSocketPath(`/api/agents/site-builder/${targetProjectId}`));
		socket = nextSocket;

		nextSocket.addEventListener('message', handleSocketMessage);
		nextSocket.addEventListener('close', handleSocketClose);
		nextSocket.addEventListener('error', handleSocketError);

		socketPromise = new Promise((resolve, reject) => {
			const onOpen = () => {
				nextSocket.removeEventListener('error', onError);
				reconnectAttempts = 0; // Reset on successful connection
				resolve(nextSocket);
			};

			const onError = () => {
				nextSocket.removeEventListener('open', onOpen);
				socketPromise = null;
				socket = null;
				reject(new Error('Unable to connect to the agent'));
			};

			nextSocket.addEventListener('open', onOpen, { once: true });
			nextSocket.addEventListener('error', onError, { once: true });
		});

		return socketPromise;
	}

	async function loadChatHistory(targetProjectId: string) {
		try {
			const response = await fetch(resolvePath(`/api/agents/site-builder/${targetProjectId}/get-messages`), {
				credentials: 'include'
			});

			if (!response.ok) {
				uiMessages = [];
				return;
			}

			const data = await response.json();
			uiMessages = Array.isArray(data) ? (data as UIChatMessage[]) : [];
			await tick();
			scrollToBottom();
		} catch {
			uiMessages = [];
		}
	}

	function sendSocketMessage(payload: Record<string, unknown>) {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error('Agent connection is not open');
		}

		socket.send(JSON.stringify(payload));
	}

	async function sendChatRequest(messagesForRequest: UIChatMessage[]) {
		const ws = await ensureSocket();
		const requestId = generateId();

		currentRequestId = requestId;
		currentStatus = 'Thinking...';
		isLoading = true;
		activeStream = null;

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
				if (chunk.toolName === 'codemode') {
					currentStatus = 'Running sandbox...';
				} else if (chunk.toolName === 'ask_user_question') {
					currentStatus = 'Waiting for your input...';
				} else {
					currentStatus = `Using ${chunk.toolName.replace(/_/g, ' ')}...`;
				}
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

	function handleSocketMessage(event: MessageEvent<string>) {
		if (typeof event.data !== 'string') return;

		let data: any;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}

		switch (data.type) {
			case AgentMessageType.CF_AGENT_CHAT_CLEAR:
				uiMessages = [];
				break;
			case AgentMessageType.CF_AGENT_CHAT_MESSAGES:
				uiMessages = Array.isArray(data.messages) ? (data.messages as UIChatMessage[]) : [];
				scrollToBottom();
				break;
			case AgentMessageType.CF_AGENT_MESSAGE_UPDATED:
				uiMessages = mergeUpdatedMessage(uiMessages, data.message as UIChatMessage);
				scrollToBottom();
				break;
			case AgentMessageType.CF_AGENT_STREAM_RESUME_NONE:
				expectingContinuation = false;
				isLoading = false;
				currentStatus = '';
				currentRequestId = null;
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
				if (!activeStream || activeStream.id !== data.id) {
					const continuation = data.continuation === true || expectingContinuation;
					activeStream = createStreamState(data.id, continuation);
				}

				if (data.body?.trim()) {
					try {
						handleStreamChunk(JSON.parse(data.body) as UIStreamChunk);
					} catch (error) {
						console.warn('Failed to parse stream chunk', error);
					}
				}

				if (data.done || data.error) {
					if (activeStream) {
						flushActiveStreamToMessages(activeStream);
					}
					activeStream = null;
					isLoading = false;
					currentStatus = '';
					currentRequestId = null;
					expectingContinuation = false;
				}
				break;
			}
		}
	}

	let messages = $derived(toDisplayMessages(uiMessages));
	let displayedMessages = $derived(messages.slice(-MAX_DISPLAYED_MESSAGES));
	let pendingToolInteraction = $derived(getPendingToolInteraction(uiMessages));

	$effect(() => {
		return () => {
			closeSocket();
		};
	});

	let previousProjectId = $state<string | null>(null);
	$effect(() => {
		if (!projectId || projectId === previousProjectId) {
			return;
		}

		const targetProjectId = projectId;
		previousProjectId = targetProjectId;
		input = '';
		attachedFile = null;
		isLoading = false;
		currentStatus = '';
		currentRequestId = null;
		activeStream = null;
		expectingContinuation = false;
		uiMessages = [];
		closeSocket();

		void (async () => {
			await loadChatHistory(targetProjectId);
			try {
				await ensureSocket(targetProjectId);
			} catch (error) {
				console.error('Failed to connect agent socket:', error);
			}
		})();
	});

	function stopRequest() {
		if (!currentRequestId) {
			return;
		}

		try {
			sendSocketMessage({
				type: AgentMessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
				id: currentRequestId
			});
		} catch (error) {
			console.error('Error stopping request:', error);
		}

		isLoading = false;
		currentStatus = '';
		activeStream = null;
		currentRequestId = null;
		expectingContinuation = false;
	}

	async function uploadFile(file: File): Promise<string> {
		const formData = new FormData();
		formData.append('file', file);

		const response = await fetch(resolvePath(`/api/projects/${projectId}/upload`), {
			method: 'POST',
			credentials: 'include',
			body: formData
		});

		if (!response.ok) {
			throw new Error('File upload failed');
		}

		const data = await response.json();
		return data.filename;
	}

	async function sendMessage() {
		if (!input.trim() || isLoading) return;

		const userMessage = input.trim();
		const fileToUpload = attachedFile;
		input = '';
		attachedFile = null;
		if (fileInput) fileInput.value = '';
		isLoading = true;

		// Upload file FIRST if attached (skip on retry - already uploaded)
		// This ensures we don't show user message if upload fails
		let uploadedFilename: string | undefined;
		if (fileToUpload) {
			try {
				isUploading = true;
				uploadedFilename = await uploadFile(fileToUpload);
				onUpdate(); // Refresh preview - uploaded file may be referenced
			} catch (error) {
				console.error('File upload failed:', error);
				uiMessages = [
					...uiMessages,
					{
						id: generateId(),
						role: 'assistant',
						parts: [{ type: 'text', text: 'Sorry, the file upload failed. Please try again.' }]
					}
				];
				isLoading = false;
				isUploading = false;
				return;
			} finally {
				isUploading = false;
			}
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

		try {
			await sendChatRequest(getCurrentMessagesForRequest(nextUserMessage));
		} catch (error: any) {
			console.error('Error sending message:', error);
			uiMessages = [
				...uiMessages,
				{
					id: generateId(),
					role: 'assistant',
					parts: [{ type: 'text', text: getErrorMessage(error) }]
				}
			];
		} finally {
			isLoading = false;
			currentStatus = '';
			currentRequestId = null;
			activeStream = null;
			expectingContinuation = false;
		}
	}

	async function rejectUserQuestion() {
		const interaction = pendingToolInteraction;
		if (!interaction) return;

		try {
			await ensureSocket();
			const output = {
				answer: '',
				declined: true
			};
			uiMessages = applyLocalToolOutput(uiMessages, interaction.toolCallId, output);
			sendSocketMessage({
				type: AgentMessageType.CF_AGENT_TOOL_RESULT,
				toolCallId: interaction.toolCallId,
				toolName: interaction.toolName,
				output,
				autoContinue: true
			});

			expectingContinuation = true;
			isLoading = true;
			currentStatus = 'Continuing...';
		} catch (error) {
			console.error('Error denying tool:', error);
			currentStatus = 'Unable to send response.';
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

		try {
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

			await ensureSocket();
			uiMessages = applyLocalToolOutput(uiMessages, interaction.toolCallId, output);
			sendSocketMessage({
				type: AgentMessageType.CF_AGENT_TOOL_RESULT,
				toolCallId: interaction.toolCallId,
				toolName: interaction.toolName,
				output,
				autoContinue: true
			});
			expectingContinuation = true;
			isLoading = true;
			currentStatus = 'Continuing...';
		} catch (error) {
			console.error('Error answering question:', error);
			currentStatus = 'Unable to send your answer.';
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
		attachedFile = null;
		if (fileInput) {
			fileInput.value = '';
		}
	}
</script>

<div class="agent-chat">
	<div class="messages" bind:this={messagesContainer}>
		{#if displayedMessages.length === 0}
			<div class="welcome">
				<h3>Let's Build Your Site</h3>
				<p>Describe what you'd like to create or change.</p>
			</div>
		{:else}
			{#if messages.length > MAX_DISPLAYED_MESSAGES}
				<div class="conversation-notice">
					Showing last {MAX_DISPLAYED_MESSAGES} messages ({messages.length - MAX_DISPLAYED_MESSAGES} older messages hidden)
				</div>
			{/if}
			{#each displayedMessages as message}
				<div class="message {message.role}">
					{#if message.blocks && message.blocks.length > 0}
						{#each message.blocks as block}
							{#if block.type === 'text' && block.text}
								<MessageContent content={block.text} role={message.role} />
							{:else if block.type === 'tools' && block.tools}
								<div class="tools-section">
									{#each block.tools as tool, i}
										<ToolExecutionCard {tool} index={i} {projectId} onRevert={onUpdate} />
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
					onSubmit={submitUserQuestionAnswers}
					onReject={rejectUserQuestion}
				/>
			{/if}
		{/key}

		{#if isLoading}
			<div class="thinking-indicator">
				<Loader2 size={14} class="animate-spin" />
				<span class="thinking-text">{currentStatus || 'Thinking...'}</span>
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
				disabled={isLoading}
				class="input-field"
				rows="1"
			></textarea>
			{#if isLoading}
				<button onclick={stopRequest} class="stop-button" title="Stop request">
					<Square size={16} />
				</button>
			{:else}
				<button onclick={() => sendMessage()} disabled={!input.trim()} class="send-button">
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
				<button class="remove-btn" onclick={removeAttachment} title="Remove attachment">
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
			<button class="icon-btn" title="Attach file" onclick={handleFileUpload}>
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

	.conversation-notice {
		text-align: center;
		padding: 0.625rem 0.875rem;
		margin-bottom: 0.75rem;
		background: var(--color-bg-tertiary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
	}

	.message {
		max-width: 90%;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.message.user {
		align-self: flex-end;
	}

	.message.user :global(.message-content) {
		background: var(--color-primary-light, #e6f4f4);
		color: var(--color-text-primary, #1f2937);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-lg);
		border-bottom-right-radius: var(--radius-sm);
		border-left: 3px solid var(--color-primary, #0d7377);
	}

	.message.assistant {
		align-self: flex-start;
	}

	.message.assistant :global(.message-content) {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-lg);
		border-bottom-left-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
	}

	.tools-section {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.25rem;
	}

	.thinking-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		width: fit-content;
		background: var(--color-bg-tertiary);
		border-radius: var(--radius-full);
	}

	.thinking-text {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
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
</style>
