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
type DraftPayload = {
	projectId: string;
	filePath: string;
	content: string | number;
	baseEtag: string | null | { value: string };
	updatedAt: string | number;
};

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function encryptedDraft(secretValue: string, draft: DraftPayload): Promise<string> {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secretValue));
	const encryptionKey = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			encryptionKey,
			encoder.encode(JSON.stringify(draft))
		)
	);
	return JSON.stringify({ version: 1, iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) });
}

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

	it('rejects a decrypted draft whose fields have the wrong types', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, snapshot, 'etag-1', secret);
		const [storageKey] = [...storage.values.keys()];
		if (!storageKey) throw new Error('draft storage key was not written');
		storage.setItem(
			storageKey,
			await encryptedDraft(secret, {
				projectId: snapshot.projectId,
				filePath: snapshot.filePath,
				content: 42,
				baseEtag: { value: 'etag-2' },
				updatedAt: 20260714
			})
		);

		expect(await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret)).toBeNull();
	});

	it('rejects a legacy draft without a concurrency token', async () => {
		const storage = memoryStorage();
		await saveDraft(storage, snapshot, 'etag-1', secret);
		const [storageKey] = [...storage.values.keys()];
		if (!storageKey) throw new Error('draft storage key was not written');
		storage.setItem(
			storageKey,
			await encryptedDraft(secret, {
				...snapshot,
				baseEtag: null,
				updatedAt: '2026-07-14T12:00:00.000Z'
			})
		);

		expect(await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret)).toBeNull();
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
