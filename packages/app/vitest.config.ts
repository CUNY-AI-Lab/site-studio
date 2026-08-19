import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: {
    target: "es2022",
    decorator: {
      legacy: false,
    },
  },
  resolve: {
    alias: [
      {
        find: "cloudflare:workers",
        replacement: fileURLToPath(new URL("./src/lib/cloudflare-workers-test-shim.ts", import.meta.url)),
      },
      { find: "agents", replacement: fileURLToPath(new URL("./src/lib/agents-test-shim.ts", import.meta.url)) },
      { find: "@cloudflare/ai-chat", replacement: fileURLToPath(new URL("./src/lib/ai-chat-test-shim.ts", import.meta.url)) },
      { find: /^@cloudflare\/codemode\/ai$/, replacement: fileURLToPath(new URL("./src/lib/codemode-test-shim.ts", import.meta.url)) },
      { find: "@cloudflare/codemode", replacement: fileURLToPath(new URL("./src/lib/codemode-test-shim.ts", import.meta.url)) },
    ],
  },
  ssr: {
    noExternal: ["agents", "@cloudflare/ai-chat", "@cloudflare/codemode", "@cloudflare/codemode/ai"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
