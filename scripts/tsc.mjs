// Typecheck entry point for every package: `node <root>/scripts/tsc.mjs --noEmit`.
// On Linux it runs tsc-rs, the Rust port of TypeScript 7 (same options and diagnostics,
// about 2.7x faster here); elsewhere it runs TypeScript's tsc, since tsc-rs 0.2.0 ships no
// Windows binary. Arguments pass through unchanged.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher script has no Effect runtime.
const packageName = process.platform === "linux" ? "tsc-rs" : "typescript";
const manifestPath = require.resolve(`${packageName}/package.json`);
const { bin } = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
const launcher = NodePath.join(NodePath.dirname(manifestPath), Object.values(bin)[0]);

const result = NodeChildProcess.spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
