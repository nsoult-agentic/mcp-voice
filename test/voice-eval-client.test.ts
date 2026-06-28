import { describe, expect, test } from "bun:test";

import { createEvalClient } from "../src/voice/eval-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_VERDICT = {
  verdict: "PASS",
  gate_a: {
    passed: true,
    cosine_delta: 0.3,
    style_cosine: null,
    percentile: 0.7,
    threshold_percentile: 0.4,
  },
  // extra sidecar fields (detector_score, note) must be tolerated/stripped
  gate_b: { flag: "none", abstained: true, detector_score: null, note: "advisory" },
  register: "email",
  word_count: 42,
};

function clientWith(responder: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return responder(u, init);
  }) as unknown as typeof fetch;
  return { client: createEvalClient({ baseUrl: "http://localhost:8920/", fetch: fetchFn }), calls };
}

describe("eval-client — /evaluate", () => {
  test("posts the request and returns the parsed verdict (extra fields stripped)", async () => {
    const { client, calls } = clientWith(() => jsonResponse(VALID_VERDICT));
    const v = await client.evaluate("hello there", "operator", "email", "normal");
    expect(v.verdict).toBe("PASS");
    expect(v.gate_a.passed).toBe(true);
    expect(v.gate_b).toEqual({ flag: "none", abstained: true }); // detector_score/note dropped
    expect(calls[0]?.url).toBe("http://localhost:8920/evaluate");
    expect(calls[0]?.body).toEqual({
      text: "hello there",
      author_id: "operator",
      register: "email",
      strictness: "normal",
    });
  });

  test("throws on a non-2xx response (e.g. 404 no profile)", async () => {
    const { client } = clientWith(() => jsonResponse({ detail: "no profile" }, 404));
    await expect(client.evaluate("x", "operator", "email", "normal")).rejects.toThrow(/404/);
  });

  test("throws when the response shape is invalid (seam validation)", async () => {
    const bad = { ...VALID_VERDICT, gate_a: { passed: true } }; // missing required gate_a fields
    const { client } = clientWith(() => jsonResponse(bad));
    await expect(client.evaluate("x", "operator", "email", "normal")).rejects.toThrow();
  });

  test("on 404, re-seeds from the persisted blob and retries once", async () => {
    const blob = { register: "email", targets: {}, metrics: { roc_auc: 0.9 } };
    const seen: string[] = [];
    let evaluateCalls = 0;
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith("/evaluate")) {
        evaluateCalls += 1;
        return evaluateCalls === 1
          ? jsonResponse({ detail: "no profile" }, 404)
          : jsonResponse(VALID_VERDICT);
      }
      if (u.endsWith("/seed")) {
        return jsonResponse({ seeded: true, profiles_loaded: 1 });
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    let loaded: { author_id: string; register: string } | undefined;
    const client = createEvalClient({
      baseUrl: "http://localhost:8920/",
      fetch: fetchFn,
      loadCalibration: async (author_id, register) => {
        loaded = { author_id, register };
        return blob;
      },
    });

    const v = await client.evaluate("x", "operator", "email", "normal");
    expect(v.verdict).toBe("PASS");
    expect(loaded).toEqual({ author_id: "operator", register: "email" });
    expect(seen).toEqual([
      "http://localhost:8920/evaluate",
      "http://localhost:8920/seed",
      "http://localhost:8920/evaluate",
    ]);
  });

  test("on 404 with no persisted blob, throws (no infinite retry)", async () => {
    let evaluateCalls = 0;
    const fetchFn = (async (url: string | URL) => {
      if (String(url).endsWith("/evaluate")) {
        evaluateCalls += 1;
      }
      return jsonResponse({ detail: "no profile" }, 404);
    }) as unknown as typeof fetch;
    const client = createEvalClient({
      baseUrl: "http://localhost:8920/",
      fetch: fetchFn,
      loadCalibration: async () => null, // nothing persisted
    });
    await expect(client.evaluate("x", "operator", "email", "normal")).rejects.toThrow(/404/);
    expect(evaluateCalls).toBe(1); // no retry when there's no blob to seed
  });
});

describe("eval-client — /calibrate", () => {
  test("parses targets + metrics and passes the opaque blob through", async () => {
    const blob = {
      register: "email",
      mfw_count: 200,
      scorer: { vocab: ["the"], mean: [0], std: [1], centroid: [0.1] },
      genuine_scores: [0.3],
      impostor_scores: [-0.2],
      targets: {
        sentence_len_mean: 14,
        sentence_len_variance: 30,
        mattr: 0.7,
        punctuation_profile: { em_dash: 0.01 },
        contraction_rate: 0.03,
        emoji_rate: 0,
        lowercase_start_rate: 0.4,
        signature_ngrams: ["make sure"],
      },
      metrics: { roc_auc: 0.97, n_genuine: 20, n_impostor: 20 },
    };
    const { client } = clientWith(() => jsonResponse(blob));
    const out = await client.calibrate("operator", "email", ["g"], ["i"]);
    expect(out.metrics.roc_auc).toBe(0.97);
    expect(out.targets.sentence_len_mean).toBe(14);
    // opaque fields survive for storage persistence
    expect((out as Record<string, unknown>).scorer).toBeDefined();
  });
});

describe("eval-client — /health", () => {
  test("returns status + profile count", async () => {
    const { client } = clientWith(() => jsonResponse({ status: "ok", profiles_loaded: 2 }));
    expect(await client.health()).toEqual({ status: "ok", profiles_loaded: 2 });
  });
});
