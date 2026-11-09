import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Link } from "react-router";

import { ExportDialog } from "@/components/export-dialog";
import { Missing, OrMissing } from "@/components/missing";
import { Page, PageHeader } from "@/components/page";
import { ResourceTable, SearchFilter, SelectFilter, useFilters } from "@/components/resource-table";
import { SourceContext } from "@/components/source-context";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HR_STATUS, PERSON_STATUS, SOURCE_LABEL } from "@/lib/states";

type PersonRow = {
  id: number;
  name: string | null;
  email: string;
  department: string | null;
  kind: string;
  status: string;
  status_source: string | null;
  hr_status: string | null;
  hr_leave_date: string | null;
  apps: number;
  open_issues: number;
  last_seen: string;
};

export function PeopleList() {
  const columns = useMemo<ColumnDef<PersonRow>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Person",
        meta: { minWidth: 240 },
        cell: ({ row: { original: p } }) => (
          <div className="flex flex-col">
            <Link to={`/people/${p.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
              {p.name ?? p.email}
            </Link>
            {p.kind === "guest" && <span className="text-xs text-fg-muted">External guest</span>}
          </div>
        ),
      },
      { id: "email", accessorKey: "email", header: "Email or identifier", meta: { minWidth: 220 } },
      {
        id: "department",
        accessorKey: "department",
        header: "Department",
        meta: { minWidth: 160 },
        cell: ({ getValue }) => <OrMissing value={getValue<string>()} />,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Account status",
        meta: { minWidth: 160 },
        cell: ({ row: { original: p } }) => (
          <div className="flex flex-col gap-1">
            <StateBadge map={PERSON_STATUS} value={p.status} />
            {p.status_source && <span className="text-xs text-fg-muted">from {SOURCE_LABEL[p.status_source] ?? p.status_source}</span>}
          </div>
        ),
      },
      {
        id: "hr_status",
        accessorKey: "hr_status",
        header: "HR status (Personio)",
        meta: { minWidth: 160 },
        cell: ({ row: { original: p } }) =>
          p.hr_status ? (
            <div className="flex flex-col gap-1">
              <StateBadge map={HR_STATUS} value={p.hr_status} />
              {p.hr_leave_date && <span className="text-xs text-fg-muted">Last day {p.hr_leave_date}</span>}
            </div>
          ) : (
            <Missing>No HR record</Missing>
          ),
      },
      { id: "apps", accessorKey: "apps", header: "Applications with evidence", meta: { align: "right", minWidth: 120 } },
      {
        id: "open_issues",
        accessorKey: "open_issues",
        header: "Open issues",
        meta: { align: "right", minWidth: 100 },
        cell: ({ getValue }) => (getValue<number>() > 0 ? <Badge tone="attention">{getValue<number>()}</Badge> : 0),
      },
      {
        id: "last_seen",
        accessorKey: "last_seen",
        header: "Last observation",
        meta: { minWidth: 180 },
        cell: ({ getValue }) => <Time iso={getValue<string>()} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row: { original: p } }) => (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/people/${p.id}`}>
              Open<span className="sr-only"> {p.name ?? p.email}</span>
            </Link>
          </Button>
        ),
      },
    ],
    []
  );
  const table = useTable<PersonRow>({
    columns,
    getRowId: (r) => String(r.id),
    refineCoreProps: { resource: "people", syncWithLocation: true, pagination: { pageSize: 25 } },
  });
  const filters = useFilters(table);

  return (
    <Page>
      <PageHeader
        title="People and access"
        description="Everyone known from Google Workspace, Microsoft Entra ID and matched CSV accounts. Account status comes from the directories (Google is authoritative; Entra decides only for people who exist in Entra alone). HR status comes from Personio and is shown separately."
        actions={
          <ExportDialog
            resource="people"
            filters={Object.fromEntries(["q", "status", "hr", "kind"].map((k) => [k, filters.value(k)]))}
            matchingCount={table.refineCore.tableQuery.data?.total}
          />
        }
        context={<SourceContext />}
      />
      <ResourceTable
        table={table}
        label="People"
        emptyTitle="No people are known yet"
        emptyHint="People appear after the first Google Workspace or Entra ID sync."
        filters={
          <>
            <SearchFilter table={table} label="Search name, email, alias or department" />
            <SelectFilter table={table} id="status" label="Account status" options={Object.entries(PERSON_STATUS).map(([k, [v]]) => [k, v])} />
            <SelectFilter
              table={table}
              id="hr"
              label="HR status"
              options={[...Object.entries(HR_STATUS).map(([k, [v]]) => [k, v] as [string, string]), ["none", "No HR record"]]}
            />
            <SelectFilter table={table} id="kind" label="Type" options={[["employee", "Employees"], ["guest", "External guests"]]} />
          </>
        }
      />
    </Page>
  );
}
