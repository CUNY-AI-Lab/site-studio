import { HTTPException } from "hono/http-exception";

type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503;

export function jsonError(message: string, status: HttpStatus = 400): never {
  throw new HTTPException(status, {
    message,
  });
}

export async function readFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return jsonError("Invalid multipart form data", 400);
  }
}

export function binaryBody(data: Uint8Array): Blob {
  return new Blob([new Uint8Array(data)]);
}
