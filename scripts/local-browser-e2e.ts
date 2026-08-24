import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  expect,
  type BrowserContext,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import { z } from "zod";

/**
 * Value-focused Site Studio browser acceptance against a local app process.
 *
 * The browser talks HTTP to a real Bun process running the production Hono app
 * and its CSRF/CAS mutation service. Storage is a deterministic in-memory
 * R2/KV binding because Wrangler's local R2 emulator does not implement the
 * conditional first-write operation that Site Studio requires. No model call
 * or provider credential is used.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = resolve(ROOT, "packages/app");
const BUILD_DIR = resolve(ROOT, "packages/frontend/build");
const IDENTITY_SCRIPT = resolve(APP_DIR, "scripts/local-browser-identity.ts");
const WORKER_SCRIPT = resolve(APP_DIR, "scripts/local-browser-worker.ts");
const CHILD_FIXTURE = resolve(ROOT, "scripts/fixtures/browser-child.js");
const MODULE_FIXTURE = resolve(ROOT, "scripts/fixtures/browser-preview-script.js");

type Identity = {
  readonly jwks: string;
  readonly issuer: string;
  readonly token: string;
};

const identitySchema = z.object({
  jwks: z.string(),
  issuer: z.string(),
  token: z.string(),
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

function startWorker(jwks: string, issuer: string, port: number): WorkerHandle {
  const output: string[] = [];
  const environment = {
    ...process.env,
    PORT: String(port),
    SITE_STUDIO_FRONTEND_BUILD: BUILD_DIR,
    CAIL_IDENTITY_JWKS: jwks,
    CAIL_IDENTITY_ISSUER: issuer,
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
      const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) });
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
      `preview frames: ${page.frames()
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

async function waitForPreviewBackground(page: Page, expected: string): Promise<void> {
  await expect
    .poll(
      async () => await previewFrame(page).locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
      { timeout: 15_000 },
    )
    .toBe(expected);
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
  const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript({
      content: "localStorage.setItem('site-studio-onboarding-completed', 'true');",
    });
    const page = await context.newPage();
    await installAuthRoute(page, baseUrl, token);

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
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
    await expect(page.getByText(projectName, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show code editor" })).toBeVisible();

    // A blank project is visibly useful only once authored assets execute.
    await page.getByRole("button", { name: "Show code editor" }).click();
    await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible();
    const filePanel = page.getByRole("complementary").filter({ hasText: "Files" });
    const upload = filePanel.locator('input[type="file"]');
    await upload.setInputFiles(CHILD_FIXTURE);
    await expect(page.getByRole("button", { name: "browser-child.js", exact: true })).toBeVisible();
    await upload.setInputFiles(MODULE_FIXTURE);
    await expect(page.getByRole("button", { name: "browser-preview-script.js", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "index.html", exact: true }).click();
    await waitForEditorText(page, "<!DOCTYPE html>");
    await replaceEditorContent(
      page,
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser value</title><link rel="stylesheet" href="styles.css"></head>
  <body><main><h1>Version A</h1><p id="module-status">module waiting</p></main><script type="module" src="browser-preview-script.js"></script></body>
</html>`,
    );
    await waitForPreview(page, "Version A");
    await waitForPreview(page, "nested module loaded");

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
    await history.getByRole("button", { name: "Close", exact: true }).first().click();

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
    await page.getByRole("menuitem", { name: "Export as ZIP" }).click();
    const exported = await zipDownloadPromise;
    const exportedPath = await exported.path();
    if (exportedPath === null || (await readFile(exportedPath)).subarray(0, 2).toString() !== "PK") {
      throw new Error("export did not return a ZIP archive");
    }

    // Reloading the actual app must recover persisted preview state.
    await page.reload({ waitUntil: "networkidle" });
    await waitForPreview(page, "Version A");
    await waitForPreview(page, "nested module loaded");

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
  const worker = startWorker(identity.jwks, identity.issuer, port);
  let passed = false;
  try {
    await waitForWorker(baseUrl, worker.child);
    await runBrowserPath(baseUrl, identity.token);
    console.log("local browser acceptance passed: dashboard/create/edit/upload/preview/CSS+nested-module/version-restore/download/export/reload/delete");
    passed = true;
  } finally {
    await stopWorker(worker);
    if (!passed) {
      console.error(`local worker output: ${worker.output.join("").slice(-8_000)}`);
    }
  }
}

await main();
