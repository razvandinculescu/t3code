import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

it("keeps native modules when Swift discovery takes longer than five seconds", async () => {
  const mobileRequire = NodeModule.createRequire(
    new URL("../apps/mobile/package.json", import.meta.url),
  );
  const expoRequire = NodeModule.createRequire(mobileRequire.resolve("expo/package.json"));
  const autolinkingRequire = NodeModule.createRequire(
    expoRequire.resolve("expo-modules-autolinking/package.json"),
  );
  const { scanExpoModulesAsync } = autolinkingRequire(
    "./build/platforms/apple/moduleScanner.js",
  ) as {
    scanExpoModulesAsync: (
      scanner: {
        scanModules: (paths: string[], options?: { timeout?: number }) => Promise<unknown>;
      },
      roots: Record<string, string>,
    ) => Promise<unknown>;
  };
  const discovered = {
    schemaVersion: 1,
    modules: [
      {
        name: "ApplicationModule",
        jsName: "ExpoApplication",
        accessLevel: "public",
        file: "/expo-application/ios/ApplicationModule.swift",
        platforms: ["iOS"],
      },
    ],
    warnings: [],
    stats: { filesScanned: 1, filesParsed: 1, durationMs: 10_000 },
  };
  using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await scanExpoModulesAsync(
    {
      scanModules: async (_paths, options) => {
        if ((options?.timeout ?? 0) < discovered.stats.durationMs) {
          throw new Error("Swift module discovery exceeded its deadline");
        }
        return discovered;
      },
    },
    { "expo-application": "/expo-application" },
  );

  expect(result).toEqual(discovered);
});
