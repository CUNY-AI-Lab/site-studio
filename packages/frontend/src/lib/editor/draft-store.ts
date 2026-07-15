import type { SaveSnapshot } from './autosave';

export interface StoredDraft extends SaveSnapshot {
	baseEtag: string | null;
	updatedAt: string;
}

type EncryptedDraft = {
	version: 1;
	iv: string;
	ciphertext: string;
};

const PREFIX = 'site-studio:draft:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function digest(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', await digest(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function storageKey(secret: string, projectId: string, filePath: string): Promise<string> {
	const scope = base64(new Uint8Array(await digest(secret))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
	return `${PREFIX}${scope}:${encodeURIComponent(projectId)}:${encodeURIComponent(filePath)}`;
}

export async function saveDraft(
	storage: Pick<Storage, 'setItem'>,
	snapshot: SaveSnapshot,
	baseEtag: string | null,
	secret: string,
	now: () => string = () => new Date().toISOString()
): Promise<void> {
	const draft: StoredDraft = { ...snapshot, baseEtag, updatedAt: now() };
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), encoder.encode(JSON.stringify(draft)))
	);
	storage.setItem(
		await storageKey(secret, snapshot.projectId, snapshot.filePath),
		JSON.stringify({ version: 1, iv: base64(iv), ciphertext: base64(ciphertext) } satisfies EncryptedDraft)
	);
}

export async function loadDraft(
	storage: Pick<Storage, 'getItem'>,
	projectId: string,
	filePath: string,
	secret: string
): Promise<StoredDraft | null> {
	try {
		const raw = storage.getItem(await storageKey(secret, projectId, filePath));
		if (!raw) return null;
		const envelope = JSON.parse(raw) as Partial<EncryptedDraft>;
		if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
			return null;
		}
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(envelope.iv) },
			await key(secret),
			fromBase64(envelope.ciphertext)
		);
		const draft = JSON.parse(decoder.decode(plaintext)) as Partial<StoredDraft>;
		if (
			draft.projectId !== projectId ||
			draft.filePath !== filePath ||
			typeof draft.content !== 'string' ||
			(draft.baseEtag !== null && typeof draft.baseEtag !== 'string') ||
			typeof draft.updatedAt !== 'string'
		) {
			return null;
		}
		return draft as StoredDraft;
	} catch {
		return null;
	}
}

export async function clearDraft(
	storage: Pick<Storage, 'getItem' | 'removeItem'>,
	snapshot: SaveSnapshot,
	secret: string
): Promise<void> {
	const draft = await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret);
	if (draft?.content === snapshot.content) {
		storage.removeItem(await storageKey(secret, snapshot.projectId, snapshot.filePath));
	}
}

export async function rebaseDraft(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	snapshot: SaveSnapshot,
	previousBaseEtag: string | null,
	nextBaseEtag: string,
	secret: string
): Promise<void> {
	const draft = await loadDraft(storage, snapshot.projectId, snapshot.filePath, secret);
	if (draft && draft.content !== snapshot.content && draft.baseEtag === previousBaseEtag) {
		await saveDraft(storage, draft, nextBaseEtag, secret, () => draft.updatedAt);
	}
}
