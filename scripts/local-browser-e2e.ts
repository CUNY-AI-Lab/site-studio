import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type BrowserContext, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { unzipSync } from "../packages/app/node_modules/fflate";
import { z } from "zod";

/**
 * Value-focused Site Studio browser acceptance against a local app process.
 *
 * The browser talks HTTP to a real Bun process running the production Hono app
 * and its CSRF/CAS mutation service. Storage and model responses use
 * deterministic test bindings; native Worker/R2 and provider behavior require
 * separate checks. No model call or provider credential is used.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = resolve(ROOT, "packages/app");
const BUILD_DIR = resolve(ROOT, "packages/frontend/build");
const IDENTITY_SCRIPT = resolve(APP_DIR, "scripts/local-browser-identity.ts");
const WORKER_SCRIPT = resolve(APP_DIR, "scripts/local-browser-worker.ts");
const CHILD_FIXTURE = resolve(ROOT, "scripts/fixtures/browser-child.js");
const MODULE_FIXTURE = resolve(ROOT, "scripts/fixtures/browser-preview-script.js");
const IMAGE_FIXTURE_NAME = "browser-image.png";
const IMAGE_FIXTURE_PATH = `images/${IMAGE_FIXTURE_NAME}`;
const IMAGE_FIXTURE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+P1e3XwAAAABJRU5ErkJggg==",
  "base64",
);

type BrowserSocketFrame = {
  type: string;
  id?: string;
  requestId?: string;
  init?: { body?: string };
  messages?: BrowserSocketMessage[];
};

type BrowserSocketMessage = {
  role: "user" | "assistant";
  parts: Array<{ type: string; text?: string }>;
};

const browserSocketFrameSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    requestId: z.string().optional(),
    init: z.object({ body: z.string().optional() }).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
        }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

type BrowserSocketEvent = {
  payload: string | Buffer;
};

function parseBrowserSocketFrame(payload: BrowserSocketEvent): BrowserSocketFrame | null {
  const stringPayload = z.string().safeParse(payload.payload);
  let text: string;
  if (stringPayload.success) {
    text = stringPayload.data;
  } else {
    const bufferPayload = z.instanceof(Buffer).safeParse(payload.payload);
    if (!bufferPayload.success) return null;
    text = bufferPayload.data.toString();
  }
  try {
    const parsed = browserSocketFrameSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Identity = {
  readonly jwks: string;
  readonly issuer: string;
  readonly token: string;
  readonly gatewayToken: string;
};

const identitySchema = z.object({
  jwks: z.string(),
  issuer: z.string(),
  token: z.string(),
  gatewayToken: z.string(),
});

type WorkerHandle = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: string[];
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null) {
    server.close();
    throw new Error("local browser acceptance could not discover a free port");
  }
  // SAFETY: the listener above is an IPv4 TCP listener on an ephemeral port,
  // so Node returns AddressInfo rather than a named-pipe address.
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return port;
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.join(""));
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr.join("")}`));
    });
  });
}

async function runIdentity(): Promise<Identity> {
  const output = await runCommand("bun", [IDENTITY_SCRIPT], APP_DIR);
  return identitySchema.parse(JSON.parse(output));
}

function startWorker(jwks: string, issuer: string, token: string, gatewayToken: string, port: number): WorkerHandle {
  const output: string[] = [];
  const environment = {
    ...process.env,
    PORT: String(port),
    SITE_STUDIO_FRONTEND_BUILD: BUILD_DIR,
    CAIL_IDENTITY_JWKS: jwks,
    CAIL_IDENTITY_ISSUER: issuer,
    CAIL_LOCAL_BROWSER_IDENTITY_JWT: token,
    CAIL_LOCAL_BROWSER_GATEWAY_JWT: gatewayToken,
  };
  const child = spawn("bun", [WORKER_SCRIPT], {
    cwd: APP_DIR,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk: Buffer): void => {
    output.push(chunk.toString());
    while (output.join("").length > 16_000) output.shift();
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  return { child, output };
}

async function waitForWorker(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`local Site Studio process exited ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // The process can need a few retries while Bun loads the Worker module.
    }
    await sleep(100);
  }
  throw new Error("local Site Studio process did not become ready");
}

async function installAuthRoute(page: Page, baseUrl: string, token: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    const initialPreview = target.pathname.startsWith("/preview/") && !target.searchParams.has("pt");
    if (target.origin === origin && (target.pathname.startsWith("/api/") || initialPreview)) {
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-cail-identity-jwt": token,
        },
      });
      return;
    }
    await route.continue();
  });
}

function editorContent(page: Page) {
  const content = page.locator('[contenteditable="true"]').last();
  return content;
}

async function replaceEditorContent(page: Page, value: string): Promise<void> {
  const editor = editorContent(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await editor.type(value);
}

async function waitForEditorText(page: Page, text: string): Promise<void> {
  await expect(editorContent(page)).toContainText(text, { timeout: 10_000 });
}

function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Site Preview"]');
}

async function waitForPreview(page: Page, text: string): Promise<void> {
  try {
    await expect(page.locator('iframe[title="Site Preview"]')).toBeVisible();
    await expect(previewFrame(page).getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const debugPath = resolve("/tmp", `site-studio-preview-${randomUUID()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.error(`preview debug screenshot: ${debugPath}`);
    console.error(
      `preview frames: ${page
        .frames()
        .map((frame) => `${frame.url()} (${frame.name()})`)
        .join("; ")}`,
    );
    for (const frame of page.frames()) {
      try {
        const body = await frame.locator("body").innerText();
        console.error(`frame body ${frame.url()}: ${body.slice(0, 500)}`);
      } catch (frameError) {
        console.error(`frame body unavailable ${frame.url()}: ${String(frameError)}`);
      }
    }
    try {
      console.error(`editor text: ${(await editorContent(page).innerText()).slice(0, 500)}`);
    } catch (editorError) {
      console.error(`editor unavailable: ${String(editorError)}`);
    }
    throw error;
  }
}

async function waitForLoadedImage(image: Locator): Promise<void> {
  await expect
    .poll(
      async () =>
        await image.evaluate((element) => {
          if (!(element instanceof HTMLImageElement)) throw new Error("expected an image element");
          return { naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight };
        }),
      { timeout: 15_000 },
    )
    .toEqual({ naturalWidth: 1, naturalHeight: 1 });
}

async function waitForPreviewBackground(page: Page, expected: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await previewFrame(page)
          .locator("body")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      { timeout: 15_000 },
    )
    .toBe(expected);
}

async function waitForPreviewImage(page: Page, alt: string): Promise<void> {
  const image = previewFrame(page).getByRole("img", { name: alt, exact: true });
  await expect(image).toHaveCount(1, { timeout: 15_000 });
  await waitForLoadedImage(image);
}

async function openProjectMenu(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Project options for ${projectName}` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

async function closeCodeEditor(page: Page): Promise<void> {
  const closeButton = page.getByRole("button", { name: "Close code editor" });
  if (await closeButton.isVisible()) await closeButton.click();
}

async function runBrowserPath(baseUrl: string, token: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
  });
  try {
    await context.addInitScript({
      content: "localStorage.setItem('site-studio-onboarding-completed', 'true');",
    });
    const page = await context.newPage();
    const receivedSocketFrames: BrowserSocketFrame[] = [];
    const sentSocketFrames: BrowserSocketFrame[] = [];
    page.on("websocket", (websocket) => {
      websocket.on("framereceived", (payload) => {
        const frame = parseBrowserSocketFrame(payload);
        if (frame) receivedSocketFrames.push(frame);
      });
      websocket.on("framesent", (payload) => {
        const frame = parseBrowserSocketFrame(payload);
        if (frame) sentSocketFrames.push(frame);
      });
    });
    await installAuthRoute(page, baseUrl, token);

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Site Studio" })).toBeVisible();
    await expect(page.getByText("No projects yet", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New Project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Blank Canvas Start from scratch" }).click();
    const projectName = `Browser value ${Date.now()}`;
    await dialog.getByLabel("Project Name (optional)").fill(projectName);
    await dialog.getByRole("button", { name: "Create Project" }).click();
    await page.waitForURL("**/editor/**");
    await expect(page.getByRole("button", { name: projectName, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show code editor" })).toBeVisible();

    // The browser now crosses the real app route into a local
    // SITE_BUILDER_AGENT binding. The binding emits one deterministic tool
    // turn and a post-persistence commit frame; no model or provider call is
    // involved.
    const chatInput = page.getByRole("textbox", {
      name: "Message to the assistant",
    });
    await expect(chatInput).toBeVisible();
    const completionMessages = () =>
      page.getByText("The local tool completed successfully.", {
        exact: false,
      });
    const completionText = () => completionMessages().first();
    await chatInput.fill("Run the local tool.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(completionText()).toBeVisible();
    await expect(page.getByRole("button", { name: /Working on your site/ })).toBeVisible();
    const completedTurn = () => receivedSocketFrames.some((frame) =>
      frame.type === "site_studio_chat_committed"
      && frame.messages?.some((message) =>
        message.role === "assistant"
        && message.parts.some((part) => part.text?.includes("The local tool completed successfully.")),
      ) === true,
    );
    await expect.poll(completedTurn).toBe(true);

    // Stop a held turn from the visible control, then prove a later request is
    // independent. The held local agent waits for the cancel frame; there is
    // no sleep or model timeout in this path.
    const completedMessagesBeforeStop = await completionMessages().count();
    await chatInput.fill("Hold this turn so I can stop it.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Stop request" })).toBeVisible();
    const heldRequestId = () =>
      sentSocketFrames
        .filter((frame) => frame.type === "cf_agent_use_chat_request")
        .map((frame) => {
          const body = frame.init?.body ?? "";
          return frame.id && body.includes("Hold this turn") ? frame.id : null;
        })
        .find((id): id is string => id !== null) ?? null;
    await expect.poll(heldRequestId).not.toBeNull();
    await page.getByRole("button", { name: "Stop request" }).click();
    await expect(page.getByRole("button", { name: "Stop request" })).not.toBeVisible();
    await expect.poll(() => completionMessages().count()).toBe(completedMessagesBeforeStop);
    const cancelledRequestId = heldRequestId();
    if (cancelledRequestId === null) throw new Error("held local chat request was not captured");
    await expect
      .poll(() => receivedSocketFrames.some((frame) => frame.type === "site_studio_chat_cancelled"))
      .toBe(true);
    await expect
      .poll(() =>
        receivedSocketFrames.some(
          (frame) => frame.type === "site_studio_chat_committed" && frame.requestId === cancelledRequestId,
        ),
      )
      .toBe(false);

    await chatInput.fill("Run the recovery turn.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => completionMessages().count()).toBe(completedMessagesBeforeStop + 1);

    const completedMessagesBeforeMultiple = await completionMessages().count();
    await chatInput.fill("Run multiple mutating tools.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => completionMessages().count()).toBe(completedMessagesBeforeMultiple + 1);
    await expect
      .poll(() => receivedSocketFrames.some((frame) =>
        frame.type === "site_studio_chat_committed"
        && frame.messages?.some((message) =>
          message.role === "assistant"
          && message.parts.filter((part) => part.type === "tool-codemode").length >= 2,
        ) === true,
      ))
      .toBe(true);

    // A blank project is visibly useful only once authored assets execute.
    await page.getByRole("button", { name: "Show code editor" }).click();
    await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible();
    const upload = page.locator('.file-tree input[type="file"]');
    await upload.setInputFiles(CHILD_FIXTURE);
    await expect(page.getByRole("button", { name: "browser-child.js", exact: true })).toBeVisible();
    await upload.setInputFiles(MODULE_FIXTURE);
    await expect(
      page.getByRole("button", {
        name: "browser-preview-script.js",
        exact: true,
      }),
    ).toBeVisible();

    // Upload a real image through the product's Image Manager. The local
    // Worker still uses the checked-in upload policy, so this crosses the same
    // authenticated multipart and image-byte validation boundary as production.
    await page.getByRole("button", { name: "Images", exact: true }).click();
    const imageDialog = page.getByRole("dialog");
    await expect(imageDialog.getByRole("heading", { name: "Images", exact: true })).toBeVisible();
    await imageDialog.locator('input[type="file"]').setInputFiles({
      name: IMAGE_FIXTURE_NAME,
      mimeType: "image/png",
      buffer: IMAGE_FIXTURE_BYTES,
    });
    const imageButton = imageDialog.getByRole("button", {
      name: `Insert this image: ${IMAGE_FIXTURE_PATH}`,
      exact: true,
    });
    await expect(imageButton).toBeVisible();
    await imageButton.click();
    await expect(imageDialog.getByRole("heading", { name: "Add this image to your site", exact: true })).toBeVisible();
    await imageDialog.getByRole("button", { name: "Close", exact: true }).last().click();

    // Exercise the parent-owned refresh queue across real file mutations. The
    // mutation requests overlap with their follow-up tree reads; the visible
    // tree must settle on the final state without losing the current project.
    page.once("dialog", async (dialog) => {
      await dialog.accept("browser-child-renamed.js");
    });
    await page.getByRole("button", { name: "Rename browser-child.js" }).click();
    await expect(page.getByRole("button", { name: "browser-child-renamed.js", exact: true })).toBeVisible();
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "Delete browser-child-renamed.js" }).click();
    await expect(page.getByRole("button", { name: "browser-child-renamed.js", exact: true })).not.toBeVisible();
    await upload.setInputFiles(CHILD_FIXTURE);
    await expect(page.getByRole("button", { name: "browser-child.js", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "index.html", exact: true }).click();
    await waitForEditorText(page, "<!DOCTYPE html>");
    await replaceEditorContent(
      page,
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser value</title><link rel="stylesheet" href="styles.css"></head>
  <body><main><h1>Version A</h1><img src="images/browser-image.png" alt="Browser fixture image"><p id="module-status">module waiting</p></main><script type="module" src="browser-preview-script.js"></script></body>
</html>`,
    );
    await waitForPreview(page, "Version A");
    await waitForPreview(page, "nested module loaded");
    await waitForPreviewImage(page, "Browser fixture image");

    await page.getByRole("button", { name: "styles.css", exact: true }).click();
    await waitForEditorText(page, "background");
    await replaceEditorContent(page, "body { background: rgb(12, 34, 56); color: white; }");
    await waitForPreview(page, "Version A");
    await waitForPreviewBackground(page, "rgb(12, 34, 56)");

    // The overlay currently covers the history dialog, so the browser path
    // proves the sequential user flow and does not claim simultaneous access.
    await closeCodeEditor(page);
    await openProjectMenu(page, projectName);
    await page.getByRole("menuitem", { name: "Version history" }).click();
    let history = page.getByRole("dialog");
    await history.getByLabel("Name this version").fill("Checkpoint A");
    try {
      await history.getByRole("button", { name: "Save version" }).click();
    } catch (error) {
      const debugPath = resolve("/tmp", `site-studio-history-${randomUUID()}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`history debug screenshot: ${debugPath}`);
      throw error;
    }
    await expect(history.getByText("Checkpoint A", { exact: true })).toBeVisible({ timeout: 10_000 });
    await history.getByRole("button", { name: "Close", exact: true }).first().click();

    await page.getByRole("button", { name: "Show code editor" }).click();
    await page.getByRole("button", { name: "index.html", exact: true }).click();
    await waitForEditorText(page, "Version A");
    await replaceEditorContent(
      page,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Browser value</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Version B</h1><p id="module-status">module waiting</p></main><script type="module" src="browser-preview-script.js"></script></body></html>`,
    );
    await waitForPreview(page, "Version B");

    await closeCodeEditor(page);
    await openProjectMenu(page, projectName);
    await page.getByRole("menuitem", { name: "Version history" }).click();
    history = page.getByRole("dialog");
    await expect(history.getByText("Checkpoint A", { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "Restore" }).first().click();
    await waitForPreview(page, "Version A");
    await waitForPreview(page, "nested module loaded");
    await waitForPreviewImage(page, "Browser fixture image");
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: "Close", exact: true }).last().click();

    // Both user-visible download paths must return the authored bytes.
    await page.getByRole("button", { name: "Show code editor" }).click();
    await page.getByRole("button", { name: "index.html", exact: true }).click();
    await waitForEditorText(page, "Version A");
    const fileDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download index.html", exact: true }).click();
    const downloadedFile = await fileDownloadPromise;
    const downloadedPath = await downloadedFile.path();
    if (downloadedPath === null || !(await readFile(downloadedPath)).includes(Buffer.from("Version A"))) {
      throw new Error("download did not return the restored authored HTML");
    }

    await openProjectMenu(page, projectName);
    const zipDownloadPromise = page.waitForEvent("download");
    try {
      await page.getByRole("menuitem", { name: "Export as ZIP" }).click();
    } catch (error) {
      const debugPath = resolve("/tmp", `site-studio-export-${randomUUID()}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      console.log(`export debug screenshot: ${debugPath}`);
      console.log(`export visible menu count: ${await page.locator('[role="menu"]:visible').count()}`);
      console.log(
        `export visible menu text: ${JSON.stringify(await page.locator('[role="menu"]:visible').allTextContents())}`,
      );
      throw error;
    }
    const exported = await zipDownloadPromise;
    const exportedPath = await exported.path();
    if (exportedPath === null) {
      throw new Error("export did not return a ZIP archive");
    }
    const archive = unzipSync(new Uint8Array(await readFile(exportedPath)));
    const archiveFiles = Object.fromEntries(
      Object.entries(archive).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
    );
    for (const path of ["index.html", "styles.css", "browser-preview-script.js", "browser-child.js"]) {
      if (!(path in archiveFiles)) throw new Error(`ZIP archive is missing authored ${path}`);
    }
    if (!archiveFiles["index.html"]?.includes("Version A"))
      throw new Error("ZIP index.html is not the restored authored file");
    if (!archiveFiles["styles.css"]?.includes("rgb(12, 34, 56)"))
      throw new Error("ZIP styles.css is not the authored file");
    if (!archiveFiles["browser-preview-script.js"]?.includes("browser-child.js"))
      throw new Error("ZIP nested module entry is not authored");
    if (!archiveFiles["browser-child.js"]?.includes("nested module loaded"))
      throw new Error("ZIP nested module content is not authored");
    const archivedImage = archive[IMAGE_FIXTURE_PATH];
    if (!archivedImage || !Buffer.from(archivedImage).equals(IMAGE_FIXTURE_BYTES))
      throw new Error("ZIP image entry does not preserve the uploaded bytes");

    // Reloading the actual app must recover persisted preview state.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPreview(page, "Version A");
    await waitForPreview(page, "nested module loaded");
    await waitForPreviewImage(page, "Browser fixture image");
    await expect(completionText()).toBeVisible();

    // The image must remain a binary asset after reload and the user-facing
    // file-tree download must return the exact uploaded bytes.
    await page.getByRole("button", { name: "Show code editor" }).click();
    await expect(page.getByRole("button", { name: `Download ${IMAGE_FIXTURE_NAME}`, exact: true })).toBeVisible();
    const imageDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${IMAGE_FIXTURE_NAME}`, exact: true }).click();
    const downloadedImage = await imageDownloadPromise;
    const downloadedImagePath = await downloadedImage.path();
    if (downloadedImagePath === null || !(await readFile(downloadedImagePath)).equals(IMAGE_FIXTURE_BYTES)) {
      throw new Error("image download did not return the uploaded bytes");
    }
    await closeCodeEditor(page);

    // Publish through the visible handle-claim flow, verify the public page
    // serves the authored image, then make it private and prove the same URL
    // now returns a real 404 from the local Worker.
    await page.getByRole("button", { name: `Publish ${projectName}`, exact: true }).click();
    const handleDialog = page.getByRole("dialog");
    await expect(handleDialog.getByRole("heading", { name: "Choose your public address", exact: true })).toBeVisible();
    const publicHandle = `browser-${Date.now()}`;
    await handleDialog.getByLabel("Address").fill(publicHandle);
    await expect(handleDialog.getByText("Available", { exact: true })).toBeVisible();
    await handleDialog.getByRole("button", { name: "Save and publish", exact: true }).click();
    const publishedButton = page.getByRole("button", { name: `View published site for ${projectName}`, exact: true });
    await expect(publishedButton).toBeVisible();
    const accessibilityHeading = page.getByRole("heading", { name: /^Published, with \d+ accessibility notes?$/ });
    if (await accessibilityHeading.count() > 0) {
      await expect(accessibilityHeading).toBeVisible();
      await page.getByRole("button", { name: "Got it", exact: true }).click();
    }
    const publishedPage = await Promise.all([
      page.waitForEvent("popup"),
      publishedButton.click(),
    ]).then(([popup]) => popup);
    await publishedPage.waitForLoadState("domcontentloaded");
    await expect(publishedPage.getByRole("heading", { name: "Version A", exact: true })).toBeVisible();
    const publishedImage = publishedPage.getByRole("img", { name: "Browser fixture image", exact: true });
    await expect(publishedImage).toHaveCount(1, { timeout: 15_000 });
    await waitForLoadedImage(publishedImage);
    const publishedUrl = publishedPage.url();
    await publishedPage.close();

    await openProjectMenu(page, projectName);
    const makePrivate = page.getByRole("menuitem", { name: "Make site private", exact: true });
    await expect(makePrivate).toBeVisible();
    page.once("dialog", async (confirmDialog) => {
      await confirmDialog.accept();
    });
    await makePrivate.click();
    await expect(page.getByRole("button", { name: `Publish ${projectName}`, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).not.toBeVisible();
    const privatePage = await context.newPage();
    const privateResponse = await privatePage.goto(publishedUrl, { waitUntil: "domcontentloaded" });
    if (!privateResponse || privateResponse.status() !== 404) {
      throw new Error(`unpublished URL returned ${privateResponse?.status() ?? "no response"} instead of 404`);
    }
    await privatePage.close();

    // Leave no project or storage state behind.
    await openProjectMenu(page, projectName);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog");
    await expect(deleteDialog.getByRole("heading", { name: "Delete Project" })).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete Project" }).click();
    await page.waitForURL(`${baseUrl}/`);
    await expect(page.getByText("No projects yet", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode === null) {
    handle.child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        handle.child.kill("SIGKILL");
        resolvePromise();
      }, 5_000);
      handle.child.once("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
  }
}

async function main(): Promise<void> {
  const buildDirectory = await stat(BUILD_DIR).catch(() => null);
  if (buildDirectory === null || !buildDirectory.isDirectory()) {
    throw new Error("frontend build is missing; run `bun run build` first");
  }

  const identity = await runIdentity();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const worker = startWorker(identity.jwks, identity.issuer, identity.token, identity.gatewayToken, port);
  let passed = false;
  try {
    await waitForWorker(baseUrl, worker.child);
    await runBrowserPath(baseUrl, identity.token);
    console.log(
      "local browser acceptance passed: dashboard/create/chat-tool/stop-recovery/multiple-tools/persisted-commit/edit/upload/image-preview/image-download/rename/delete/preview/nested-module/version-restore/download/ZIP/reload/publish/unpublish",
    );
    passed = true;
  } finally {
    await stopWorker(worker);
    if (!passed) {
      console.error(`local worker output: ${worker.output.join("").slice(-8_000)}`);
    }
  }
}

await main();
