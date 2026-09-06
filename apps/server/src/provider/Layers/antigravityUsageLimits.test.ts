import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  AntigravityQuotaSummary,
  antigravityQuotaWindows,
  makeAntigravityUsageProbe,
} from "./antigravityUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSummary = Schema.decodeUnknownSync(AntigravityQuotaSummary);

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: 0.75,
          resetTime: "2026-09-06T16:12:15Z",
        },
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 1 }],
    },
  ],
};

describe("Antigravity quota mapping", () => {
  it("keeps shared groups and reset windows distinct, including exhausted and full quotas", () => {
    const windows = antigravityQuotaWindows(decodeSummary(summary));
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({
      id: "gemini-5h",
      kind: "session",
      label: "Gemini Models · Five Hour Limit Remaining",
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: "2026-09-06T16:12:15.000Z",
    });
    expect(windows[1]).toMatchObject({
      usedPercent: 100,
      kind: "weekly",
      windowDurationMins: 10080,
    });
    expect(windows[2]).toMatchObject({ usedPercent: 0, id: "3p-5h" });
  });
  it("supports older buckets and unknown windows without inventing durations or reset times", () => {
    expect(
      antigravityQuotaWindows({
        buckets: [
          { bucketId: "custom", window: "custom", remainingFraction: 0.5, resetTime: "invalid" },
        ],
      }),
    ).toEqual([{ id: "custom", kind: "other", label: "custom", usedPercent: 50 }]);
  });
  it("omits informational, disabled and missing-fraction buckets", () => {
    expect(
      antigravityQuotaWindows({
        buckets: [
          { bucketId: "missing" },
          { bucketId: "disabled", disabled: true, remainingFraction: 1 },
        ],
      }),
    ).toEqual([]);
    expect(antigravityQuotaWindows({ groups: [{ displayName: "Info" }] })).toEqual([]);
  });
  it("rejects malformed and out-of-range quota instead of showing a false balance", () => {
    for (const value of [-1, 2, "0.5", null]) {
      expect(() =>
        decodeSummary({ buckets: [{ bucketId: "bad", remainingFraction: value }] }),
      ).toThrow();
    }
  });
});

const credential = encodeJson({
  client_id: "test-client",
  client_secret: "test-secret",
  refresh_token: "test-refresh",
});
const harness = Effect.fn("quotaTestHarness")(function* (
  options: { status?: number; enterprise?: boolean; replace?: boolean; empty?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(`${directory}/antigravity-acp`);
  const file = `${directory}/antigravity-acp/acp_token.json`;
  yield* fs.writeFileString(file, credential);
  const urls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url);
      const body = request.url.endsWith("/token")
        ? { access_token: "test-access" }
        : request.url.endsWith(":loadCodeAssist")
          ? {
              cloudaicompanionProject: "test-project",
              paidTier: { usesGcpTos: options.enterprise ?? false },
            }
          : options.empty
            ? {}
            : summary;
      if (options.replace && request.url.endsWith(":retrieveUserQuotaSummary"))
        yield* fs.remove(file).pipe(Effect.orDie);
      return HttpClientResponse.fromWeb(
        request,
        new Response(encodeJson(body), { status: options.status ?? 200 }),
      );
    }),
  );
  const probe = yield* makeAntigravityUsageProbe(directory).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return { probe, file, fs, urls };
});

it.effect(
  "reads the scoped account, routes consumer quotas correctly, and never changes stored credentials",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.probe;
      expect(result?.windows).toHaveLength(3);
      expect(h.urls).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      ]);
      expect(yield* h.fs.readFileString(h.file)).toBe(credential);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("routes GCP terms accounts to production and discards a result after sign-out", () =>
  Effect.gen(function* () {
    const h = yield* harness({ enterprise: true, replace: true });
    expect(yield* h.probe).toBeUndefined();
    expect(h.urls[2]).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a sanitized failure for HTTP errors or absent quotas", () =>
  Effect.gen(function* () {
    for (const options of [{ status: 429 }, { empty: true }]) {
      const h = yield* harness(options);
      const result = yield* h.probe;
      expect(result?.unavailable?.reason).toBe("probeFailed");
      expect(encodeJson(result)).not.toContain("test-secret");
      expect(result?.windows).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not contact Google for a missing profile credential", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.fs.remove(h.file);
    expect(yield* h.probe).toBeUndefined();
    expect(h.urls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
