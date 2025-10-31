<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Send, Loader2, Wrench, X, Paperclip } from 'lucide-svelte';
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
	let pendingPlan = $state<ToolCall[] | null>(null);
	let pendingSessionId = $state<string | null>(null);
	let messagesContainer: HTMLDivElement;
	let planMode = $state(true); // true = plan mode (interactive), false = direct execution
	let fileInput: HTMLInputElement;
	let currentStatus = $state<string>(''); // For showing contextual status
	let attachedFile = $state<File | null>(null); // Track attached file
	let isUploading = $state(false); // Track upload state
	let templatePromptSent = $state(false); // Track if template prompt was sent

	// Check for template prompt and send when projectId is available
	$effect(() => {
		// Only run when projectId becomes available and we haven't sent the template prompt yet
		if (projectId && !templatePromptSent) {
			const templatePrompt = localStorage.getItem('templatePrompt');
			if (templatePrompt && messages.length === 0) {
				// Auto-send template prompt
				input = templatePrompt;
				localStorage.removeItem('templatePrompt'); // Remove after using
				templatePromptSent = true; // Mark as sent
				sendMessage();
			} else {
				// No template prompt, just mark as checked
				templatePromptSent = true;
			}
		}
	});

	async function uploadFile(file: File): Promise<string> {
		const formData = new FormData();
		formData.append('file', file);

		const response = await fetch(`/api/projects/${projectId}/upload`, {
			method: 'POST',
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

	async function sendMessage() {
		if (!input.trim() || isLoading) return;

		const userMessage = input.trim();
		const fileToUpload = attachedFile;
		input = '';
		attachedFile = null;
		if (fileInput) fileInput.value = '';
		isLoading = true;

		// Add user message
		let messageContent = userMessage;
		if (fileToUpload) {
			messageContent += ` [Attached: ${fileToUpload.name}]`;
		}
		messages = [...messages, { role: 'user', content: messageContent }];

		// Upload file first if attached
		let uploadedFilename: string | undefined;
		if (fileToUpload) {
			try {
				isUploading = true;
				uploadedFilename = await uploadFile(fileToUpload);
				// Append file info to the prompt
				const fileInfo = `\n\n[File uploaded: ${uploadedFilename} (${(fileToUpload.size / 1024).toFixed(1)}KB)]`;
				messages[messages.length - 1].content += fileInfo;
				messages = [...messages];
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

		// Scroll to bottom
		scrollToBottom();

		try {
			const response = await fetch('/api/query', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: userMessage,
					projectId: projectId,
					sessionId: sessionId,
					uploadedFile: uploadedFilename // Send the uploaded filename to backend
				})
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
			let currentMessage: Message = { role: 'assistant', content: '', blocks: [] };
			messages = [...messages, currentMessage];

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const lines = chunk.split('\n');

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);

						if (data === '[DONE]') {
							break;
						}

						try {
							const event = JSON.parse(data);
							console.log('[CHAT] Event received:', event.type, event);

							// Capture session ID
							if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
								sessionId = event.session_id;
								console.log('[CHAT] Session ID:', sessionId);
							}

							// Handle permission requests (plan mode)
							if (event.type === 'permission_request' && event.tool_calls) {
								console.log('[CHAT] Permission request, tool calls:', event.tool_calls.length);
								pendingPlan = event.tool_calls;
								pendingSessionId = sessionId;
								isLoading = false;
								scrollToBottom();
								return; // Stop processing until user approves/rejects
							}

							// Handle assistant messages
							if (event.type === 'assistant' && event.message?.content) {
								console.log('[CHAT] Assistant message, blocks:', event.message.content.length);
								for (const block of event.message.content) {
									if (block.type === 'text') {
										console.log('[CHAT] Text block, length:', block.text.length, 'section:', currentSectionText.length);
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

										console.log('[CHAT] ContentBlocks now:', contentBlocks.length, 'types:', contentBlocks.map(b => b.type));
										messages[messages.length - 1].blocks = [...contentBlocks];
										messages = [...messages];
										scrollToBottom();
									} else if (block.type === 'tool_use') {
										// Only process if we haven't seen this tool ID before
										if (!processedToolIds.has(block.id)) {
											console.log('[CHAT] Tool use (NEW):', block.name, 'id:', block.id);
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

											currentStatus = `Using ${block.name.replace(/_/g, ' ')}...`;
											const toolExecution: ToolExecution = {
												id: block.id,
												name: block.name,
												input: block.input,
												status: 'running'
											};
											currentToolsGroup.push(toolExecution);

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
										} else {
											console.log('[CHAT] Tool use (DUPLICATE SKIPPED):', block.name, 'id:', block.id);
										}
									}
								}
							}

							// Handle user events (tool results)
							if (event.type === 'user' && event.message?.content) {
								for (const block of event.message.content) {
									if (block.type === 'tool_result') {
										// Match tool result with tool_use by ID
										const toolIndex = currentToolsGroup.findIndex(t => t.id === block.tool_use_id);
										if (toolIndex !== -1) {
											currentToolsGroup[toolIndex].status = block.is_error ? 'error' : 'success';
											// Extract text from content array
											currentToolsGroup[toolIndex].output = Array.isArray(block.content)
												? block.content.map(c => c.text).join('\n')
												: block.content;
										// Update the tools block
										const toolsBlock = contentBlocks.find(b => b.type === 'tools');
										if (toolsBlock) {
											toolsBlock.tools = [...currentToolsGroup];
										}
											messages[messages.length - 1].blocks = [...contentBlocks];
											messages = [...messages];
											scrollToBottom();
										}
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

			// Notify parent to refresh
			onUpdate();
		} catch (error) {
			console.error('Error sending message:', error);
			messages = [
				...messages,
				{
					role: 'assistant',
					content: 'Sorry, there was an error processing your request.'
				}
			];
		} finally {
			isLoading = false;
			currentStatus = '';
			scrollToBottom();
		}
	}

	async function approvePlan() {
		if (!pendingSessionId) return;

		isLoading = true;
		const tempPlan = pendingPlan;
		pendingPlan = null;

		try {
			const response = await fetch('/api/query/approve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId: projectId,
					sessionId: pendingSessionId,
					approved: true
				})
			});

			if (!response.ok) throw new Error('Approval failed');
			if (!response.body) throw new Error('No response body');

			// Read SSE stream for execution results
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let currentSectionText = '';  // Text for current section (resets after tools)
			let contentBlocks: ContentBlock[] = [];
			let currentToolsGroup: ToolExecution[] = [];
			let processedToolIds = new Set<string>();  // Track which tools we've seen

			// Add execution message
			let currentMessage: Message = { role: 'assistant', content: '', blocks: [] };
			messages = [...messages, currentMessage];

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const lines = chunk.split('\n');

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);
						if (data === '[DONE]') break;

						try {
							const event = JSON.parse(data);

							// Capture session ID
							if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
								sessionId = event.session_id;
							}

							// Handle assistant messages with blocks
							if (event.type === 'assistant' && event.message?.content) {
								for (const block of event.message.content) {
									if (block.type === 'text') {
										currentStatus = 'Responding...';
										currentSectionText += block.text;  // Accumulate for current section

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
									} else if (block.type === 'tool_use') {
										// Only process if we haven't seen this tool ID before
										if (!processedToolIds.has(block.id)) {
											processedToolIds.add(block.id);

											// Flush current text section before starting tools
											if (currentSectionText.trim()) {
												const lastBlock = contentBlocks[contentBlocks.length - 1];
												if (lastBlock?.type === 'text') {
													lastBlock.text = currentSectionText;
												}
											}
											// Reset for next section
											currentSectionText = '';

											currentStatus = `Using ${block.name.replace(/_/g, ' ')}...`;
											const toolExecution: ToolExecution = {
												id: block.id,
												name: block.name,
												input: block.input,
												status: 'running'
											};
											currentToolsGroup.push(toolExecution);

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
										// Match tool result with tool_use by ID
										const toolIndex = currentToolsGroup.findIndex(t => t.id === block.tool_use_id);
										if (toolIndex !== -1) {
											currentToolsGroup[toolIndex].status = block.is_error ? 'error' : 'success';
											currentToolsGroup[toolIndex].output = Array.isArray(block.content)
												? block.content.map(c => c.text).join('\n')
												: block.content;
											// Update the tools block
											const toolsBlock = contentBlocks.find(b => b.type === 'tools');
											if (toolsBlock) {
												toolsBlock.tools = [...currentToolsGroup];
											}
											messages[messages.length - 1].blocks = [...contentBlocks];
											messages = [...messages];
											scrollToBottom();
										}
										currentStatus = '';
									}
								}
							}
						} catch (e) {
							// Ignore parse errors
						}
					}
				}
			}

			// Notify parent to refresh
			onUpdate();
		} catch (error) {
			console.error('Error approving plan:', error);
			messages = [
				...messages,
				{
					role: 'assistant',
					content: 'Sorry, there was an error executing the plan.'
				}
			];
		} finally {
			isLoading = false;
			scrollToBottom();
		}
	}

	function rejectPlan() {
		pendingPlan = null;
		pendingSessionId = null;
		messages = [
			...messages,
			{
				role: 'assistant',
				content: 'Plan rejected. Please tell me what you\'d like to change.'
			}
		];
		scrollToBottom();
	}

	function scrollToBottom() {
		setTimeout(() => {
			if (messagesContainer) {
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
			}
		}, 0);
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
		{#if messages.length === 0}
			<div class="welcome">
				<h3>Let's Build Your Site</h3>
				<p>Work with the agent to customize your website. Try one of these:</p>
				<div class="suggestions">
					<Badge
						variant="outline"
						class="suggestion-badge"
						onclick={() => { input = 'Add a dark mode toggle'; sendMessage(); }}
					>
						Add a dark mode toggle
					</Badge>
					<Badge
						variant="outline"
						class="suggestion-badge"
						onclick={() => { input = 'Create a contact form'; sendMessage(); }}
					>
						Create a contact form
					</Badge>
					<Badge
						variant="outline"
						class="suggestion-badge"
						onclick={() => { input = 'Add an image gallery'; sendMessage(); }}
					>
						Add an image gallery
					</Badge>
					<Badge
						variant="outline"
						class="suggestion-badge"
						onclick={() => { input = 'Improve the navigation menu'; sendMessage(); }}
					>
						Improve navigation
					</Badge>
				</div>
			</div>
		{:else}
			{#each messages as message}
				<div class="message {message.role}">
					{#if message.blocks && message.blocks.length > 0}
						{#each message.blocks as block}
							{#if block.type === 'text' && block.text}
								<MessageContent content={block.text} role={message.role} />
							{:else if block.type === 'tools' && block.tools}
								<div class="tools-section">
									{#each block.tools as tool, i}
										<ToolExecutionCard {tool} index={i} />
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

			{#if pendingPlan}
				<PlanApprovalCard plan={pendingPlan} onApprove={approvePlan} onReject={rejectPlan} />
			{/if}
		{/if}

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
				placeholder="Ask a follow-up..."
				disabled={isLoading}
				class="input-field"
			/>
			<button onclick={sendMessage} disabled={isLoading || !input.trim()} class="send-button">
				{#if isLoading}
					<Loader2 size={18} class="animate-spin" />
				{:else}
					<Send size={18} />
				{/if}
			</button>
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
	}

	.messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.welcome {
		text-align: center;
		padding: 2rem;
	}

	.welcome h3 {
		margin-bottom: 0.5rem;
		color: var(--color-text-primary);
	}

	.welcome p {
		color: var(--color-text-secondary);
		margin-bottom: 1.5rem;
	}

	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: center;
		max-width: 400px;
		margin: 0 auto;
	}

	:global(.suggestion-badge) {
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.875rem;
		padding: 0.5rem 1rem;
	}

	:global(.suggestion-badge:hover) {
		background: hsl(var(--accent));
		color: hsl(var(--accent-foreground));
		border-color: hsl(var(--accent));
	}

	.message {
		max-width: 85%;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.message.user {
		align-self: flex-end;
	}

	.message.user :global(.message-content) {
		background: var(--color-accent);
		color: white;
		padding: 0.75rem 1rem;
		border-radius: 12px;
		border-bottom-right-radius: 4px;
	}

	.message.assistant {
		align-self: flex-start;
	}

	.message.assistant :global(.message-content) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
		padding: 0.75rem 1rem;
		border-radius: 12px;
		border-bottom-left-radius: 4px;
	}

	.tools-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.thinking-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		width: fit-content;
		opacity: 0.6;
	}

	.thinking-text {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.input-container {
		padding: 1rem;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg-primary);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
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
		border-radius: 8px;
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-size: 0.875rem;
		font-family: inherit;
	}

	.input-field:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.input-field:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.send-button {
		width: 40px;
		height: 40px;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		flex-shrink: 0;
	}

	.send-button:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.send-button:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.attachment-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.875rem;
		margin-bottom: 0.5rem;
	}

	.attachment-indicator .filename {
		color: var(--color-text-primary);
		font-weight: 500;
	}

	.attachment-indicator .filesize {
		color: var(--color-text-secondary);
		font-size: 0.75rem;
	}

	.remove-btn {
		padding: 0.25rem;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		margin-left: auto;
	}

	.remove-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.upload-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: rgba(59, 130, 246, 0.1);
		border: 1px solid rgba(59, 130, 246, 0.3);
		border-radius: 6px;
		font-size: 0.875rem;
		color: rgb(59, 130, 246);
		margin-bottom: 0.5rem;
	}

	.action-buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.icon-btn {
		width: 36px;
		height: 36px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
		transition: all 0.2s;
		cursor: pointer;
	}

	.icon-btn:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-accent);
	}

	.plan-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-size: 0.875rem;
		transition: all 0.2s;
		cursor: pointer;
	}

	.plan-btn:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-accent);
	}

	.plan-btn.active {
		background: rgba(59, 130, 246, 0.15);
		border-color: rgb(59, 130, 246);
		color: rgb(59, 130, 246);
	}

	.plan-btn.active:hover {
		background: rgba(59, 130, 246, 0.25);
	}

	.play-icon {
		font-size: 0.75rem;
	}

	.plus-icon {
		font-weight: 300;
		font-size: 1.5rem;
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
