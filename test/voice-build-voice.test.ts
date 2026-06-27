import { describe, expect, test } from "bun:test";

import type { CorpusRecord } from "../src/corpus-record.ts";
import type { Exemplar, ExemplarStore } from "../src/exemplar-store.ts";
import type { ProfileInput, ProfileStore } from "../src/profile-store.ts";
import type { RawUnit } from "../src/adapters/raw-unit.ts";
import type { BuildProfileDeps } from "../src/voice/build-profile.ts";
import { type BuildVoiceDeps, createBuildVoice } from "../src/voice/build-voice.ts";
import type { CalibrateBlob } from "../src/voice/eval-client.ts";

const TARGETS = {
  sentence_len_mean: 14,
  sentence_len_variance: 30,
  mattr: 0.7,
  punctuation_profile: {},
  contraction_rate: 0.03,
  emoji_rate: 0,
  lowercase_start_rate: 0.4,
  signature_ngrams: [],
};

function exemplar(text: string): Exemplar {
  return {
    id: text,
    author_id: "operator",
    register: "longform",
    medium: "matrix",
    source_uri: text,
    thread_id: null,
    authored_at: "2026-01-01T00:00:00Z",
    ingested_at: "2026-01-01T00:00:00Z",
    text,
    word_count: 10,
    dedup_cluster_id: text,
    is_canonical: true,
    content_embedding: null,
    style_embedding: null,
    ingest_version: "1",
    profile_version: null,
  };
}

function rawUnit(i: number, text: string): RawUnit {
  return {
    author_id: "operator",
    medium: "matrix",
    source_uri: `matrix:event:${i}`,
    thread_id: null,
    timestamp: "2026-01-01T00:00:00Z",
    raw_text: text,
  };
}

const SENTENCES = [
  "The deploy went out at three and the dashboards held steady all evening.",
  "I went through the renewal numbers again and the second option clearly wins.",
  "We should ship the migration in two passes so we can roll back the first.",
  "Honestly the new build feels faster and the error rate is finally flat.",
  "Let me know if Tuesday works and I will book the room for the review.",
  "The trail was steeper than the map suggested but the view paid it back.",
];

interface Recorder {
  upserted: CorpusRecord[][];
  written: ProfileInput[];
  retrieveReturns: Exemplar[];
}

function makeDeps(retrieveReturns: Exemplar[]): { deps: BuildVoiceDeps; rec: Recorder } {
  const rec: Recorder = { upserted: [], written: [], retrieveReturns };
  const exemplars: ExemplarStore = {
    async upsert(records) {
      rec.upserted.push(records);
      return records.length;
    },
    async retrieve() {
      return rec.retrieveReturns;
    },
    getById: () => Promise.reject(new Error("unused")),
    getByIds: () => Promise.reject(new Error("unused")),
  };
  const profiles: ProfileStore = {
    async writeProfile(input) {
      rec.written.push(input);
    },
    async activateProfile() {},
    getActiveProfile: () => Promise.reject(new Error("unused")),
    getProfile: () => Promise.reject(new Error("unused")),
    listVersions: () => Promise.reject(new Error("unused")),
  };
  const buildProfile: BuildProfileDeps = {
    exemplars,
    profiles,
    calibrator: {
      async calibrate() {
        return {
          register: "longform",
          targets: TARGETS,
          metrics: { roc_auc: 0.95 },
        } as CalibrateBlob;
      },
    },
    prose: {
      async extract() {
        return { voice_summary: "vs", habits: [], do_more_of: [] };
      },
    },
    impostors: {
      async collect() {
        return ["impostor a", "impostor b"];
      },
    },
  };
  let n = 0;
  const deps: BuildVoiceDeps = {
    corpus: {
      async pull() {
        return SENTENCES.map((t, i) => rawUnit(i, t));
      },
    },
    buildProfile,
    ingestVersion: "ingest-1",
    newVersion: () => {
      n += 1;
      return `v${n}`;
    },
    now: () => "2026-06-27T00:00:00Z",
  };
  return { deps, rec };
}

const INPUT = { voice_id: "operator", sources: ["matrix"] as const };

describe("buildVoice pipeline", () => {
  test("ingests the corpus, stores exemplars, and builds a profile per register", async () => {
    const { deps, rec } = makeDeps(SENTENCES.map(exemplar)); // store returns ≥5 → builds
    const result = await createBuildVoice(deps)(INPUT);

    // ran the real ingestion pipeline over the pulled units → stored them
    expect(rec.upserted).toHaveLength(1);
    expect(rec.upserted[0]?.length).toBeGreaterThan(0);
    expect(result.ingested).toBe(rec.upserted[0]?.length);
    // built at least one register's profile (and wrote it)
    expect(result.builtRegisters.length).toBeGreaterThan(0);
    expect(rec.written.length).toBe(result.builtRegisters.length);
    expect(result.skippedRegisters).toHaveLength(0);
  });

  test("skips a register too thin to calibrate (cold-start, not a failure)", async () => {
    const { deps, rec } = makeDeps([exemplar("only one")]); // store returns <5 → InsufficientCorpus
    const result = await createBuildVoice(deps)(INPUT);

    expect(rec.upserted).toHaveLength(1); // corpus still ingested
    expect(result.builtRegisters).toHaveLength(0);
    expect(result.skippedRegisters.length).toBeGreaterThan(0);
    expect(rec.written).toHaveLength(0); // nothing built/activated
  });
});
