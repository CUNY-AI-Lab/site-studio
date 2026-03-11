import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';

function getLanguageExtension(filename: string) {
	if (filename.endsWith('.html')) return html();
	if (filename.endsWith('.css')) return css();
	if (filename.endsWith('.js')) return javascript();
	return html();
}

export function createEditorInstance(
	parent: HTMLElement,
	filename: string,
	content: string,
	onChange: (content: string) => void
) {
	return new EditorView({
		doc: content,
		extensions: [
			basicSetup,
			getLanguageExtension(filename),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChange(update.state.doc.toString());
				}
			})
		],
		parent
	});
}
