import WebSocket from 'ws';

const PRODUCTION_SITE_URL = 'https://site-studio-app.ailab-452.workers.dev/site-studio/';
const PRODUCTION_PUBLIC_ORIGIN = 'https://tools.ailab.gc.cuny.edu';
const PRODUCTION_IDENTITY_ISSUER = `${PRODUCTION_PUBLIC_ORIGIN}/cail-sso`;
const CHAT_REQUEST = 'cf_agent_use_chat_request';
const CHAT_RESPONSE = 'cf_agent_use_chat_response';
const CHAT_CANCEL = 'cf_agent_chat_request_cancel';
const STREAM_RESUMING = 'cf_agent_stream_resuming';
const STREAM_RESUME_ACK = 'cf_agent_stream_resume_ack';

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function jwtClaims(jwt, audience) {
	const payload = jwt.split('.')[1];
	if (!payload) throw new Error(`${audience} JWT is malformed`);
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	if (typeof claims.sub !== 'string' || !/^cail-[0-9a-f]{32}$/.test(claims.sub)) {
		throw new Error(`${audience} JWT has no canonical subject`);
	}
	if (claims.iss !== PRODUCTION_IDENTITY_ISSUER || claims.aud !== audience) {
		throw new Error(`${audience} JWT has the wrong issuer or scalar audience`);
	}
	return claims;
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
	if (typeof chunk?.delta === 'string') return chunk.delta;
	if (typeof chunk?.text === 'string') return chunk.text;
	return '';
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
				const message = JSON.parse(raw.toString('utf8'));
				if (message.id !== requestId) return;
				if (message.type === STREAM_RESUMING) {
					socket.send(JSON.stringify({ type: STREAM_RESUME_ACK, id: requestId }));
					return;
				}
				if (message.type !== CHAT_RESPONSE) return;
				if (message.error) throw new Error(message.body || 'chat stream failed');
				if (typeof message.body === 'string' && message.body.trim()) {
					const chunk = JSON.parse(message.body);
					if (chunk.type === 'finish') sawFinish = true;
					const part = textFromChunk(chunk);
					if (part) text.push(part);
					if (typeof chunk.toolName === 'string') tools.add(chunk.toolName);
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
	if (typeof handle !== 'string' || !handle) {
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
		'Build a complete, polished one-page academic project site in this project.',
		`The visible page must contain the exact text ${JSON.stringify(marker)}.`,
		'Use inline HTML and CSS only: no images, scripts, local resources, or external resources.',
		'Use the project tools to write the files, then briefly state what you built.',
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
	const preview = await request(`preview/${encodeURIComponent(projectId)}/`, { headers: { accept: 'text/html' } });
	const previewBody = await preview.text();
	if (!preview.ok || !previewBody.includes(marker)) throw new Error(`preview failed with ${preview.status}`);

	const published = await json(`api/projects/${encodeURIComponent(projectId)}/publish`, { method: 'POST' });
	if (published.success !== true) throw new Error('publish did not report success');
	const publishedUrl = new URL(published.url);
	if (
		publishedUrl.origin !== PRODUCTION_PUBLIC_ORIGIN ||
		!publishedUrl.pathname.startsWith(`/site-studio/u/${handle}/`)
	) throw new Error('publish returned an unexpected configured public URL');
	directPublicUrl = new URL(`${publishedUrl.pathname}${publishedUrl.search}`, baseUrl.origin);
	const publicResponse = await fetch(directPublicUrl, { redirect: 'manual' });
	const publicBody = await publicResponse.text();
	if (!publicResponse.ok || !publicBody.includes(marker)) {
		throw new Error(`direct Worker public fetch failed with ${publicResponse.status}`);
	}

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
