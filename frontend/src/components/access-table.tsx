import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { ExportDialog } from "@/components/export-dialog";
import { Missing } from "@/components/missing";
import { ResourceTable, SearchFilter, SelectFilter, useFilters } from "@/components/resource-table";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { type RowUsage, UsageCell } from "@/components/usage";
import { Badge } from "@/components/ui/badge";
import { ACCOUNT_STATE, EVIDENCE_LABEL, FRESHNESS, OBSERVED, SOURCE_LABEL } from "@/lib/states";

type AccountRow = {
  id: number;
  app_id: number;
  app_name: string;
  person_id: number | null;
  person_name: string | null;
  email: string | null;
  source: string;
  kind: string;
  external_id: string;
  role: string | null;
  plan: string | null;
  state: string;
  last_activity_at: string | null;
  usage: RowUsage;
  observed: string;
  observed_at: string | null;
  freshness: string;
  risky_scopes: string[];
};

/** Access evidence for one application or one person. One row per piece of evidence, history included. */
export function AccessTable({ scope }: { scope: { app_id: number } | { person_id: number } }) {
  const byApp = "app_id" in scope;
  const columns = useMemo<ColumnDef<AccountRow>[]>(
    () => [
      byApp
        ? {
            id: "email",
            accessorKey: "email",
            header: "Person",
            meta: { minWidth: 240 },
            cell: ({ row: { original: r } }) =>
              r.person_id ? (
                <div className="flex flex-col">
                  <Link to={`/people/${r.person_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                    {r.person_name ?? r.email}
                  </Link>
                  {r.person_name && <span className="text-xs text-fg-muted">{r.email}</span>}
                </div>
              ) : (
                <div className="flex flex-col">
                  <span className="font-medium text-fg">{r.email ?? r.external_id}</span>
                  <span className="text-xs text-fg-muted">Not matched to a known person</span>
                </div>
              ),
          }
        : {
            id: "app_name",
            accessorKey: "app_name",
            header: "Application",
            meta: { minWidth: 220 },
            cell: ({ row: { original: r } }) => (
              <Link to={`/applications/${r.app_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                {r.app_name}
              </Link>
            ),
          },
      {
        id: "kind",
        accessorKey: "kind",
        header: "Access level or entitlement",
        meta: { minWidth: 200 },
        cell: ({ row: { original: r } }) => (
          <div className="flex flex-col gap-1">
            <span>{EVIDENCE_LABEL[r.kind] ?? r.kind}</span>
            {r.role && <span className="text-xs text-fg-muted">Role: {r.role}</span>}
            {r.state !== "removed" && r.state !== "active" && <StateBadge map={ACCOUNT_STATE} value={r.state} prefix="Account" />}
            {r.risky_scopes.length > 0 && (
              <Badge tone="attention" title={r.risky_scopes.join("\n")}>
                {r.risky_scopes.length} sensitive scope{r.risky_scopes.length > 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "plan",
        accessorKey: "plan",
        header: "License assignment",
        enableSorting: false,
        meta: { minWidth: 160 },
        cell: ({ row: { original: r } }) =>
          r.plan ?? (r.kind === "license" || r.kind === "imported" ? <Missing reason="not_reported" /> : <Missing reason="not_applicable" />),
      },
      {
        id: "state",
        accessorKey: "state",
        header: "Observed access",
        meta: { minWidth: 160 },
        cell: ({ row: { original: r } }) => (
          <div className="flex flex-wrap gap-1">
            <StateBadge map={OBSERVED} value={r.observed} />
            <StateBadge map={FRESHNESS} value={r.freshness} />
          </div>
        ),
      },
      {
        id: "last_seen",
        accessorKey: "observed_at",
        header: "Observation time",
        meta: { minWidth: 180 },
        cell: ({ getValue }) => <Time iso={getValue<string>()} />,
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Source",
        meta: { minWidth: 160 },
        cell: ({ row: { original: r } }) => SOURCE_LABEL[r.source] ?? r.source,
      },
      {
        id: "last_activity_at",
        accessorKey: "last_activity_at",
        header: ({ table }) => `Usage (last ${(table.options.meta as { days?: number })?.days ?? "…"} days)`,
        meta: { minWidth: 220 },
        cell: ({ row: { original: r }, table }) => <UsageCell usage={r.usage} days={(table.options.meta as { days?: number })?.days ?? 90} />,
      },
    ],
    [byApp]
  );
  const permanent = Object.entries(scope).map(([field, value]) => ({ field, operator: "eq" as const, value }));
  const [days, setDays] = useState<number>();
  const table = useTable<AccountRow>({
    columns,
    meta: { days },
    getRowId: (r) => String(r.id),
    refineCoreProps: {
      resource: "accounts",
      syncWithLocation: false,
      pagination: { pageSize: 25 },
      filters: { permanent },
    },
  });
  const filters = useFilters(table);
  const responseDays = (table.refineCore.tableQuery.data as { extra?: { inactivity_days?: number } } | undefined)?.extra?.inactivity_days;
  if (responseDays !== days) setDays(responseDays);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-3xl text-sm text-fg-secondary">
          Each row is one piece of evidence from one source. Removed evidence stays as history with observed access Absent. Usage
          combines all evidence for the person and application: Usage unknown means no source reports activity, which is not
          the same as inactive.
        </p>
        <ExportDialog
          resource="accounts"
          filters={{ ...Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, String(v)])), q: filters.value("q"), state: filters.value("state") }}
          matchingCount={table.refineCore.tableQuery.data?.total}
        />
      </div>
      <ResourceTable
        table={table}
        label="Access evidence"
        emptyTitle={byApp ? "No source has reported accounts for this application" : "No access evidence for this person"}
        filters={
          <>
            <SearchFilter table={table} label={byApp ? "Search people" : "Search applications"} />
            <SelectFilter table={table} id="state" label="Evidence" allLabel="Current and removed" options={[["current", "Current evidence only"]]} />
          </>
        }
      />
    </div>
  );
}
