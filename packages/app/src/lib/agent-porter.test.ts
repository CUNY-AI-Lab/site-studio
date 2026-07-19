import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";

const SUBJECT = TEST_SUBJECTS.alice;

const getAgentByName = vi.fn();

vi.mock("agents", () => ({
  getAgentByName: (...args: unknown[]) => getAgentByName(...args)
}));

import {
  clearProjectAgentHistory,
  createAgentHistoryPorter,
  moveProjectAgentHistory
} from "./agent-porter";

describe("project agent history lifecycle", () => {
  const namespace = { __brand: "SITE_BUILDER_AGENT" } as any;
  const env = { SITE_BUILDER_AGENT: namespace };

  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("SS-41: clears the exact owner/project Durable Object", async () => {
    const clearChatHistory = vi.fn(async () => undefined);
    getAgentByName.mockResolvedValueOnce({ clearChatHistory });

    await clearProjectAgentHistory(env, "owner-1", "project-a");

    expect(getAgentByName).toHaveBeenCalledWith(namespace, "owner-1:project-a");
    expect(clearChatHistory).toHaveBeenCalledOnce();
  });

  it("SS-41: moves non-empty history to the renamed project and clears the source", async () => {
    const messages = [{ id: "m1", role: "user", parts: [] }];
    const source = {
      exportChatHistoryForMigration: vi.fn(async () => messages),
      clearChatHistory: vi.fn(async () => undefined)
    };
    const destination = {
      importChatHistoryForMigration: vi.fn(async () => true)
    };
    getAgentByName.mockResolvedValueOnce(source).mockResolvedValueOnce(destination);

    await moveProjectAgentHistory(env, "owner-1", "old-name", "new-name");

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

    await moveProjectAgentHistory(env, "owner-1", "old-name", "new-name");

    expect(getAgentByName).toHaveBeenCalledTimes(1);
    expect(source.clearChatHistory).toHaveBeenCalledOnce();
  });
});

describe("createAgentHistoryPorter", () => {
  const namespace = { __brand: "SITE_BUILDER_AGENT" } as any;
  const env = { SITE_BUILDER_AGENT: namespace };

  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("ports chat history from the anonymous instance to the subject instance", async () => {
    const messages = [{ id: "m1", role: "user", parts: [] }];
    const importSpy = vi.fn(async () => true);
    getAgentByName
      .mockResolvedValueOnce({ exportChatHistoryForMigration: async () => messages })
      .mockResolvedValueOnce({ importChatHistoryForMigration: importSpy });

    const porter = createAgentHistoryPorter(env);
    await porter.port("user_anon42", "blog", SUBJECT, "blog-imported");

    expect(getAgentByName).toHaveBeenNthCalledWith(1, namespace, "user_anon42:blog");
    expect(getAgentByName).toHaveBeenNthCalledWith(2, namespace, `${SUBJECT}:blog-imported`);
    expect(importSpy).toHaveBeenCalledWith(messages);
  });

  it("does not touch the destination when the source has no history", async () => {
    getAgentByName.mockResolvedValueOnce({ exportChatHistoryForMigration: async () => [] });

    const porter = createAgentHistoryPorter(env);
    await porter.port("user_anon42", "blog", SUBJECT, "blog");

    // Only the source instance was contacted; no destination DO was created.
    expect(getAgentByName).toHaveBeenCalledTimes(1);
  });
});
