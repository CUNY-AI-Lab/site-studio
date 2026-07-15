import { describe, expect, it } from 'vitest';
import { clearDraft, loadDraft, rebaseDraft, saveDraft } from './draft-store';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key)
	};
}

const snapshot = { projectId: 'project-1', filePath: 'index.html', content: 'local edit' };
const secret = 'owner-scoped-csrf-token';

describe('draft-store', () => {
	it('round-trips an encrypted draft with the etag it was based on', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, snapshot, 'etag-1', secret, () => '2026-07-14T12:00:00.000Z');
		expect(await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret)).toEqual({
			...snapshot,
			baseEtag: 'etag-1',
			updatedAt: '2026-07-14T12:00:00.000Z'
		});
		expect([...storage.values.values()].join('')).not.toContain(snapshot.content);
	});

	it('does not disclose one owner draft to a different authenticated scope', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, snapshot, 'etag-1', secret);
		expect(await loadDraft(storage, snapshot.projectId, snapshot.filePath, 'different-owner-token')).toBeNull();
	});

	it('does not clear a newer queued draft when an older save completes', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, { ...snapshot, content: 'newer edit' }, 'etag-1', secret);
		await clearDraft(storage, snapshot, secret);
		expect((await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret))?.content).toBe('newer edit');
	});

	it('rebases a newer local draft after its preceding save is acknowledged', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, { ...snapshot, content: 'newer edit' }, 'etag-1', secret);
		await rebaseDraft(storage, snapshot, 'etag-1', 'etag-2', secret);
		expect((await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret))?.baseEtag).toBe('etag-2');
	});

	it('clears only the exact content confirmed saved', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, snapshot, 'etag-1', secret);
		await clearDraft(storage, snapshot, secret);
		expect(await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret)).toBeNull();
	});
});
