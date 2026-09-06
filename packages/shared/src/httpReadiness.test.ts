import * as Data from "effect/Data";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { waitForHttpReady } from "./httpReadiness.ts";

class ReadinessError extends Data.TaggedError("ReadinessError")<{ readonly cause: unknown }> {}

function recordSpans(spans: Array<{ name: string; failed: boolean }>) {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        spans.push({ name: options.name, failed: Exit.isFailure(exit) });
        end(time, exit);
      };
      return span;
    },
  });
}

it.effect("traces recovered startup as successful without failed HTTP attempts", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    let attempts = 0;
    const spans: Array<{ name: string; failed: boolean }> = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        attempts++;
        if (attempts === 1) {
          yield* Deferred.succeed(attempted, undefined);
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("ECONNREFUSED"),
            }),
          });
        }
        return HttpClientResponse.fromWeb(request, new Response("ready"));
      }),
    );
    const fiber = yield* waitForHttpReady({
      baseUrl: "http://127.0.0.1:3773",
      intervalMs: 100,
      timeoutMs: 1000,
      makeError: ({ cause }) => new ReadinessError({ cause }),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.withTracer(recordSpans(spans)),
      Effect.forkChild,
    );
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(fiber);
    expect(attempts).toBe(2);
    expect(spans.filter((span) => span.failed)).toEqual([]);
    expect(spans.some((span) => span.name === "shared.httpReadiness.waitForHttpReady")).toBe(true);
  }),
);

it.effect(
  "retains a failed readiness span and diagnostics when the backend never becomes ready",
  () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const spans: Array<{ name: string; failed: boolean }> = [];
      const client = HttpClient.make(() =>
        Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* waitForHttpReady({
        baseUrl: "http://127.0.0.1:3773",
        timeoutMs: 50,
        makeError: ({ cause }) => new ReadinessError({ cause }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.withTracer(recordSpans(spans)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("50 millis");
      const error = yield* Fiber.join(fiber);
      expect(error.cause).toMatchObject({ kind: "overall-timeout", timeoutMs: 50 });
      expect(spans).toContainEqual({ name: "shared.httpReadiness.waitForHttpReady", failed: true });
    }),
);
