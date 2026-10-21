import * as FileSystem from "effect/FileSystem";
import { ClaudeSettings } from "@t3tools/contracts";

// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  externalClaudeUsageLimitsFromJson,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

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

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});
