import { Hono } from "hono";
import type { Env } from "../types";
import {
  OBSERVABILITY_CONTRACT,
  healthResponse,
} from "../../../observability-core/src/contract";

export function createHealthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get(OBSERVABILITY_CONTRACT.services.app.healthPath, () => healthResponse("app"));

  return app;
}
