import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTMLRewriter as NodeHTMLRewriter } from "htmlrewriter";
import { z } from "zod";
import { createPreviewRouter } from "../src/routes/preview.ts";
import { createPublishRouter } from "../src/routes/publish.ts";
import { previewTokenAuth } from "../src/lib/preview-token.ts";

const OWNER_ID = "user_boundary";
const PROJECT_ID = "site";
const HANDLE = "janedoe";
const serverAddressSchema = z.object({ port: z.number().int().positive() });

function createR2Body(key, stored) {
  const bytes = stored.bytes.slice();
  return {
    key,
    version: "1",
    size: bytes.byteLength,
    etag: stored.etag,
    httpEtag: `"${stored.etag}"`,
    checksums: {},
    uploaded: stored.uploaded,
    httpMetadata: stored.httpMetadata,
    customMetadata: {},
    storageClass: "Standard",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    }),
    bodyUsed: false,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    blob: async () => new Blob([bytes]),
    writeHttpMetadata(headers) {
      if (stored.httpMetadata?.contentType) headers.set("Content-Type", stored.httpMetadata.contentType);
    }
  };
}

function createBucket(initial) {
  const stored = new Map();
  let generation = 0;
  for (const [key, value] of Object.entries(initial)) {
    generation += 1;
    stored.set(key, {
      bytes: new TextEncoder().encode(value),
      etag: `etag-${generation}`,
      uploaded: new Date("2026-08-24T00:00:00.000Z")
    });
  }
  return {
    async get(key) {
      const value = stored.get(key);
      return value ? createR2Body(key, value) : null;
    },
    async head(key) {
      const value = stored.get(key);
      return value ? createR2Body(key, value) : null;
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const delimiter = options.delimiter;
      const objects = [];
      const delimitedPrefixes = new Set();
      for (const [key, value] of stored) {
        if (!key.startsWith(prefix)) continue;
        const relative = key.slice(prefix.length);
        const delimiterIndex = delimiter ? relative.indexOf(delimiter) : -1;
        if (delimiter && delimiterIndex >= 0) {
          delimitedPrefixes.add(`${prefix}${relative.slice(0, delimiterIndex + delimiter.length)}`);
        } else {
          objects.push(createR2Body(key, value));
        }
      }
      return {
        objects,
        delimitedPrefixes: [...delimitedPrefixes],
        truncated: false
      };
    }
  };
}

function createKv() {
  const stored = new Map();
  return {
    async get(key) {
      return stored.get(key) ?? null;
    },
    async put(key, value) {
      stored.set(key, value);
    },
    async delete(key) {
      stored.delete(key);
    }
  };
}

function createEnvironment() {
  const createdAt = "2026-08-24T00:00:00.000Z";
  const prefix = `projects/${OWNER_ID}/${PROJECT_ID}`;
  const bucket = createBucket({
    [`${prefix}/.metadata.json`]: JSON.stringify({
      id: PROJECT_ID,
      name: "Boundary Site",
      createdAt,
      updatedAt: createdAt,
      published: true,
      publishedAt: createdAt,
      slug: PROJECT_ID
    }),
    [`${prefix}/index.html`]: [
      '<link rel="stylesheet" href="/styles/main.css">',
      '<source srcset="/images/small.png 1x, /images/large.png 2x">',
      '<script type="module" src="/scripts/main.js"></script>'
    ].join(""),
    [`${prefix}/styles/main.css`]: "@font-face { font-family: Boundary; src: url('../fonts/body.woff2'); }",
    [`${prefix}/fonts/body.woff2`]: "font",
    [`${prefix}/scripts/main.js`]: [
      "import { nestedMarker } from './nested.js';",
      "globalThis.entryMarker = 'entry-module-ok';",
      "globalThis.nestedMarker = nestedMarker;",
      "if (globalThis.loadLazy) void import('/lazy.js');"
    ].join("\n"),
    [`${prefix}/scripts/nested.js`]: "import { deepMarker } from './deep.js'; export const nestedMarker = `nested-${deepMarker}`;",
    [`${prefix}/scripts/deep.js`]: "export const deepMarker = 'module-ok';",
    [`${prefix}/lazy.js`]: "export const lazy = true;",
    [`${prefix}/images/small.png`]: "small",
    [`${prefix}/images/large.png`]: "large",
    [`handles/${HANDLE}.json`]: JSON.stringify({ ownerId: OWNER_ID, claimedAt: createdAt })
  });

  return {
    CAIL_LOG_ENV: "test",
    SESSION_KV: createKv(),
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {},
    MIGRATION_COORDINATOR: {},
    LOADER: {},
    PUBLISHED_BASE_URL: "https://tools.ailab.gc.cuny.edu/site-studio"
  };
}

function createApp() {
  const app = new Hono();
  app.get("/boundary/no-cors.js", (context) =>
    context.body("globalThis.entryMarker = 'must-not-run';", 200, {
      "Content-Type": "application/javascript"
    })
  );
  app.use("/preview/*", cors({
    origin: (origin) => origin === "https://tools.ailab.gc.cuny.edu" ? origin : null,
    credentials: true
  }));
  app.use("/preview/*", previewTokenAuth);
  app.use("/preview/:id", previewTokenAuth);
  app.use("/preview/*", async (context, next) => {
    if (!context.get("user") && context.req.header("X-Boundary-Owner") === OWNER_ID) {
      context.set("user", { id: OWNER_ID, createdAt: new Date().toISOString() });
      context.set("sessionId", "boundary-owner");
    }
    if (!context.get("user")) return context.text("Unauthorized", 401);
    await next();
  });
  app.route("/", createPreviewRouter());
  app.route("/", createPublishRouter());
  return app;
}

function requireMatch(value, expression, label) {
  const match = expression.exec(value)?.[1];
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}

async function expectResponse(response, status, label) {
  const body = await response.text();
  if (response.status !== status) {
    throw new Error(`${label} returned ${response.status}: ${body}`);
  }
  return body;
}

async function runServer() {
  globalThis.HTMLRewriter = NodeHTMLRewriter;
  const environment = createEnvironment();
  const app = createApp();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request, environment)
  });
  console.log(JSON.stringify({ port: server.port }));
  await new Promise(() => {});
}

async function readServerPort(child) {
  const reader = child.stdout.getReader();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Boundary server exited before reporting its port");
    buffer += new TextDecoder().decode(chunk.value);
    const newline = buffer.indexOf("\n");
    if (newline < 0) continue;
    return serverAddressSchema.parse(JSON.parse(buffer.slice(0, newline))).port;
  }
}

async function runOpaqueModuleClient(entryUrl) {
  const client = Bun.spawn([
    "node",
    "--no-warnings",
    "--experimental-vm-modules",
    `${import.meta.dir}/opaque-module-client.mjs`,
    entryUrl
  ], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
    client.exited
  ]);
  return { exitCode, stdout, stderr };
}

async function runContract() {
  const child = Bun.spawn([process.execPath, import.meta.path, "--server"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "inherit"
  });

  try {
    const port = await readServerPort(child);
    const origin = `http://127.0.0.1:${port}`;
    const page = await expectResponse(await fetch(`${origin}/preview/${PROJECT_ID}/index.html?v=42&ready=42`, {
      headers: { "X-Boundary-Owner": OWNER_ID }
    }), 200, "preview page");
    const pageToken = requireMatch(page, /scripts\/main\.js\?v=42&pt=([0-9a-f]{64})/, "page token");
    if (!page.includes('parent.postMessage({"type":"site-studio-preview-ready","token":"42"},"*")')) {
      throw new Error("Resolved preview page omitted the child readiness signal");
    }
    if (!page.includes(`images/large.png?v=42&pt=${pageToken} 2x`)) {
      throw new Error("Preview page did not rewrite every srcset candidate");
    }

    const rejectedExecution = await runOpaqueModuleClient(`${origin}/boundary/no-cors.js`);
    if (
      rejectedExecution.exitCode === 0
      || !rejectedExecution.stderr.includes("Opaque-origin module CORS rejected")
    ) {
      throw new Error("Opaque module client did not reject the no-CORS negative control");
    }

    const opaqueClient = await runOpaqueModuleClient(
      `${origin}/preview/${PROJECT_ID}/scripts/main.js?v=42&pt=${pageToken}`
    );
    if (opaqueClient.exitCode !== 0) {
      throw new Error(`Opaque module client failed: ${opaqueClient.stderr || opaqueClient.stdout}`);
    }
    const opaqueExecution = JSON.parse(opaqueClient.stdout);
    if (
      opaqueExecution.entryMarker !== "entry-module-ok"
      || opaqueExecution.nestedMarker !== "nested-module-ok"
    ) {
      throw new Error("Opaque-origin module graph did not execute through the preview capability");
    }

    const main = await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/scripts/main.js?v=42&pt=${pageToken}`),
      200,
      "main module"
    );
    const moduleToken = requireMatch(main, /nested\.js\?v=42&pt=([0-9a-f]{64})/, "module token");
    if (!main.includes(`/preview/${PROJECT_ID}/lazy.js?v=42&pt=${moduleToken}`)) {
      throw new Error("Dynamic module import did not receive the child capability");
    }

    const nested = await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/scripts/nested.js?v=42&pt=${moduleToken}`),
      200,
      "nested module"
    );
    const deepToken = requireMatch(nested, /deep\.js\?v=42&pt=([0-9a-f]{64})/, "nested module token");
    await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/scripts/deep.js?pt=${deepToken}`),
      200,
      "deep module"
    );
    await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/images/large.png?pt=${pageToken}`),
      200,
      "responsive image"
    );
    const style = await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/styles/main.css?v=42&pt=${pageToken}`),
      200,
      "preview stylesheet"
    );
    const fontToken = requireMatch(style, /fonts\/body\.woff2\?v=42&pt=([0-9a-f]{64})/, "font token");
    const font = await fetch(`${origin}/preview/${PROJECT_ID}/fonts/body.woff2?pt=${fontToken}`);
    await expectResponse(font.clone(), 200, "preview font");
    if (font.headers.get("Access-Control-Allow-Origin") !== "*") {
      throw new Error("Resolved authored font omitted opaque-origin CORS");
    }
    const missingPage = await fetch(`${origin}/preview/${PROJECT_ID}/missing.html?ready=42`, {
      headers: { "X-Boundary-Owner": OWNER_ID, Accept: "text/html" }
    });
    const missingPageBody = await expectResponse(missingPage, 404, "missing preview page");
    if (missingPageBody.includes("site-studio-preview-ready")) {
      throw new Error("Missing preview page emitted a false readiness signal");
    }
    const missingFont = await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/fonts/missing.woff2`, {
      headers: { Host: "site-studio.test" }
    });
    await expectResponse(missingFont.clone(), 404, "missing published font");
    if (missingFont.headers.has("Access-Control-Allow-Origin")) {
      throw new Error("Missing authored font received a success-only CORS header");
    }
    await expectResponse(
      await fetch(`${origin}/preview/${PROJECT_ID}/unlinked.txt?pt=${pageToken}`),
      401,
      "unlinked preview resource"
    );

    const publicHeaders = { Host: "site-studio.test" };
    const publishedPage = await expectResponse(
      await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/index.html`, { headers: publicHeaders }),
      200,
      "published page"
    );
    if (!publishedPage.includes("/site-studio/u/janedoe/site/images/large.png 2x")) {
      throw new Error("Published srcset candidate missed the configured mount");
    }
    if (!publishedPage.includes('src="/site-studio/u/janedoe/site/scripts/main.js"')) {
      throw new Error("Published module entry missed the configured mount");
    }
    await expectResponse(
      await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/images/large.png`, { headers: publicHeaders }),
      200,
      "published responsive image"
    );

    const publishedModule = await expectResponse(
      await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/scripts/main.js`, {
        headers: publicHeaders
      }),
      200,
      "published module"
    );
    if (!publishedModule.includes('import("/site-studio/u/janedoe/site/lazy.js")')) {
      throw new Error("Published root-relative module import missed the configured mount");
    }
    if (!publishedModule.includes("from './nested.js'")) {
      throw new Error("Published relative module import changed unexpectedly");
    }
    await expectResponse(
      await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/scripts/nested.js`, { headers: publicHeaders }),
      200,
      "published nested module"
    );
    await expectResponse(
      await fetch(`${origin}/u/${HANDLE}/${PROJECT_ID}/lazy.js`, { headers: publicHeaders }),
      200,
      "published dynamic module"
    );

    console.log("preview route contract: readiness, opaque-origin modules/fonts, nested capabilities, and public mounts crossed child HTTP/process boundaries");
  } finally {
    child.kill();
    await child.exited;
  }
}

if (process.argv.includes("--server")) {
  await runServer();
} else {
  await runContract();
}
