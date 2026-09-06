// @effect-diagnostics nodeBuiltinImport:off - read the native trajectory with a bounded read-only SQLite query.
import * as NodeSqlite from "node:sqlite";
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const isSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const MAX_METADATA_BYTES = 64 * 1024;

/** Read protobuf wire fields without decoding prompt text or loading Google's
 * runtime. Field numbers below come from the official ACP distribution's
 * CortexStepMetadata, ModelUsageStats and ModelInfo descriptors. Unknown fields
 * are skipped, and malformed/truncated messages fail the whole snapshot. */
function fields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  let offset = 0;
  const result = new Map<number, number | Uint8Array>();
  const varint = () => {
    let value = 0;
    let multiplier = 1;
    for (let count = 0; count < 10; count++) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated protobuf field");
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error("Unsafe protobuf integer");
      if (byte < 128) return value;
      multiplier *= 128;
    }
    throw new Error("Invalid protobuf integer");
  };
  while (offset < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    if (field === 0) throw new Error("Invalid protobuf field");
    const wire = key % 8;
    if (wire === 0) {
      result.set(field, varint());
      continue;
    }
    const size = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (size < 0 || size > bytes.length - offset) throw new Error("Invalid protobuf length");
    if (wire === 2) result.set(field, bytes.subarray(offset, offset + size));
    offset += size;
  }
  return result;
}

export function decodeAntigravityContextUsage(
  metadata: Uint8Array,
): ThreadTokenUsageSnapshot | undefined {
  if (metadata.length > MAX_METADATA_BYTES) return undefined;
  const step = fields(metadata);
  const usageBytes = step.get(9);
  if (!(usageBytes instanceof Uint8Array)) return undefined;
  const usage = fields(usageBytes);
  const input = usage.get(2);
  if (typeof input !== "number") return undefined;
  const number = (field: number) => {
    const value = usage.get(field);
    if (value === undefined) return 0;
    if (typeof value !== "number") throw new Error("Invalid token count");
    return value;
  };
  const cached = number(5) + number(4);
  const output = number(3);
  const usedTokens = input + cached + output;
  if (!Number.isSafeInteger(usedTokens)) return undefined;
  const modelBytes = step.get(24);
  const maxTokens = modelBytes instanceof Uint8Array ? fields(modelBytes).get(4) : undefined;
  return {
    usedTokens,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: number(9),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
  };
}

/** The newest model step describes current context, unlike cumulative session
 * billing. Read only this session, never create a database or scan trajectories. */
export const readAntigravityContextUsage = Effect.fn("readAntigravityContextUsage")(function* (
  profileDirectory: string,
  sessionId: string,
) {
  if (!isSessionId(sessionId)) return undefined;
  const path = yield* Path.Path;
  const filename = path.join(
    profileDirectory,
    "antigravity-acp",
    "conversations",
    `${sessionId}.db`,
  );
  return yield* Effect.try(() => {
    const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true, allowExtension: false });
    try {
      const rows = db
        .prepare(
          "SELECT CASE WHEN length(metadata) <= 65536 THEN metadata END AS metadata FROM steps ORDER BY idx DESC LIMIT 32",
        )
        .iterate();
      for (const row of rows) {
        if (!(row.metadata instanceof Uint8Array)) continue;
        const usage = decodeAntigravityContextUsage(row.metadata);
        if (usage) return usage;
      }
      return undefined;
    } finally {
      db.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));
});
