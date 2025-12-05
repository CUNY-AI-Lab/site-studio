<script lang="ts">
	import { tick } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Send, Loader2, Wrench, X, Paperclip, Square } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';
	import PlanApprovalCard from './PlanApprovalCard.svelte';
	import ToolExecutionCard from './ToolExecutionCard.svelte';
	import MessageContent from './MessageContent.svelte';

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

	interface ToolCall {
		name: string;
		input: Record<string, any>;
	}

	interface ToolExecution {
		id?: string;  // tool_use id for matching results
		name: string;
		input: Record<string, any>;
		status?: 'running' | 'success' | 'error';
		output?: string;
		startTime?: number;  // Track when tool started for elapsed time
		elapsedTime?: number; // Current elapsed time in seconds
	}

	let {
		projectId,
		onUpdate
	}: {
		projectId: string;
		onUpdate: () => void;
	} = $props();

	let messages = $state<Message[]>([]);
	let input = $state('');
	let isLoading = $state(false);
	let sessionId = $state<string | null>(null);
	let pendingToolApproval = $state<{ requestId: string; toolName: string; input: Record<string, any> } | null>(null);
	let messagesContainer: HTMLDivElement;
	let planMode = $state(true); // true = plan mode (interactive), false = direct execution
	let fileInput: HTMLInputElement;
	let currentStatus = $state<string>(''); // For showing contextual status
	let attachedFile = $state<File | null>(null); // Track attached file
	let isUploading = $state(false); // Track upload state
	let filesModifiedDuringExecution = $state(false); // Track if files were modified
	let abortController = $state<AbortController | null>(null); // For canceling requests
	let toolTimerInterval = $state<ReturnType<typeof setInterval> | null>(null); // Timer for tool elapsed time

	// Limit displayed messages to most recent 10 to manage context
	const MAX_DISPLAYED_MESSAGES = 10;
	let displayedMessages = $derived(messages.slice(-MAX_DISPLAYED_MESSAGES));

	// Track running tools for elapsed time updates
	let runningTools = $state<Map<string, ToolExecution>>(new Map());

	// Start timer to update elapsed time for running tools
	function startToolTimer() {
		if (toolTimerInterval) return;
		toolTimerInterval = setInterval(() => {
			const now = Date.now();
			runningTools.forEach((tool) => {
				if (tool.startTime && tool.status === 'running') {
					tool.elapsedTime = Math.round((now - tool.startTime) / 100) / 10; // 0.1s precision
				}
			});
			// Trigger reactivity
			runningTools = new Map(runningTools);
		}, 100);
	}

	// Stop the timer when no tools are running
	function stopToolTimer() {
		if (toolTimerInterval) {
			clearInterval(toolTimerInterval);
			toolTimerInterval = null;
		}
	}

	// Cleanup timer on component unmount
	$effect(() => {
		return () => {
			stopToolTimer();
			if (abortController) {
				abortController.abort();
			}
		};
	});

	// Reset state when projectId changes (e.g., browser back/forward navigation)
	let previousProjectId = $state<string | null>(null);
	$effect(() => {
		if (previousProjectId !== null && previousProjectId !== projectId) {
			// Project changed - reset all chat state
			messages = [];
			sessionId = null;
			pendingToolApproval = null;
			input = '';
			isLoading = false;
			currentStatus = '';
			attachedFile = null;
			filesModifiedDuringExecution = false;
			stopToolTimer();
			runningTools.clear();
			if (abortController) {
				abortController.abort();
				abortController = null;
			}
		}
		previousProjectId = projectId;
	});

	// Stop the current request
	function stopRequest() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		stopToolTimer();
		isLoading = false;
		currentStatus = '';

		// Mark any running tools as stopped
		runningTools.forEach((tool) => {
			if (tool.status === 'running') {
				tool.status = 'error';
				tool.output = 'Request cancelled by user';
			}
		});
		runningTools.clear();
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

	// Helper to flush current text block into blocks array
	function flushTextBlock(blocks: ContentBlock[], currentText: string): string {
		if (currentText.trim()) {
			blocks.push({ type: 'text', text: currentText });
		}
		return ''; // Reset current text
	}

	// Helper to add tools block
	function addToolsBlock(blocks: ContentBlock[], tools: ToolExecution[]) {
		if (tools.length > 0) {
			blocks.push({ type: 'tools', tools: [...tools] });
		}
	}

	async function sendMessage(retryCount = 0, previousUploadedFilename?: string) {
		const MAX_RETRIES = 2;
		const RETRY_DELAY_MS = 1000;

		if (!input.trim() || isLoading) return;

		const userMessage = input.trim();
		const fileToUpload = attachedFile;
		input = '';
		attachedFile = null;
		if (fileInput) fileInput.value = '';
		isLoading = true;
		filesModifiedDuringExecution = false; // Reset file modification tracking
		abortController = new AbortController(); // Create new abort controller

		// Upload file FIRST if attached (skip on retry - already uploaded)
		// This ensures we don't show user message if upload fails
		let uploadedFilename: string | undefined = previousUploadedFilename;
		if (fileToUpload && retryCount === 0) {
			try {
				isUploading = true;
				uploadedFilename = await uploadFile(fileToUpload);
			} catch (error) {
				console.error('File upload failed:', error);
				messages = [...messages, {
					role: 'assistant',
					content: 'Sorry, the file upload failed. Please try again.'
				}];
				isLoading = false;
				isUploading = false;
				return;
			} finally {
				isUploading = false;
			}
		}

		// Add user message AFTER successful upload (only on first attempt, not retries)
		if (retryCount === 0) {
			let messageContent = userMessage;
			if (fileToUpload) {
				messageContent += ` [Attached: ${fileToUpload.name}]`;
			}
			if (uploadedFilename) {
				messageContent += `\n\n[File uploaded: ${uploadedFilename} (${(fileToUpload!.size / 1024).toFixed(1)}KB)]`;
			}
			messages = [...messages, { role: 'user', content: messageContent }];
		}

		// Scroll to bottom
		scrollToBottom();

		try {
			const response = await fetch(resolvePath('/api/query'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					prompt: userMessage,
					projectId: projectId,
					sessionId: sessionId,
					uploadedFile: uploadedFilename, // Send the uploaded filename to backend
					mode: planMode ? 'plan' : 'execute' // Send plan mode preference
				}),
				signal: abortController?.signal // Enable request cancellation
			});

			if (!response.ok) throw new Error('Request failed');
			if (!response.body) throw new Error('No response body');

			// Read SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let currentSectionText = '';  // Text for current section (resets after tools)
		let contentBlocks: ContentBlock[] = [];
			let currentToolsGroup: ToolExecution[] = [];
			let processedToolIds = new Set<string>();  // Track which tools we've seen
			let toolIdMap = new Map<string, ToolExecution>();  // O(1) lookup for tool results
			let receivedStreamEvents = false;  // Track if we've received stream_event text deltas
			let currentMessage: Message = { role: 'assistant', content: '', blocks: [] };
			messages = [...messages, currentMessage];

			// Buffer for incomplete SSE lines that span across chunks
			let lineBuffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });

				// Prepend any buffered content from previous chunk
				const fullChunk = lineBuffer + chunk;
				lineBuffer = '';

				// Split by newline - SSE uses \n\n as message separator
				const lines = fullChunk.split('\n');

				// If the chunk doesn't end with a newline, the last "line" is incomplete
				// Save it for the next chunk
				if (!fullChunk.endsWith('\n')) {
					lineBuffer = lines.pop() || '';
				}

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);

						if (data === '[DONE]') {
							break;
						}

						try {
							const event = JSON.parse(data);

							// Log non-streaming events for debugging
							const isStreamingDelta = event.type === 'stream_event' &&
								event.event?.type === 'content_block_delta';
							if (!isStreamingDelta) {
								console.log('[SSE]', event.type, event.subtype || event.event?.type || '', event);
							}

							// Capture session ID
							if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
								sessionId = event.session_id;
							}

							// Handle streaming text deltas for real-time display
							if (event.type === 'stream_event' && event.event) {
								const streamEvent = event.event;
								if (streamEvent.type === 'content_block_delta' &&
									streamEvent.delta?.type === 'text_delta') {
									const textDelta = streamEvent.delta.text;

									currentStatus = 'Responding...';
									currentSectionText += textDelta;
									receivedStreamEvents = true;  // Mark that we're using stream events for text

									// Find or create text block for current section
									let textBlockIndex = contentBlocks.findIndex((b, i) => {
										if (b.type === 'text') {
											const hasToolsAfter = contentBlocks.slice(i + 1).some(cb => cb.type === 'tools');
											return !hasToolsAfter;
										}
										return false;
									});

									if (textBlockIndex >= 0) {
										contentBlocks[textBlockIndex].text = currentSectionText;
									} else {
										contentBlocks.push({ type: 'text', text: currentSectionText });
									}

									messages[messages.length - 1].blocks = [...contentBlocks];
									messages = [...messages];
									scrollToBottom();
								}
							}

							// Handle tool approval requests (canUseTool callback)
							if (event.type === 'tool_approval_request') {
								pendingToolApproval = {
									requestId: event.request_id,
									toolName: event.tool_name,
									input: event.input
								};
								currentStatus = 'Waiting for approval...';
								// Wait for DOM to update before scrolling
								await tick();
								scrollToBottom();
								// Double scroll after a short delay to ensure approval card is fully rendered
								setTimeout(scrollToBottom, 100);
							}

							// Handle assistant messages
							if (event.type === 'assistant' && event.message?.content) {
								for (const block of event.message.content) {
									if (block.type === 'text') {
										// Skip assistant text if we've already processed stream_events for real-time display
										// The assistant event contains the complete text which would duplicate streamed content
										if (receivedStreamEvents) {
											continue;
										}

										// Reset tools group when starting new text section after tools
										if (currentToolsGroup.length > 0 && contentBlocks[contentBlocks.length - 1]?.type === 'tools') {
											currentToolsGroup = [];
										}

										currentStatus = 'Responding...';
										currentSectionText += block.text;  // Accumulate for current section

										// Find or create text block for current section
										let textBlockIndex = contentBlocks.findIndex((b, i) => {
											// Find the last text block (after last tools block if any)
											if (b.type === 'text') {
												const hasToolsAfter = contentBlocks.slice(i + 1).some(cb => cb.type === 'tools');
												return !hasToolsAfter;
											}
											return false;
										});

										if (textBlockIndex >= 0) {
											// Update existing text block
											contentBlocks[textBlockIndex].text = currentSectionText;
										} else {
											// Create new text block
											contentBlocks.push({ type: 'text', text: currentSectionText });
										}

										messages[messages.length - 1].blocks = [...contentBlocks];
										messages = [...messages];
										scrollToBottom();
									} else if (block.type === 'tool_use') {
										// Only process if we haven't seen this tool ID before
										if (!processedToolIds.has(block.id)) {
											processedToolIds.add(block.id);

											// Flush current text section before starting tools
											if (currentSectionText.trim()) {
												// Make sure the text block is finalized
												const lastBlock = contentBlocks[contentBlocks.length - 1];
												if (lastBlock?.type === 'text') {
													lastBlock.text = currentSectionText;
												}
											}
											// Reset for next section
											currentSectionText = '';
											receivedStreamEvents = false;  // Reset for next text section after tools

											currentStatus = `Using ${block.name.replace(/_/g, ' ')}...`;
											const toolExecution: ToolExecution = {
												id: block.id,
												name: block.name,
												input: block.input,
												status: 'running',
												startTime: Date.now(),
												elapsedTime: 0
											};
											currentToolsGroup.push(toolExecution);
											runningTools.set(block.id, toolExecution);
											toolIdMap.set(block.id, toolExecution);  // O(1) lookup for results
											startToolTimer();

											// Update or create tools block
											const toolsBlockIndex = contentBlocks.findIndex(b => b.type === 'tools' &&
												!contentBlocks.slice(contentBlocks.indexOf(b) + 1).some(cb => cb.type === 'text'));
											if (toolsBlockIndex >= 0) {
												contentBlocks[toolsBlockIndex].tools = [...currentToolsGroup];
											} else {
												contentBlocks.push({ type: 'tools', tools: [...currentToolsGroup] });
											}
											messages[messages.length - 1].blocks = [...contentBlocks];
											messages = [...messages];
											scrollToBottom();
										}
									}
								}
							}

							// Handle user events (tool results)
							if (event.type === 'user' && event.message?.content) {
								for (const block of event.message.content) {
									if (block.type === 'tool_result') {
										console.log('[CHAT] Tool result for:', block.tool_use_id, 'is_error:', block.is_error);

										// Always remove from running tools (cleanup timer even if not in currentToolsGroup)
										runningTools.delete(block.tool_use_id);
										if (runningTools.size === 0) {
											stopToolTimer();
										}

										// Extract output text
										const output = Array.isArray(block.content)
											? block.content.map(c => c.text).join('\n')
											: block.content;

										// Check if this tool modified files (has diff metadata) - refresh preview immediately
										if (!block.is_error && output.includes('<!-- diff:')) {
											filesModifiedDuringExecution = true;
											onUpdate(); // Refresh preview immediately after file change
										}

										// O(1) lookup for tool result matching
										const tool = toolIdMap.get(block.tool_use_id);
										if (tool) {
											tool.status = block.is_error ? 'error' : 'success';
											tool.output = output;
											console.log('[CHAT] Tool result matched:', block.tool_use_id);
										} else {
											console.log('[CHAT] Tool result not found (may have arrived before tool_use):', block.tool_use_id);
										}

										// Update UI
										messages[messages.length - 1].blocks = [...contentBlocks];
										messages = [...messages];
										scrollToBottom();
										currentStatus = '';
									}
								}
							}
						} catch (e) {
							// Ignore parse errors for incomplete JSON
						}
					}
				}
			}

		} catch (error: any) {
			console.error('Error sending message:', error);
			// Check if it was aborted
			if (error.name === 'AbortError' || abortController?.signal.aborted) {
				messages = [
					...messages,
					{
						role: 'assistant',
						content: 'Request cancelled.'
					}
				];
			} else {
				// Check for network errors (QUIC, connection failures, etc.)
				const isNetworkError = error.name === 'TypeError' &&
					(error.message?.includes('network') || error.message?.includes('fetch'));

				if (isNetworkError && retryCount < MAX_RETRIES) {
					console.log(`Network error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
					isLoading = false;
					currentStatus = `Connection lost, retrying...`;
					await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
					// Restore input for retry
					input = userMessage;
					return sendMessage(retryCount + 1, uploadedFilename);
				}

				messages = [
					...messages,
					{
						role: 'assistant',
						content: isNetworkError
							? 'Connection lost. Please check your network and try again.'
							: 'Sorry, there was an error processing your request.'
					}
				];
			}
		} finally {
			isLoading = false;
			currentStatus = '';
			abortController = null;
			stopToolTimer();
			// Mark any tools still showing as 'running' as cancelled
			for (const tool of runningTools.values()) {
				if (tool.status === 'running') {
					tool.status = 'error';
					tool.output = tool.output || 'Operation interrupted';
				}
			}
			runningTools.clear();
			// Update UI to reflect cancelled tools
			messages = [...messages];
			scrollToBottom();
		}
	}

	// Approve a tool operation (canUseTool callback flow)
	async function approveToolOperation() {
		if (!pendingToolApproval) return;

		const requestId = pendingToolApproval.requestId;
		pendingToolApproval = null;
		currentStatus = 'Executing...';

		try {
			const response = await fetch(resolvePath('/api/query/tool-approve'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					requestId,
					approved: true
				})
			});

			if (!response.ok) {
				console.error('Tool approval failed:', response.status);
			}
		} catch (error) {
			console.error('Error approving tool:', error);
		}
	}

	// Deny a specific tool operation (for canUseTool callback flow)
	async function denyToolOperation() {
		if (!pendingToolApproval) return;

		const requestId = pendingToolApproval.requestId;
		pendingToolApproval = null;
		currentStatus = '';

		try {
			const response = await fetch(resolvePath('/api/query/tool-approve'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					requestId,
					approved: false
				})
			});

			if (!response.ok) {
				console.error('Tool denial failed:', response.status);
			}
		} catch (error) {
			console.error('Error denying tool:', error);
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

	function togglePlanMode() {
		planMode = !planMode;
		messages = [...messages, {
			role: 'assistant',
			content: planMode
				? 'Plan mode enabled. I will show you proposed actions before executing.'
				: 'Direct execution mode enabled. I will execute actions immediately.'
		}];
		scrollToBottom();
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

		<!-- Tool approval card - {#key} forces re-render on async state changes -->
		{#key pendingToolApproval}
			{#if pendingToolApproval}
				<PlanApprovalCard
					plan={[{ name: pendingToolApproval.toolName, input: pendingToolApproval.input }]}
					onApprove={approveToolOperation}
					onReject={denyToolOperation}
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
			<input
				type="text"
				bind:value={input}
				onkeydown={handleKeyDown}
				placeholder={messages.length > 0 ? "Ask a follow-up..." : "Describe what you'd like to build..."}
				disabled={isLoading}
				class="input-field"
			/>
			{#if isLoading}
				<button onclick={stopRequest} class="stop-button" title="Stop request">
					<Square size={16} />
				</button>
			{:else}
				<button onclick={sendMessage} disabled={!input.trim()} class="send-button">
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
			<button
				class="plan-btn {planMode ? 'active' : ''}"
				title={planMode ? 'Plan mode active' : 'Direct execution mode'}
				onclick={togglePlanMode}
			>
				<span class="play-icon">▶</span> {planMode ? 'Plan' : 'Direct'}
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
		align-items: center;
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
