import { zodResolver } from "@hookform/resolvers/zod";
import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { ExportDialog } from "@/components/export-dialog";
import { Field, FormErrors } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Missing } from "@/components/missing";
import { Page, PageHeader } from "@/components/page";
import { ResourceTable, SearchFilter, SelectFilter, useFilters } from "@/components/resource-table";
import { SourceContext } from "@/components/source-context";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { ISSUE_KIND, ISSUE_STATUS, SEVERITY } from "@/lib/states";

type IssueRow = {
  id: number;
  kind: string;
  severity: string;
  title: string;
  detail: string | null;
  status: string;
  app_id: number | null;
  app_name: string | null;
  person_id: number | null;
  person_email: string | null;
  opened_at: string;
  resolved_at: string | null;
  accepted_by: string | null;
  accepted_reason: string | null;
  accepted_until: string | null;
};

export function IssueList() {
  const { isAdmin } = useRole();
  const columns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        id: "kind",
        accessorKey: "kind",
        header: "Issue",
        meta: { minWidth: 320 },
        cell: ({ row: { original: i } }) => (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fg">{i.title}</span>
            <span className="text-xs text-fg-muted">{ISSUE_KIND[i.kind] ?? i.kind}</span>
            {i.detail && <span className="text-xs [overflow-wrap:anywhere] text-fg-muted">{i.detail}</span>}
          </div>
        ),
      },
      {
        id: "severity_rank",
        accessorKey: "severity",
        header: "Severity",
        meta: { minWidth: 110 },
        cell: ({ getValue }) => <StateBadge map={SEVERITY} value={getValue<string>()} />,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        meta: { minWidth: 160 },
        cell: ({ row: { original: i } }) => (
          <div className="flex flex-col gap-1">
            <StateBadge map={ISSUE_STATUS} value={i.status} />
            {i.status === "accepted" && (
              <span className="text-xs text-fg-muted">
                by {i.accepted_by}
                {i.accepted_until ? <> until <Time iso={i.accepted_until} dateOnly /></> : " without expiry"}: {i.accepted_reason}
              </span>
            )}
            {i.status === "resolved" && i.resolved_at && (
              <span className="text-xs text-fg-muted">
                <Time iso={i.resolved_at} />
              </span>
            )}
          </div>
        ),
      },
      {
        id: "app",
        header: "Affected",
        enableSorting: false,
        meta: { minWidth: 200 },
        cell: ({ row: { original: i } }) =>
          i.app_id || i.person_id ? (
            <div className="flex flex-col">
              {i.app_id && (
                <Link to={`/applications/${i.app_id}`} className="text-fg underline-offset-4 hover:underline">
                  {i.app_name}
                </Link>
              )}
              {i.person_id && (
                <Link to={`/people/${i.person_id}`} className="text-xs text-fg-secondary underline-offset-4 hover:underline">
                  {i.person_email}
                </Link>
              )}
            </div>
          ) : (
            <Missing reason="not_applicable" />
          ),
      },
      {
        id: "opened_at",
        accessorKey: "opened_at",
        header: "Opened",
        meta: { minWidth: 180 },
        cell: ({ getValue }) => <Time iso={getValue<string>()} />,
      },
      ...(isAdmin
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">Actions</span>,
              enableSorting: false,
              meta: { minWidth: 140 },
              cell: ({ row: { original: i } }) =>
                i.status === "open" ? <AcceptDialog issue={i} /> : i.status === "accepted" ? <ReopenButton issue={i} /> : null,
            } satisfies ColumnDef<IssueRow>,
          ]
        : []),
    ],
    [isAdmin]
  );
  const table = useTable<IssueRow>({
    columns,
    getRowId: (r) => String(r.id),
    refineCoreProps: { resource: "issues", syncWithLocation: true, pagination: { pageSize: 25 } },
  });
  const filters = useFilters(table);

  return (
    <Page>
      <PageHeader
        title="Issues"
        description="Findings recomputed after every sync, import and change: leavers with access, unmatched accounts, sensitive scopes, unused grants to sensitive data, apps nobody uses, apps without a decision or owner, seat over-allocation, inactive seats, renewals and stale connectors. An issue resolves itself when its condition disappears."
        actions={
          <ExportDialog
            resource="issues"
            filters={Object.fromEntries(["q", "status", "severity", "kind", "app_id", "person_id"].map((k) => [k, filters.value(k)]))}
            matchingCount={table.refineCore.tableQuery.data?.total}
          />
        }
        context={<SourceContext />}
      />
      <ResourceTable
        table={table}
        label="Issues"
        emptyTitle="No open issues"
        emptyHint="Choose status All to see resolved and accepted issues."
        filters={
          <>
            <SearchFilter table={table} label="Search issues" />
            <SelectFilter
              table={table}
              id="status"
              label="Status"
              allLabel="Open"
              options={[["accepted", "Accepted risk"], ["resolved", "Resolved"], ["all", "All"]]}
            />
            <SelectFilter table={table} id="severity" label="Severity" options={Object.entries(SEVERITY).map(([k, [v]]) => [k, v])} />
            <SelectFilter table={table} id="kind" label="Type" options={Object.entries(ISSUE_KIND)} />
          </>
        }
      />
    </Page>
  );
}

const acceptSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(1000),
  until: z.string(),
});

function AcceptDialog({ issue }: { issue: IssueRow }) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const refresh = useRefresh();
  const { register, handleSubmit, formState, reset } = useForm<z.infer<typeof acceptSchema>>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { reason: "", until: "" },
  });
  const submit = handleSubmit(async (v) => {
    setServerError(null);
    try {
      await api(`/api/issues/${issue.id}/accept`, { method: "POST", body: { reason: v.reason, until: v.until || null } });
      setOpen(false);
      reset();
      refresh();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Could not record the exception.");
    }
  });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Accept risk<span className="sr-only">: {issue.title}</span>
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        dirty={formState.isDirty}
        title="Accept this risk"
        description={issue.title}
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-6">
            {serverError && <FormErrors errors={[serverError]} />}
            <Field label="Reason" required error={formState.errors.reason?.message}>
              {(a) => <Textarea {...a} {...register("reason")} />}
            </Field>
            <Field label="Accepted until" helper="Optional. The issue reopens automatically after this date if its condition still exists.">
              {(a) => <Input {...a} type="date" {...register("until")} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? "Saving…" : "Accept risk"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}

function ReopenButton({ issue }: { issue: IssueRow }) {
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await api(`/api/issues/${issue.id}/reopen`, { method: "POST" });
            refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not reopen.");
          } finally {
            setPending(false);
          }
        }}
      >
        Reopen<span className="sr-only">: {issue.title}</span>
      </Button>
      {error && <span role="alert" className="text-xs text-failure-fg">{error}</span>}
    </div>
  );
}
