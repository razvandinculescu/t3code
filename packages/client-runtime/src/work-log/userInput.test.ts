import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { foldUserInputActivities } from "./userInput.ts";

describe("foldUserInputActivities", () => {
  it.each(["pending", "answered"] as const)(
    "folds %s questions without Array.toSorted on Hermes",
    (state) => {
      const turnId = TurnId.make("turn-1");
      const activities: OrchestrationThreadActivity[] = [
        {
          id: EventId.make("question-tool"),
          turnId,
          createdAt: "2026-09-11T07:00:00Z",
          kind: "tool.completed",
          tone: "tool",
          summary: "Ask questions",
          payload: {
            toolCallId: "tool-1",
            title: "request_user_input",
            data: {
              toolName: "request_user_input",
              input: {
                questions: [
                  { id: "b", question: "Second question?" },
                  { id: "a", question: "First question?" },
                ],
              },
            },
          },
        },
        {
          id: EventId.make("answer"),
          turnId,
          createdAt: "2026-09-11T07:00:01Z",
          kind: state === "pending" ? "user-input.requested" : "user-input.answer-submitted",
          tone: "tool",
          summary: "User input submitted",
          payload: {
            requestId: "request-1",
            questionTextById: { a: "First question?", b: "Second question?" },
            answers: state === "pending" ? {} : { a: "First answer", b: "Second answer" },
            attachmentsByQuestionId: {},
          },
        },
      ];
      const original = structuredClone(activities);
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
      let folded: ReadonlyArray<OrchestrationThreadActivity>;
      try {
        // oxlint-disable-next-line no-extend-native -- Reproduce the shipped Hermes runtime.
        Object.defineProperty(Array.prototype, "toSorted", {
          configurable: true,
          value: undefined,
        });
        folded = foldUserInputActivities(activities);
      } finally {
        // oxlint-disable-next-line no-extend-native -- Restore the test worker's original runtime.
        if (descriptor) Object.defineProperty(Array.prototype, "toSorted", descriptor);
        else Reflect.deleteProperty(Array.prototype, "toSorted");
      }
      expect(folded).toHaveLength(1);
      expect(folded[0]).toMatchObject({
        id: "answer",
        payload: { answers: state === "pending" ? {} : { a: "First answer", b: "Second answer" } },
      });
      expect(activities).toEqual(original);
    },
  );
});
