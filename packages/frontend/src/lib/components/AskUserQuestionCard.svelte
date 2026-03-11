<script lang="ts">
	import { Check, MessageSquare, Send, X } from 'lucide-svelte';

	interface QuestionOption {
		label: string;
		description?: string;
		preview?: string;
	}

	interface QuestionAnnotation {
		preview?: string;
		notes?: string;
	}

	export interface UserQuestionPrompt {
		header?: string;
		question: string;
		options?: QuestionOption[];
		multiSelect?: boolean;
		placeholder?: string;
	}

	export interface UserQuestionSubmission {
		answers: Record<string, string>;
		annotations?: Record<string, QuestionAnnotation>;
	}

	let {
		questions = [],
		onSubmit,
		onReject
	}: {
		questions: UserQuestionPrompt[];
		onSubmit: (submission: UserQuestionSubmission) => void;
		onReject: () => void;
	} = $props();

	let selectedAnswers = $state<Record<number, string[]>>({});
	let customAnswers = $state<Record<number, string>>({});
	let notesByIndex = $state<Record<number, string>>({});
	let activeOptionByIndex = $state<Record<number, string>>({});
	let validationMessage = $state('');

	function getSelectedAnswers(index: number): string[] {
		return selectedAnswers[index] || [];
	}

	function isSelected(index: number, label: string): boolean {
		return getSelectedAnswers(index).includes(label);
	}

	function getOption(question: UserQuestionPrompt, label: string): QuestionOption | undefined {
		return question.options?.find((option) => option.label === label);
	}

	function focusPreview(index: number, label: string) {
		activeOptionByIndex[index] = label;
	}

	function resetPreview(index: number) {
		const selected = getSelectedAnswers(index);
		activeOptionByIndex[index] = selected[selected.length - 1] || '';
	}

	function chooseOption(index: number, question: UserQuestionPrompt, label: string) {
		if (question.multiSelect) {
			const current = getSelectedAnswers(index);
			selectedAnswers[index] = current.includes(label)
				? current.filter((item) => item !== label)
				: [...current, label];
		} else {
			selectedAnswers[index] = [label];
			customAnswers[index] = '';
		}

		focusPreview(index, label);
		validationMessage = '';
	}

	function updateCustomAnswer(index: number, question: UserQuestionPrompt, value: string) {
		customAnswers[index] = value;
		if (!question.multiSelect && value.trim()) {
			selectedAnswers[index] = [];
		}
		validationMessage = '';
	}

	function updateNotes(index: number, value: string) {
		notesByIndex[index] = value;
	}

	function getAnswer(question: UserQuestionPrompt, index: number): string {
		const customAnswer = customAnswers[index]?.trim();
		const selected = getSelectedAnswers(index);

		if (question.multiSelect) {
			return [...selected, ...(customAnswer ? [customAnswer] : [])].join(', ');
		}

		if (customAnswer) {
			return customAnswer;
		}

		return selected[0]?.trim() || '';
	}

	function getSelectedPreview(question: UserQuestionPrompt, index: number): string | undefined {
		const previews = getSelectedAnswers(index)
			.map((label) => getOption(question, label)?.preview)
			.filter((preview): preview is string => typeof preview === 'string' && preview.length > 0);

		if (previews.length === 0) {
			return undefined;
		}

		return previews.join('\n<hr />\n');
	}

	function getVisiblePreview(question: UserQuestionPrompt, index: number): string | undefined {
		const activeOption = activeOptionByIndex[index];
		const activePreview = activeOption ? getOption(question, activeOption)?.preview : undefined;

		return activePreview || getSelectedPreview(question, index);
	}

	function hasPreviewOptions(question: UserQuestionPrompt): boolean {
		return question.options?.some((option) => !!option.preview) ?? false;
	}

	function buildAnnotation(question: UserQuestionPrompt, index: number): QuestionAnnotation | undefined {
		const preview = getSelectedPreview(question, index);
		const notes = notesByIndex[index]?.trim();

		if (!preview && !notes) {
			return undefined;
		}

		return {
			...(preview ? { preview } : {}),
			...(notes ? { notes } : {})
		};
	}

	function looksLikeHtml(content: string): boolean {
		return /<\/?[a-z][\s\S]*>/i.test(content);
	}

	function escapeHtml(content: string): string {
		return content
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function buildPreviewMarkup(content: string): string {
		if (looksLikeHtml(content)) {
			return content;
		}

		return `<pre class="plain-preview">${escapeHtml(content)}</pre>`;
	}

	function buildPreviewDocument(content: string): string {
		return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<style>
			:root {
				color-scheme: light;
				font-family: "Georgia", "Iowan Old Style", serif;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				padding: 1rem;
				background: linear-gradient(180deg, #fbfaf6 0%, #f4f0e6 100%);
				color: #1f2933;
			}

			img,
			video,
			iframe {
				max-width: 100%;
			}

			hr {
				border: 0;
				border-top: 1px solid rgba(31, 41, 51, 0.12);
				margin: 1rem 0;
			}

			.plain-preview {
				margin: 0;
				font-family: "SFMono-Regular", "Menlo", monospace;
				font-size: 0.9rem;
				line-height: 1.5;
				white-space: pre-wrap;
			}
		</style>
	</head>
	<body>${buildPreviewMarkup(content)}</body>
</html>`;
	}

	let canSubmit = $derived(
		questions.length > 0 && questions.every((question, index) => getAnswer(question, index).length > 0)
	);

	function submitAnswers() {
		if (!canSubmit) {
			validationMessage = 'Answer each question to continue.';
			return;
		}

		const answers: Record<string, string> = {};
		const annotations: Record<string, QuestionAnnotation> = {};

		for (const [index, question] of questions.entries()) {
			answers[question.question] = getAnswer(question, index);

			const annotation = buildAnnotation(question, index);
			if (annotation) {
				annotations[question.question] = annotation;
			}
		}

		onSubmit({
			answers,
			...(Object.keys(annotations).length > 0 ? { annotations } : {})
		});
	}
</script>

<div class="question-card">
	<div class="card-header">
		<div class="header-icon">
			<MessageSquare size={18} />
		</div>
		<div class="header-copy">
			<h3>Question</h3>
			<p>The agent needs clarification before it continues.</p>
		</div>
	</div>

	<div class="questions">
		{#each questions as question, index}
			{@const previewContent = getVisiblePreview(question, index)}
			<div class="question-block">
				{#if question.header}
					<div class="question-header">{question.header}</div>
				{/if}

				<label class="question-label" for={`question-${index}`}>
					{question.question}
				</label>

				{#if question.options && question.options.length > 0}
					{#if question.multiSelect}
						<p class="question-meta">You can choose more than one option.</p>
					{/if}

					<div class="options">
						{#each question.options as option}
							<button
								type="button"
								class="option-button"
								class:selected={isSelected(index, option.label)}
								class:active={activeOptionByIndex[index] === option.label}
								aria-pressed={isSelected(index, option.label)}
								onclick={() => chooseOption(index, question, option.label)}
								onmouseenter={() => focusPreview(index, option.label)}
								onmouseleave={() => resetPreview(index)}
								onfocus={() => focusPreview(index, option.label)}
								onblur={() => resetPreview(index)}
							>
								<span class="option-header">
									<span class="selection-indicator" class:selected={isSelected(index, option.label)}>
										{#if isSelected(index, option.label)}
											<Check size={12} />
										{/if}
									</span>
									<span class="option-label">{option.label}</span>
								</span>
								{#if option.description}
									<span class="option-description">{option.description}</span>
								{/if}
							</button>
						{/each}
					</div>

					{#if previewContent}
						<div class="preview-panel">
							<div class="preview-label">Preview</div>
							<div class="preview-surface">
								<iframe
									class="preview-frame"
									title={`Preview for ${question.header || question.question}`}
									sandbox=""
									srcdoc={buildPreviewDocument(previewContent)}
								></iframe>
							</div>
						</div>
					{/if}

					<div class="freeform">
						<label class="field-label" for={`question-${index}`}>
							Other
						</label>
						<input
							id={`question-${index}`}
							type="text"
							class="answer-input"
							placeholder={question.placeholder || 'Add a custom answer'}
							value={customAnswers[index] || ''}
							oninput={(event) => updateCustomAnswer(index, question, (event.currentTarget as HTMLInputElement).value)}
						/>
					</div>

					{#if hasPreviewOptions(question)}
						<div class="notes">
							<label class="field-label" for={`notes-${index}`}>
								Notes for the agent
							</label>
							<textarea
								id={`notes-${index}`}
								class="notes-textarea"
								rows="2"
								placeholder="Optional notes about the preview or your choice"
								value={notesByIndex[index] || ''}
								oninput={(event) => updateNotes(index, (event.currentTarget as HTMLTextAreaElement).value)}
							></textarea>
						</div>
					{/if}
				{:else}
					<textarea
						id={`question-${index}`}
						class="answer-textarea"
						rows="3"
						placeholder={question.placeholder || 'Type your answer'}
						value={customAnswers[index] || ''}
						oninput={(event) => updateCustomAnswer(index, question, (event.currentTarget as HTMLTextAreaElement).value)}
					></textarea>
				{/if}
			</div>
		{/each}
	</div>

	{#if validationMessage}
		<p class="validation-message">{validationMessage}</p>
	{/if}

	<div class="actions">
		<button type="button" class="action-button reject" onclick={onReject}>
			<X size={15} />
			<span>Cancel</span>
		</button>
		<button type="button" class="action-button submit" onclick={submitAnswers}>
			<Send size={15} />
			<span>Send answer</span>
		</button>
	</div>
</div>

<style>
	.question-card {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-border) 72%, white 28%);
		background:
			linear-gradient(160deg, color-mix(in srgb, var(--color-bg-elevated) 88%, white 12%) 0%, var(--color-bg-elevated) 100%);
		box-shadow: 0 14px 32px rgba(12, 16, 24, 0.14);
	}

	.card-header {
		display: flex;
		align-items: flex-start;
		gap: 0.875rem;
	}

	.header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.85rem;
		background: color-mix(in srgb, var(--color-primary) 16%, white 84%);
		color: var(--color-primary);
		flex-shrink: 0;
	}

	.header-copy h3 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.header-copy p {
		margin: 0.2rem 0 0;
		font-size: 0.84rem;
		color: var(--color-text-secondary);
	}

	.questions {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.question-block {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 0.85rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg) 76%, white 24%);
		border: 1px solid color-mix(in srgb, var(--color-border) 84%, white 16%);
	}

	.question-header {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.question-label {
		font-size: 0.93rem;
		font-weight: 600;
		line-height: 1.4;
	}

	.question-meta {
		margin: -0.15rem 0 0;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}

	.options {
		display: grid;
		gap: 0.55rem;
	}

	.option-button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.3rem;
		padding: 0.75rem 0.85rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-border) 80%, white 20%);
		background: var(--color-bg-elevated);
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
	}

	.option-button:hover,
	.option-button.active {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border) 45%);
	}

	.option-button.selected {
		border-color: var(--color-primary);
		background: color-mix(in srgb, var(--color-primary) 10%, white 90%);
	}

	.option-header {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}

	.selection-indicator {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--color-border) 80%, white 20%);
		background: color-mix(in srgb, var(--color-bg) 88%, white 12%);
		color: transparent;
		flex-shrink: 0;
	}

	.selection-indicator.selected {
		border-color: var(--color-primary);
		background: var(--color-primary);
		color: white;
	}

	.option-label {
		font-size: 0.88rem;
		font-weight: 600;
	}

	.option-description {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}

	.preview-panel {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-border) 72%);
		background: color-mix(in srgb, var(--color-primary) 6%, white 94%);
	}

	.preview-label,
	.field-label {
		font-size: 0.76rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.preview-surface {
		border-radius: calc(var(--radius-md) - 2px);
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--color-border) 68%, white 32%);
		background: white;
	}

	.preview-frame {
		display: block;
		width: 100%;
		min-height: 16rem;
		border: 0;
		background: white;
	}

	.freeform,
	.notes {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.answer-input,
	.answer-textarea,
	.notes-textarea {
		width: 100%;
		padding: 0.75rem 0.85rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-border) 78%, white 22%);
		background: var(--color-bg-elevated);
		color: var(--color-text);
		font: inherit;
	}

	.answer-input:focus,
	.answer-textarea:focus,
	.notes-textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-primary) 58%, var(--color-border) 42%);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 14%, transparent 86%);
	}

	.answer-textarea,
	.notes-textarea {
		resize: vertical;
		min-height: 5.5rem;
	}

	.notes-textarea {
		min-height: 4rem;
	}

	.validation-message {
		margin: 0;
		font-size: 0.82rem;
		color: #b42318;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
	}

	.action-button {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.65rem 1rem;
		border: none;
		border-radius: var(--radius-md);
		font-weight: 600;
		cursor: pointer;
		transition: transform 0.15s ease, opacity 0.15s ease;
	}

	.action-button:hover {
		transform: translateY(-1px);
	}

	.action-button.reject {
		background: color-mix(in srgb, var(--color-border) 68%, white 32%);
		color: var(--color-text);
	}

	.action-button.submit {
		background: var(--color-primary);
		color: white;
	}

	@media (max-width: 640px) {
		.actions {
			flex-direction: column-reverse;
		}

		.action-button {
			width: 100%;
			justify-content: center;
		}
	}
</style>
