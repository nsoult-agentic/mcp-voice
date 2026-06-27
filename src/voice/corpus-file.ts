/**
 * File-based CorpusSource (live wiring) — the concrete corpus the voice_add build
 * reads. The operator's curated Slack + Claude-chat text is prepared into a JSON
 * corpus file (out of band; the deployed server can't reach Nextcloud/transcripts at
 * runtime), and this source reads it into `RawUnit`s tagged with the imported mediums
 * (slack/claude → no boundary stripping; register classified from content).
 *
 * The file is validated with Zod at the seam. `input.sources` is not consulted in v1
 * (the file IS the corpus); it remains for the future live email/matrix adapters.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { z } from "zod";
import type { RawUnit } from "../adapters/raw-unit";
import type { CorpusSource } from "./build-voice";

const CorpusEntrySchema = z.object({
  medium: z.enum(["slack", "claude"]),
  source_uri: z.string().min(1),
  timestamp: z.string().datetime(), // ISO-8601; fail at the seam, not later at the record schema
  text: z.string().min(1),
});
const CorpusFileSchema = z.array(CorpusEntrySchema);

export interface FileCorpusDeps {
  path: string;
  /** Synthetic identity for imported text (no email/MXID); defaults to the voice_id. */
  authorAddress?: string;
  /** Injected for tests; defaults to reading `path` from disk as UTF-8. */
  readFile?: (path: string) => Promise<string>;
}

/** A CorpusSource that reads a prepared JSON corpus file. */
export function createFileCorpusSource(deps: FileCorpusDeps): CorpusSource {
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, "utf-8"));
  return {
    async pull(input): Promise<RawUnit[]> {
      const raw = await read(deps.path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("corpus file is not valid JSON");
      }
      const entries = CorpusFileSchema.parse(parsed);
      return entries.map((e) => ({
        author_id: input.voice_id,
        author_address: deps.authorAddress ?? input.voice_id,
        medium: e.medium,
        source_uri: e.source_uri,
        thread_id: null,
        timestamp: e.timestamp,
        raw_text: e.text,
      }));
    },
  };
}
