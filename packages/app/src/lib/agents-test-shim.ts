/** Faithful test-runtime boundary for the Agents SDK's Node-incompatible hooks. */
export function callable() {
  return () => undefined;
}

export function getCurrentAgent() {
  return { connection: undefined };
}

export async function getAgentByName(): Promise<never> {
  throw new Error("getAgentByName is not available in this isolated test runtime");
}
