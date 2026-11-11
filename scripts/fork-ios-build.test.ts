// @effect-diagnostics nodeBuiltinImport:off - exercises release validation against isolated filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import Plist from "plist";
import { it, expect } from "vite-plus/test";
import { verifyForkIosApp, writeForkIosCompilers } from "./fork-ios-build.ts";

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "compiler launchers enforce cache settings without Xcode inheriting the caller environment",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ios compiler's "));
    try {
      const cacheBinary = NodePath.join(root, "cache executable");
      const compiler = NodePath.join(root, "compiler executable");
      NodeFS.writeFileSync(
        cacheBinary,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({kind:'cache',compiler:process.argv[2],args:process.argv.slice(3),directory:process.env.CCACHE_DIR,config:process.env.CCACHE_CONFIGPATH,base:process.env.CCACHE_BASEDIR,check:process.env.CCACHE_COMPILERCHECK}));\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        compiler,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({kind:'compiler'}));\n`,
        { mode: 0o755 },
      );
      const options = {
        directory: NodePath.join(root, "launchers"),
        cacheBinary,
        cacheDirectory: NodePath.join(root, "cache's directory"),
        configFile: NodePath.join(root, "cache config"),
        baseDirectory: root,
        clang: compiler,
        clangxx: compiler,
      };
      const launchers = writeForkIosCompilers(options);
      for (const file of [launchers.cc, launchers.cxx]) {
        const result = JSON.parse(
          NodeChildProcess.execFileSync(file, ["-c", "input with spaces.c"], {
            encoding: "utf8",
            env: { CCACHE_DIR: "unrelated directory" },
          }),
        );
        expect(result).toEqual({
          kind: "cache",
          compiler,
          args: ["-c", "input with spaces.c"],
          directory: options.cacheDirectory,
          config: options.configFile,
          base: root,
          check: "content",
        });
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true });
    }
  },
);

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
