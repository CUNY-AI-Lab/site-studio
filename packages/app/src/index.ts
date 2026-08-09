import app, { normalizeMountedRequest } from "./app";
import type { Env } from "./types";
import { SiteBuilderAgent } from "./agents/site-builder";
import { MigrationCoordinator } from "./agents/migration-coordinator";
import { MutationCoordinator } from "./agents/mutation-coordinator";

// Worker entry: the Hono app is assembled in ./app (importable from tests);
// this module only adds the Durable Object exports, whose dependency trees need
// the Workers runtime (`cloudflare:` modules).
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(normalizeMountedRequest(request, env), env, ctx);
  },
};

export default worker;
export { SiteBuilderAgent, MigrationCoordinator, MutationCoordinator };
