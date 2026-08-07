import { Hono } from "hono";
import type { Env } from "../types";
import {
  OBSERVABILITY_CONTRACT,
  healthResponse,
  parseCailLogEnvironment,
  serviceUnavailableResponse,
} from "../../../observability-core/src/contract";

export function createHealthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get(OBSERVABILITY_CONTRACT.services.app.healthPath, (c) => {
    if (!parseCailLogEnvironment(c.env.CAIL_LOG_ENV)) {
      return serviceUnavailableResponse();
    }
    return healthResponse("app", c.env.CF_VERSION_METADATA);
  });

  return app;
}
