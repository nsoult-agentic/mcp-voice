import { describe, expect, test } from "bun:test";

import {
  createNomicEmbedders,
  createOllamaEmbedder,
  NOMIC_DIM,
} from "../src/voice/embedder-ollama.ts";

const vec = (n: number) => Array.from({ length: n }, (_, i) => i / n);

function fetchReturning(
  body: unknown,
  status = 200,
): { fn: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("ollama embedder", () => {
  test("posts {model, prompt} and returns the 768-d vector", async () => {
    const v = vec(NOMIC_DIM);
    const { fn, calls } = fetchReturning({ embedding: v });
    const e = createOllamaEmbedder({ baseUrl: "http://172.16.10.50:11434/", fetch: fn });
    expect(e.dimensions).toBe(NOMIC_DIM);
    expect(await e.embed("hello")).toEqual(v);
    expect(calls[0]?.url).toBe("http://172.16.10.50:11434/api/embeddings");
    expect(calls[0]?.body).toEqual({ model: "nomic-embed-text", prompt: "hello" });
  });

  test("throws on a wrong-dimension vector", async () => {
    const { fn } = fetchReturning({ embedding: vec(512) });
    await expect(
      createOllamaEmbedder({ baseUrl: "http://x", fetch: fn }).embed("t"),
    ).rejects.toThrow(/expected 768/);
  });

  test("throws on a non-array / non-numeric embedding", async () => {
    const { fn } = fetchReturning({ embedding: "nope" });
    await expect(
      createOllamaEmbedder({ baseUrl: "http://x", fetch: fn }).embed("t"),
    ).rejects.toThrow();
  });

  test("throws on an HTTP error", async () => {
    const { fn } = fetchReturning({ error: "model not found" }, 404);
    await expect(
      createOllamaEmbedder({ baseUrl: "http://x", fetch: fn }).embed("t"),
    ).rejects.toThrow(/404/);
  });

  test("createNomicEmbedders gives content + style (both nomic, v1 Option A)", async () => {
    const v = vec(NOMIC_DIM);
    const { fn } = fetchReturning({ embedding: v });
    const e = createNomicEmbedders({ baseUrl: "http://x", fetch: fn });
    expect(e.content.dimensions).toBe(NOMIC_DIM);
    expect(e.style.dimensions).toBe(NOMIC_DIM);
    expect(await e.content.embed("a")).toEqual(v);
    expect(await e.style.embed("b")).toEqual(v);
  });
});
