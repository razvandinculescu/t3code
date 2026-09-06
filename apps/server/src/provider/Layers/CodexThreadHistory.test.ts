import { assert, describe, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { readCodexThreadHistory } from "./CodexThreadHistory.ts";

const reasoning = {
  type: "reasoning" as const,
  id: "r1",
  summary: ["Checking"],
  content: ["Details"],
};
const answer = { type: "agentMessage" as const, id: "a1", text: "Done" };
const noLegacyRead = () => Effect.die("unexpected legacy history read");

describe("Codex paginated history", () => {
  it.effect("loads every page in chronological order with full reasoning and message items", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const snapshot = yield* readCodexThreadHistory(
        {
          request: noLegacyRead,
          raw: {
            request: (method, params) => {
              assert.equal(method, "thread/turns/list");
              calls.push(params);
              return Effect.succeed(
                calls.length === 1
                  ? {
                      data: [{ id: "turn-1", items: [reasoning], itemsView: "full" }],
                      nextCursor: "next",
                    }
                  : {
                      data: [{ id: "turn-2", items: [answer], itemsView: "full" }],
                      nextCursor: null,
                    },
              );
            },
          },
        },
        "thread-1",
      );
      assert.deepEqual(calls, [
        { threadId: "thread-1", limit: 50, sortDirection: "asc", itemsView: "full" },
        {
          threadId: "thread-1",
          limit: 50,
          sortDirection: "asc",
          itemsView: "full",
          cursor: "next",
        },
      ]);
      assert.deepEqual(snapshot, {
        threadId: "thread-1",
        turns: [
          { id: TurnId.make("turn-1"), items: [reasoning] },
          { id: TurnId.make("turn-2"), items: [answer] },
        ],
      });
    }),
  );

  it.effect("uses legacy history only when the CLI does not support turn pagination", () =>
    Effect.gen(function* () {
      let legacyReads = 0;
      const snapshot = yield* readCodexThreadHistory(
        {
          raw: {
            request: () =>
              Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code: -32601,
                  errorMessage: "Method not found",
                }),
              ),
          },
          request: (method, params) => {
            legacyReads++;
            assert.equal(method, "thread/read");
            assert.deepEqual(params, { threadId: "old-thread", includeTurns: true });
            return Effect.succeed({
              thread: {
                id: "old-thread",
                sessionId: "old-thread",
                turns: [],
                cliVersion: "test",
                cwd: "/tmp",
                createdAt: 0,
                updatedAt: 0,
                ephemeral: false,
                modelProvider: "openai",
                preview: "",
                source: "cli",
                status: { type: "idle" },
              },
            } satisfies CodexSchema.V2ThreadReadResponse);
          },
        },
        "old-thread",
      );
      assert.equal(legacyReads, 1);
      assert.deepEqual(snapshot, { threadId: "old-thread", turns: [] });
    }),
  );

  it.effect("propagates server errors instead of returning an empty or partial history", () =>
    Effect.gen(function* () {
      const failure = new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "storage unavailable",
      });
      const error = yield* readCodexThreadHistory(
        { request: noLegacyRead, raw: { request: () => Effect.fail(failure) } },
        "thread-1",
      ).pipe(Effect.flip);
      assert.strictEqual(error, failure);
    }),
  );

  it.effect("rejects summarized items instead of silently losing history", () =>
    Effect.gen(function* () {
      const error = yield* readCodexThreadHistory(
        {
          request: noLegacyRead,
          raw: {
            request: () =>
              Effect.succeed({
                data: [{ id: "turn-1", items: [], itemsView: "summary" }],
                nextCursor: null,
              }),
          },
        },
        "thread-1",
      ).pipe(Effect.flip);
      assert.instanceOf(error, CodexErrors.CodexAppServerProtocolParseError);
    }),
  );

  it.effect("stops a repeated cursor instead of looping or returning duplicate turns", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* readCodexThreadHistory(
        {
          request: noLegacyRead,
          raw: {
            request: () => {
              calls++;
              return Effect.succeed({ data: [], nextCursor: "same" });
            },
          },
        },
        "thread-1",
      ).pipe(Effect.flip);
      assert.equal(calls, 2);
      assert.instanceOf(error, CodexErrors.CodexAppServerRequestError);
    }),
  );
});
