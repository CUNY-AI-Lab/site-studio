import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download';

describe('downloadBlob', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('keeps the object URL alive until after the browser has committed the download', () => {
		vi.useFakeTimers();
		const createObjectURL = vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:download');
		const revokeObjectURL = vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

		downloadBlob(new Blob(['content']), 'notes.txt');

		expect(createObjectURL).toHaveBeenCalledOnce();
		expect(click).toHaveBeenCalledOnce();
		expect(revokeObjectURL).not.toHaveBeenCalled();
		expect(document.querySelector('a[download="notes.txt"]')).toBeNull();

		vi.advanceTimersByTime(999);
		expect(revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
	});
});
