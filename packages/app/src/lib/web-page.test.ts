import { describe, expect, it } from "vitest";
import { readWebPage } from "./web-page";

describe("public page reading", () => {
  it("reads text and resolved links through a credential-free redirect", async () => {
    const requests: Request[] = [];
    const fetchPage: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) return Response.redirect("https://pages.example.edu/course/", 302);
      return new Response(
        '<!doctype html><h1>Course readings</h1><script>privateScript()</script><style>.hidden{}</style>' +
        '<p>Read <a href="week-one">Week one</a> before class.</p>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    };
    const result = await readWebPage("https://example.edu/course", undefined, fetchPage);
    expect(result).toEqual({
      url: "https://pages.example.edu/course/",
      content: "<!doctype html>\nCourse readings\nRead Week one (https://pages.example.edu/course/week-one) before class.",
      truncated: false,
    });
    expect(requests.map((request) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      return { method: request.method, credentials: request.credentials, redirect: request.redirect, headers };
    })).toEqual(Array.from({ length: 2 }, () => ({
      method: "GET", credentials: "omit", redirect: "manual",
      headers: { accept: "text/html, text/plain, text/markdown, application/json" },
    })));
  });

  it("stops a public-page redirect before it can request a local destination", async () => {
    const visited: string[] = [];
    const fetchPage: typeof fetch = async (input) => {
      visited.push(String(input));
      return Response.redirect("http://127.0.0.1/private", 302);
    };
    await expect(readWebPage("https://example.edu/", undefined, fetchPage)).rejects.toThrow("Only public web pages");
    expect(visited).toEqual(["https://example.edu/"]);
  });

  it("rejects credentials before fetching and gives usable HTTP/file errors", async () => {
    let calls = 0;
    const fetchPage: typeof fetch = async () => {
      calls += 1;
      return new Response("private error body", { status: 403 });
    };
    await expect(readWebPage("https://person:secret@example.edu/", undefined, fetchPage)).rejects.toThrow("without embedded credentials");
    await expect(readWebPage("https://example.edu/", undefined, fetchPage)).rejects.toThrow("HTTP 403");
    expect(calls).toBe(1);
    await expect(readWebPage("https://example.edu/paper.pdf", undefined, async () =>
      new Response("PDF bytes", { headers: { "content-type": "application/pdf" } }),
    )).rejects.toThrow("Upload documents or images");
  });

  it("returns useful truncated text and cancels the remaining page stream", async () => {
    let cancelled = false;
    const fetchPage: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(120_001))); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/plain" } });
    const result = await readWebPage("https://example.edu/long", undefined, fetchPage);
    expect(result.content).toBe("x".repeat(120_000));
    expect(result.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("passes cancellation to the active request and does not retry it", async () => {
    const controller = new AbortController();
    let calls = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetchPage: typeof fetch = async (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      if (!signal) throw new Error("Expected request cancellation signal");
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const reading = readWebPage("https://example.edu/slow", controller.signal, fetchPage);
    await ready;
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(reading).rejects.toThrow("Stopped");
    expect(calls).toBe(1);
  });
});
