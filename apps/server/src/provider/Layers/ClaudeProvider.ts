import {
  type ClaudeSettings,
  type ModelCapabilities,
  ServerProviderUsageWindow,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
} from "../ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function isClaudeFirstPartyOAuth(input: {
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
}): boolean {
  const tokenSource = input.tokenSource?.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    input.apiProvider === "firstParty" &&
    (input.subscriptionType !== undefined || tokenSource === "claudecodeoauthtoken")
  );
}

function claudeUsageUnavailableFallback(input: Parameters<typeof isClaudeFirstPartyOAuth>[0]): {
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
} {
  return isClaudeFirstPartyOAuth(input)
    ? {
        reason: "probeFailed",
        message: "Claude temporarily could not read subscription limits. Retrying later.",
      }
    : { reason: "unsupported" };
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
const EXTERNAL_USAGE_PROBE_TIMEOUT_MS = 10_000;
const EXTERNAL_USAGE_PROBE_ARG = "--t3-usage-limits-json";

const ExternalUsageLimitsResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    windows: Schema.Array(ServerProviderUsageWindow),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    hidden: Schema.Literal(true),
  }),
]);
const decodeExternalUsageLimitsResponse = Schema.decodeUnknownOption(ExternalUsageLimitsResponse);

export type ExternalClaudeUsageLimits =
  | { readonly kind: "limits"; readonly limits: ReturnType<typeof makeUsageLimits> }
  | { readonly kind: "hidden" };

/** Parse the deliberately small stdout contract implemented by provider wrappers. */
export function externalClaudeUsageLimitsFromJson(
  raw: string,
  checkedAt: string,
): ExternalClaudeUsageLimits | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const decoded = decodeExternalUsageLimitsResponse(json);
  if (Option.isNone(decoded)) return undefined;
  return "hidden" in decoded.value
    ? { kind: "hidden" }
    : {
        kind: "limits",
        limits: makeUsageLimits({ checkedAt, windows: decoded.value.windows }),
      };
}

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * Subscription windows from the SDK's `get_usage` control request, or
   * `undefined` when the request itself failed. Absent windows on an
   * otherwise successful response mean the account has none (API key).
   */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
};

const CachedClaudeUsageWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
});
const CachedClaudeUsageLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(
    Schema.Struct({
      model: Schema.NullOr(Schema.Struct({ display_name: Schema.String })),
    }),
  ),
});
const CachedClaudeUsageFile = Schema.fromJsonString(
  Schema.Struct({
    cachedUsageUtilization: Schema.Struct({
      fetchedAtMs: Schema.Number,
      utilization: Schema.Struct({
        five_hour: Schema.optionalKey(Schema.NullOr(CachedClaudeUsageWindow)),
        seven_day: Schema.optionalKey(Schema.NullOr(CachedClaudeUsageWindow)),
        limits: Schema.optionalKey(Schema.Array(CachedClaudeUsageLimit)),
      }),
    }),
  }),
);
const decodeCachedClaudeUsageFile = Schema.decodeUnknownOption(CachedClaudeUsageFile);

/** Usage windows recovered from Claude Code's on-disk cache, stamped with when the CLI fetched them. */
export type CachedClaudeUsage = {
  readonly usage: NonNullable<ClaudeCapabilitiesProbe["usage"]>;
  readonly checkedAt: string;
};

/**
 * The CLI refreshes this cache on its own schedule, so it can be hours old.
 * A window whose reset already passed would publish a dead percentage next
 * to a past reset time, so it is dropped; the survivors carry the cache's
 * own `fetchedAtMs` as `checkedAt` instead of pretending to be fresh.
 */
export function cachedClaudeUsageFromJson(
  raw: string,
  now: DateTime.Utc,
): CachedClaudeUsage | undefined {
  const decoded = decodeCachedClaudeUsageFile(raw);
  if (Option.isNone(decoded)) return undefined;
  const cached = decoded.value.cachedUsageUtilization;
  const nowMs = DateTime.toEpochMillis(now);
  const isCurrent = (resetsAt: string | null) => {
    if (!resetsAt) return true;
    const reset = DateTime.make(resetsAt);
    return Option.isNone(reset) || DateTime.toEpochMillis(reset.value) > nowMs;
  };
  const { limits = [] } = cached.utilization;
  const five_hour = cached.utilization.five_hour ?? null;
  const seven_day = cached.utilization.seven_day ?? null;
  const currentFiveHour = five_hour && isCurrent(five_hour.resets_at) ? five_hour : null;
  const currentSevenDay = seven_day && isCurrent(seven_day.resets_at) ? seven_day : null;
  const modelScoped = limits.flatMap((limit) => {
    const displayName = limit.scope?.model?.display_name;
    return limit.kind === "weekly_scoped" &&
      displayName &&
      limit.percent !== null &&
      isCurrent(limit.resets_at)
      ? [{ display_name: displayName, utilization: limit.percent, resets_at: limit.resets_at }]
      : [];
  });
  if (!currentFiveHour && !currentSevenDay && modelScoped.length === 0) return undefined;
  const fetchedAt = Option.getOrElse(DateTime.make(cached.fetchedAtMs), () => now);
  return {
    usage: {
      rate_limits_available: true,
      rate_limits: {
        ...(currentFiveHour ? { five_hour: currentFiveHour } : {}),
        ...(currentSevenDay ? { seven_day: currentSevenDay } : {}),
        ...(modelScoped.length > 0 ? { model_scoped: modelScoped } : {}),
      },
    } as NonNullable<ClaudeCapabilitiesProbe["usage"]>,
    checkedAt: DateTime.formatIso(fetchedAt),
  };
}

const readCachedClaudeUsage = Effect.fn("readCachedClaudeUsage")(function* (
  claudeSettings: ClaudeSettings,
): Effect.fn.Return<CachedClaudeUsage | undefined, never, FileSystem.FileSystem | Path.Path> {
  // Custom CLAUDE_CONFIG_DIR layouts are not guaranteed to use ~/.claude.json.
  if (claudeSettings.homePath.trim().length > 0) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveClaudeHomePath(claudeSettings);
  const raw = yield* fs.readFileString(path.join(home, ".claude.json")).pipe(
    Effect.map((value): string | undefined => value),
    Effect.catchCause(() => Effect.succeed(undefined)),
  );
  if (raw === undefined) return undefined;
  return cachedClaudeUsageFromJson(raw, yield* DateTime.now);
});

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });
      const init = await q.initializationResult();
      // Usage is a second control round trip on the same process; a failure
      // there must not cost the slash commands and account we already have.
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().then(
        (response) => ({
          rate_limits_available: response.rate_limits_available,
          rate_limits: response.rate_limits,
        }),
        () => undefined,
      );
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
        ...(usage ? { usage } : {}),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Optional wrapper protocol for Anthropic-compatible subscription providers.
 * Unknown binaries simply reject the flag and retain the normal unsupported
 * result; wrappers that own a credential return only normalized quota data.
 * Spawns the binary, so the driver memoizes it under the capabilities TTL
 * (`resolveExternalUsage` on `checkClaudeProviderStatus`); the limits carry
 * the time of that spawn, not of the status check that reused them.
 */
export const probeExternalClaudeUsageLimits = Effect.fn("probeExternalClaudeUsageLimits")(
  function* (claudeSettings: ClaudeSettings, environment?: NodeJS.ProcessEnv) {
    const checkedAt = yield* nowIso;
    const result = yield* runClaudeCommand(
      claudeSettings,
      [EXTERNAL_USAGE_PROBE_ARG],
      environment,
    ).pipe(Effect.timeoutOption(EXTERNAL_USAGE_PROBE_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
    const command = result.success.value;
    if (command.code !== 0) return undefined;
    return externalClaudeUsageLimitsFromJson(command.stdout, checkedAt);
  },
);

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  /** Memoized wrapper usage probe; defaults to spawning the binary on every check. */
  resolveExternalUsage?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ExternalClaudeUsageLimits | undefined>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  const usageUnavailable = claudeUsageUnavailableFallback(capabilities);
  const cachedUsage =
    isClaudeFirstPartyOAuth(capabilities) &&
    (!capabilities.usage?.rate_limits_available || !capabilities.usage.rate_limits)
      ? yield* readCachedClaudeUsage(claudeSettings)
      : undefined;
  const effectiveUsage = cachedUsage?.usage ?? capabilities.usage;
  const usageCheckedAt = cachedUsage?.checkedAt ?? checkedAt;
  const externalUsage =
    usageUnavailable.reason === "unsupported"
      ? yield* resolveExternalUsage
          ? resolveExternalUsage(claudeSettings)
          : probeExternalClaudeUsageLimits(claudeSettings, resolvedEnvironment)
      : undefined;
  const usageLimits =
    externalUsage?.kind === "hidden"
      ? undefined
      : externalUsage?.kind === "limits"
        ? externalUsage.limits
        : !effectiveUsage
          ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
          : scopedLimitNames
            ? yield* recordClaudeUsageResponse(scopedLimitNames, {
                response: effectiveUsage,
                checkedAt: usageCheckedAt,
                unavailableReason: usageUnavailable.reason,
                ...(usageUnavailable.message
                  ? { unavailableMessage: usageUnavailable.message }
                  : {}),
              })
            : claudeUsageResponseToLimits({
                response: effectiveUsage,
                checkedAt: usageCheckedAt,
                unavailableReason: usageUnavailable.reason,
                ...(usageUnavailable.message
                  ? { unavailableMessage: usageUnavailable.message }
                  : {}),
              }).limits;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      ...(usageLimits ? { usageLimits } : {}),
    },
  });
});

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
