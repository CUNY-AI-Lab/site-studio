import { accessSync, constants } from "node:fs";
import { extname } from "node:path";
import ts from "typescript";

const workersModule = `
export class DurableObject { constructor(state, env) { this.ctx = state; this.env = env; } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export const env = {}
export const exports = {}
export const tracing = undefined
`;

const emailModule = `export class EmailMessage {}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: `data:text/javascript,${encodeURIComponent(workersModule)}`, shortCircuit: true };
  }
  if (specifier === "cloudflare:email") {
    return { url: `data:text/javascript,${encodeURIComponent(emailModule)}`, shortCircuit: true };
  }
  if (specifier.startsWith(".") && !extname(specifier)) {
    for (const extension of [".ts", ".js", ".mjs"]) {
      const candidate = new URL(`${specifier}${extension}`, context.parentURL);
      try {
        accessSync(candidate, constants.F_OK);
        return nextResolve(candidate.href, context);
      } catch {
        // Try the next source extension.
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const loaded = await nextLoad(url, { ...context, format: "module" });
  const source = loaded.source instanceof Uint8Array
    ? new TextDecoder().decode(loaded.source)
    : loaded.source;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false,
    },
    fileName: url,
  });
  return { format: "module", source: transpiled.outputText, shortCircuit: true };
}
