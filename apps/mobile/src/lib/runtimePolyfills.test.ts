import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads project schemas and validates grapheme monograms without native Intl.Segmenter", async () => {
  const descriptors = Object.getOwnPropertyDescriptors(Intl);
  Reflect.deleteProperty(descriptors, "Segmenter");
  vi.stubGlobal("Intl", Object.create(Object.getPrototypeOf(Intl), descriptors));
  expect(Intl.Segmenter).toBeUndefined();

  await import("./runtimePolyfills.ts");
  const { ProjectMonogramText } = await import("@t3tools/contracts");
  const decode = Schema.decodeUnknownSync(ProjectMonogramText);

  for (const text of ["T3", "É", "文書", "कि", "किखि", "e\u0301", "한"]) {
    expect(decode(text)).toBe(text);
  }
  for (const text of ["ABC", "किखिगि", "A B", "🚀"]) {
    expect(() => decode(text)).toThrow();
  }
});

it("preserves a native Intl.Segmenter implementation", async () => {
  const segmenter = Intl.Segmenter;
  await import("./runtimePolyfills.ts");
  expect(Intl.Segmenter).toBe(segmenter);
});
