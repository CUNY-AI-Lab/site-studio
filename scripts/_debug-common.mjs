import { mkdir, readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';

const CHAT_MESSAGE_TYPE = {
  REQUEST: 'cf_agent_use_chat_request',
  RESPONSE: 'cf_agent_use_chat_response',
  CANCEL: 'cf_agent_chat_request_cancel',
  STREAM_RESUMING: 'cf_agent_stream_resuming',
  STREAM_RESUME_ACK: 'cf_agent_stream_resume_ack',
  STREAM_RESUME_NONE: 'cf_agent_stream_resume_none',
};
const DEBUG_SESSION_PATH = '.site-studio-debug-session.json';

function parseSetCookie(setCookie) {
  if (!setCookie) return null;
  const first = setCookie.split(';')[0]?.trim();
  return first || null;
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export async function loadStoredCookie() {
  try {
    const raw = await readFile(DEBUG_SESSION_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.cookie === 'string' ? parsed.cookie : '';
  } catch {
    return '';
  }
}

export async function persistSessionCookie(cookie) {
  if (!cookie) return;
  await writeFile(DEBUG_SESSION_PATH, `${JSON.stringify({ cookie }, null, 2)}\n`, 'utf8');
}

export class SessionClient {
  constructor(baseUrl, initialCookie) {
    this.baseUrl = new URL(baseUrl);
    this.cookie = initialCookie || '';
  }

  updateCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    const parsed = parseSetCookie(setCookie);
    if (parsed) {
      this.cookie = parsed;
    }
  }

  async fetch(path, init = {}) {
    const url = new URL(path, this.baseUrl);
    const headers = new Headers(init.headers || {});
    if (this.cookie) {
      headers.set('Cookie', this.cookie);
    }
    const response = await fetch(url, {
      ...init,
      headers,
    });
    this.updateCookie(response);
    return response;
  }

  async json(path, init = {}) {
    const response = await this.fetch(path, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return payload;
  }

  async ensureSession() {
    await this.json('/api/projects');
    return this.cookie;
  }
}

export async function createProject(session, name, template) {
  return session.json('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(template ? { template } : {}),
    }),
  });
}

export async function fetchMessages(session, projectId) {
  const response = await session.fetch(`/api/agents/site-builder/${projectId}/get-messages`);
  if (!response.ok) {
    return [];
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload : [];
}

export async function fetchObservability(session, projectId) {
  return session.json(`/api/projects/${projectId}/observability`);
}

export function printObservabilitySummary(observability) {
  const latest = observability.requests?.[0];
  if (!latest) {
    console.log('No observability requests recorded yet.');
    return;
  }

  console.log(`requestId: ${latest.requestId}`);
  console.log(`status: ${latest.status}`);
  console.log(`model: ${latest.model}`);
  if (latest.projectId) {
    console.log(`projectId: ${latest.projectId}`);
  }
  if (latest.latestUserRequest) {
    console.log(`latestUserRequest: ${latest.latestUserRequest}`);
  }
  console.log(`startedAt: ${latest.startedAt}`);
  console.log(`updatedAt: ${latest.updatedAt}`);
  console.log(`idleMs: ${latest.idleMs}`);
  console.log(`suspectedStall: ${latest.suspectedStall}`);
  console.log(`steps: ${latest.steps}`);
  console.log(`finishReason: ${latest.finishReason || '(none)'}`);
  if (latest.rawFinishReason) {
    console.log(`rawFinishReason: ${latest.rawFinishReason}`);
  }
  if (Array.isArray(latest.errors) && latest.errors.length > 0) {
    console.log(`errors: ${latest.errors.join(' | ')}`);
  }
  const counts = latest.chunkCounts || {};
  console.log(`chunkCounts: text=${counts.text || 0} reasoning=${counts.reasoning || 0} toolInput=${counts.toolInput || 0} toolResult=${counts.toolResult || 0} raw=${counts.raw || 0}`);
  if (Array.isArray(latest.tools) && latest.tools.length > 0) {
    console.log('tools:');
    for (const tool of latest.tools) {
      console.log(`  - ${tool.toolName} (${tool.toolCallId}) state=${tool.state} chars=${tool.inputChars} deltas=${tool.deltaCount}${tool.lastPreview ? ` preview=${JSON.stringify(tool.lastPreview)}` : ''}`);
    }
  }
}

export async function saveObservability(observability, prefix = 'chat-trace') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `logs/${prefix}-${stamp}.json`;
  await mkdir('logs', { recursive: true });
  await writeFile(path, `${JSON.stringify(observability, null, 2)}\n`, 'utf8');
  return path;
}

export async function connectAgent(session, projectId) {
  const baseUrl = new URL(session.baseUrl);
  const wsUrl = new URL(`api/agents/site-builder/${projectId}`, baseUrl);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  return new Promise((resolve, reject) => {
    const client = new WebSocket(wsUrl.toString(), {
      headers: session.cookie ? { Cookie: session.cookie } : undefined,
    });
    const onOpen = () => {
      client.off('error', onError);
      resolve(client);
    };
    const onError = (error) => {
      client.off('open', onOpen);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.once('open', onOpen);
    client.once('error', onError);
  });
}

function makeUserMessage(prompt) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
  };
}

function textFromChunk(chunk) {
  if (typeof chunk?.delta === 'string') return chunk.delta;
  if (typeof chunk?.text === 'string') return chunk.text;
  return '';
}

export async function sendChatTurn({
  client,
  messages,
  prompt,
  idleTimeoutMs = 60000,
  totalTimeoutMs = 180000,
  verbose = true,
}) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const allMessages = [...messages, makeUserMessage(prompt)];

  return new Promise((resolve, reject) => {
    let finished = false;
    const chunks = [];
    const textParts = [];
    let idleTimer = null;
    let totalTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      client.off('message', onMessage);
      client.off('close', onClose);
    };

    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        try {
          client.send(JSON.stringify({
            id: requestId,
            type: CHAT_MESSAGE_TYPE.CANCEL,
          }));
        } catch {}
        finish({
          ok: false,
          requestId,
          reason: `idle-timeout after ${idleTimeoutMs}ms`,
          chunks,
          text: textParts.join(''),
        });
      }, idleTimeoutMs);
    };

    const onClose = (code) => {
      if (finished) return;
      finish({
        ok: false,
        requestId,
        reason: `socket-closed code=${code}`,
        chunks,
        text: textParts.join(''),
      });
    };

    const onMessage = (rawData) => {
      try {
        const data = JSON.parse(typeof rawData === 'string' ? rawData : rawData.toString('utf8'));

        if (data.type === CHAT_MESSAGE_TYPE.STREAM_RESUMING && data.id === requestId) {
          resetIdleTimer();
          try {
            client.send(JSON.stringify({
              type: CHAT_MESSAGE_TYPE.STREAM_RESUME_ACK,
              id: requestId,
            }));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        if (data.type === CHAT_MESSAGE_TYPE.STREAM_RESUME_NONE && data.id === requestId) {
          resetIdleTimer();
          return;
        }

        if (data.type !== CHAT_MESSAGE_TYPE.RESPONSE || data.id !== requestId) {
          return;
        }

        resetIdleTimer();

        if (data.error) {
          finish({
            ok: false,
            requestId,
            reason: data.body || 'chat-stream-error',
            chunks,
            text: textParts.join(''),
          });
          return;
        }

        if (typeof data.body === 'string' && data.body.trim()) {
          const chunk = JSON.parse(data.body);
          chunks.push(chunk);
          const text = textFromChunk(chunk);
          if (text) {
            textParts.push(text);
            if (verbose) process.stdout.write(text);
          } else if (
            verbose &&
            (chunk.type === 'tool-input-start'
              || chunk.type === 'tool-input-available'
              || chunk.type === 'tool-output-available'
              || chunk.type === 'tool-output-error')
          ) {
            process.stdout.write(`\n[${chunk.type}:${chunk.toolName || chunk.toolCallId}]\n`);
          }
        }

        if (data.done) {
          if (verbose) process.stdout.write('\n');
          finish({
            ok: true,
            requestId,
            chunks,
            text: textParts.join(''),
          });
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    totalTimer = setTimeout(() => {
      if (finished) return;
      finish({
        ok: false,
        requestId,
        reason: `total-timeout after ${totalTimeoutMs}ms`,
        chunks,
        text: textParts.join(''),
      });
    }, totalTimeoutMs);

    client.on('message', onMessage);
    client.once('close', onClose);
    resetIdleTimer();

    try {
      client.send(JSON.stringify({
        type: CHAT_MESSAGE_TYPE.REQUEST,
        id: requestId,
        init: {
          method: 'POST',
          body: JSON.stringify({
            messages: allMessages,
            trigger: 'submit-message',
          }),
        },
      }));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
