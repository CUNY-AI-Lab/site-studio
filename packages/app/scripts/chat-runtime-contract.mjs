import assert from "node:assert/strict";
import { AIChatAgent } from "@cloudflare/ai-chat";

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

const connection = {
  id: "connection-a",
  readyState: 1,
  sent: [],
  send(message) {
    this.sent.push(message);
  },
  close() {},
  setState() {},
};

class BoundaryProbeAgent extends AIChatAgent {
  constructor(ctx, env) {
    super(ctx, env);
    assert.equal(Object.hasOwn(this, "onMessage"), true, "AIChatAgent must install an instance onMessage wrapper");
    assert.equal(Object.hasOwn(this, "onConnect"), true, "AIChatAgent must install an instance onConnect wrapper");

    const frameworkOnMessage = this.onMessage.bind(this);
    const frameworkOnConnect = this.onConnect.bind(this);
    this.gates = [];
    this.onConnect = async (socket, connectContext) => {
      this.gates.push("authorize");
      return frameworkOnConnect(socket, connectContext);
    };
    this.onMessage = async (socket, message) => {
      this.gates.push(`message:${message}`);
      if (message === "foreign-tool-result") return;
      return frameworkOnMessage(socket, message);
    };
  }

  async onChatMessage() {
    return new Response(null);
  }
}

const agent = new BoundaryProbeAgent(context, {});
await agent.onConnect(connection, { request: new Request("https://contract.example/agent") });
await agent.onMessage(connection, "foreign-tool-result");
await agent.onMessage(connection, JSON.stringify({
  type: "cf_agent_stream_resume_request",
  probeId: "probe-a",
}));

assert.deepEqual(agent.gates, [
  "authorize",
  "message:foreign-tool-result",
  `message:{"type":"cf_agent_stream_resume_request","probeId":"probe-a"}`,
]);
assert.equal(connection.sent.some((message) => String(message).includes("cf_agent_identity")), true);
assert.equal(connection.sent.some((message) => String(message).includes("cf_agent_stream_resume_none")), true);
console.log("chat runtime contract: actual @cloudflare/ai-chat instance handlers wrapped and gated");
