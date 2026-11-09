import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { ExportDialog } from "@/components/export-dialog";
import { LicenseFormDialog } from "@/components/license-form";
import { Availability, Cost, type PlanRow, Usage } from "@/components/license-plans";
import { Missing } from "@/components/missing";
import { Page, PageHeader } from "@/components/page";
import { ResourceTable, SearchFilter, useFilters } from "@/components/resource-table";
import { SourceContext } from "@/components/source-context";
import { Time } from "@/components/time";
import { useRole } from "@/hooks/use-role";
import { formatNumber } from "@/lib/format";
import { SOURCE_LABEL } from "@/lib/states";

export function LicenseList() {
  const { isAdmin } = useRole();
  const columns = useMemo<ColumnDef<PlanRow>[]>(
    () => [
      {
        id: "app_name",
        accessorKey: "app_name",
        header: "Application",
        meta: { minWidth: 200 },
        cell: ({ row: { original: p } }) => (
          <Link to={`/applications/${p.app_id}`} className="text-fg underline-offset-4 hover:underline">
            {p.app_name}
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Plan",
        meta: { minWidth: 220 },
        cell: ({ row: { original: p } }) => (
          <div className="flex flex-col">
            <Link to={`/licenses/${p.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
              {p.name}
            </Link>
            <span className="text-xs text-fg-muted">{SOURCE_LABEL[p.source] ?? p.source}</span>
          </div>
        ),
      },
      {
        id: "quantity",
        accessorKey: "quantity",
        header: "Purchased",
        meta: { align: "right", minWidth: 110 },
        cell: ({ getValue }) => (getValue<number | null>() === null ? <Missing reason="not_reported" /> : formatNumber(getValue<number>())),
      },
      { id: "assigned", accessorKey: "assigned", header: "Assigned", meta: { align: "right", minWidth: 100 } },
      {
        id: "available",
        accessorKey: "available",
        header: "Available or over-allocated",
        meta: { minWidth: 180 },
        cell: ({ row: { original: p } }) => <Availability plan={p} />,
      },
      {
        id: "usage",
        header: "Usage",
        enableSorting: false,
        meta: { minWidth: 220 },
        // The activity window (INACTIVITY_DAYS) arrives with the data, so it is read from table meta.
        cell: ({ row: { original: p }, table }) => <Usage plan={p} inactivityDays={(table.options.meta as { days: number }).days} />,
      },
      {
        id: "cost",
        header: "Cost and billing period",
        enableSorting: false,
        meta: { minWidth: 200 },
        cell: ({ row: { original: p } }) => <Cost plan={p} />,
      },
      {
        id: "renewal_date",
        accessorKey: "renewal_date",
        header: "Renewal date",
        meta: { minWidth: 140 },
        cell: ({ getValue }) => <Time iso={getValue<string>()} dateOnly missing="not_reported" />,
      },
    ],
    []
  );
  const [serverDays, setServerDays] = useState<number>();
  const table = useTable<PlanRow>({
    columns,
    meta: { days: serverDays },
    getRowId: (r) => String(r.id),
    refineCoreProps: { resource: "licenses", syncWithLocation: true, pagination: { pageSize: 25 } },
  });
  const responseDays = (table.refineCore.tableQuery.data as { extra?: { inactivity_days?: number } } | undefined)?.extra?.inactivity_days;
  if (responseDays !== serverDays) setServerDays(responseDays); // adjust state during render (no effect)
  const filters = useFilters(table);

  return (
    <Page>
      <PageHeader
        title="Licenses"
        description="Purchased, assigned and available seats per plan. Availability is only calculated when the purchased quantity is known; usage only when a source reports activity."
        actions={
          <>
            {isAdmin && <LicenseFormDialog />}
            <ExportDialog resource="licenses" filters={{ q: filters.value("q") }} matchingCount={table.refineCore.tableQuery.data?.total} />
          </>
        }
        context={<SourceContext />}
      />
      <ResourceTable
        table={table}
        label="Licence plans"
        emptyTitle="No licence plans are recorded yet"
        emptyHint="Plans appear from Google and Microsoft licence data, or can be added manually."
        filters={<SearchFilter table={table} label="Search application or plan" />}
      />
    </Page>
  );
}
