#!/usr/bin/env python3
"""Value-focused Site Studio browser acceptance against a local app process.

This deliberately exercises the user-visible workspace path rather than
repeating route-only fixtures. The browser talks HTTP to a real Bun process
running the production Hono app and its CSRF/CAS mutation service. Storage is a
deterministic in-memory R2/KV binding because Wrangler's local R2 emulator does
not implement the conditional first-write operation that Site Studio requires.
No model call or provider credential is used.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, TimeoutError, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "packages" / "app"
BUILD_DIR = ROOT / "packages" / "frontend" / "build"
IDENTITY_SCRIPT = APP_DIR / "scripts" / "local-browser-identity.ts"
WORKER_SCRIPT = APP_DIR / "scripts" / "local-browser-worker.ts"
CHILD_FIXTURE = ROOT / "scripts" / "fixtures" / "browser-child.js"
MODULE_FIXTURE = ROOT / "scripts" / "fixtures" / "browser-preview-script.js"


def free_port() -> int:
    with socket.socket() as server_socket:
        server_socket.bind(("127.0.0.1", 0))
        return int(server_socket.getsockname()[1])


def run_identity() -> dict[str, str]:
    result = subprocess.run(
        ["bun", str(IDENTITY_SCRIPT)],
        cwd=APP_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def start_worker(identity: dict[str, str], port: int) -> tuple[subprocess.Popen[str], Path]:
    log_file = Path(tempfile.mkstemp(prefix="site-studio-browser-worker-", suffix=".log")[1])
    environment = os.environ.copy()
    environment.update(
        {
            "PORT": str(port),
            "SITE_STUDIO_FRONTEND_BUILD": str(BUILD_DIR),
            "CAIL_IDENTITY_JWKS": identity["jwks"],
            "CAIL_IDENTITY_ISSUER": identity["issuer"],
        }
    )
    output = log_file.open("w", encoding="utf-8")
    process = subprocess.Popen(
        ["bun", str(WORKER_SCRIPT)],
        cwd=APP_DIR,
        env=environment,
        stdout=output,
        stderr=subprocess.STDOUT,
        text=True,
    )
    process._site_studio_log = output  # type: ignore[attr-defined]
    return process, log_file


def wait_for_worker(base_url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"local Site Studio process exited with {process.returncode}")
        try:
            import urllib.request

            with urllib.request.urlopen(f"{base_url}/", timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise TimeoutError("local Site Studio process did not become ready")


def install_auth_route(page: Page, base_url: str, token: str) -> None:
    origin = urlparse(base_url).netloc

    def route_request(route, request) -> None:
        target = urlparse(request.url)
        initial_preview = target.path.startswith("/preview/") and "pt" not in target.query
        if target.netloc == origin and (target.path.startswith("/api/") or initial_preview):
            headers = dict(request.headers)
            headers["x-cail-identity-jwt"] = token
            route.continue_(headers=headers)
            return
        route.continue_()

    page.route("**/*", route_request)


def editor_content(page: Page):
    content = page.locator('[contenteditable="true"]').last
    expect(content).to_be_visible()
    return content


def replace_editor_content(page: Page, value: str) -> None:
    editor = editor_content(page)
    editor.click()
    editor.press("ControlOrMeta+A")
    editor.press("Backspace")
    editor.type(value)


def wait_for_editor_text(page: Page, text: str) -> None:
    expect(editor_content(page)).to_contain_text(text, timeout=10_000)


def preview_frame(page: Page):
    frame = page.frame_locator('iframe[title="Site Preview"]')
    expect(page.locator('iframe[title="Site Preview"]')).to_be_visible()
    return frame


def wait_for_preview(page: Page, text: str) -> None:
    try:
        expect(preview_frame(page).get_by_text(text, exact=True)).to_be_visible(timeout=15_000)
    except AssertionError:
        debug_path = Path(tempfile.mkstemp(prefix="site-studio-preview-", suffix=".png")[1])
        page.screenshot(path=str(debug_path), full_page=True)
        print(f"preview debug screenshot: {debug_path}", file=sys.stderr)
        print(
            "preview frames: "
            + "; ".join(f"{frame.url} ({frame.name})" for frame in page.frames),
            file=sys.stderr,
        )
        for frame in page.frames:
            try:
                print(f"frame body {frame.url}: {frame.locator('body').inner_text()[:500]!r}", file=sys.stderr)
            except Exception as error:
                print(f"frame body unavailable {frame.url}: {error}", file=sys.stderr)
        try:
            print(f"editor text: {editor_content(page).inner_text()[:500]!r}", file=sys.stderr)
        except Exception as error:
            print(f"editor unavailable: {error}", file=sys.stderr)
        raise


def wait_for_preview_background(page: Page, expected: str) -> None:
    deadline = time.monotonic() + 15
    last_value = None
    while time.monotonic() < deadline:
        try:
            last_value = preview_frame(page).locator("body").evaluate(
                "element => getComputedStyle(element).backgroundColor"
            )
            if last_value == expected:
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise AssertionError(f"authored CSS did not execute: {last_value!r}")


def open_project_menu(page: Page, project_name: str) -> None:
    page.get_by_role("button", name=f"Project options for {project_name}").click()
    expect(page.get_by_role("menu")).to_be_visible()


def close_code_editor(page: Page) -> None:
    close_button = page.get_by_role("button", name="Close code editor")
    if close_button.is_visible():
        close_button.click()


def run_browser_path(base_url: str, token: str) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context: BrowserContext = browser.new_context(accept_downloads=True)
        context.add_init_script(
            "localStorage.setItem('site-studio-onboarding-completed', 'true');"
        )
        page = context.new_page()
        install_auth_route(page, base_url, token)

        page.goto(f"{base_url}/", wait_until="networkidle")
        expect(page.get_by_role("heading", name="Site Studio")).to_be_visible()
        expect(page.get_by_text("No projects yet", exact=True)).to_be_visible()

        page.get_by_role("button", name="New Project").click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        dialog.get_by_role("button", name="Blank Canvas Start from scratch").click()
        project_name = f"Browser value {int(time.time())}"
        dialog.get_by_label("Project Name (optional)").fill(project_name)
        dialog.get_by_role("button", name="Create Project").click()
        page.wait_for_url("**/editor/**")
        expect(page.get_by_text(project_name, exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Show code editor")).to_be_visible()

        # A blank project is visibly useful only once authored assets execute.
        page.get_by_role("button", name="Show code editor").click()
        expect(page.get_by_role("button", name="Upload file")).to_be_visible()
        file_panel = page.get_by_role("complementary").filter(has_text="Files")
        upload = file_panel.locator('input[type="file"]')
        upload.set_input_files(str(CHILD_FIXTURE))
        expect(page.get_by_role("button", name="browser-child.js", exact=True)).to_be_visible()
        upload.set_input_files(str(MODULE_FIXTURE))
        expect(page.get_by_role("button", name="browser-preview-script.js", exact=True)).to_be_visible()

        page.get_by_role("button", name="index.html", exact=True).click()
        wait_for_editor_text(page, "<!DOCTYPE html>")
        replace_editor_content(
            page,
            """<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser value</title><link rel="stylesheet" href="styles.css"></head>
  <body><main><h1>Version A</h1><p id="module-status">module waiting</p></main><script type="module" src="browser-preview-script.js"></script></body>
</html>""",
        )
        wait_for_preview(page, "Version A")
        wait_for_preview(page, "nested module loaded")

        page.get_by_role("button", name="styles.css", exact=True).click()
        wait_for_editor_text(page, "background")
        replace_editor_content(page, "body { background: rgb(12, 34, 56); color: white; }")
        wait_for_preview(page, "Version A")
        wait_for_preview_background(page, "rgb(12, 34, 56)")

        # A user-requested version must round-trip through the real snapshot API.
        close_code_editor(page)
        open_project_menu(page, project_name)
        page.get_by_role("menuitem", name="Version history").click()
        history = page.get_by_role("dialog")
        history.get_by_label("Name this version").fill("Checkpoint A")
        try:
            history.get_by_role("button", name="Save version").click()
        except TimeoutError:
            debug_path = Path(tempfile.mkstemp(prefix="site-studio-history-", suffix=".png")[1])
            page.screenshot(path=str(debug_path), full_page=True)
            print(f"history debug screenshot: {debug_path}", file=sys.stderr)
            raise
        expect(history.get_by_text("Checkpoint A", exact=True)).to_be_visible(timeout=10_000)
        history.get_by_role("button", name="Close", exact=True).first.click()

        page.get_by_role("button", name="Show code editor").click()
        page.get_by_role("button", name="index.html", exact=True).click()
        wait_for_editor_text(page, "Version A")
        replace_editor_content(
            page,
            """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Browser value</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Version B</h1><p id="module-status">module waiting</p></main><script type="module" src="browser-preview-script.js"></script></body></html>""",
        )
        wait_for_preview(page, "Version B")

        close_code_editor(page)
        open_project_menu(page, project_name)
        page.get_by_role("menuitem", name="Version history").click()
        history = page.get_by_role("dialog")
        expect(history.get_by_text("Checkpoint A", exact=True)).to_be_visible()
        history.get_by_role("button", name="Restore").first.click()
        wait_for_preview(page, "Version A")
        wait_for_preview(page, "nested module loaded")
        history.get_by_role("button", name="Close", exact=True).first.click()

        # Both user-visible download paths must return the authored bytes.
        page.get_by_role("button", name="Show code editor").click()
        page.get_by_role("button", name="index.html", exact=True).click()
        wait_for_editor_text(page, "Version A")
        with page.expect_download() as file_download:
            page.get_by_role("button", name="Download index.html", exact=True).click()
        downloaded_file = file_download.value
        assert "Version A" in Path(downloaded_file.path()).read_text(encoding="utf-8")

        open_project_menu(page, project_name)
        with page.expect_download() as zip_download:
            page.get_by_role("menuitem", name="Export as ZIP").click()
        exported = zip_download.value
        assert Path(exported.path()).read_bytes()[:2] == b"PK", "export did not return a ZIP archive"

        # Reloading the actual app must recover persisted preview state.
        page.reload(wait_until="networkidle")
        wait_for_preview(page, "Version A")
        wait_for_preview(page, "nested module loaded")

        # Leave no project or storage state behind.
        open_project_menu(page, project_name)
        page.get_by_role("menuitem", name="Delete").click()
        delete_dialog = page.get_by_role("dialog")
        expect(delete_dialog.get_by_role("heading", name="Delete Project")).to_be_visible()
        delete_dialog.get_by_role("button", name="Delete Project").click()
        page.wait_for_url(f"{base_url}/")
        expect(page.get_by_text("No projects yet", exact=True)).to_be_visible()

        context.close()
        browser.close()


def main() -> int:
    if not BUILD_DIR.is_dir():
        raise RuntimeError("frontend build is missing; run `bun run build` first")
    identity = run_identity()
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    process, log_file = start_worker(identity, port)
    failed = True
    try:
        wait_for_worker(base_url, process)
        run_browser_path(base_url, identity["token"])
        print("local browser acceptance passed: dashboard/create/edit/upload/preview/CSS+nested-module/version-restore/download/export/reload/delete")
        failed = False
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log_handle = getattr(process, "_site_studio_log", None)
        if log_handle is not None:
            log_handle.close()
        if failed:
            print(f"local worker log: {log_file}", file=sys.stderr)
            print(log_file.read_text(encoding="utf-8")[-8_000:], file=sys.stderr)
        log_file.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
