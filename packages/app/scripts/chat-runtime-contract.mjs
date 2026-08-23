import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIChatAgent, } from "@cloudflare/ai-chat";
import { SiteBuilderAgent } from "../src/agents/site-builder.ts";

function sqlResult(rows = []) {
  return Object.assign([...rows], { toArray: () => [...rows] });
}

const storage = {
  sql: {
    exec() {
      return sqlResult();
    },
  },
  get: async () => undefined,
  put: async () => undefined,
  delete: async () => true,
  setAlarm: async () => undefined,
  deleteAlarm: async () => undefined,
};

const context = {
  id: {
    name: "site-builder:contract",
    toString: () => "site-builder:contract",
  },
  storage,
  waitUntil(promise) {
    void promise;
  },
  blockConcurrencyWhile(callback) {
    return callback();
  },
  acceptWebSocket() {},
};

function identityJwt(subject) {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
  return `header.${payload}.signature`;
}

function connection(id, subject) {
  let state = null;
  const sent = [];
  return {
    id,
    readyState: 1,
    sent,
    get state() {
      return state;
    },
    setState(next) {
      state = next instanceof Function ? next(state) : next;
      return state;
    },
    send(message) {
      sent.push(message);
    },
    close() {},
    subject,
  };
}

const agent = new SiteBuilderAgent(context, {});
const connectionA = connection("connection-a", "subject-a");
const connectionB = connection("connection-b", "subject-a");
const connections = [connectionA, connectionB];
agent.getConnections = () => connections;
agent.getConnection = (id) => connections.find((candidate) => candidate.id === id);

assert.equal(Object.hasOwn(agent, "onMessage"), true, "SiteBuilderAgent must install its onMessage boundary wrapper");
assert.equal(Object.hasOwn(agent, "onConnect"), true, "SiteBuilderAgent must install its onConnect boundary wrapper");
assert.equal(agent.chatRecovery, false, "Site Studio must keep AIChatAgent recovery disabled");
assert.equal(agent.chatStreamStallTimeoutMs, 300_000, "Site Studio must use the five-minute production stall value");

const aiChatPackage = JSON.parse(readFileSync(new URL("../node_modules/@cloudflare/ai-chat/package.json", import.meta.url), "utf8"));
assert.equal(aiChatPackage.version, "0.9.3", "the chat contract must use the pinned SDK");
const aiChatSource = readFileSync(new URL("../node_modules/@cloudflare/ai-chat/dist/index.js", import.meta.url), "utf8");
assert.match(aiChatSource, /const stallTimeoutMs = this\.chatStreamStallTimeoutMs/);
assert.match(aiChatSource, /reader\.cancel\(\)\.catch/);

class InjectableStallAgent extends AIChatAgent {
  chatStreamStallTimeoutMs = 20;
  _completeStream() {}
  _broadcastChatMessage() {}
  _storeStreamChunk() { return Promise.resolve(); }
}

const stalledAgent = new InjectableStallAgent(context, {});
let upstreamCancelled = false;
const reader = {
  read: () => new Promise(() => {}),
  cancel: async () => { upstreamCancelled = true; },
};
await assert.rejects(
  stalledAgent._streamSSEReply(
    "request-stall",
    "stream-stall",
    reader,
    { id: "assistant-stall", parts: [] },
    { value: false },
    false,
    new AbortController().signal,
  ),
  /stalled/i,
);
assert.equal(upstreamCancelled, true, "the SDK-owned watchdog must cancel the upstream reader");

const progressAgent = new InjectableStallAgent(context, {});
let progressReads = 0;
let progressCancelled = false;
const progressReader = {
  read: async () => {
    progressReads += 1;
    if (progressReads <= 3) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        done: false,
        value: new TextEncoder().encode(`data: ${JSON.stringify({
          type: "text-delta",
          id: `progress-${progressReads}`,
          delta: "progress",
        })}\n\n`),
      };
    }
    return new Promise(() => {});
  },
  cancel: async () => { progressCancelled = true; },
};
const progressStartedAt = Date.now();
await assert.rejects(
  progressAgent._streamSSEReply(
    "request-progress",
    "stream-progress",
    progressReader,
    { id: "assistant-progress", parts: [] },
    { value: false },
    false,
    new AbortController().signal,
  ),
  /stalled/i,
);
assert.equal(progressCancelled, true);
assert.ok(Date.now() - progressStartedAt >= 60, "each progress chunk must reset the SDK watchdog");

const request = new Request("https://contract.example/agent", {
  headers: {
    "x-partykit-props": JSON.stringify({ identityJwt: identityJwt("subject-a") }),
  },
});
await agent.onConnect(connectionA, { request });
await agent.onConnect(connectionB, { request });

const remember = agent.rememberChatRequestConnection.bind(agent);
assert.equal(remember("request-a", connectionA), true);
agent.chatToolRequestIds.set("tool-a", "request-a");

let frameworkContinuationCalled = false;
agent._enqueueInteractionApply = () => {
  frameworkContinuationCalled = true;
  return Promise.resolve();
};

await agent.onMessage(connectionB, JSON.stringify({
  type: "cf_agent_tool_result",
  toolCallId: "tool-a",
  output: "foreign",
}));
assert.equal(frameworkContinuationCalled, false, "foreign tool result must stop at SiteBuilderAgent");

await agent.onMessage(connectionA, JSON.stringify({
  type: "cf_agent_tool_result",
  toolCallId: "tool-a",
  output: "owner",
}));
assert.equal(frameworkContinuationCalled, true, "owner tool result must reach AIChatAgent");

await agent.onMessage(connectionB, JSON.stringify({
  type: "cf_agent_use_chat_request",
  id: "request-a",
}));
assert.equal(connectionB.sent.some((message) => String(message).includes("chat_request_conflict")), true);

const controlFrame = JSON.stringify({ type: "cf_agent_stream_resuming", id: "request-a" });
connectionB.send(controlFrame);
assert.equal(connectionB.sent.includes(controlFrame), false, "foreign resume metadata must be suppressed");
connectionA.send(controlFrame);
assert.equal(connectionA.sent.includes(controlFrame), true, "owner resume metadata must pass");

console.log("chat runtime contract: actual SiteBuilderAgent constructor boundary installed and gated");
