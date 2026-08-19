<script module lang="ts">
	import { marked } from 'marked';
	import { markedHighlight } from 'marked-highlight';
	import DOMPurify from 'dompurify';
	import hljs from 'highlight.js/lib/core';
	import javascript from 'highlight.js/lib/languages/javascript';
	import typescript from 'highlight.js/lib/languages/typescript';
	import python from 'highlight.js/lib/languages/python';
	import html from 'highlight.js/lib/languages/xml';
	import css from 'highlight.js/lib/languages/css';
	import json from 'highlight.js/lib/languages/json';
	import bash from 'highlight.js/lib/languages/bash';
	import { browserWindow } from '$lib/contracts';

	// One-time configuration of the module-global `marked` singleton. This lives in
	// a `<script module>` block so it runs exactly ONCE per module load rather than
	// on every component instantiation. Registering the highlight extension and
	// language grammars per-instance would stack them on the shared singleton, so a
	// second mounted message would re-highlight already-highlighted HTML (producing
	// garbled, multiply-escaped output).
	hljs.registerLanguage('javascript', javascript);
	hljs.registerLanguage('typescript', typescript);
	hljs.registerLanguage('python', python);
	hljs.registerLanguage('html', html);
	hljs.registerLanguage('css', css);
	hljs.registerLanguage('json', json);
	hljs.registerLanguage('bash', bash);

	marked.use(
		markedHighlight({
			langPrefix: 'hljs language-',
			highlight(code: string, lang: string) {
				const language = hljs.getLanguage(lang) ? lang : 'plaintext';
				return hljs.highlight(code, { language }).value;
			}
		})
	);

	marked.setOptions({
		breaks: true,
		gfm: true
	});

	// Sanitizer configuration. Chat content (assistant text, user text, and — via
	// the agent — file/PDF/search-result text) is untrusted: an attacker can plant
	// markup in a file the agent later echoes into chat. Because this renders in the
	// top-level app origin (session cookie, credentialed /api/* calls), any raw
	// <script>, on* handler, or javascript:/data: URI would be app-origin XSS.
	//
	// We run marked's HTML output through DOMPurify with an allowlist limited to the
	// inert formatting tags markdown produces. Images are excluded entirely:
	// assistant or file-derived markdown must not initiate attacker-controlled
	// network requests from the authenticated app page.
	const SANITIZE_CONFIG = {
		ALLOWED_TAGS: [
			'p', 'br', 'hr', 'span', 'div',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
			'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
			'ul', 'ol', 'li',
			'blockquote',
			'pre', 'code',
			'a',
			'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'
		],
		ALLOWED_ATTR: ['href', 'title', 'alt', 'class', 'align', 'colspan', 'rowspan'],
		// URI-scheme safety is left to DOMPurify's audited default ALLOWED_URI_REGEXP,
		// which permits http(s), mailto, tel, relative links, and safe data:image/*
		// while blocking javascript:, vbscript:, and data:text/html. A hand-rolled
		// regexp here is easy to get wrong (an over-broad one let data:text/html
		// through), so we intentionally do NOT override it.
		FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'svg', 'math'],
		FORBID_ATTR: ['style'],
		ALLOW_DATA_ATTR: false
	};

	// Harden anchors: external-looking links open with noopener/noreferrer so a
	// rendered link can't reach back into window.opener. Only runs in the browser
	// (DOMPurify hooks require a DOM); harmless if it never registers under SSR.
	let hookRegistered = false;
	function ensureHook() {
		if (hookRegistered || !browserWindow()) return;
		DOMPurify.addHook('afterSanitizeAttributes', (node) => {
			if (node.tagName === 'A' && node.hasAttribute('href')) {
				node.setAttribute('rel', 'noopener noreferrer');
				if (/^https?:/i.test(node.getAttribute('href') ?? '')) {
					node.setAttribute('target', '_blank');
				}
			}
		});
		hookRegistered = true;
	}

	// Escape fallback for any non-browser (SSR/prerender) render path: emit inert
	// text rather than trusting unsanitized markup where DOMPurify has no DOM.
	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// Turn untrusted markdown into sanitized, inert HTML. Kept at module scope so it
	// closes over the shared config/hook without re-creating them per instance.
	function renderMarkdown(content: string): string {
		const rawHtml = marked.parse(content, { async: false });
		if (!browserWindow()) {
			// No DOM available (SSR/prerender): never emit unsanitized HTML.
			return escapeHtml(content);
		}
		ensureHook();
		return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
	}
</script>

<script lang="ts">
	let {
		content,
		role = 'assistant'
	}: {
		content: string;
		role?: 'user' | 'assistant';
	} = $props();

	let renderedContent = $derived(renderMarkdown(content));
</script>

<div class="message-content {role}">
	{@html renderedContent}
</div>

<style>
	.message-content {
		line-height: 1.6;
		word-wrap: break-word;
	}

	.message-content :global(p) {
		margin: 0 0 0.75rem 0;
	}

	.message-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.message-content :global(h1),
	.message-content :global(h2),
	.message-content :global(h3),
	.message-content :global(h4),
	.message-content :global(h5),
	.message-content :global(h6) {
		margin: 1rem 0 0.5rem 0;
		font-weight: 600;
		line-height: 1.3;
	}

	.message-content :global(h1:first-child),
	.message-content :global(h2:first-child),
	.message-content :global(h3:first-child) {
		margin-top: 0;
	}

	.message-content :global(ul),
	.message-content :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	.message-content :global(li) {
		margin: 0.25rem 0;
	}

	.message-content :global(code) {
		font-family: 'Courier New', Consolas, Monaco, monospace;
		font-size: 0.875em;
		padding: 0.125rem 0.25rem;
		border-radius: 3px;
	}

	.message-content.user :global(code) {
		background: rgba(255, 255, 255, 0.2);
		color: rgba(255, 255, 255, 0.95);
	}

	.message-content.assistant :global(code) {
		background: rgba(0, 0, 0, 0.08);
		color: rgb(214, 51, 132);
	}

	.message-content :global(pre) {
		margin: 0.75rem 0;
		padding: 0;
		border-radius: 8px;
		overflow: hidden;
		background: #1e1e1e;
	}

	.message-content :global(pre code) {
		display: block;
		padding: 1rem;
		overflow-x: auto;
		background: transparent;
		color: #d4d4d4;
		line-height: 1.5;
		font-size: 0.85rem;
	}

	/* Highlight.js theme - VS Code Dark+ inspired */
	.message-content :global(.hljs-keyword),
	.message-content :global(.hljs-selector-tag),
	.message-content :global(.hljs-literal),
	.message-content :global(.hljs-section),
	.message-content :global(.hljs-link) {
		color: #569cd6;
	}

	.message-content :global(.hljs-string),
	.message-content :global(.hljs-attr) {
		color: #ce9178;
	}

	.message-content :global(.hljs-name),
	.message-content :global(.hljs-title),
	.message-content :global(.hljs-type),
	.message-content :global(.hljs-attribute) {
		color: #4ec9b0;
	}

	.message-content :global(.hljs-number),
	.message-content :global(.hljs-symbol),
	.message-content :global(.hljs-built_in) {
		color: #b5cea8;
	}

	.message-content :global(.hljs-comment),
	.message-content :global(.hljs-quote) {
		color: #6a9955;
		font-style: italic;
	}

	.message-content :global(.hljs-function),
	.message-content :global(.hljs-params) {
		color: #dcdcaa;
	}

	.message-content :global(.hljs-variable),
	.message-content :global(.hljs-template-variable) {
		color: #9cdcfe;
	}

	.message-content :global(.hljs-meta) {
		color: #d16969;
	}

	.message-content :global(blockquote) {
		margin: 0.75rem 0;
		padding-left: 1rem;
		border-left: 3px solid var(--color-border);
		color: var(--color-text-secondary);
		font-style: italic;
	}

	.message-content :global(a) {
		color: rgb(59, 130, 246);
		text-decoration: none;
	}

	.message-content :global(a:hover) {
		text-decoration: underline;
	}

	.message-content :global(table) {
		border-collapse: collapse;
		width: 100%;
		margin: 0.75rem 0;
		font-size: 0.875rem;
	}

	.message-content :global(th),
	.message-content :global(td) {
		border: 1px solid var(--color-border);
		padding: 0.5rem;
		text-align: left;
	}

	.message-content :global(th) {
		background: var(--color-bg-tertiary);
		font-weight: 600;
	}

	.message-content :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 1rem 0;
	}

</style>
