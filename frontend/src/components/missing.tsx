import type { ReactNode } from "react";

// One explicit label per missing meaning. Never a bare dash, never a fake zero.
const LABELS = {
  not_reported: "Not reported",
  not_synced: "Not yet synced",
  could_not_load: "Could not load",
  not_supported: "Not supported",
  not_applicable: "Not applicable",
  restricted: "Restricted",
  unknown: "Unknown",
} as const;

export type MissingReason = keyof typeof LABELS;

export function Missing({ reason, children }: { reason?: MissingReason; children?: ReactNode }) {
  return <span className="text-fg-muted">{children ?? LABELS[reason ?? "unknown"]}</span>;
}

/** Renders value, or the explicit missing label when the value is null/undefined/empty (0 stays 0). */
export function OrMissing({ value, reason = "not_reported" }: { value: ReactNode; reason?: MissingReason }) {
  if (value === null || value === undefined || value === "") return <Missing reason={reason} />;
  return <>{value}</>;
}
