import { HTTPException } from "hono/http-exception";

type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

export function jsonError(message: string, status = 400): never {
  throw new HTTPException(status as HttpStatus, {
    message,
  });
}

export function jsonHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return headers;
}

export function binaryBody(data: Uint8Array): Blob {
  return new Blob([new Uint8Array(data)]);
}
