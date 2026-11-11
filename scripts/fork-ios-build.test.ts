// @effect-diagnostics nodeBuiltinImport:off - exercises release validation against isolated filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Plist from "plist";
import { it, expect } from "vite-plus/test";
import { verifyForkIosApp } from "./fork-ios-build.ts";

it.each([
  "main.jsbundle",
  "ExpoWidgets.bundle/ExpoWidgets.bundle",
  "ExpoWidgets.bundle/ExpoWidgetsLayoutRegistry.json",
])("rejects a cached %s that was not rebuilt", (stale) => {
  const app = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ios-release-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(app, "Info.plist"),
      Plist.build({
        CFBundleIdentifier: "ro.razvandinculescu.t3code",
        CFBundleVersion: "2026111201",
        CFBundleShortVersionString: "2.3.0",
      }),
    );
    for (const file of [
      "main.jsbundle",
      "ExpoWidgets.bundle/ExpoWidgets.bundle",
      "ExpoWidgets.bundle/ExpoWidgetsLayoutRegistry.json",
    ]) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(app, file)), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(app, file),
        Buffer.from("c61fbc03c103191f0000000000000000", "hex"),
      );
      NodeFS.utimesSync(NodePath.join(app, file), 300, 300);
    }
    expect(verifyForkIosApp(app, "2026111201", 200_000).buildNumber).toBe("2026111201");
    expect(() => verifyForkIosApp(app, "2026111201", Number.NaN)).toThrow("Invalid build start");
    NodeFS.utimesSync(NodePath.join(app, stale), 100, 100);
    expect(() => verifyForkIosApp(app, "2026111201", 200_000)).toThrow("was not rebuilt");
  } finally {
    NodeFS.rmSync(app, { recursive: true });
  }
});
