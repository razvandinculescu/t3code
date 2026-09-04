import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  cachedClaudeUsageFromJson,
  checkClaudeProviderStatus,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  externalClaudeUsageLimitsFromJson,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("decodes normalized usage supplied by an Anthropic-compatible wrapper", () => {
  assert.deepEqual(
    externalClaudeUsageLimitsFromJson(
      JSON.stringify({
        version: 1,
        windows: [
          {
            id: "kimi_weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 42.5,
            resetsAt: "2026-09-05T13:57:49Z",
            windowDurationMins: 10_080,
          },
        ],
      }),
      "2026-09-04T12:00:00Z",
    ),
    {
      kind: "limits",
      limits: {
        checkedAt: "2026-09-04T12:00:00Z",
        windows: [
          {
            id: "kimi_weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 42.5,
            resetsAt: "2026-09-05T13:57:49Z",
            windowDurationMins: 10_080,
          },
        ],
      },
    },
  );
});

it("lets a wrapper hide a duplicate subscription row", () => {
  assert.deepEqual(
    externalClaudeUsageLimitsFromJson(
      JSON.stringify({ version: 1, hidden: true }),
      "2026-09-04T12:00:00Z",
    ),
    { kind: "hidden" },
  );
});

it("rejects malformed wrapper usage instead of publishing misleading limits", () => {
  assert.equal(
    externalClaudeUsageLimitsFromJson(
      JSON.stringify({
        version: 1,
        windows: [{ id: "bad", kind: "weekly", label: "Weekly", usedPercent: 101 }],
      }),
      "2026-09-04T12:00:00Z",
    ),
    undefined,
  );
  assert.equal(externalClaudeUsageLimitsFromJson("not json", "2026-09-04T12:00:00Z"), undefined);
});

it("maps Claude's cached usage without reading credentials", () => {
  assert.deepEqual(
    cachedClaudeUsageFromJson(
      JSON.stringify({
        unrelated: "ignored",
        cachedUsageUtilization: {
          fetchedAtMs: 1_788_510_804_364,
          utilization: {
            five_hour: { utilization: 11, resets_at: "2026-09-04T12:00:00Z" },
            seven_day: { utilization: 6, resets_at: "2026-09-11T06:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 11,
                resets_at: "2026-09-11T06:00:00Z",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        },
      }),
    ),
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 11, resets_at: "2026-09-04T12:00:00Z" },
        seven_day: { utilization: 6, resets_at: "2026-09-11T06:00:00Z" },
        ...({
          model_scoped: [
            { display_name: "Fable", utilization: 11, resets_at: "2026-09-11T06:00:00Z" },
          ],
        } as object),
      },
    },
  );
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          "  const reply = (response) => process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          '    response: { subtype: "success", request_id: message.request_id, response },',
          '  }) + "\\n");',
          '  if (message.request?.subtype === "initialize") {',
          "    reply({",
          '      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "      agents: [],",
          '      output_style: "default",',
          '      available_output_styles: ["default"],',
          "      models: [],",
          '      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "    });",
          "  }",
          "  // The probe follows initialize with get_usage on the same process.",
          '  if (message.request?.subtype === "get_usage") {',
          "    reply({",
          "      session: {},",
          '      subscription_type: "pro",',
          "      rate_limits_available: true,",
          '      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },',
          "      behaviors: null,",
          "    });",
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("external Claude usage probe", (it) => {
  it.effect("publishes wrapper limits and hides an explicitly aliased account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-usage-probe-" });
      const executablePath = path.join(tempDir, "fake-provider.mjs");
      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const flag = process.argv[2];",
          'if (flag === "--version") { console.log("2.1.258"); process.exit(0); }',
          'if (flag === "--t3-usage-limits-json") {',
          '  console.log(process.env.T3_EXTERNAL_HIDE === "1"',
          "    ? JSON.stringify({ version: 1, hidden: true })",
          "    : JSON.stringify({ version: 1, windows: [{",
          '        id: "vendor_weekly", kind: "weekly", label: "Weekly",',
          "        usedPercent: 37, windowDurationMins: 10080,",
          "      }] }));",
          "  process.exit(0);",
          "}",
          "process.exit(2);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = {
        email: undefined,
        subscriptionType: undefined,
        tokenSource: "apiKey",
        apiProvider: undefined,
        slashCommands: [],
        usage: { rate_limits_available: false, rate_limits: null },
      };
      const settings = decodeClaudeSettings({ binaryPath: executablePath });
      const withLimits = yield* checkClaudeProviderStatus(
        settings,
        () => Effect.succeed(capabilities),
        process.env,
        tempDir,
      );
      assert.deepEqual(withLimits.usageLimits?.windows, [
        {
          id: "vendor_weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 37,
          windowDurationMins: 10_080,
        },
      ]);

      const hidden = yield* checkClaudeProviderStatus(
        settings,
        () => Effect.succeed(capabilities),
        { ...process.env, T3_EXTERNAL_HIDE: "1" },
        tempDir,
      );
      assert.equal(hidden.usageLimits, undefined);
    }).pipe(Effect.scoped),
  );
});
