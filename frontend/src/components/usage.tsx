import { Missing } from "@/components/missing";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { formatNumber } from "@/lib/format";
import { USAGE } from "@/lib/states";

export type UsageSummary = { coverage: "none" | "partial" | "complete"; since: string | null; active: number; people: number };
export type RowUsage = { state: string; last: string | null; since: string | null };

/** People active within the window. Never infers inactivity without activity data or a full window of history. */
export function ActiveCount({ usage, days }: { usage: UsageSummary; days: number }) {
  if (usage.coverage === "none") return <Missing>Unknown: no source reports activity</Missing>;
  if (usage.coverage === "partial")
    return (
      <div className="flex flex-col">
        <span className="tabular">{formatNumber(usage.active)} active</span>
        <span className="text-xs text-fg-muted">
          {usage.since ? (
            <>
              observed since <Time iso={usage.since} dateOnly />, less than {days} days
            </>
          ) : (
            "history start unknown"
          )}
        </span>
      </div>
    );
  return (
    <span className="tabular">
      {formatNumber(usage.active)} of {formatNumber(usage.people)}
    </span>
  );
}

/** Usage state of one person on one app, with the last activity behind it. */
export function UsageCell({ usage, days }: { usage: RowUsage; days: number }) {
  return (
    <div className="flex flex-col gap-1">
      <StateBadge map={USAGE} value={usage.state} />
      <span className="text-xs text-fg-muted">
        {usage.last ? (
          <>
            Last activity <Time iso={usage.last} />
          </>
        ) : usage.state === "unknown" ? (
          "No source reports activity for this app"
        ) : usage.state === "insufficient_history" ? (
          <>No activity since {usage.since ? <Time iso={usage.since} dateOnly /> : "history start"}; shorter than {days} days</>
        ) : (
          `No activity in ${days} days`
        )}
      </span>
    </div>
  );
}
