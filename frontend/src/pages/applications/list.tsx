import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { AppTile } from "@/components/app-tile";
import { ActiveCount, type UsageSummary } from "@/components/usage";
import { ExportDialog } from "@/components/export-dialog";
import { ImportDialog } from "@/components/import-dialog";
import { Missing } from "@/components/missing";
import { Page, PageHeader } from "@/components/page";
import { ErrorPanel } from "@/components/panels";
import { ResourceTable, SearchFilter, SelectFilter, selectColumn, useFilters } from "@/components/resource-table";
import { SourceContext } from "@/components/source-context";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { formatNumber, plural } from "@/lib/format";
import { APP_STATUS, SOURCE_LABEL, type StateMap } from "@/lib/states";

export type AppRow = {
  id: number;
  name: string;
  status: string;
  category: string | null;
  owner_email: string | null;
  website: string | null;
  people: number;
  usage: UsageSummary;
  plans: number;
  sources: string | null;
  last_observed: string | null;
  open_issues: number;
};

export const STATUS_OPTIONS = Object.entries(APP_STATUS).map(([k, [label]]) => [k, label] as [string, string]);

export function ApplicationList() {
  const { isAdmin } = useRole();
  const columns = useMemo<ColumnDef<AppRow>[]>(
    () => [
      ...(isAdmin ? [selectColumn<AppRow>((r) => r.name)] : []),
      {
        id: "name",
        accessorKey: "name",
        header: "Application",
        meta: { minWidth: 240 },
        cell: ({ row: { original: r } }) => (
          <div className="flex items-center gap-3">
            <AppTile id={r.id} name={r.name} website={r.website} />
            <div className="flex min-w-0 flex-col">
              <Link to={`/applications/${r.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                {r.name}
              </Link>
              <span className="text-xs text-fg-muted">{r.category ?? "No category"}</span>
            </div>
          </div>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        meta: { minWidth: 210 },
        cell: ({ getValue }) => <StateBadge map={APP_STATUS} value={getValue<string>()} />,
      },
      {
        id: "owner_email",
        accessorKey: "owner_email",
        header: "Owner",
        enableSorting: false,
        meta: { minWidth: 180 },
        cell: ({ getValue }) => getValue<string>() ?? <Missing>No owner assigned</Missing>,
      },
      { id: "people", accessorKey: "people", header: "People with access", meta: { align: "right", minWidth: 120 } },
      {
        id: "active",
        header: ({ table }) => `Active in last ${(table.options.meta as { days?: number })?.days ?? "…"} days`,
        enableSorting: false,
        meta: { minWidth: 190 },
        cell: ({ row: { original: r }, table }) => <ActiveCount usage={r.usage} days={(table.options.meta as { days?: number })?.days ?? 90} />,
      },
      {
        id: "plans",
        accessorKey: "plans",
        header: "License information",
        enableSorting: false,
        meta: { minWidth: 150 },
        cell: ({ getValue }) => (getValue<number>() > 0 ? plural(getValue<number>(), "plan") : <Missing>No plan recorded</Missing>),
      },
      {
        id: "sources",
        accessorKey: "sources",
        header: "Source",
        enableSorting: false,
        meta: { minWidth: 160 },
        cell: ({ getValue }) => {
          const v = getValue<string | null>();
          return v ? (
            <ul className="flex flex-col">
              {v.split(",").map((s) => (
                <li key={s}>{SOURCE_LABEL[s] ?? s}</li>
              ))}
            </ul>
          ) : (
            <Missing reason="unknown" />
          );
        },
      },
      {
        id: "last_observed",
        accessorKey: "last_observed",
        header: "Last observation",
        meta: { minWidth: 180 },
        cell: ({ getValue }) => (getValue<string>() ? <Time iso={getValue<string>()} /> : <Missing>No evidence yet</Missing>),
      },
      { id: "open_issues", accessorKey: "open_issues", header: "Open issues", meta: { align: "right", minWidth: 100 } },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        meta: { minWidth: 48 },
        cell: ({ row: { original: r } }) => (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/applications/${r.id}`}>
              Open<span className="sr-only"> {r.name}</span>
            </Link>
          </Button>
        ),
      },
    ],
    [isAdmin],
  );

  const [days, setDays] = useState<number>();
  const table = useTable<AppRow>({
    columns,
    meta: { days },
    getRowId: (r) => String(r.id),
    enableRowSelection: isAdmin,
    refineCoreProps: { resource: "applications", syncWithLocation: true, pagination: { pageSize: 25 } },
  });
  const filters = useFilters(table);
  const responseDays = (table.refineCore.tableQuery.data as { extra?: { inactivity_days?: number } } | undefined)?.extra?.inactivity_days;
  if (responseDays !== days) setDays(responseDays); // the window (INACTIVITY_DAYS) arrives with the data
  const extra = (table.refineCore.tableQuery.data as { extra?: { sources?: string[]; categories?: string[]; no_category?: string } } | undefined)?.extra;
  const currentFilters = Object.fromEntries(["q", "status", "category", "source"].map((k) => [k, filters.value(k)]));
  // The reviewed target set lives here, outside the selection bar, so results stay visible after the table refreshes.
  const [bulkTargets, setBulkTargets] = useState<AppRow[] | null>(null);
  const rowsById = Object.fromEntries(table.reactTable.getRowModel().rows.map((r) => [r.id, r.original]));

  return (
    <Page>
      <PageHeader
        title="Applications"
        description="Every application found in Google Workspace, Microsoft Entra ID and CSV imports. People with access counts anyone with current evidence (account, licence, OAuth grant, SSO assignment or sign-in); having access does not mean using it. Active counts only people with recorded activity, and only where a source reports activity."
        actions={
          <>
            {isAdmin && <ImportDialog />}
            <ExportDialog
              resource="applications"
              filters={currentFilters}
              matchingCount={table.refineCore.tableQuery.data?.total}
              selectedIds={Object.keys(table.reactTable.getState().rowSelection)}
            />
          </>
        }
        context={<SourceContext />}
      />
      <ResourceTable
        table={table}
        label="Applications"
        emptyTitle="No applications have been discovered yet"
        emptyHint="Connect Google Workspace or Microsoft Entra ID on the Integrations page, or import a CSV user export."
        filters={
          <>
            <SearchFilter table={table} label="Search applications" />
            <SelectFilter
              table={table}
              id="status"
              label="Status"
              allLabel="All except ignored"
              options={[...STATUS_OPTIONS, ["all", "All, including ignored"]]}
            />
            <SelectFilter
              table={table}
              id="category"
              label="Category"
              options={[
                ...(extra?.categories ?? []).map((c) => [c, c] as [string, string]),
                ...(extra?.no_category ? [[extra.no_category, "No category"] as [string, string]] : []),
              ]}
            />
            <SelectFilter table={table} id="source" label="Source" options={(extra?.sources ?? []).map((s) => [s, SOURCE_LABEL[s] ?? s])} />
          </>
        }
        selectionActions={(ids) => (
          <Button size="sm" onClick={() => setBulkTargets(ids.map((id) => rowsById[id]).filter(Boolean) as AppRow[])}>
            Change status
          </Button>
        )}
      />
      {bulkTargets && (
        <BulkStatusDialog
          targets={bulkTargets}
          onClose={() => {
            setBulkTargets(null);
            table.reactTable.resetRowSelection();
          }}
        />
      )}
    </Page>
  );
}

type Outcome = { id: number; name?: string; outcome: "completed" | "unchanged" | "failed" | "unknown"; message: string | null };
const OUTCOME: StateMap = {
  completed: ["Completed", "info"],
  unchanged: ["No change needed", "neutral"],
  failed: ["Failed", "failure"],
  unknown: ["Outcome unknown", "attention"],
};

/**
 * Bulk status change for exactly the reviewed ids. Results are shown per target. If the response is lost, every
 * target is "Outcome unknown" and the only offered action re-reads current state; nothing is re-submitted.
 */
function BulkStatusDialog({ targets: reviewed, onClose }: { targets: AppRow[]; onClose: () => void }) {
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<Outcome[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const refresh = useRefresh();
  const label = status ? APP_STATUS[status]?.[0] : "";

  async function apply() {
    setPending(true);
    try {
      const res = await api<{ results: Outcome[] }>("/api/applications/bulk-status", {
        method: "POST",
        body: { ids: reviewed.map((t) => t.id), status },
      });
      setResults(res.results);
    } catch (e) {
      const network = !(e instanceof Error && "status" in e);
      setResults(
        reviewed.map((t) => ({
          id: t.id,
          name: t.name,
          outcome: network ? "unknown" : "failed",
          message: network ? "The response did not arrive. Check the current status before doing anything else." : (e as Error).message,
        })),
      );
    } finally {
      setPending(false);
      refresh();
    }
  }

  async function checkStatus() {
    setCheckError(null);
    try {
      const checked = await Promise.all(
        (results ?? []).map(async (r) => {
          if (r.outcome !== "unknown") return r;
          const res = await api<{ app: { status: string } }>(`/api/applications/${r.id}`);
          return res.app.status === status
            ? { ...r, outcome: "completed" as const, message: `Status is now ${label}.` }
            : {
                ...r,
                outcome: "failed" as const,
                message: `Status is still ${APP_STATUS[res.app.status]?.[0] ?? res.app.status}; the change was not applied.`,
              };
        }),
      );
      setResults(checked);
    } catch {
      setCheckError("Could not check the current status. Try again in a moment.");
    }
  }

  const counts = results?.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change status of {plural(reviewed.length, "application")}</DialogTitle>
          <DialogDescription>
            Applies only to the applications listed below, by their ids. Other matching records are not affected.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          {!results && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="bulk-status">New status (required)</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="bulk-status" className="w-full">
                  <SelectValue placeholder="Choose a status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {results && counts && (
            <p role="status" className="text-sm text-fg">
              {formatNumber(counts.completed ?? 0)} completed · {formatNumber(counts.unchanged ?? 0)} no change needed ·{" "}
              {formatNumber(counts.failed ?? 0)} failed · {formatNumber(counts.unknown ?? 0)} outcome unknown
            </p>
          )}
          <div role="region" aria-label="Targets" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Application</TableHead>
                  <TableHead>{results ? "Status before" : "Current status"}</TableHead>
                  {results && <TableHead>Result</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewed.map((t) => {
                  const r = results?.find((x) => x.id === t.id);
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>
                        <StateBadge map={APP_STATUS} value={t.status} />
                      </TableCell>
                      {results && (
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <StateBadge map={OUTCOME} value={r?.outcome ?? "unknown"} />
                            {r?.message && <span className="text-xs text-fg-muted">{r.message}</span>}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {checkError && <ErrorPanel message={checkError} />}
        </DialogBody>
        <DialogFooter>
          {!results ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!status || pending} onClick={apply}>
                {pending ? "Applying…" : status ? `Set ${plural(reviewed.length, "application")} to ${label}` : "Choose a status"}
              </Button>
            </>
          ) : (
            <>
              {counts?.unknown ? (
                <Button variant="outline" onClick={checkStatus}>
                  Check current status
                </Button>
              ) : null}
              <Button onClick={onClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
