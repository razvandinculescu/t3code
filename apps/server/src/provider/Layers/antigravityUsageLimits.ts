import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";

const Bucket = Schema.Struct({
  bucketId: Schema.String,
  displayName: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remainingFraction: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  resetTime: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
// The official ACP distribution carries these CCPA discovery schemas. New
// responses group shared model quotas; older responses use top-level buckets.
export const AntigravityQuotaSummary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.String,
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});

export function antigravityQuotaWindows(summary: typeof AntigravityQuotaSummary.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups ?? [{ displayName: "", buckets: summary.buckets ?? [] }];
  for (const group of groups) {
    for (const bucket of group.buckets ?? []) {
      // Missing fractions are not evidence of either full or exhausted quota.
      if (bucket.disabled || bucket.remainingFraction === undefined || !bucket.bucketId.trim())
        continue;
      const duration =
        bucket.window === "5h" ? 300 : bucket.window === "weekly" ? 10080 : undefined;
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      windows.set(bucket.bucketId, {
        id: bucket.bucketId,
        kind: bucket.window === "5h" ? "session" : bucket.window === "weekly" ? "weekly" : "other",
        label: [group.displayName, bucket.displayName || bucket.window || bucket.bucketId]
          .filter(Boolean)
          .join(" · "),
        usedPercent: (1 - bucket.remainingFraction) * 100,
        ...(duration === undefined ? {} : { windowDurationMins: duration }),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
  }
  return [...windows.values()];
}

const Credential = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});
const decodeCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(Credential));
const Token = Schema.Struct({ access_token: Schema.NonEmptyString });
const Account = Schema.Struct({
  cloudaicompanionProject: Schema.NonEmptyString,
  paidTier: Schema.optional(Schema.Struct({ usesGcpTos: Schema.optional(Schema.Boolean) })),
});
const PRODUCTION = "https://cloudcode-pa.googleapis.com";
const CONSUMER = "https://daily-cloudcode-pa.googleapis.com";

/** Read the same isolated file-backed personal profile as ACP. Never persist or
 * log tokens, refresh credentials, raw HTTP failures, or account responses. */
export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (
  profileDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "acp_token.json");
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(tokenPath))) return undefined;
      const raw = yield* fs.readFileString(tokenPath);
      const credential = yield* decodeCredential(raw);
      const token = yield* HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
        HttpClientRequest.bodyUrlParams({ ...credential, grant_type: "refresh_token" }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
      );
      const post = (url: string, body: object) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(token.access_token),
          HttpClientRequest.setHeader(
            "User-Agent",
            "antigravity/acp/unknown (aidev_client; host_path=t3-code/unknown; proxy_client=antigravity/sdk)",
          ),
          HttpClientRequest.bodyJson(body),
          Effect.flatMap(http.execute),
        );
      // Match ACP's endpoint selection, without invoking onboardUser or
      // accepting terms on behalf of an account which is not onboarded.
      const account = yield* post(`${PRODUCTION}/v1internal:loadCodeAssist`, {
        metadata: { ideType: "ANTIGRAVITY" },
      }).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Account)));
      const endpoint = account.paidTier?.usesGcpTos ? PRODUCTION : CONSUMER;
      const summary = yield* post(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        project: account.cloudaicompanionProject,
      }).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AntigravityQuotaSummary)));
      // A sign-out or account replacement must invalidate an in-flight read.
      if ((yield* fs.readFileString(tokenPath).pipe(Effect.orElseSucceed(() => ""))) !== raw)
        return undefined;
      const windows = antigravityQuotaWindows(summary);
      return windows.length > 0
        ? makeUsageLimits({ checkedAt, windows })
        : makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Google did not report subscription limits.",
          });
    });
    return yield* read.pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read Antigravity subscription limits.",
        }),
      ),
    );
  });
});
