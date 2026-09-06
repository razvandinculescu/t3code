// @effect-diagnostics nodeBuiltinImport:off - create isolated native-format SQLite fixtures.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  decodeAntigravityContextUsage,
  readAntigravityContextUsage,
} from "./AntigravityContextUsage.ts";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";

const varint = (value: number): number[] => {
  const bytes = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const message = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const metadata = (input: number, cached = 0, output = 0) =>
  new Uint8Array([
    ...message(9, [
      ...number(2, input),
      ...number(5, cached),
      ...number(3, output),
      ...number(9, 10),
    ]),
    ...message(24, number(4, 1_000_000)),
  ]);

it("decodes the latest prompt including cached input without counting thinking output twice", () => {
  expect(decodeAntigravityContextUsage(metadata(100, 200, 30))).toEqual({
    usedTokens: 330,
    inputTokens: 100,
    cachedInputTokens: 200,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    maxTokens: 1_000_000,
  });
});
it("does not invent usage for tool steps or a maximum absent from native metadata", () => {
  expect(decodeAntigravityContextUsage(new Uint8Array(number(3, 1)))).toBeUndefined();
  expect(decodeAntigravityContextUsage(new Uint8Array(message(9, number(2, 42))))).toMatchObject({
    usedTokens: 42,
  });
  expect(
    decodeAntigravityContextUsage(new Uint8Array(message(9, number(2, 42)))),
  ).not.toHaveProperty("maxTokens");
});
it("rejects truncated and invalid wire data, and ignores unknown fields", () => {
  for (const bytes of [[0], [74, 100], [128], [15]])
    expect(() => decodeAntigravityContextUsage(new Uint8Array(bytes))).toThrow();
  expect(
    decodeAntigravityContextUsage(new Uint8Array([...metadata(20), ...number(999, 3)]))?.usedTokens,
  ).toBe(20);
});
it("preserves ACP context updates including a decrease after compaction", () => {
  for (const used of [900_000, 20_000, 0])
    expect(
      parseSessionUpdateEvent({
        sessionId: "session",
        update: { sessionUpdate: "usage_update", used, size: 1_000_000 },
      }).events,
    ).toEqual([{ _tag: "ContextUsageUpdated", usedTokens: used, maxTokens: 1_000_000 }]);
});
it.effect(
  "reads only the newest model step in this session and never creates a missing database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const id = "ecaa8718-be01-4dc0-a4f9-edb1eed939a8";
      const folder = `${dir}/antigravity-acp/conversations`;
      yield* fs.makeDirectory(folder, { recursive: true });
      expect(yield* readAntigravityContextUsage(dir, id)).toBeUndefined();
      expect(yield* fs.readDirectory(folder)).toEqual([]);
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(`${folder}/${id}.db`);
        try {
          db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
          const insert = db.prepare("INSERT INTO steps VALUES (?, ?)");
          insert.run(0, metadata(900_000));
          insert.run(1, metadata(10_000, 100, 20));
          insert.run(2, new Uint8Array(number(3, 1)));
        } finally {
          db.close();
        }
      });
      expect((yield* readAntigravityContextUsage(dir, id))?.usedTokens).toBe(10_120);
      expect(yield* readAntigravityContextUsage(dir, "../other")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
