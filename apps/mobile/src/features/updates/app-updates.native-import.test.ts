import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { transformSync, types, type PluginObj } from "@babel/core";
import { expect, it, vi } from "vite-plus/test";
import * as runtime from "@t3tools/client-runtime/state/runtime";
import type { AppUpdateClient } from "./app-updates";

it("checks updates on foreground without evaluating optional native exports", async () => {
  const listeners = new Set<(state: string) => void>();
  const unavailableNativeModule = vi.fn(() => {
    throw new Error("NativeEventEmitter received the unlinked PushNotificationIOS module");
  });
  const native = {
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    },
    get PushNotificationIOS() {
      return unavailableNativeModule();
    },
  };
  const require = NodeModule.createRequire(import.meta.url);
  const babel = NodeModule.createRequire(require.resolve("babel-preset-expo"));
  const source = NodeFS.readFileSync(new URL("./app-updates.ts", import.meta.url), "utf8");
  const compiled = transformSync(source, {
    filename: "app-updates.ts",
    babelrc: false,
    configFile: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          CallExpression(path) {
            if (path.node.callee.type === "Import")
              path.node.callee = types.identifier("importModule");
          },
        },
      }),
      babel.resolve("@babel/plugin-transform-typescript"),
      babel.resolve("@babel/plugin-transform-modules-commonjs"),
    ],
  })!.code!;
  const exports = {} as Pick<typeof import("./app-updates"), "createAppUpdateForegroundRecheck">;
  const importFailures: unknown[] = [];
  const load = (name: string) => {
    if (name === "react-native") return native;
    if (name === "expo-updates") return { isEnabled: false };
    if (name === "@t3tools/client-runtime/state/runtime") return runtime;
    throw new Error(`Unexpected module: ${name}`);
  };
  NodeVM.runInNewContext(compiled, {
    exports,
    require: load,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    importModule: async (name: string) => {
      // Metro's importAll reads each enumerable export, including RN's lazy native getters.
      try {
        return Object.fromEntries(Object.entries(load(name)));
      } catch (error) {
        importFailures.push(error);
        return native;
      }
    },
  });
  const client: AppUpdateClient = {
    isEnabled: true,
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: false })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: false, isRollBackToEmbedded: false })),
    reloadAsync: vi.fn(async () => {}),
  };
  exports.createAppUpdateForegroundRecheck(client)();
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  expect(importFailures).toEqual([]);
  expect(unavailableNativeModule).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    for (const listener of listeners) listener("background");
    clock.mockReturnValue(1_001 + 15 * 60 * 1_000);
    for (const listener of listeners) listener("active");
    await vi.waitFor(() => expect(client.checkForUpdateAsync).toHaveBeenCalledOnce());
  } finally {
    clock.mockRestore();
  }
});
