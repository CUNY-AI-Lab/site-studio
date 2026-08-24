const OBJECT_URL_REVOCATION_DELAY_MS = 1_000;

/** Start a browser download and keep the Blob URL alive until navigation commits. */
export function downloadBlob(blob: Blob, fileName: string): void {
	const objectUrl = window.URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = objectUrl;
	anchor.download = fileName;
	anchor.hidden = true;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOCATION_DELAY_MS);
}
