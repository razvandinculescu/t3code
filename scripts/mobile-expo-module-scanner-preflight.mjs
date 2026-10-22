import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mobileRoot = NodeURL.fileURLToPath(new URL("../apps/mobile/", import.meta.url));
const mobileRequire = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const expoRequire = NodeModule.createRequire(mobileRequire.resolve("expo/package.json"));
const autolinkingRoot = NodePath.dirname(
  expoRequire.resolve("expo-modules-autolinking/package.json"),
);
const { collectPackageRoots, loadModulesScanner, scanExpoModulesAsync } = expoRequire(
  NodePath.join(autolinkingRoot, "build/platforms/apple/moduleScanner.js"),
);
const searchResults = JSON.parse(
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(autolinkingRoot, "bin/expo-modules-autolinking.js"),
      "search",
      "--platform",
      "apple",
      "--json",
    ],
    { cwd: mobileRoot, encoding: "utf8" },
  ),
);
const scanner = loadModulesScanner(
  NodePath.dirname(expoRequire.resolve("expo-modules-core/package.json")),
);
if (!scanner) throw new Error("Expo native module scanner is unavailable");
const result = await scanExpoModulesAsync(scanner, collectPackageRoots(searchResults));
if (!result) throw new Error("Expo native module discovery did not complete");
for (const name of ["ApplicationModule", "HapticsModule", "SQLiteModule"]) {
  if (!result.modules.some((module) => module.name === name)) {
    throw new Error(`Required native module was not discovered: ${name}`);
  }
}
console.log(JSON.stringify({ nativeModules: result.modules.length, ...result.stats }));
