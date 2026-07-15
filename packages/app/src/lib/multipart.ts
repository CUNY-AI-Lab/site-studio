import { HTTPException } from "hono/http-exception";

export async function readBoundedFormData(
  request: Request,
  maxBodyBytes: number,
  tooLargeMessage: string
): Promise<FormData> {
  const rawLength = request.headers.get("content-length");
  const declaredLength = rawLength === null ? Number.NaN : Number(rawLength);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HTTPException(413, { message: tooLargeMessage });
  }
  const parse = async (target: Request): Promise<FormData> => {
    try {
      return await target.formData();
    } catch {
      throw new HTTPException(400, { message: "Invalid multipart form data" });
    }
  };

  const reader = request.body?.getReader();
  if (!reader) return parse(request);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw new HTTPException(413, { message: tooLargeMessage });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parse(new Request(request.url, { method: request.method, headers: request.headers, body }));
}
