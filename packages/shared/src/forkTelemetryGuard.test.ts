// @effect-diagnostics nodeBuiltinImport:off - scans the real source tree on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

// Fork (Razvan, 28.11.2026): telemetry stays off. A new analytics/tracing endpoint from an upstream
// merge fails here until someone checks it is off by default and lists it below with the reason.
const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

const TELEMETRY_ENDPOINT =
  /ingest\.t3\.codes|[a-z0-9.-]*posthog\.com|phc_[A-Za-z0-9]{20,}|api\.axiom\.co|[a-z0-9.-]*sentry\.io|api\.segment\.io|mixpanel\.com|amplitude\.com|datadoghq\.(?:com|eu)|bugsnag\.com|honeycomb\.io|clerk-telemetry\.com/gi;

const KNOWN: Readonly<Record<string, string>> = {
  "apps/server/src/telemetry/AnalyticsService.ts|ingest.t3.codes":
    "product analytics; fork default off, see AnalyticsService.test 'fork: sends nothing'",
  "apps/server/src/telemetry/AnalyticsService.ts|phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m":
    "ingest key for the same analytics; unused while telemetry is off",
  "apps/mobile/app.config.ts|api.axiom.co":
    "relay traces; need a build-time dataset and token the fork never sets, and default off",
  "apps/mobile/src/features/pull-requests/botBadgeImages.ts|api.segment.io":
    "badge image URL prefix used to recognize bot badges in PRs, not telemetry",
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "fixtures", "testkit"]);

const sourceFiles = (directory: string): ReadonlyArray<string> => {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    const isTest = /\.test\.[cm]?[jt]sx?$/.test(entry.name);
    return SOURCE_EXTENSIONS.has(NodePath.extname(entry.name)) && !isTest ? [path] : [];
  });
};

const scannedFiles = (): ReadonlyArray<string> => {
  const apps = NodeFS.readdirSync(NodePath.join(repoRoot, "apps")).filter(
    (name) => name !== "marketing",
  );
  const packages = NodeFS.readdirSync(NodePath.join(repoRoot, "packages"));
  return [
    ...apps.flatMap((name) => [
      ...sourceFiles(NodePath.join(repoRoot, "apps", name, "src")),
      ...sourceFiles(NodePath.join(repoRoot, "apps", name, "scripts")),
    ]),
    ...packages.flatMap((name) => sourceFiles(NodePath.join(repoRoot, "packages", name, "src"))),
    NodePath.join(repoRoot, "apps/mobile/app.config.ts"),
  ];
};

describe("fork telemetry guard", () => {
  it("finds every telemetry endpoint in shipped source and only the reviewed ones", () => {
    const files = scannedFiles();
    assert.isAbove(files.length, 1000, "the scan should cover the apps and packages sources");
    const found = new Set<string>();
    for (const file of files) {
      const text = NodeFS.readFileSync(file, "utf8");
      for (const match of text.matchAll(TELEMETRY_ENDPOINT)) {
        found.add(`${NodePath.relative(repoRoot, file).split(NodePath.sep).join("/")}|${match[0]}`);
      }
    }
    const unreviewed = [...found].filter((key) => KNOWN[key] === undefined).toSorted();
    assert.deepEqual(
      unreviewed,
      [],
      "new telemetry endpoint: make sure it is off by default in the fork, then add it to KNOWN",
    );
    assert.deepEqual([...found].toSorted(), Object.keys(KNOWN).toSorted());
  });
});
