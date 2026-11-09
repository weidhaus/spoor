import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { ShieldCheck } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { ExportDialog } from "@/components/export-dialog";
import { Missing } from "@/components/missing";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel } from "@/components/panels";
import { ResourceTable, SearchFilter, SelectFilter, type TableModel, useFilters } from "@/components/resource-table";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { AUDIT_OUTCOME } from "@/lib/states";

type Event = {
  id: number;
  event_id: string;
  occurred_at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
  outcome: string;
  origin: "user" | "system";
};

const TARGET_TYPES: [string, string][] = [
  ["app", "Application"],
  ["request", "Access request"],
  ["subscription", "Licence plan"],
  ["issue", "Issue"],
  ["user", "User or role"],
  ["integration", "Integration"],
  ["export", "Export"],
];
const TARGET_LABEL = Object.fromEntries(TARGET_TYPES);

export function AuditPage() {
  const [open, setOpen] = useState<Event | null>(null);
  const columns = useMemo<ColumnDef<Event>[]>(
    () => [
      {
        id: "occurred_at",
        accessorKey: "occurred_at",
        header: "Event time",
        meta: { minWidth: 190 },
        cell: ({ getValue }) => <Time iso={getValue<string>()} />,
      },
      { id: "actor", accessorKey: "actor", header: "Actor", meta: { minWidth: 200 } },
      {
        id: "action",
        accessorKey: "action",
        header: "Action",
        meta: { minWidth: 170 },
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span>,
      },
      {
        id: "target",
        header: "Target",
        enableSorting: false,
        meta: { minWidth: 180 },
        cell: ({ row: { original: e } }) =>
          e.target_type ? (
            <span>
              {TARGET_LABEL[e.target_type] ?? e.target_type}
              {e.target_id && <span className="text-fg-muted"> · {e.target_id}</span>}
            </span>
          ) : (
            <Missing reason="not_applicable" />
          ),
      },
      {
        id: "outcome",
        accessorKey: "outcome",
        header: "Outcome",
        enableSorting: false,
        meta: { minWidth: 110 },
        cell: ({ getValue }) => <StateBadge map={AUDIT_OUTCOME} value={getValue<string>()} />,
      },
      {
        id: "origin",
        accessorKey: "origin",
        header: "Source",
        enableSorting: false,
        meta: { minWidth: 130 },
        cell: ({ getValue }) => (getValue<string>() === "user" ? "Signed-in user" : "System (sync, scheduler)"),
      },
      {
        id: "details",
        header: () => <span className="sr-only">Details</span>,
        enableSorting: false,
        cell: ({ row: { original: e } }) => (
          <Button variant="ghost" size="sm" onClick={() => setOpen(e)}>
            Details<span className="sr-only"> of {e.action} at {formatDateTime(e.occurred_at)}</span>
          </Button>
        ),
      },
    ],
    []
  );
  const table = useTable<Event>({
    columns,
    getRowId: (r) => String(r.id),
    refineCoreProps: { resource: "audit", syncWithLocation: true, pagination: { pageSize: 25 } },
  });
  const filters = useFilters(table);
  const actions = (table.refineCore.tableQuery.data as { extra?: { actions?: string[] } } | undefined)?.extra?.actions ?? [];
  const current = Object.fromEntries(["from", "to", "actor", "action", "target_type", "outcome", "q"].map((k) => [k, filters.value(k)]));

  return (
    <Page>
      <PageHeader
        title="Audit and exports"
        description="Every sign-in, change, sync, import, export and verification. The log is append-only and each event is HMAC-chained to the previous one. Exports of any resource start here."
        actions={
          <>
            <ExportDialog resource="audit" filters={current} matchingCount={table.refineCore.tableQuery.data?.total} chooseResource />
            <VerifyIntegrity />
          </>
        }
      />
      <ResourceTable
        table={table}
        label="Audit events"
        emptyTitle="No audit events yet"
        filters={
          <>
            <DateFilter table={table} id="from" label="From date" />
            <DateFilter table={table} id="to" label="To date" />
            <SearchFilter table={table} id="actor" label="Actor" />
            <SelectFilter table={table} id="action" label="Action" options={actions.map((a) => [a, a])} />
            <SelectFilter table={table} id="target_type" label="Target" options={TARGET_TYPES} />
            <SelectFilter table={table} id="outcome" label="Outcome" options={[["completed", "Completed"], ["failed", "Failed"]]} />
          </>
        }
      />
      <Sheet open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent side="right">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-sm">{open.action}</SheetTitle>
                <SheetDescription>{formatDateTime(open.occurred_at)}</SheetDescription>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-6">
                <Details
                  items={[
                    ["Event time", <Time iso={open.occurred_at} />],
                    ["Ingestion time", "Same as event time: events are written when they happen."],
                    ["Actor", open.actor],
                    ["Action", <span className="font-mono text-xs">{open.action}</span>],
                    ["Target", open.target_type ? `${TARGET_LABEL[open.target_type] ?? open.target_type} ${open.target_id ?? ""}` : <Missing reason="not_applicable" />],
                    ["Outcome", <StateBadge map={AUDIT_OUTCOME} value={open.outcome} />],
                    ["Event id", <span className="font-mono text-xs">{open.event_id}</span>],
                  ]}
                />
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-fg">Details, including before and after values</h3>
                  {open.detail ? (
                    <pre className="overflow-x-auto rounded-md border border-line bg-canvas p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {JSON.stringify(JSON.parse(open.detail), null, 2)}
                    </pre>
                  ) : (
                    <Missing reason="not_applicable" />
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-fg">Chain evidence</h3>
                  <Details
                    items={[
                      ["Previous hash", <span className="font-mono text-xs break-all">{open.prev_hash || "(first event)"}</span>],
                      ["Event hash", <span className="font-mono text-xs break-all">{open.hash}</span>],
                    ]}
                  />
                </div>
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Page>
  );
}

function DateFilter({ table, id, label }: { table: TableModel<Event>; id: string; label: string }) {
  const filters = useFilters(table);
  const inputId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <Input id={inputId} type="date" value={filters.value(id)} onChange={(e) => filters.set(id, e.target.value)} className="w-44" />
    </div>
  );
}

function VerifyIntegrity() {
  const [state, setState] = useState<{ ok: boolean; events: number; first_bad_event: string | null; checked_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            setState(await api("/api/audit/verify", { method: "POST" }));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Verification failed to run.");
          } finally {
            setPending(false);
          }
        }}
      >
        <ShieldCheck strokeWidth={1.75} aria-hidden />
        {pending ? "Verifying…" : "Verify integrity"}
      </Button>
      <div role="status" aria-live="polite" className="max-w-xs text-xs">
        {state &&
          (state.ok ? (
            <span className="text-fg-secondary">
              Chain intact: {formatNumber(state.events)} events checked at {formatDateTime(state.checked_at)}.
            </span>
          ) : (
            <span className="font-medium text-failure-fg">
              Integrity failure at event {state.first_bad_event} (#{state.events}). Investigate before trusting the log.
            </span>
          ))}
        {error && <ErrorPanel message={error} />}
      </div>
    </div>
  );
}
