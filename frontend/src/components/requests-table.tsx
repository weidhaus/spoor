import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Link } from "react-router";

import { ExportDialog } from "@/components/export-dialog";
import { Missing } from "@/components/missing";
import { ResourceTable, SearchFilter, SelectFilter, useFilters } from "@/components/resource-table";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { DECISION, EXECUTION, REQUEST_TYPE } from "@/lib/states";

export type RequestRow = {
  id: number;
  type: "grant" | "revoke";
  person_id: number;
  person_name: string | null;
  person_email: string;
  app_id: number;
  app_name: string;
  requested_access: string | null;
  requested_by: string;
  requested_at: string;
  decision: string;
  execution: string;
};

const options = (map: Record<string, readonly [string, unknown]>) => Object.entries(map).map(([k, [v]]) => [k, v] as [string, string]);

/** Request queue. Decision and execution are separate columns; observation and verification are on the record. */
export function RequestsTable({ scope, syncWithLocation = false }: { scope?: { app_id: number } | { person_id: number }; syncWithLocation?: boolean }) {
  const columns = useMemo<ColumnDef<RequestRow>[]>(
    () => [
      {
        id: "person_email",
        accessorKey: "person_email",
        header: "Target person",
        meta: { minWidth: 220 },
        cell: ({ row: { original: r } }) => (
          <div className="flex flex-col">
            <Link to={`/requests/${r.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
              {REQUEST_TYPE[r.type]}: {r.person_name ?? r.person_email}
            </Link>
            <span className="text-xs text-fg-muted">
              Request #{r.id} · {r.person_email}
            </span>
          </div>
        ),
      },
      {
        id: "app_name",
        accessorKey: "app_name",
        header: "Application",
        meta: { minWidth: 160 },
        cell: ({ row: { original: r } }) => (
          <Link to={`/applications/${r.app_id}`} className="text-fg underline-offset-4 hover:underline">
            {r.app_name}
          </Link>
        ),
      },
      {
        id: "requested_access",
        accessorKey: "requested_access",
        header: "Requested access",
        enableSorting: false,
        meta: { minWidth: 150 },
        cell: ({ getValue }) => getValue<string>() ?? <Missing>Any access</Missing>,
      },
      {
        id: "requested_at",
        accessorKey: "requested_at",
        header: "Submitted",
        meta: { minWidth: 180 },
        cell: ({ row: { original: r } }) => (
          <div className="flex flex-col">
            <Time iso={r.requested_at} />
            <span className="text-xs text-fg-muted">by {r.requested_by}</span>
          </div>
        ),
      },
      {
        id: "decision",
        accessorKey: "decision",
        header: "Decision",
        meta: { minWidth: 150 },
        cell: ({ getValue }) => <StateBadge map={DECISION} value={getValue<string>()} />,
      },
      {
        id: "execution",
        accessorKey: "execution",
        header: "Execution",
        meta: { minWidth: 130 },
        cell: ({ getValue }) => <StateBadge map={EXECUTION} value={getValue<string>()} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row: { original: r } }) => (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/requests/${r.id}`}>
              Open<span className="sr-only"> request {r.id}</span>
            </Link>
          </Button>
        ),
      },
    ],
    []
  );
  const permanent = Object.entries(scope ?? {}).map(([field, value]) => ({ field, operator: "eq" as const, value }));
  const table = useTable<RequestRow>({
    columns,
    getRowId: (r) => String(r.id),
    refineCoreProps: { resource: "requests", syncWithLocation, pagination: { pageSize: 25 }, filters: { permanent } },
  });
  const filters = useFilters(table);
  const scopeFilters = Object.fromEntries(Object.entries(scope ?? {}).map(([k, v]) => [k, String(v)]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <ExportDialog
          resource="requests"
          filters={{ ...scopeFilters, ...Object.fromEntries(["q", "decision", "execution", "type"].map((k) => [k, filters.value(k)])) }}
          matchingCount={table.refineCore.tableQuery.data?.total}
        />
      </div>
      <ResourceTable
        table={table}
        label="Access requests"
        emptyTitle="No access requests yet"
        filters={
          <>
            <SearchFilter table={table} label="Search requests" />
            <SelectFilter table={table} id="decision" label="Decision" options={options(DECISION)} />
            <SelectFilter table={table} id="execution" label="Execution" options={options(EXECUTION)} />
            <SelectFilter table={table} id="type" label="Change" options={Object.entries(REQUEST_TYPE)} />
          </>
        }
      />
    </div>
  );
}
