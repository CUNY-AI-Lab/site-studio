const workersModule = `
export class DurableObject { constructor(state, env) { this.ctx = state; this.env = env; } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
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
  return nextResolve(specifier, context);
}
