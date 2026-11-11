// @effect-diagnostics nodeBuiltinImport:off - validates Xcode's on-disk release output before CI publishes it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import Plist from "plist";
import * as Schema from "effect/Schema";

const decodeAppInfo = Schema.decodeUnknownSync(
  Schema.Struct({
    CFBundleIdentifier: Schema.String,
    CFBundleVersion: Schema.String,
    CFBundleShortVersionString: Schema.String,
  }),
);

const javascriptOutputs = [
  "main.jsbundle",
  "ExpoWidgets.bundle/ExpoWidgets.bundle",
  "ExpoWidgets.bundle/ExpoWidgetsLayoutRegistry.json",
];

export function writeForkIosCompilers(options: {
  directory: string;
  cacheBinary: string;
  cacheDirectory: string;
  configFile: string;
  baseDirectory: string;
  clang: string;
  clangxx: string;
}) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  NodeFS.mkdirSync(options.directory, { recursive: true });
  const write = (name: string, compiler: string) => {
    const file = NodePath.join(options.directory, name);
    NodeFS.writeFileSync(
      file,
      [
        "#!/bin/sh",
        `export CCACHE_DIR=${quote(options.cacheDirectory)}`,
        `export CCACHE_CONFIGPATH=${quote(options.configFile)}`,
        `export CCACHE_BASEDIR=${quote(options.baseDirectory)}`,
        "export CCACHE_COMPILERCHECK=content",
        "export CCACHE_MAXSIZE=2G",
        `exec ${quote(options.cacheBinary)} ${quote(compiler)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return file;
  };
  return {
    cc: write("ccache-clang", options.clang),
    cxx: write("ccache-clang++", options.clangxx),
  };
}

export function verifyForkIosApp(app: string, buildNumber: string, buildStartedAt: number) {
  if (!Number.isFinite(buildStartedAt) || buildStartedAt <= 0)
    throw new Error("Invalid build start timestamp");
  const file = NodePath.join(app, "Info.plist");
  const raw = NodeFS.readFileSync(file);
  const xml =
    raw.subarray(0, 8).toString() === "bplist00"
      ? NodeChildProcess.execFileSync("plutil", ["-convert", "xml1", "-o", "-", file], {
          encoding: "utf8",
        })
      : raw.toString();
  const info = decodeAppInfo(Plist.parse(xml));
  if (info.CFBundleIdentifier !== "ro.razvandinculescu.t3code")
    throw new Error("Unexpected iOS bundle identifier");
  if (info.CFBundleVersion !== buildNumber) throw new Error("Unexpected iOS build number");
  const outputs = Object.fromEntries(
    javascriptOutputs.map((name) => {
      const target = NodePath.join(app, name);
      const bytes = NodeFS.readFileSync(target);
      if (bytes.length === 0) throw new Error(`Empty JavaScript output: ${name}`);
      if (NodeFS.statSync(target).mtimeMs < buildStartedAt)
        throw new Error(`JavaScript output was not rebuilt: ${name}`);
      return [name, NodeCrypto.createHash("sha256").update(bytes).digest("hex")];
    }),
  );
  if (
    NodeFS.readFileSync(NodePath.join(app, "main.jsbundle")).subarray(0, 8).toString("hex") !==
    "c61fbc03c103191f"
  )
    throw new Error("Release bundle is not Hermes bytecode");
  return { version: info.CFBundleShortVersionString, buildNumber, outputs, buildStartedAt };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      app: { type: "string" },
      "build-number": { type: "string" },
      "started-at": { type: "string" },
      output: { type: "string" },
      "write-compilers": { type: "boolean" },
      directory: { type: "string" },
      "cache-directory": { type: "string" },
      "config-file": { type: "string" },
    },
  });
  if (values["write-compilers"]) {
    if (!values.directory || !values["cache-directory"] || !values["config-file"])
      throw new Error("Expected --directory, --cache-directory and --config-file");
    const command = (program: string, args: string[]) =>
      NodeChildProcess.execFileSync(program, args, { encoding: "utf8" }).trim();
    process.stdout.write(
      JSON.stringify(
        writeForkIosCompilers({
          directory: values.directory,
          cacheDirectory: values["cache-directory"],
          configFile: values["config-file"],
          baseDirectory: process.cwd(),
          cacheBinary: command("which", ["ccache"]),
          clang: command("xcrun", ["--find", "clang"]),
          clangxx: command("xcrun", ["--find", "clang++"]),
        }),
      ) + "\n",
    );
    process.exit(0);
  }
  if (!values.app || !values["build-number"] || !values["started-at"] || !values.output)
    throw new Error("Expected --app, --build-number, --started-at and --output");
  const verified = verifyForkIosApp(
    values.app,
    values["build-number"],
    Number(values["started-at"]),
  );
  const sourceCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  NodeFS.writeFileSync(
    values.output,
    JSON.stringify(
      {
        ...verified,
        sourceCommit,
        codeSigningAllowed: false,
        nativeFingerprint: process.env.T3_IOS_NATIVE_FINGERPRINT,
        nativeCacheHit: process.env.T3_IOS_NATIVE_CACHE_HIT === "true",
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify(verified) + "\n");
}
