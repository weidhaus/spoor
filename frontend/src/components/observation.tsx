import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { FRESHNESS, OBSERVED, SOURCE_LABEL } from "@/lib/states";

export type Observation = {
  state: "present" | "absent" | "unknown";
  observed_at: string | null;
  source: string | null;
  freshness: "current" | "stale" | "unknown";
};

/** Observed access, freshness, observation time and source, each visible on its own. */
export function ObservationSummary({ obs }: { obs: Observation }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <StateBadge map={OBSERVED} value={obs.state} />
        {obs.state !== "unknown" && <StateBadge map={FRESHNESS} value={obs.freshness} />}
      </div>
      <span className="text-xs text-fg-muted">
        {obs.observed_at ? (
          <>
            Observed <Time iso={obs.observed_at} />
            {obs.source && <> · {SOURCE_LABEL[obs.source] ?? obs.source}</>}
          </>
        ) : (
          "No source has reported this application yet"
        )}
      </span>
    </div>
  );
}
