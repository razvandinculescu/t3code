import {
  collectLimitAccounts,
  type LimitAccount,
  collectLimitPools,
  formatResetsIn,
} from "@t3tools/shared/usageLimits";
import { TicketIcon } from "lucide-react";

import { barColor, PaceIcon } from "./UsageLimits";
import { AccountAvatar, AccountName, PoolSegment, UsageLimitsPooled } from "./UsageLimitsPooled";

/** Keep account layout separate from upstream quota calculation and reset actions. */
export function UsageLimitsAccounts({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  return (
    <UsageLimitsPooled
      presentations={presentations}
      now={now}
      renderAccounts={(accounts) => <AccountCards accounts={accounts} now={now} />}
    />
  );
}

function AccountCards({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  return (
    <div className="@container">
      <div className="columns-1 gap-4 @min-[42rem]:columns-2">
        {accounts.map((account) => {
          const pool = collectLimitPools([account], now)[0];
          if (!pool) return null;
          const credits = account.limits.resetCredits?.availableCount ?? 0;
          return (
            <section
              key={account.key}
              className="mb-4 min-w-0 break-inside-avoid overflow-hidden rounded-xl border border-border/70 bg-card/30"
            >
              <header className="flex min-w-0 items-center gap-3 border-b border-border/50 px-5 py-4">
                <AccountAvatar account={account} className="size-6 shrink-0" />
                <h2 className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">
                  <AccountName account={account} />
                </h2>
                {credits > 0 ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <TicketIcon className="size-3.5" aria-hidden />
                    <span>{credits} resets</span>
                  </span>
                ) : null}
              </header>
              <div className="divide-y divide-border/40 px-5">
                {pool.windows.map((window) => {
                  const member = window.members[0]!;
                  const reset = window.resets[0];
                  const resetsIn = formatResetsIn(member.window, now);
                  return (
                    <div key={`${window.kind}:${window.id}`} className="space-y-2.5 py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-sm text-foreground/85">{window.label}</span>
                        <span className="flex shrink-0 items-baseline gap-1.5">
                          <span className="text-xl font-semibold tabular-nums text-foreground">
                            {window.remainingPercent}%
                          </span>
                          <span className="text-xs text-muted-foreground">left</span>
                        </span>
                      </div>
                      <div className="grid grid-cols-1">
                        <PoolSegment
                          account={account}
                          window={member.window}
                          reset={reset}
                          color={barColor(account.driver)}
                          now={now}
                          index={1}
                          compact
                        />
                      </div>
                      <div className="flex min-h-4 items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {resetsIn ?? "Reset time not reported"}
                        </span>
                        {window.pace ? <PaceIcon pace={window.pace} /> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
