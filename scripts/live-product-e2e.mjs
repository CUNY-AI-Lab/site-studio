import WebSocket from 'ws';
import { z } from 'zod';

const PRODUCTION_SITE_URL = 'https://site-studio-app.ailab-452.workers.dev/site-studio/';
const PRODUCTION_PUBLIC_ORIGIN = 'https://cail-doorway.ailab-452.workers.dev';
const PRODUCTION_PUBLIC_PATH = '/site-studio';
const PRODUCTION_IDENTITY_ISSUER = `${PRODUCTION_PUBLIC_ORIGIN}/cail-sso`;
const CHAT_REQUEST = 'cf_agent_use_chat_request';
const CHAT_RESPONSE = 'cf_agent_use_chat_response';
const CHAT_CANCEL = 'cf_agent_chat_request_cancel';
const STREAM_RESUMING = 'cf_agent_stream_resuming';
const STREAM_RESUME_ACK = 'cf_agent_stream_resume_ack';

const jwtClaimsSchema = z.object({
	sub: z.string().regex(/^cail-[0-9a-f]{32}$/),
	iss: z.string(),
	aud: z.string()
});
const jsonValueSchema = z.lazy(() => z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(jsonValueSchema),
	z.record(z.string(), jsonValueSchema)
]));
const textChunkSchema = z.object({ delta: z.string().optional(), text: z.string().optional() }).passthrough();
const chatMessageSchema = z.object({
	id: z.string(),
	type: z.string().optional(),
	error: jsonValueSchema.optional(),
	body: jsonValueSchema.optional(),
	done: z.boolean().optional()
}).passthrough();

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function jwtClaims(jwt, audience) {
	const payload = jwt.split('.')[1];
	if (!payload) throw new Error(`${audience} JWT is malformed`);
	const claims = jwtClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
	if (!claims.success) {
		throw new Error(`${audience} JWT has no canonical subject`);
	}
	if (claims.data.iss !== PRODUCTION_IDENTITY_ISSUER || claims.data.aud !== audience) {
		throw new Error(`${audience} JWT has the wrong issuer or scalar audience`);
	}
	return claims.data;
}

function parseCsrfCookie(response) {
	const header = response.headers.get('set-cookie') ?? '';
	const match = /(?:^|,\s*)cail_csrf_sitestudio=([^;,\s]+)/i.exec(header);
	return match ? decodeURIComponent(match[1]) : '';
}

function userMessage(text) {
	return {
		id: `msg_${crypto.randomUUID()}`,
		role: 'user',
		parts: [{ type: 'text', text }]
	};
}

function textFromChunk(chunk) {
	const parsed = textChunkSchema.safeParse(chunk);
	if (!parsed.success) return '';
	if (parsed.data.delta !== undefined) return parsed.data.delta;
	if (parsed.data.text !== undefined) return parsed.data.text;
	return '';
}

function linkedResource(html, attribute, filename, documentUrl) {
	const escapedFilename = filename.replace('.', '\\.');
	const pattern = new RegExp(`${attribute}=["']([^"']*${escapedFilename}[^"']*)["']`, 'i');
	const match = pattern.exec(html);
	if (!match) throw new Error(`${filename} is not linked from ${documentUrl.pathname}`);
	return new URL(match[1], documentUrl);
}

async function assertPublicResource(resourceUrl, expectedType, marker, context) {
	const response = await fetch(resourceUrl, { redirect: 'manual' });
	const body = await response.text();
	if (!response.ok) throw new Error(`${context} returned ${response.status}`);
	if (!response.headers.get('content-type')?.toLowerCase().startsWith(expectedType)) {
		throw new Error(`${context} returned an unexpected content type`);
	}
	if (!body.includes(marker)) throw new Error(`${context} did not contain the required marker`);
	if (response.headers.get('content-security-policy') !== 'sandbox allow-scripts') {
		throw new Error(`${context} did not include the app content security policy`);
	}
	return { response, body };
}

async function assertPublishedDocument(documentUrl, marker, context) {
	const response = await fetch(documentUrl, { redirect: 'manual' });
	const body = await response.text();
	if (!response.ok || !body.includes(marker)) {
		throw new Error(`${context} returned ${response.status}`);
	}
	if (response.headers.get('content-security-policy') !== 'sandbox allow-scripts') {
		throw new Error(`${context} did not include the app content security policy`);
	}
	const stylesUrl = linkedResource(body, 'href', 'styles.css', documentUrl);
	const scriptUrl = linkedResource(body, 'src', 'script.js', documentUrl);
	await assertPublicResource(stylesUrl, 'text/css', marker, `${context} stylesheet`);
	await assertPublicResource(scriptUrl, 'application/javascript', marker, `${context} script`);
	return response;
}

let interrupted = false;
let activeSocket = null;
let activeChat = null;
let cleaningUp = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		interrupted = true;
		if (activeChat?.socket.readyState === WebSocket.OPEN) {
			try {
				activeChat.socket.send(JSON.stringify({ type: CHAT_CANCEL, id: activeChat.requestId }));
			} catch {
				activeChat.socket.close();
			}
		} else {
			activeSocket?.close();
		}
	});
}

function requireNotInterrupted() {
	if (interrupted) throw new Error('live product E2E was interrupted');
}

async function runChat({ baseUrl, projectId, csrfToken, headers, messages, prompt }) {
	const requestId = crypto.randomUUID();
	const target = new URL(`api/agents/site-builder/${encodeURIComponent(projectId)}`, baseUrl);
	target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
	target.searchParams.set('csrf', csrfToken);

	const socket = new WebSocket(target, { headers: Object.fromEntries(headers) });
	activeSocket = socket;
	await new Promise((resolve, reject) => {
		const onOpen = () => {
			socket.off('error', onError);
			socket.off('close', onClose);
			resolve();
		};
		const onError = (error) => {
			socket.off('open', onOpen);
			socket.off('close', onClose);
			if (activeSocket === socket) activeSocket = null;
			socket.close();
			reject(error);
		};
		const onClose = (code) => {
			socket.off('open', onOpen);
			socket.off('error', onError);
			if (activeSocket === socket) activeSocket = null;
			reject(new Error(`chat socket closed during handshake with code ${code}`));
		};
		socket.once('open', onOpen);
		socket.once('error', onError);
		socket.once('close', onClose);
	});

	return new Promise((resolve, reject) => {
		const text = [];
		const tools = new Set();
		let sawFinish = false;
		let settled = false;

		const cleanup = () => {
			socket.off('message', onMessage);
			socket.off('error', fail);
			socket.off('close', onClose);
			if (activeSocket === socket) activeSocket = null;
			if (activeChat?.socket === socket) activeChat = null;
		};
		const finish = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close();
			resolve(value);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close();
			reject(error);
		};
		const onClose = (code) => fail(new Error(`chat socket closed before completion with code ${code}`));
		const onMessage = (raw) => {
			try {
				const messageResult = chatMessageSchema.safeParse(JSON.parse(raw.toString('utf8')));
				if (!messageResult.success) throw new Error('chat stream sent an invalid message');
				const message = messageResult.data;
				if (message.id !== requestId) return;
				if (message.type === STREAM_RESUMING) {
					socket.send(JSON.stringify({ type: STREAM_RESUME_ACK, id: requestId }));
					return;
				}
				if (message.type !== CHAT_RESPONSE) return;
				if (message.error) throw new Error(message.body || 'chat stream failed');
				const bodyResult = z.string().safeParse(message.body);
				if (bodyResult.success && bodyResult.data.trim()) {
					const chunk = JSON.parse(bodyResult.data);
					if (chunk.type === 'finish') sawFinish = true;
					const part = textFromChunk(chunk);
					if (part) text.push(part);
					const toolName = z.string().safeParse(chunk.toolName);
					if (toolName.success) tools.add(toolName.data);
				}
				if (message.done) {
					if (!sawFinish) throw new Error('chat stream ended without a finish event');
					finish({ text: text.join('').trim(), tools: [...tools] });
				}
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};

		socket.on('message', onMessage);
		socket.once('error', fail);
		socket.once('close', onClose);
		activeChat = { socket, requestId };
		socket.send(JSON.stringify({
			type: CHAT_REQUEST,
			id: requestId,
			init: {
				method: 'POST',
				body: JSON.stringify({
					messages: [...messages, userMessage(prompt)],
					trigger: 'submit-message'
				})
			}
		}));
	});
}

const baseUrl = new URL(required('SITE_STUDIO_URL'));
if (baseUrl.href !== PRODUCTION_SITE_URL) {
	throw new Error(`SITE_STUDIO_URL must be the standalone production Worker at ${PRODUCTION_SITE_URL}`);
}
const appJwt = required('SITE_STUDIO_APP_IDENTITY_JWT');
const gatewayJwt = required('SITE_STUDIO_GATEWAY_IDENTITY_JWT');
const appClaims = jwtClaims(appJwt, 'cail:site-studio');
const gatewayClaims = jwtClaims(gatewayJwt, 'cail:gateway');
if (appClaims.sub !== gatewayClaims.sub) throw new Error('app and Gateway JWT subjects differ');

const proofId = crypto.randomUUID().replaceAll('-', '');
const marker = `site-studio-live-${proofId}`;
const projectName = `Site Studio live ${proofId}`;
const projectId = marker;

const appHeaders = new Headers({ 'X-CAIL-Identity-JWT': appJwt });
const keyringHeaders = new Headers(appHeaders);
keyringHeaders.set('X-CAIL-Gateway-Identity-JWT', gatewayJwt);
let csrfToken = '';

function url(path) {
	return new URL(path.replace(/^\/+/, ''), baseUrl);
}

function mountedWorkerPath(target) {
	const targetUrl = target instanceof URL ? target : new URL(target, baseUrl);
	if (targetUrl.origin !== baseUrl.origin) {
		throw new Error(`worker resource resolved outside the standalone Worker: ${targetUrl.href}`);
	}
	const mountPath = baseUrl.pathname.replace(/\/+$/, '');
	if (mountPath && !targetUrl.pathname.startsWith(`${mountPath}/`)) {
		throw new Error(`worker resource escaped the configured mount path: ${targetUrl.pathname}`);
	}
	const relativePath = mountPath
		? targetUrl.pathname.slice(mountPath.length + 1)
		: targetUrl.pathname.replace(/^\/+/, '');
	return `${relativePath}${targetUrl.search}`;
}

async function request(path, init = {}) {
	if (!cleaningUp) requireNotInterrupted();
	const headers = new Headers(appHeaders);
	for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
	if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
		if (!csrfToken) throw new Error('CSRF token has not been established');
		headers.set('X-CSRF-Token', csrfToken);
	}
	const response = await fetch(url(path), { ...init, headers, redirect: 'manual' });
	if (path === 'api/csrf') csrfToken = parseCsrfCookie(response);
	return response;
}

async function json(path, init = {}) {
	const response = await request(path, init);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.error ?? 'unknown error'}`);
	return body;
}

async function getMessages() {
	const response = await request(`api/agents/site-builder/${encodeURIComponent(projectId)}/get-messages`);
	if (!response.ok) throw new Error(`agent messages returned ${response.status}`);
	const messages = await response.json().catch(() => []);
	return Array.isArray(messages) ? messages : [];
}

async function persistedAssistantMessages() {
	while (true) {
		requireNotInterrupted();
		const messages = await getMessages();
		if (
			messages.some(
				(message) => message?.role === 'assistant' && Array.isArray(message.parts) && message.parts.length > 0
			)
		) return messages;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

let projectAttempted = false;
let directPublicUrl = null;
let doorwayPublicUrl = null;

async function deleteProject() {
	const response = await request(`api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
	if (!response.ok && response.status !== 404) {
		throw new Error(`project cleanup failed with ${response.status}`);
	}
}

async function assertProjectAbsent() {
	const projects = await json('api/projects');
	if (projects.projects?.some((project) => project.id === projectId)) {
		throw new Error('proof project still appears after deletion');
	}
}

async function cleanupProject() {
	if (!projectAttempted) return { projectDeleted: true, agentChatHistoryCleared: true };
	await deleteProject();
	await assertProjectAbsent();
	if (directPublicUrl) {
		const publicAfterDelete = await fetch(directPublicUrl, { redirect: 'manual' });
		if (publicAfterDelete.status !== 404) {
			throw new Error(`deleted public project returned ${publicAfterDelete.status}, expected 404`);
		}
	}
	if (doorwayPublicUrl) {
		const doorwayAfterDelete = await fetch(doorwayPublicUrl, { redirect: 'manual' });
		if (doorwayAfterDelete.status !== 404) {
			throw new Error(`deleted Doorway project returned ${doorwayAfterDelete.status}, expected 404`);
		}
	}

	const recreated = await json('api/projects', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: projectName, template: 'blank' })
	});
	if (recreated.id !== projectId) throw new Error('history probe recreated an unexpected project');
	if ((await getMessages()).length !== 0) throw new Error('agent history survived project deletion');
	await deleteProject();
	await assertProjectAbsent();
	return { projectDeleted: true, agentChatHistoryCleared: true };
}

const publicHealthResponse = await fetch(url('api/health'), { redirect: 'manual' });
const health = await publicHealthResponse.json().catch(() => ({}));
if (!publicHealthResponse.ok || health.status !== 'ok' || health.product_id !== 'site-studio') {
	throw new Error(`standalone production health failed with ${publicHealthResponse.status}`);
}

let summary = null;
let runError = null;
let cleanup = null;
let cleanupError = null;
try {
	const projectsBeforeResponse = await request('api/projects');
	const projectsBefore = await projectsBeforeResponse.json().catch(() => ({}));
	if (!projectsBeforeResponse.ok || !Array.isArray(projectsBefore.projects)) {
		throw new Error(`app-only project read failed with ${projectsBeforeResponse.status}`);
	}
	if (projectsBefore.projects.some((project) => project.id === projectId)) {
		throw new Error('proof project already exists; no mutation was made');
	}
	const { handle } = await json('api/handle');
	const handleResult = z.string().min(1).safeParse(handle);
	if (!handleResult.success) {
		throw new Error('the admitted identity must already own a Site Studio handle');
	}
	const appOnlyQuota = await request('api/quota');
	if (appOnlyQuota.status !== 401) {
		throw new Error(`app-only Gateway-dependent request returned ${appOnlyQuota.status}, expected 401`);
	}
	const csrf = await request('api/csrf');
	if (!csrf.ok || !csrfToken) throw new Error('Site Studio did not establish CSRF state');

	projectAttempted = true;
	const project = await json('api/projects', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: projectName, template: 'blank' })
	});
	if (project.id !== projectId) throw new Error('project creation returned an unexpected deterministic id');
	const initialMessages = await getMessages();
	if (initialMessages.length !== 0) throw new Error('proof project started with stale agent history');

	const prompt = [
		'Build a complete, polished one-page academic project site in this project using exactly three local files: index.html, styles.css, and script.js.',
		`The visible page must contain the exact text ${JSON.stringify(marker)}.`,
		'index.html must link to styles.css with a relative stylesheet link and script.js with a relative deferred script tag; styles.css and script.js must each include the exact marker in their contents.',
		'Do not use inline styles or scripts, images, or external resources. Use the project tools to write all three files, then briefly state what you built.',
		'Do not ask a follow-up question.'
	].join(' ');
	const chat = await runChat({
		baseUrl,
		projectId,
		csrfToken,
		headers: keyringHeaders,
		messages: initialMessages,
		prompt
	});
	if (!chat.text) throw new Error('paid authoring completed without an assistant response');
	const persistedMessages = await persistedAssistantMessages();

	const file = await json(`api/projects/${encodeURIComponent(projectId)}/file?path=index.html`);
	if (!file.content.includes(marker)) throw new Error('paid authoring completed without the required page marker');
	const stylesFile = await json(`api/projects/${encodeURIComponent(projectId)}/file?path=styles.css`);
	const scriptFile = await json(`api/projects/${encodeURIComponent(projectId)}/file?path=script.js`);
	if (!stylesFile.content.includes(marker) || !scriptFile.content.includes(marker)) {
		throw new Error('paid authoring completed without the required linked asset markers');
	}
	const authoredIndex = String(file.content);
	if (!/href=["'](?:\.\/)?styles\.css(?:["']|\?)/i.test(authoredIndex)) {
		throw new Error('index.html does not link the local stylesheet');
	}
	if (!/src=["'](?:\.\/)?script\.js(?:["']|\?)/i.test(authoredIndex)) {
		throw new Error('index.html does not link the local script');
	}
	const preview = await request(`preview/${encodeURIComponent(projectId)}/`, { headers: { accept: 'text/html' } });
	const previewBody = await preview.text();
	const previewUrl = url(`preview/${encodeURIComponent(projectId)}/`);
	if (!preview.ok || !previewBody.includes(marker)) throw new Error(`preview failed with ${preview.status}`);
	if (preview.headers.get('content-security-policy') !== 'sandbox allow-scripts') {
		throw new Error('preview did not include the app content security policy');
	}
	const previewStylesUrl = linkedResource(previewBody, 'href', 'styles.css', previewUrl);
	const previewScriptUrl = linkedResource(previewBody, 'src', 'script.js', previewUrl);
	const previewResourcePrefix = `preview/${encodeURIComponent(projectId)}/`;
	const previewStylesPath = mountedWorkerPath(previewStylesUrl);
	const previewScriptPath = mountedWorkerPath(previewScriptUrl);
	if (!previewStylesPath.startsWith(`${previewResourcePrefix}styles.css`) ||
		!previewScriptPath.startsWith(`${previewResourcePrefix}script.js`)) {
		throw new Error('preview linked resources did not resolve beneath the project preview path');
	}
	const previewStyles = await request(previewStylesPath);
	const previewScript = await request(previewScriptPath);
	if (!previewStyles.ok || !previewStyles.headers.get('content-type')?.toLowerCase().startsWith('text/css')) {
		throw new Error(`preview stylesheet failed with ${previewStyles.status}`);
	}
	if (!previewScript.ok || !previewScript.headers.get('content-type')?.toLowerCase().startsWith('application/javascript')) {
		throw new Error(`preview script failed with ${previewScript.status}`);
	}
	if (!(await previewStyles.text()).includes(marker) || !(await previewScript.text()).includes(marker)) {
		throw new Error('preview linked assets did not contain the required marker');
	}

	const published = await json(`api/projects/${encodeURIComponent(projectId)}/publish`, { method: 'POST' });
	if (published.success !== true) throw new Error('publish did not report success');
	const publishedUrl = new URL(published.url);
	if (
		publishedUrl.origin !== PRODUCTION_PUBLIC_ORIGIN ||
		!publishedUrl.pathname.startsWith(`${PRODUCTION_PUBLIC_PATH}/u/${handle}/`)
	) throw new Error('publish returned an unexpected configured public URL');
	directPublicUrl = new URL(`${publishedUrl.pathname}${publishedUrl.search}`, baseUrl.origin);
	doorwayPublicUrl = publishedUrl;
	const publicResponse = await assertPublishedDocument(directPublicUrl, marker, 'direct Worker public fetch');
	await assertPublishedDocument(doorwayPublicUrl, marker, 'Doorway public fetch');

	summary = {
		boundary: 'direct signed-identity standalone Worker to production Gateway; not CUNY browser login',
		proofProject: projectId,
		publicHealthStatus: publicHealthResponse.status,
		appOnlyProjectsStatus: projectsBeforeResponse.status,
		appOnlyQuotaStatus: appOnlyQuota.status,
		assistantText: chat.text.replaceAll(marker, '<proof-marker>'),
		assistantPersisted: persistedMessages.some((message) => message?.role === 'assistant'),
		tools: chat.tools,
		fileAuthored: true,
		previewStatus: preview.status,
		publishStatus: true,
		directWorkerPublicStatus: publicResponse.status
	};
} catch (error) {
	runError = error;
} finally {
	try {
		cleaningUp = true;
		cleanup = await cleanupProject();
	} catch (error) {
		cleanupError = error;
	}
}

if (interrupted) {
	throw new Error(`live product E2E was interrupted; inspect proof project ${projectId}`, { cause: cleanupError });
}
if (runError) {
	throw new Error(`${runError.message}; inspect proof project ${projectId}`, {
		cause: cleanupError ?? runError.cause
	});
}
if (cleanupError) {
	throw new Error(`cleanup failed; inspect proof project ${projectId}`, { cause: cleanupError });
}
console.log(JSON.stringify({ ...summary, ...cleanup }, null, 2));
