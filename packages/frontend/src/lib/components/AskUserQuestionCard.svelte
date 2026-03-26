<script lang="ts" module>
	export interface QuestionOption {
		label: string;
		description?: string;
		preview?: string;
	}

	export interface QuestionAnnotation {
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
</script>

<script lang="ts">
	import { Check, Send, X } from 'lucide-svelte';

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
			validationMessage = 'Please provide an answer to continue.';
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

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && canSubmit) {
			event.preventDefault();
			submitAnswers();
		}
	}
</script>

<div class="question-flow">
	{#each questions as question, index}
		{@const previewContent = getVisiblePreview(question, index)}

		<div class="question-text">
			{#if question.header}
				<span class="question-tag">{question.header}</span>
			{/if}
			{question.question}
		</div>

		{#if question.options && question.options.length > 0}
			{#if question.multiSelect}
				<p class="hint">Select one or more:</p>
			{/if}

			<div class="options-row">
				{#each question.options as option}
					<button
						type="button"
						class="option-pill"
						class:selected={isSelected(index, option.label)}
						aria-pressed={isSelected(index, option.label)}
						onclick={() => chooseOption(index, question, option.label)}
						onmouseenter={() => focusPreview(index, option.label)}
						onmouseleave={() => resetPreview(index)}
						onfocus={() => focusPreview(index, option.label)}
						onblur={() => resetPreview(index)}
					>
						{#if isSelected(index, option.label)}
							<Check size={12} />
						{/if}
						<span>{option.label}</span>
					</button>
				{/each}
			</div>

			{#if question.options.some(o => o.description)}
				{@const activeLabel = activeOptionByIndex[index] || getSelectedAnswers(index)[0]}
				{@const activeDesc = activeLabel ? getOption(question, activeLabel)?.description : null}
				{#if activeDesc}
					<p class="option-desc">{activeDesc}</p>
				{/if}
			{/if}

			{#if previewContent}
				<div class="preview-area">
					<iframe
						class="preview-frame"
						title={`Preview for ${question.header || question.question}`}
						sandbox=""
						srcdoc={buildPreviewDocument(previewContent)}
					></iframe>
				</div>
			{/if}

			<div class="or-divider"><span>or type your own</span></div>
			<input
				id={`question-${index}`}
				type="text"
				class="inline-input"
				placeholder={question.placeholder || 'Custom answer...'}
				value={customAnswers[index] || ''}
				oninput={(event) => updateCustomAnswer(index, question, (event.currentTarget as HTMLInputElement).value)}
				onkeydown={handleKeydown}
			/>

			{#if hasPreviewOptions(question)}
				<textarea
					id={`notes-${index}`}
					class="inline-textarea"
					rows="2"
					placeholder="Notes for the agent (optional)"
					value={notesByIndex[index] || ''}
					oninput={(event) => updateNotes(index, (event.currentTarget as HTMLTextAreaElement).value)}
				></textarea>
			{/if}
		{:else}
			<textarea
				id={`question-${index}`}
				class="inline-textarea"
				rows="3"
				placeholder={question.placeholder || 'Write your answer'}
				value={customAnswers[index] || ''}
				oninput={(event) => updateCustomAnswer(index, question, (event.currentTarget as HTMLTextAreaElement).value)}
				onkeydown={handleKeydown}
			></textarea>
		{/if}
	{/each}

	{#if validationMessage}
		<p class="validation">{validationMessage}</p>
	{/if}

	<div class="response-actions">
		<button type="button" class="action-dismiss" onclick={onReject} title="Skip question">
			<X size={14} />
		</button>
		<button
			type="button"
			class="action-send"
			class:ready={canSubmit}
			onclick={submitAnswers}
			disabled={!canSubmit}
		>
			<Send size={14} />
			<span>Reply</span>
		</button>
	</div>
</div>

<style>
	/* ---- Flow container: no card, no box, just content ---- */
	.question-flow {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.5rem 0;
	}

	/* ---- Question text: looks like assistant message prose ---- */
	.question-text {
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--color-text-primary);
		border-left: 2px solid var(--color-primary, #0d7377);
		padding-left: 0.75rem;
	}

	.question-tag {
		display: inline-block;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-primary, #0d7377);
		margin-right: 0.375rem;
		vertical-align: middle;
	}

	.hint {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	/* ---- Option pills: horizontal flow, compact ---- */
	.options-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.option-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.375rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-primary);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
	}

	.option-pill:hover {
		border-color: var(--color-primary, #0d7377);
		color: var(--color-primary, #0d7377);
	}

	.option-pill.selected {
		border-color: var(--color-primary, #0d7377);
		background: color-mix(in srgb, var(--color-primary, #0d7377) 12%, transparent 88%);
		color: var(--color-primary, #0d7377);
		font-weight: 600;
	}

	.option-desc {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		font-style: italic;
		padding-left: 0.75rem;
		border-left: 2px solid var(--color-border);
	}

	/* ---- Preview (only when options have previews) ---- */
	.preview-area {
		border-radius: var(--radius-md);
		overflow: hidden;
		border: 1px solid var(--color-border);
	}

	.preview-frame {
		display: block;
		width: 100%;
		min-height: 12rem;
		border: 0;
		background: white;
	}

	/* ---- Divider ---- */
	.or-divider {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
	}

	.or-divider::before,
	.or-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}

	/* ---- Inline inputs: no wrapper box ---- */
	.inline-input,
	.inline-textarea {
		width: 100%;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary, rgba(255, 255, 255, 0.04));
		color: var(--color-text-primary);
		font: inherit;
		font-size: 0.875rem;
	}

	.inline-input:focus,
	.inline-textarea:focus {
		outline: none;
		border-color: var(--color-primary, #0d7377);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary, #0d7377) 16%, transparent 84%);
	}

	.inline-textarea {
		resize: vertical;
		min-height: 3.5rem;
	}

	.validation {
		margin: 0;
		font-size: 0.8125rem;
		color: #ef4444;
	}

	/* ---- Action row: small, right-aligned ---- */
	.response-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.5rem;
	}

	.action-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-full, 999px);
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-tertiary);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.action-dismiss:hover {
		border-color: #ef4444;
		color: #ef4444;
		background: color-mix(in srgb, #ef4444 8%, transparent 92%);
	}

	.action-send {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius-full, 999px);
		border: none;
		background: var(--color-border);
		color: var(--color-text-tertiary);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: not-allowed;
		transition: all 0.15s ease;
		opacity: 0.5;
	}

	.action-send.ready {
		background: var(--color-primary, #0d7377);
		color: white;
		cursor: pointer;
		opacity: 1;
	}

	.action-send.ready:hover {
		filter: brightness(1.1);
	}
</style>
