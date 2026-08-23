import assert from "node:assert/strict";
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
