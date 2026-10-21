import { MessageId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";

import { describe, expect, it } from "vite-plus/test";
import { splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("shows sentence-only thinking in paced batches without buffering the entire trace", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    const first = "Checking the merge and its provider contracts.";
    expect(filter(turnItem(first, true, "reasoning"), 0)).toMatchObject({
      turnItem: { text: first },
    });
    const next = first + "x".repeat(100);
    expect(filter(turnItem(next, true, "reasoning"), 399)).toBeNull();
    expect(filter(turnItem(next, true, "reasoning"), 400)).toMatchObject({
      turnItem: { text: next },
    });
    expect(filter(turnItem(next + " short", true, "reasoning"), 800)).toBeNull();
    const final = turnItem(next + " short", false, "reasoning");
    expect(filter(final, 801)).toBe(final);
    expect(makeAssistantStreamingFilter("paragraph")(turnItem(first), 0)).toBeNull();
  });

  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});
