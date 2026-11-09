import { zodResolver } from "@hookform/resolvers/zod";
import { type BaseRecord, type HttpError, useOne } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Controller } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { z } from "zod";

import { AccessTable } from "@/components/access-table";
import { AppTile } from "@/components/app-tile";
import { ActiveCount, type UsageSummary } from "@/components/usage";
import { Field, FormErrors } from "@/components/field";
import { FormDialog, errorList } from "@/components/form-dialog";
import { LicensePlansTable, type PlanRow } from "@/components/license-plans";
import { Missing, OrMissing } from "@/components/missing";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel } from "@/components/panels";
import { RequestDialog } from "@/components/request-dialog";
import { RequestsTable } from "@/components/requests-table";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { LicenseFormDialog } from "@/components/license-form";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import {
  APP_STATUS,
  FRESHNESS,
  ISSUE_KIND,
  ISSUE_STATUS,
  SEVERITY,
  SOURCE_LABEL,
} from "@/lib/states";
import { STATUS_OPTIONS } from "@/pages/applications/list";

type App = {
  id: number;
  name: string;
  status: string;
  category: string | null;
  owner_email: string | null;
  website: string | null;
  notes: string | null;
  first_seen: string;
  updated_at: string | null;
};
type Detail = {
  app: App;
  summary: {
    people: number;
    open_issues: number;
    last_observed: string | null;
    usage: UsageSummary;
  };
  sources: {
    source: string;
    external_id: string;
    label: string | null;
    first_seen: string;
    last_seen: string;
    freshness: string;
  }[];
  licenses: PlanRow[];
  issues: {
    id: number;
    kind: string;
    severity: string;
    title: string;
    detail: string | null;
    status: string;
    opened_at: string;
  }[];
  events: AuditEvent[];
  merge_targets: { id: number; name: string }[];
  freshness_policy: string;
  inactivity_days: number;
};
export type AuditEvent = {
  id: number;
  event_id: string;
  occurred_at: string;
  actor: string;
  action: string;
  detail: string | null;
};

const TABS = [
  "overview",
  "access",
  "licenses",
  "requests",
  "activity",
] as const;

export function ApplicationShow() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get("tab") as never)
    ? params.get("tab")!
    : "overview";
  const { isAdmin, workflows } = useRole();
  const { query, result } = useOne<Detail>({
    resource: "applications",
    id: id!,
  });
  const d = result as Detail | undefined;

  if (query.isLoading) return <LoadingPanel label="Loading application…" />;
  if (query.isError || !d)
    return (
      <ErrorPanel
        message={
          query.error?.statusCode === 404
            ? "This application does not exist. It may have been merged."
            : query.error?.message
        }
        onRetry={() => query.refetch()}
      />
    );
  const { app } = d;

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link
            to="/applications"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
            Applications
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <AppTile id={app.id} name={app.name} website={app.website} />
            {app.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge map={APP_STATUS} value={app.status} />
            <span>{app.category ?? "No category"}</span>
          </span>
        }
        actions={
          isAdmin ? (
            <>
              {workflows && (
                <RequestDialog
                  label="Request access"
                  preset={{ app_id: app.id }}
                />
              )}
              <EditAppDialog app={app} />
            </>
          ) : undefined
        }
      />
      {!isAdmin && (
        <p className="text-sm text-fg-secondary">
          Your auditor role can read and export this record, but not change it.
        </p>
      )}

      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ tab: v }, { replace: true })}
      >
        <TabsList aria-label="Application sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="access">
            People and access ({formatNumber(d.summary.people)})
          </TabsTrigger>
          <TabsTrigger value="licenses">
            Licenses ({formatNumber(d.licenses.length)})
          </TabsTrigger>
          {workflows && <TabsTrigger value="requests">Requests</TabsTrigger>}
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <Details
                  items={[
                    [
                      "Status",
                      <StateBadge map={APP_STATUS} value={app.status} />,
                    ],
                    [
                      "Owner",
                      app.owner_email ?? <Missing>No owner assigned</Missing>,
                    ],
                    ["Category", <OrMissing value={app.category} />],
                    [
                      "Website",
                      app.website ? (
                        <a
                          href={app.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {app.website}
                        </a>
                      ) : (
                        <Missing reason="not_reported" />
                      ),
                    ],
                    [
                      "People with access",
                      <span className="tabular">
                        {formatNumber(d.summary.people)}
                      </span>,
                    ],
                    [
                      `Active in last ${d.inactivity_days} days`,
                      <ActiveCount
                        usage={d.summary.usage}
                        days={d.inactivity_days}
                      />,
                    ],
                    [
                      "Open issues",
                      <span className="tabular">
                        {formatNumber(d.summary.open_issues)}
                      </span>,
                    ],
                    ["First seen", <Time iso={app.first_seen} />],
                    [
                      "Last observation",
                      <Time
                        iso={d.summary.last_observed}
                        missing="not_synced"
                      />,
                    ],
                    [
                      "Notes",
                      <OrMissing value={app.notes} reason="not_applicable" />,
                    ],
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Open issues</CardTitle>
                <Link
                  to={`/issues?filters[0][field]=app_id&filters[0][operator]=eq&filters[0][value]=${app.id}&filters[1][field]=status&filters[1][operator]=eq&filters[1][value]=all`}
                  className="text-sm text-primary underline-offset-4 hover:underline"
                >
                  All issues for this application
                </Link>
              </CardHeader>
              <CardContent>
                {d.issues.length === 0 ? (
                  <p className="text-sm text-fg-secondary">
                    No open or accepted issues.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {d.issues.map((i) => (
                      <li key={i.id} className="flex flex-col gap-1">
                        <div className="flex flex-wrap gap-1">
                          <StateBadge map={SEVERITY} value={i.severity} />
                          <StateBadge map={ISSUE_STATUS} value={i.status} />
                          <span className="text-xs text-fg-muted">
                            {ISSUE_KIND[i.kind] ?? i.kind}
                          </span>
                        </div>
                        <span className="text-sm text-fg">{i.title}</span>
                        {i.detail && (
                          <span className="text-xs [overflow-wrap:anywhere] text-fg-muted">
                            {i.detail}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Sources</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">{d.freshness_policy}</p>
              <div
                role="region"
                aria-label="Sources table"
                tabIndex={0}
                className="relative overflow-x-auto rounded-lg border border-line"
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Identifier</TableHead>
                      <TableHead>First seen</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead>Freshness</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.sources.map((s) => (
                      <TableRow key={`${s.source}:${s.external_id}`}>
                        <TableCell>
                          {SOURCE_LABEL[s.source] ?? s.source}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {s.external_id}
                        </TableCell>
                        <TableCell>
                          <Time iso={s.first_seen} />
                        </TableCell>
                        <TableCell>
                          <Time iso={s.last_seen} />
                        </TableCell>
                        <TableCell>
                          <StateBadge map={FRESHNESS} value={s.freshness} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          {isAdmin && <MergeCard app={app} targets={d.merge_targets} />}
        </TabsContent>

        <TabsContent value="access">
          <AccessTable scope={{ app_id: app.id }} />
        </TabsContent>

        <TabsContent value="licenses">
          {isAdmin && (
            <div className="flex justify-end">
              <LicenseFormDialog appId={app.id} variant="outline" />
            </div>
          )}
          <LicensePlansTable
            plans={d.licenses}
            inactivityDays={d.inactivity_days}
          />
        </TabsContent>

        <TabsContent value="requests">
          <RequestsTable scope={{ app_id: app.id }} />
        </TabsContent>

        <TabsContent value="activity">
          <ActivityList
            events={d.events}
            empty="No recorded changes for this application."
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

export function ActivityList({
  events,
  empty,
}: {
  events: AuditEvent[];
  empty: string;
}) {
  if (!events.length)
    return <p className="text-sm text-fg-secondary">{empty}</p>;
  return (
    <div
      role="region"
      aria-label="Activity table"
      tabIndex={0}
      className="relative overflow-x-auto rounded-lg border border-line bg-surface"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead style={{ minWidth: 180 }}>Event time</TableHead>
            <TableHead style={{ minWidth: 180 }}>Actor</TableHead>
            <TableHead style={{ minWidth: 160 }}>Action</TableHead>
            <TableHead style={{ minWidth: 280 }}>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e.id}>
              <TableCell>
                <Time iso={e.occurred_at} />
              </TableCell>
              <TableCell>{e.actor}</TableCell>
              <TableCell className="font-mono text-xs">{e.action}</TableCell>
              <TableCell className="font-mono text-xs text-fg-secondary">
                {e.detail ?? <Missing reason="not_applicable" />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const editSchema = z.object({
  status: z.string().min(1, "Choose a status."),
  owner_email: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
      "Enter a valid owner email address.",
    ),
  category: z
    .string()
    .trim()
    .max(100, "Keep the category under 100 characters."),
  website: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || /^https?:\/\//.test(v),
      "The website must start with https://",
    ),
  notes: z.string().max(4000, "Keep notes under 4,000 characters."),
});
type EditValues = z.infer<typeof editSchema>;

function EditAppDialog({ app }: { app: App }) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const refresh = useRefresh();
  const defaults: EditValues = {
    status: app.status,
    owner_email: app.owner_email ?? "",
    category: app.category ?? "",
    website: app.website ?? "",
    notes: app.notes ?? "",
  };
  const { register, control, handleSubmit, formState, reset, refineCore } =
    useForm<BaseRecord, HttpError, EditValues>({
      refineCoreProps: {
        resource: "applications",
        action: "edit",
        id: app.id,
        redirect: false,
        queryOptions: { enabled: false },
        successNotification: false,
        errorNotification: false,
        onMutationSuccess: () => {
          setOpen(false);
          refresh();
        },
        onMutationError: (e) => setServerError(e.message),
      },
      resolver: zodResolver(editSchema),
      defaultValues: defaults,
      warnWhenUnsavedChanges: false,
    });
  const errors = formState.errors;
  const summary = errorList(errors as never, serverError);
  const submit = handleSubmit((v) =>
    refineCore.onFinish({
      status: v.status,
      owner_email: v.owner_email || null,
      category: v.category || null,
      website: v.website || null,
      notes: v.notes || null,
    } as never),
  );

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          reset(defaults);
          setServerError(null);
          setOpen(true);
        }}
      >
        Edit details
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        dirty={formState.isDirty}
        title={`Edit ${app.name}`}
      >
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody className="flex flex-col gap-6">
            {formState.submitCount > 0 &&
              (summary.length > 1 || serverError) && (
                <FormErrors errors={summary} />
              )}
            <Field
              label="Status"
              required
              error={errors.status?.message}
              helper="Sanctioned apps need an owner; unsanctioned apps with sensitive scopes raise an issue."
            >
              {(a) => (
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger ref={field.ref} {...a} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map(([k, v]) => (
                          <SelectItem key={k} value={k}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
            <Field label="Owner email" error={errors.owner_email?.message}>
              {(a) => (
                <Input
                  {...a}
                  type="email"
                  autoComplete="off"
                  {...register("owner_email")}
                />
              )}
            </Field>
            <Field label="Category" error={errors.category?.message}>
              {(a) => <Input {...a} {...register("category")} />}
            </Field>
            <Field
              label="Website"
              helper="Starts with https://"
              error={errors.website?.message}
            >
              {(a) => <Input {...a} type="url" {...register("website")} />}
            </Field>
            <Field label="Notes" error={errors.notes?.message}>
              {(a) => <Textarea {...a} {...register("notes")} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={refineCore.formLoading}>
              {refineCore.formLoading ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}

function MergeCard({
  app,
  targets,
}: {
  app: App;
  targets: { id: number; name: string }[];
}) {
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const refresh = useRefresh();
  const targetName = targets.find((t) => String(t.id) === target)?.name;

  async function merge() {
    setError(null);
    try {
      await api(`/api/applications/${app.id}/merge`, {
        method: "POST",
        body: { target_id: Number(target) },
      });
      refresh();
      navigate(`/applications/${target}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Merge into another application</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-fg-secondary">
          Use this when the same product was discovered under two names or
          sources.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-[240px] flex-col gap-2">
            <Label htmlFor="merge-target">Merge into</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="merge-target" className="w-full">
                <SelectValue placeholder="Choose an application" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={!target}
            onClick={() => setConfirm(true)}
          >
            Review merge
          </Button>
        </div>
        {error && <ErrorPanel title="Merge failed" message={error} />}
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Merge {app.name} into {targetName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                All sources, access evidence, licence plans, issues and requests
                of {app.name} move to {targetName}, and {app.name} is deleted.
                This cannot be undone. The merge is recorded in the audit log.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep both</AlertDialogCancel>
              <AlertDialogAction destructive onClick={merge}>
                Merge into {targetName}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
