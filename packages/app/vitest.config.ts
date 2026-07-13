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
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/lib/cloudflare-workers-test-shim.ts", import.meta.url),
      ),
    },
  },
  ssr: {
    noExternal: ["agents", "@cloudflare/ai-chat", "@cloudflare/codemode"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
