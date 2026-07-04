import { describe, it, expect, beforeEach, vi } from "vitest";

const getAgentByName = vi.fn();

vi.mock("agents", () => ({
  getAgentByName: (...args: unknown[]) => getAgentByName(...args)
}));

import { createAgentHistoryPorter } from "./agent-porter";

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
    await porter.port("user_anon42", "blog", "cail-abc", "blog-imported");

    expect(getAgentByName).toHaveBeenNthCalledWith(1, namespace, "user_anon42:blog");
    expect(getAgentByName).toHaveBeenNthCalledWith(2, namespace, "cail-abc:blog-imported");
    expect(importSpy).toHaveBeenCalledWith(messages);
  });

  it("does not touch the destination when the source has no history", async () => {
    getAgentByName.mockResolvedValueOnce({ exportChatHistoryForMigration: async () => [] });

    const porter = createAgentHistoryPorter(env);
    await porter.port("user_anon42", "blog", "cail-abc", "blog");

    // Only the source instance was contacted; no destination DO was created.
    expect(getAgentByName).toHaveBeenCalledTimes(1);
  });
});
