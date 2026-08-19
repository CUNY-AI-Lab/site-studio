<script lang="ts">
	import { Check, MessageCircleQuestion, Send, X, Pencil } from 'lucide-svelte';

	export interface QuestionOption {
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
		busy = false,
		onSubmit,
		onReject
	}: {
		questions: UserQuestionPrompt[];
		busy?: boolean;
		onSubmit: (submission: UserQuestionSubmission) => void;
		onReject: () => void;
	} = $props();

	let selectedAnswers = $state<Record<number, string[]>>({});
	let customAnswers = $state<Record<number, string>>({});
	let showCustomInput = $state<Record<number, boolean>>({});
	let validationMessage = $state('');

	function getSelectedAnswers(index: number): string[] {
		return selectedAnswers[index] || [];
	}

	function isSelected(index: number, label: string): boolean {
		return getSelectedAnswers(index).includes(label);
	}

	function chooseOption(index: number, question: UserQuestionPrompt, label: string) {
		if (busy) return;
		if (question.multiSelect) {
			const current = getSelectedAnswers(index);
			selectedAnswers[index] = current.includes(label)
				? current.filter((item) => item !== label)
				: [...current, label];
		} else {
			selectedAnswers[index] = [label];
			customAnswers[index] = '';
			showCustomInput[index] = false;
		}
		validationMessage = '';
	}

	function toggleCustom(index: number, question: UserQuestionPrompt) {
		if (busy) return;
		showCustomInput[index] = !showCustomInput[index];
		if (showCustomInput[index]) {
			if (!question.multiSelect) {
				selectedAnswers[index] = [];
			}
			// Focus the input after it renders
			requestAnimationFrame(() => {
				const input = document.getElementById(`custom-${index}`);
				input?.focus();
			});
		} else {
			customAnswers[index] = '';
		}
		validationMessage = '';
	}

	function updateCustomAnswer(index: number, question: UserQuestionPrompt, value: string) {
		if (busy) return;
		customAnswers[index] = value;
		if (!question.multiSelect && value.trim()) {
			selectedAnswers[index] = [];
		}
		validationMessage = '';
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
		if (!question.options) return undefined;
		const previews = getSelectedAnswers(index)
			.map((label) => question.options?.find((o) => o.label === label)?.preview)
			.filter((p): p is string => Boolean(p && p.length > 0));
		return previews.length > 0 ? previews.join('\n') : undefined;
	}

	function buildAnnotation(question: UserQuestionPrompt, index: number): QuestionAnnotation | undefined {
		const preview = getSelectedPreview(question, index);
		if (!preview) return undefined;
		return { preview };
	}

	let canSubmit = $derived(
		questions.length > 0 && questions.every((question, index) => getAnswer(question, index).length > 0)
	);

	function submitAnswers() {
		if (busy) return;
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

		const submission: UserQuestionSubmission = { answers };
		if (Object.keys(annotations).length > 0) {
			submission.annotations = annotations;
		}
		onSubmit(submission);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && canSubmit && !busy) {
			event.preventDefault();
			submitAnswers();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="question-card" onkeydown={handleKeydown}>
	{#each questions as question, index}
		<div class="question-section">
			<div class="question-row">
				<span class="q-icon" aria-hidden="true">
					<MessageCircleQuestion size={16} />
				</span>
				<div class="q-text">
					{#if question.header}
						<span class="q-tag">{question.header}</span>
					{/if}
					<p class="q-label">{question.question}</p>
					{#if question.multiSelect}
						<span class="q-hint">Select multiple</span>
					{/if}
				</div>
			</div>

			{#if question.options && question.options.length > 0}
				<div class="options-row">
					{#each question.options as option}
						<button
							type="button"
							class="option-chip"
							class:selected={isSelected(index, option.label)}
							aria-pressed={isSelected(index, option.label)}
							aria-describedby={validationMessage ? 'question-validation' : undefined}
							disabled={busy}
							onclick={() => chooseOption(index, question, option.label)}
							title={option.description || ''}
						>
							{#if isSelected(index, option.label)}
								<Check size={12} strokeWidth={3} />
							{/if}
							<span>{option.label}</span>
						</button>
					{/each}

					<button
						type="button"
						class="option-chip other-chip"
						class:selected={showCustomInput[index]}
						aria-pressed={showCustomInput[index]}
						aria-describedby={validationMessage ? 'question-validation' : undefined}
						disabled={busy}
						onclick={() => toggleCustom(index, question)}
					>
						<Pencil size={11} />
						<span>Other</span>
					</button>
				</div>

				{#if showCustomInput[index]}
					<input
						id={`custom-${index}`}
						type="text"
						class="custom-input"
						aria-label={`${question.question} answer`}
						aria-describedby={validationMessage ? 'question-validation' : undefined}
						disabled={busy}
						placeholder={question.placeholder || 'Type your answer…'}
						value={customAnswers[index] || ''}
						oninput={(e) => updateCustomAnswer(index, question, (e.currentTarget as HTMLInputElement).value)}
					/>
				{/if}
			{:else}
				<textarea
					id={`freeform-${index}`}
					class="freeform-input"
					aria-label={`${question.question} answer`}
					aria-describedby={validationMessage ? 'question-validation' : undefined}
					disabled={busy}
					rows="2"
					placeholder={question.placeholder || 'Type your answer…'}
					value={customAnswers[index] || ''}
					oninput={(e) => updateCustomAnswer(index, question, (e.currentTarget as HTMLTextAreaElement).value)}
				></textarea>
			{/if}
		</div>
	{/each}

	{#if validationMessage}
		<p id="question-validation" class="validation" role="alert" aria-live="assertive">{validationMessage}</p>
	{/if}

	<div class="card-actions">
		<button type="button" class="action-btn reject" disabled={busy} onclick={onReject}>
			<X size={15} />
			<span>Skip</span>
		</button>
		<button type="button" class="action-btn submit" disabled={!canSubmit || busy} onclick={submitAnswers}>
			<Send size={14} />
			<span>Reply</span>
		</button>
	</div>
</div>

<style>
	.question-card {
		background: linear-gradient(
			145deg,
			rgba(30, 32, 38, 0.98) 0%,
			rgba(24, 26, 32, 0.98) 100%
		);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 12px;
		overflow: hidden;
		box-shadow:
			0 4px 24px rgba(0, 0, 0, 0.3),
			0 0 0 1px rgba(255, 255, 255, 0.03) inset;
		margin: 0.75rem 0;
		animation: cardIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
		flex-shrink: 0;
	}

	@keyframes cardIn {
		from {
			opacity: 0;
			transform: translateY(-8px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	/* ── Question section ── */
	.question-section {
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.question-section + .question-section {
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.question-row {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.q-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 7px;
		background: rgba(13, 115, 119, 0.18);
		color: #5eead4;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.q-text {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.q-tag {
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #71717a;
	}

	.q-label {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 500;
		color: #e4e4e7;
		line-height: 1.45;
	}

	.q-hint {
		font-size: 0.6875rem;
		color: #71717a;
	}

	/* ── Option chips ── */
	.options-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding-left: calc(28px + 0.75rem); /* align with question text */
	}

	.option-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.75rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(255, 255, 255, 0.04);
		color: #d4d4d8;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
	}

	.option-chip:hover {
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(255, 255, 255, 0.16);
	}

	.option-chip:disabled,
	.custom-input:disabled,
	.freeform-input:disabled,
	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.option-chip.selected {
		background: rgba(13, 115, 119, 0.22);
		border-color: rgba(13, 115, 119, 0.5);
		color: #5eead4;
	}

	.other-chip {
		border-style: dashed;
	}

	.other-chip.selected {
		border-style: solid;
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(255, 255, 255, 0.18);
		color: #d4d4d8;
	}

	/* ── Inputs ── */
	.custom-input,
	.freeform-input {
		margin-left: calc(28px + 0.75rem);
		width: calc(100% - 28px - 0.75rem);
		padding: 0.5rem 0.75rem;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(0, 0, 0, 0.25);
		color: #e4e4e7;
		font: inherit;
		font-size: 0.8125rem;
		transition: border-color 0.15s ease;
		animation: inputFade 0.15s ease;
	}

	@keyframes inputFade {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.custom-input:focus,
	.freeform-input:focus {
		outline: none;
		border-color: rgba(13, 115, 119, 0.5);
		box-shadow: 0 0 0 2px rgba(13, 115, 119, 0.15);
	}

	.custom-input::placeholder,
	.freeform-input::placeholder {
		color: #52525b;
	}

	.freeform-input {
		resize: vertical;
		min-height: 3rem;
	}

	/* ── Validation ── */
	.validation {
		margin: 0;
		padding: 0 1.25rem;
		font-size: 0.75rem;
		color: #ef4444;
	}

	/* ── Actions ── */
	.card-actions {
		display: flex;
		gap: 0.625rem;
		padding: 0.875rem 1rem;
		background: rgba(0, 0, 0, 0.2);
		border-top: 1px solid rgba(255, 255, 255, 0.05);
	}

	.action-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.6rem 1rem;
		border-radius: 8px;
		font-size: 0.8125rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.action-btn:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.action-btn:active {
		transform: translateY(0);
	}

	.action-btn.reject {
		background: rgba(255, 255, 255, 0.06);
		color: #a1a1aa;
		border: 1px solid rgba(255, 255, 255, 0.08);
	}

	.action-btn.reject:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #d4d4d8;
	}

	.action-btn.submit {
		background: linear-gradient(135deg, #0d7377 0%, #0a5c5f 100%);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 2px 8px rgba(13, 115, 119, 0.3);
	}

	.action-btn.submit:hover:not(:disabled) {
		background: linear-gradient(135deg, #0a5c5f 0%, #084547 100%);
		box-shadow: 0 4px 12px rgba(13, 115, 119, 0.4);
	}

	.action-btn.submit:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@media (max-width: 640px) {
		.options-row {
			padding-left: 0;
		}

		.custom-input,
		.freeform-input {
			margin-left: 0;
			width: 100%;
		}
	}
</style>
