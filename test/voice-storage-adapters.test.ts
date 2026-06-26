import { describe, expect, test } from "bun:test";

import type { Exemplar, ExemplarStore, RetrieveOptions } from "../src/exemplar-store.ts";
import type { Profile, ProfileStore } from "../src/profile-store.ts";
import {
  createStorageExemplarSource,
  createStorageProfileSource,
} from "../src/voice/storage-adapters.ts";

const VALID_STYLE_CARD = {
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
  prose: { voice_summary: "vs", habits: ["h"], do_more_of: ["d"] },
};

function exemplar(text: string): Exemplar {
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
    style_embedding: null,
    ingest_version: "1",
    profile_version: null,
  };
}

function fakeExemplarStore(): { store: ExemplarStore; calls: RetrieveOptions[] } {
  const calls: RetrieveOptions[] = [];
  const store: ExemplarStore = {
    async retrieve(options) {
      calls.push(options);
      return [exemplar("one"), exemplar("two")];
    },
    upsert: () => Promise.reject(new Error("unused")),
    getById: () => Promise.reject(new Error("unused")),
    getByIds: () => Promise.reject(new Error("unused")),
  };
  return { store, calls };
}

function fakeProfileStore(active: Profile | null): ProfileStore {
  return {
    async getActiveProfile() {
      return active;
    },
    writeProfile: () => Promise.reject(new Error("unused")),
    activateProfile: () => Promise.reject(new Error("unused")),
    getProfile: () => Promise.reject(new Error("unused")),
    listVersions: () => Promise.reject(new Error("unused")),
  };
}

function profileWith(style_card: unknown, exemplar_count: number): Profile {
  return {
    author_id: "operator",
    register: "email",
    version: "v3",
    style_card,
    stylometric_vector: {},
    style_centroid: null,
    built_at: "2026-01-01T00:00:00Z",
    exemplar_count,
    is_active: true,
  };
}

describe("storage exemplar source", () => {
  test("styleExemplars retrieves register-scoped (no query seed) and returns text", async () => {
    const { store, calls } = fakeExemplarStore();
    const src = createStorageExemplarSource(store);
    const out = await src.styleExemplars("operator", "email", 3);
    expect(out).toEqual(["one", "two"]);
    expect(calls[0]).toEqual({ author_id: "operator", register: "email", k: 3 });
  });

  test("groundingExemplars passes the query on the content axis", async () => {
    const { store, calls } = fakeExemplarStore();
    const src = createStorageExemplarSource(store);
    await src.groundingExemplars("operator", "email", "release date", 2);
    expect(calls[0]).toEqual({
      author_id: "operator",
      register: "email",
      queryText: "release date",
      k: 2,
    });
  });
});

describe("storage profile source", () => {
  test("returns null when there is no active profile", async () => {
    const src = createStorageProfileSource(fakeProfileStore(null));
    expect(await src.getActiveProfile("operator", "email")).toBeNull();
  });

  test("maps a valid profile and derives readiness from exemplar count", async () => {
    const lean = createStorageProfileSource(fakeProfileStore(profileWith(VALID_STYLE_CARD, 10)));
    const r = await lean.getActiveProfile("operator", "email");
    expect(r?.version).toBe("v3");
    expect(r?.style_card.prose.voice_summary).toBe("vs");
    expect(r?.readiness).toBe("generation-ready");

    const rich = createStorageProfileSource(fakeProfileStore(profileWith(VALID_STYLE_CARD, 80)));
    expect((await rich.getActiveProfile("operator", "email"))?.readiness).toBe("profile-grade");
  });

  test("throws when the stored style_card is malformed (seam validation)", async () => {
    const bad = createStorageProfileSource(fakeProfileStore(profileWith({ prose: {} }, 10)));
    await expect(bad.getActiveProfile("operator", "email")).rejects.toThrow();
  });
});
