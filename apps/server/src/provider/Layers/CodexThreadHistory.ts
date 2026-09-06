import { TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexAppServerClient } from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexThreadSnapshot } from "./CodexSessionRuntime.ts";

// Pagination is experimental and is not in our generated protocol snapshot yet.
// Request full items so imports and checkpoint rollback retain reasoning and tools.
const TurnsPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      items: Schema.Array(CodexSchema.V2ThreadReadResponse__ThreadItem),
      itemsView: Schema.optionalKey(Schema.Literal("full")),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
const decodeTurnsPage = Schema.decodeUnknownEffect(TurnsPage);
const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

export const readCodexThreadHistory = Effect.fn("CodexThreadHistory.read")(function* (
  client: {
    readonly raw: Pick<CodexAppServerClient["Service"]["raw"], "request">;
    readonly request: (
      method: "thread/read",
      params: CodexSchema.V2ThreadReadParams,
    ) => Effect.Effect<CodexSchema.V2ThreadReadResponse, CodexErrors.CodexAppServerError>;
  },
  threadId: string,
): Effect.fn.Return<CodexThreadSnapshot, CodexErrors.CodexAppServerError> {
  const turns: Array<CodexThreadSnapshot["turns"][number]> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* client.raw
      .request("thread/turns/list", {
        threadId,
        limit: 50,
        sortDirection: "asc",
        itemsView: "full",
        ...(cursor !== undefined ? { cursor } : {}),
      })
      .pipe(
        Effect.flatMap((response) =>
          decodeTurnsPage(response).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                "decode-response-payload",
                error,
                { method: "thread/turns/list" },
              ),
            ),
          ),
        ),
        // Older CLIs do not expose this method. Other failures must remain visible.
        Effect.catchIf(
          (error) => cursor === undefined && isRequestError(error) && error.code === -32601,
          () => Effect.succeed(null),
        ),
      );
    if (page === null) {
      const response = yield* client.request("thread/read", { threadId, includeTurns: true });
      return {
        threadId: response.thread.id,
        turns: response.thread.turns.map((turn) => ({
          id: TurnId.make(turn.id),
          items: turn.items,
        })),
      };
    }
    turns.push(...page.data.map((turn) => ({ id: TurnId.make(turn.id), items: turn.items })));
    if (page.nextCursor === null) break;
    if (cursors.has(page.nextCursor)) {
      return yield* new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "Codex thread history returned a repeated pagination cursor.",
        method: "thread/turns/list",
      });
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  return { threadId, turns };
});
