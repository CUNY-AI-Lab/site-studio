import type { SaveSnapshot } from './autosave';
import { z } from 'zod';

export interface StoredDraft extends SaveSnapshot {
	baseEtag: string | null;
	updatedAt: string;
}

type EncryptedDraft = {
	version: 1;
	iv: string;
	ciphertext: string;
};

const encryptedDraftSchema = z.object({
	version: z.literal(1),
	iv: z.string().min(1),
	ciphertext: z.string().min(1)
});
const storedDraftSchema = z.object({
	projectId: z.string(),
	filePath: z.string(),
	content: z.string(),
	baseEtag: z.string().nullable(),
	updatedAt: z.string()
});

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
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return buffer;
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
		const parsedEnvelope = encryptedDraftSchema.safeParse(JSON.parse(raw));
		if (!parsedEnvelope.success) {
			return null;
		}
		const envelope: EncryptedDraft = parsedEnvelope.data;
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(envelope.iv) },
			await key(secret),
			fromBase64(envelope.ciphertext)
		);
		const parsedDraft = storedDraftSchema.safeParse(JSON.parse(decoder.decode(plaintext)));
		if (!parsedDraft.success || parsedDraft.data.projectId !== projectId || parsedDraft.data.filePath !== filePath) {
			return null;
		}
		return parsedDraft.data;
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
