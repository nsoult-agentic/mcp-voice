import { describe, expect, test } from "bun:test";

import { runPipeline } from "../src/pipeline.ts";
import { createFileCorpusSource } from "../src/voice/corpus-file.ts";

function sourceWith(json: string) {
  return createFileCorpusSource({ path: "/corpus.json", readFile: async () => json });
}

const INPUT = { voice_id: "operator", sources: ["matrix"] as const };

describe("file corpus source", () => {
  test("parses entries into RawUnits tagged with the imported medium", async () => {
    const json = JSON.stringify([
      {
        medium: "slack",
        source_uri: "slack:1",
        timestamp: "2026-01-01T00:00:00Z",
        text: "hello team",
      },
      {
        medium: "claude",
        source_uri: "claude:2",
        timestamp: "2026-01-02T00:00:00Z",
        text: "merge it",
      },
    ]);
    const units = await sourceWith(json).pull(INPUT);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      author_id: "operator",
      author_address: "operator",
      medium: "slack",
      source_uri: "slack:1",
      raw_text: "hello team",
    });
    expect(units[1]?.medium).toBe("claude");
  });

  test("authorAddress override is used when provided", async () => {
    const json = JSON.stringify([
      { medium: "slack", source_uri: "s", timestamp: "2026-01-01T00:00:00Z", text: "hi" },
    ]);
    const src = createFileCorpusSource({
      path: "/c",
      authorAddress: "@neil",
      readFile: async () => json,
    });
    expect((await src.pull(INPUT))[0]?.author_address).toBe("@neil");
  });

  test("throws on invalid JSON", async () => {
    await expect(sourceWith("not json").pull(INPUT)).rejects.toThrow(/not valid JSON/);
  });

  test("throws on a schema violation (bad medium / missing text)", async () => {
    await expect(
      sourceWith(
        JSON.stringify([{ medium: "email", source_uri: "x", timestamp: "t", text: "y" }]),
      ).pull(INPUT),
    ).rejects.toThrow();
    await expect(
      sourceWith(JSON.stringify([{ medium: "slack", source_uri: "x", timestamp: "t" }])).pull(
        INPUT,
      ),
    ).rejects.toThrow();
    // a non-ISO timestamp is rejected at the seam (not deferred to the record schema)
    await expect(
      sourceWith(
        JSON.stringify([{ medium: "slack", source_uri: "x", timestamp: "yesterday", text: "y" }]),
      ).pull(INPUT),
    ).rejects.toThrow();
  });
});

describe("imported mediums through the real pipeline", () => {
  test("slack default register is longform; boundaries are NOT stripped", async () => {
    // A quoted line + sig that email-stripping WOULD trim — must survive for slack.
    const text = "Here is my take on the plan.\n\n> someone said something\n--\nNeil";
    const json = JSON.stringify([
      { medium: "slack", source_uri: "slack:q", timestamp: "2026-01-01T00:00:00Z", text },
    ]);
    const units = await sourceWith(json).pull(INPUT);
    const [record] = runPipeline(units, { ingest_version: "t" });
    expect(record?.register).toBe("longform"); // slack medium default
    expect(record?.text_clean).toContain("> someone said something"); // not boundary-stripped
    expect(record?.text_clean).toContain("Neil");
  });

  test("a terse claude message classifies as chat", async () => {
    const json = JSON.stringify([
      {
        medium: "claude",
        source_uri: "claude:1",
        timestamp: "2026-01-01T00:00:00Z",
        text: "merge it",
      },
    ]);
    const [record] = runPipeline(await sourceWith(json).pull(INPUT), { ingest_version: "t" });
    expect(record?.register).toBe("chat");
  });
});
