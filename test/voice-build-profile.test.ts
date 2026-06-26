import { describe, expect, test } from "bun:test";

import type { Exemplar, ExemplarStore } from "../src/exemplar-store.ts";
import type { ProfileInput, ProfileStore } from "../src/profile-store.ts";
import {
  buildRegisterProfile,
  type BuildProfileDeps,
  createHybridImpostorSource,
  InsufficientCorpusError,
  meanVector,
} from "../src/voice/build-profile.ts";
import type { CalibrateBlob } from "../src/voice/eval-client.ts";

function exemplar(text: string, style_embedding: number[] | null = null): Exemplar {
  return {
    id: text,
    author_id: "operator",
    register: "email",
    medium: "email",
    source_uri: "x",
    thread_id: null,
    authored_at: "2026-01-01T00:00:00Z",
    ingested_at: "2026-01-01T00:00:00Z",
    text,
    word_count: 5,
    dedup_cluster_id: "c",
    is_canonical: true,
    content_embedding: null,
    style_embedding,
    ingest_version: "1",
    profile_version: null,
  };
}

const TARGETS = {
  sentence_len_mean: 14,
  sentence_len_variance: 30,
  mattr: 0.7,
  punctuation_profile: { em_dash: 0.01 },
  contraction_rate: 0.03,
  emoji_rate: 0,
  lowercase_start_rate: 0.4,
  signature_ngrams: ["make sure"],
};

function blob(roc_auc = 0.95): CalibrateBlob {
  return {
    register: "email",
    targets: TARGETS,
    metrics: { roc_auc },
  } as CalibrateBlob;
}

interface Recorder {
  written: ProfileInput[];
  activated: { author_id: string; register: string; version: string }[];
  calibrateArgs: { genuine: string[]; impostors: string[] }[];
}

function makeDeps(
  rows: Exemplar[],
  impostors: string[],
): { deps: BuildProfileDeps; rec: Recorder } {
  const rec: Recorder = { written: [], activated: [], calibrateArgs: [] };
  const exemplars: ExemplarStore = {
    async retrieve() {
      return rows;
    },
    upsert: () => Promise.reject(new Error("unused")),
    getById: () => Promise.reject(new Error("unused")),
    getByIds: () => Promise.reject(new Error("unused")),
  };
  const profiles: ProfileStore = {
    async writeProfile(input) {
      rec.written.push(input);
    },
    async activateProfile(author_id, register, version) {
      rec.activated.push({ author_id, register, version });
    },
    getActiveProfile: () => Promise.reject(new Error("unused")),
    getProfile: () => Promise.reject(new Error("unused")),
    listVersions: () => Promise.reject(new Error("unused")),
  };
  const deps: BuildProfileDeps = {
    exemplars,
    profiles,
    calibrator: {
      async calibrate(_a, _r, genuine, imps) {
        rec.calibrateArgs.push({ genuine, impostors: imps });
        return blob();
      },
    },
    prose: {
      async extract() {
        return { voice_summary: "vs", habits: ["h"], do_more_of: ["d"] };
      },
    },
    impostors: {
      async collect() {
        return impostors;
      },
    },
  };
  return { deps, rec };
}

const OPTS = {
  author_id: "operator",
  register: "email" as const,
  version: "v1",
  builtAt: "2026-06-26T00:00:00Z",
};

describe("buildRegisterProfile", () => {
  test("builds, writes, and activates a versioned profile", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => exemplar(`msg ${i}`, [i, i + 1]));
    const { deps, rec } = makeDeps(rows, ["impostor a", "impostor b"]);
    const result = await buildRegisterProfile(deps, OPTS);

    expect(result).toEqual({
      version: "v1",
      exemplar_count: 6,
      readiness: "generation-ready",
      roc_auc: 0.95,
    });
    const w = rec.written[0];
    expect(w?.version).toBe("v1");
    expect((w?.style_card as { prose: { voice_summary: string } }).prose.voice_summary).toBe("vs");
    expect((w?.style_card as { targets: typeof TARGETS }).targets.sentence_len_mean).toBe(14);
    expect(w?.exemplar_count).toBe(6);
    // centroid = element-wise mean of the style embeddings
    expect(w?.style_centroid).toEqual(meanVector(rows.map((r) => r.style_embedding as number[])));
    // calibration saw genuine + the supplied impostors
    expect(rec.calibrateArgs[0]?.genuine.length).toBe(6);
    expect(rec.calibrateArgs[0]?.impostors).toEqual(["impostor a", "impostor b"]);
    // activated after write, for the same version
    expect(rec.activated[0]).toEqual({ author_id: "operator", register: "email", version: "v1" });
  });

  test("throws InsufficientCorpusError below the floor and writes nothing (cold-start)", async () => {
    const { deps, rec } = makeDeps([exemplar("a"), exemplar("b")], ["i"]);
    await expect(buildRegisterProfile(deps, OPTS)).rejects.toBeInstanceOf(InsufficientCorpusError);
    expect(rec.written).toHaveLength(0);
    expect(rec.activated).toHaveLength(0);
  });

  test("centroid is null when no exemplar has a style embedding", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => exemplar(`m${i}`, null));
    const { deps, rec } = makeDeps(rows, ["i"]);
    await buildRegisterProfile(deps, OPTS);
    expect(rec.written[0]?.style_centroid).toBeNull();
  });

  test("profile-grade readiness at the richer-corpus threshold", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => exemplar(`m${i}`));
    const { deps } = makeDeps(rows, ["i"]);
    expect((await buildRegisterProfile(deps, OPTS)).readiness).toBe("profile-grade");
  });
});

describe("createHybridImpostorSource", () => {
  test("unions bundled with other-author negatives", async () => {
    const src = createHybridImpostorSource({
      bundled: ["base1", "base2"],
      otherAuthors: async () => ["other1"],
    });
    expect(await src.collect("operator", "email")).toEqual(["base1", "base2", "other1"]);
  });

  test("works with bundled only (no other authors yet)", async () => {
    const src = createHybridImpostorSource({ bundled: ["base1"] });
    expect(await src.collect("operator", "email")).toEqual(["base1"]);
  });

  test("defaults to the shipped baseline when bundled is omitted", async () => {
    const src = createHybridImpostorSource({});
    const out = await src.collect("operator", "email");
    expect(out.length).toBeGreaterThanOrEqual(5); // BUNDLED_NEGATIVES baseline
  });
});

describe("meanVector", () => {
  test("averages element-wise", () => {
    expect(
      meanVector([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([2, 3]);
  });
  test("null on empty", () => {
    expect(meanVector([])).toBeNull();
  });
});
