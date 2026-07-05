import app from "./app";
import { SiteBuilderAgent } from "./agents/site-builder";

// Worker entry: the Hono app is assembled in ./app (importable from tests);
// this module only adds the Durable Object export, whose dependency tree needs
// the Workers runtime (`cloudflare:` modules).
export default app;
export { SiteBuilderAgent };
