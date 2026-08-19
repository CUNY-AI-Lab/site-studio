import app, { normalizeMountedRequest } from "./app";
import type { Env } from "./types";

/** Worker fetch boundary kept separate from Durable Object class exports. */
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(normalizeMountedRequest(request, env), env, ctx);
  },
};

export default worker;
