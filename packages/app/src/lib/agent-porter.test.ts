import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import type { Env } from "../types";
import type { UIMessage } from "ai";
import type { AgentHistoryResolver } from "./agent-porter";

const SUBJECT = TEST_SUBJECTS.alice;

import {
  clearProjectAgentHistory,
  createAgentHistoryPorter,
  moveProjectAgentHistory
} from "./agent-porter";

describe("project agent history lifecycle", () => {
  // SAFETY: Tests need only an identity token for the injected resolver; no
  // Durable Object methods are called on this namespace value.
  const namespace = {} as Env["SITE_BUILDER_AGENT"];
  const env = { SITE_BUILDER_AGENT: namespace } satisfies Pick<Env, "SITE_BUILDER_AGENT">;
  const getAgentByName = vi.fn<AgentHistoryResolver>();

  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("SS-41: clears the exact owner/project Durable Object", async () => {
    const clearChatHistory = vi.fn(async () => undefined);
    getAgentByName.mockResolvedValueOnce({ clearChatHistory });

    await clearProjectAgentHistory(env, "owner-1", "project-a", getAgentByName);

    expect(getAgentByName).toHaveBeenCalledWith(namespace, "owner-1:project-a");
    expect(clearChatHistory).toHaveBeenCalledOnce();
  });

  it("SS-41: moves non-empty history to the renamed project and clears the source", async () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "history" }] }] satisfies UIMessage[];
    const source = {
      exportChatHistoryForMigration: vi.fn(async () => messages),
      clearChatHistory: vi.fn(async () => undefined)
    };
    const destination = {
      importChatHistoryForMigration: vi.fn(async () => true)
    };
    getAgentByName.mockResolvedValueOnce(source).mockResolvedValueOnce(destination);

    await moveProjectAgentHistory(env, "owner-1", "old-name", "new-name", getAgentByName);

    expect(getAgentByName).toHaveBeenNthCalledWith(1, namespace, "owner-1:old-name");
    expect(getAgentByName).toHaveBeenNthCalledWith(2, namespace, "owner-1:new-name");
    expect(destination.importChatHistoryForMigration).toHaveBeenCalledWith(messages);
    expect(source.clearChatHistory).toHaveBeenCalledOnce();
  });

  it("SS-41: skips the destination for empty history but still clears the source", async () => {
    const source = {
      exportChatHistoryForMigration: vi.fn(async () => []),
      clearChatHistory: vi.fn(async () => undefined)
    };
    getAgentByName.mockResolvedValueOnce(source);

    await moveProjectAgentHistory(env, "owner-1", "old-name", "new-name", getAgentByName);

    expect(getAgentByName).toHaveBeenCalledTimes(1);
    expect(source.clearChatHistory).toHaveBeenCalledOnce();
  });

  it("SS-41: preserves source history when the rename destination refuses it", async () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "history" }] }] satisfies UIMessage[];
    const source = {
      exportChatHistoryForMigration: vi.fn(async () => messages),
      clearChatHistory: vi.fn(async () => undefined)
    };
    getAgentByName
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ importChatHistoryForMigration: vi.fn(async () => false) });

    await expect(
      moveProjectAgentHistory(env, "owner-1", "old-name", "new-name", getAgentByName)
    ).rejects.toThrow("Destination chat history differs");
    expect(source.clearChatHistory).not.toHaveBeenCalled();
  });
});

describe("createAgentHistoryPorter", () => {
  // SAFETY: Tests need only an identity token for the injected resolver; no
  // Durable Object methods are called on this namespace value.
  const namespace = {} as Env["SITE_BUILDER_AGENT"];
  const env = { SITE_BUILDER_AGENT: namespace } satisfies Pick<Env, "SITE_BUILDER_AGENT">;
  const getAgentByName = vi.fn<AgentHistoryResolver>();

  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("ports chat history from the anonymous instance to the subject instance", async () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "history" }] }] satisfies UIMessage[];
    const importSpy = vi.fn(async () => true);
    getAgentByName
      .mockResolvedValueOnce({ exportChatHistoryForMigration: async () => messages })
      .mockResolvedValueOnce({ importChatHistoryForMigration: importSpy });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await porter.port("user_anon42", "blog", SUBJECT, "blog-imported");

    expect(getAgentByName).toHaveBeenNthCalledWith(1, namespace, "user_anon42:blog");
    expect(getAgentByName).toHaveBeenNthCalledWith(2, namespace, `${SUBJECT}:blog-imported`);
    expect(importSpy).toHaveBeenCalledWith(messages);
  });

  it("preserves tool labels and preliminary results during migration", async () => {
    const messages = [{
      id: "m-tool",
      role: "assistant",
      parts: [{
        type: "tool-ask_user_question",
        toolCallId: "call-1",
        state: "output-available",
        input: { question: "Which direction?" },
        output: { answer: "left" },
        title: "Custom label",
        preliminary: true,
      }]
    }] satisfies UIMessage[];
    const importSpy = vi.fn(async (received: UIMessage[]) => received.length >= 0);
    getAgentByName
      .mockResolvedValueOnce({ exportChatHistoryForMigration: async () => messages })
      .mockResolvedValueOnce({ importChatHistoryForMigration: importSpy });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await porter.port("user_anon42", "blog", SUBJECT, "blog-imported");

    expect(importSpy).toHaveBeenCalledOnce();
    expect(importSpy.mock.calls[0]?.[0]).toBe(messages);
    expect(importSpy.mock.calls[0]?.[0][0]?.parts[0]).toEqual(messages[0].parts[0]);
  });

  it("rejects output-error tool parts that carry an output", async () => {
    const malformedMessages = JSON.parse(`[
      {
        "id": "m-tool",
        "role": "assistant",
        "parts": [
          {
            "type": "tool-ask_user_question",
            "toolCallId": "call-1",
            "state": "output-error",
            "input": { "question": "Which direction?" },
            "output": { "answer": "left" },
            "errorText": "question failed"
          }
        ]
      }
    ]`);
    getAgentByName.mockResolvedValueOnce({
      exportChatHistoryForMigration: async () => malformedMessages
    });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await expect(
      porter.port("user_anon42", "blog", SUBJECT, "blog-imported")
    ).rejects.toThrow("Agent chat history is malformed");
    expect(getAgentByName).toHaveBeenCalledOnce();
  });

  it("rejects approval-requested tool parts that carry an approval reason", async () => {
    const malformedMessages = JSON.parse(`[
      {
        "id": "m-tool",
        "role": "assistant",
        "parts": [
          {
            "type": "tool-ask_user_question",
            "toolCallId": "call-1",
            "state": "approval-requested",
            "input": { "question": "Which direction?" },
            "approval": { "id": "approval-1", "reason": "already decided" }
          }
        ]
      }
    ]`);
    getAgentByName.mockResolvedValueOnce({
      exportChatHistoryForMigration: async () => malformedMessages
    });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await expect(
      porter.port("user_anon42", "blog", SUBJECT, "blog-imported")
    ).rejects.toThrow("Agent chat history is malformed");
    expect(getAgentByName).toHaveBeenCalledOnce();
  });

  it("does not touch the destination when the source has no history", async () => {
    getAgentByName.mockResolvedValueOnce({ exportChatHistoryForMigration: async () => [] });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await porter.port("user_anon42", "blog", SUBJECT, "blog");

    // Only the source instance was contacted; no destination DO was created.
    expect(getAgentByName).toHaveBeenCalledTimes(1);
  });

  it("propagates source export failures so account import can retry", async () => {
    const error = new Error("anonymous chat export unavailable");
    getAgentByName.mockResolvedValueOnce({
      exportChatHistoryForMigration: vi.fn(async () => {
        throw error;
      })
    });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await expect(
      porter.port("user_anon42", "blog", SUBJECT, "blog-imported")
    ).rejects.toBe(error);
    expect(getAgentByName).toHaveBeenCalledTimes(1);
  });

  it("propagates destination import failures so account import retains the source", async () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "history" }] }] satisfies UIMessage[];
    const error = new Error("subject chat import unavailable");
    getAgentByName
      .mockResolvedValueOnce({ exportChatHistoryForMigration: async () => messages })
      .mockResolvedValueOnce({
        importChatHistoryForMigration: vi.fn(async () => {
          throw error;
        })
      });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await expect(
      porter.port("user_anon42", "blog", SUBJECT, "blog-imported")
    ).rejects.toBe(error);
    expect(getAgentByName).toHaveBeenCalledTimes(2);
  });

  it("fails when the destination refuses different existing history", async () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "history" }] }] satisfies UIMessage[];
    getAgentByName
      .mockResolvedValueOnce({ exportChatHistoryForMigration: async () => messages })
      .mockResolvedValueOnce({ importChatHistoryForMigration: vi.fn(async () => false) });

    const porter = createAgentHistoryPorter(env, getAgentByName);
    await expect(
      porter.port("user_anon42", "blog", SUBJECT, "blog-imported")
    ).rejects.toThrow("Destination chat history differs");
  });
});
