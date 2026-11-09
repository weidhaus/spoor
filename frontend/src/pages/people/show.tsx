import { useOne } from "@refinedev/core";
import { ChevronLeft } from "lucide-react";
import { Link, useParams } from "react-router";

import { AccessTable } from "@/components/access-table";
import { OrMissing } from "@/components/missing";
import {
  OffboardDialog,
  type OffboardStep,
} from "@/components/offboard-dialog";
import { type Observation, ObservationSummary } from "@/components/observation";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel } from "@/components/panels";
import { RequestDialog } from "@/components/request-dialog";
import { type SecurityActions, SecurityActionsCard } from "@/components/security-actions";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRole } from "@/hooks/use-role";
import {
  DECISION,
  EXECUTION,
  HR_STATUS,
  ISSUE_KIND,
  OFFBOARD_EVENT,
  ISSUE_STATUS,
  PERSON_STATUS,
  REQUEST_TYPE,
  SEVERITY,
  SOURCE_LABEL,
  VERIFICATION,
} from "@/lib/states";

type Detail = {
  security_actions: SecurityActions | null;
  person: {
    id: number;
    name: string | null;
    email: string;
    department: string | null;
    title: string | null;
    manager_email: string | null;
    kind: string;
    status: string;
    status_source: string | null;
    first_seen: string;
    last_seen: string;
  };
  emails: string[];
  hr: {
    personio_id: string;
    status: string;
    hire_date: string | null;
    leave_date: string | null;
    department: string | null;
    title: string | null;
    supervisor_email: string | null;
    removed_at: string | null;
    last_seen: string;
  }[];
  requests: {
    id: number;
    type: string;
    app_id: number;
    app_name: string;
    requested_access: string | null;
    requested_at: string;
    decision: string;
    execution: string;
    observed: Observation;
    verification: string;
  }[];
  issues: {
    id: number;
    kind: string;
    severity: string;
    title: string;
    status: string;
    app_name: string | null;
  }[];
  offboarding: {
    steps: OffboardStep[];
    default_recipient: string | null;
    history: {
      occurred_at: string;
      actor: string;
      action: string;
      detail: string | null;
    }[];
  };
};

function eventText(e: { action: string; detail: string | null }) {
  const d = e.detail ? JSON.parse(e.detail) : {};
  if (e.action === "offboarding.started")
    return `Steps: ${(d.steps ?? []).join(", ")}${d.recipient ? ` · recipient ${d.recipient}` : ""}`;
  return [d.label, d.detail ?? d.error].filter(Boolean).join(": ");
}

export function PersonShow() {
  const { id } = useParams();
  const { isAdmin, workflows, officer, email } = useRole();
  const { query, result } = useOne<Detail>({ resource: "people", id: id! });
  const d = result as Detail | undefined;
  if (query.isLoading) return <LoadingPanel label="Loading person…" />;
  if (query.isError || !d)
    return (
      <ErrorPanel
        message={query.error?.message}
        onRetry={() => query.refetch()}
      />
    );
  const p = d.person;
  const aliases = d.emails.filter((e) => e !== p.email);

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link
            to="/people"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
            People and access
          </Link>
        }
        title={p.name ?? p.email}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="[overflow-wrap:anywhere]">{p.email}</span>
            <StateBadge map={PERSON_STATUS} value={p.status} />
            {p.kind === "guest" && <Badge>External guest</Badge>}
          </span>
        }
        actions={
          isAdmin && workflows ? (
            <>
              <RequestDialog
                label="Request access"
                preset={{ person_id: p.id, type: "grant" }}
              />
              <RequestDialog
                label="Request revocation"
                variant="outline"
                preset={{ person_id: p.id, type: "revoke" }}
              />
              {d.offboarding.steps.some((s) => s.available) && (
                <OffboardDialog
                  person={p}
                  steps={d.offboarding.steps}
                  defaultRecipient={d.offboarding.default_recipient}
                />
              )}
            </>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <Details
              items={[
                ["Primary email", p.email],
                [
                  "Aliases",
                  aliases.length ? (
                    <ul>
                      {aliases.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  ) : (
                    <OrMissing value={null} reason="not_reported" />
                  ),
                ],
                ["Department", <OrMissing value={p.department} />],
                ["Job title", <OrMissing value={p.title} />],
                ["Manager", <OrMissing value={p.manager_email} />],
                [
                  "Status source",
                  <OrMissing
                    value={
                      p.status_source &&
                      (SOURCE_LABEL[p.status_source] ?? p.status_source)
                    }
                    reason="unknown"
                  />,
                ],
                ["First seen", <Time iso={p.first_seen} />],
                ["Last observation", <Time iso={p.last_seen} />],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>HR record (Personio)</CardTitle>
          </CardHeader>
          <CardContent>
            {d.hr.length === 0 ? (
              <p className="text-sm text-fg-secondary">
                No Personio employee matches this person's email addresses.
              </p>
            ) : (
              <div className="flex flex-col gap-6">
                {d.hr.map((h) => (
                  <Details
                    key={h.personio_id}
                    items={[
                      [
                        "Employment",
                        <span className="flex flex-wrap gap-1">
                          <StateBadge map={HR_STATUS} value={h.status} />
                          {h.removed_at && <Badge>No longer in Personio</Badge>}
                        </span>,
                      ],
                      ["Hire date", <OrMissing value={h.hire_date} />],
                      [
                        "Last working day",
                        <OrMissing
                          value={h.leave_date}
                          reason="not_applicable"
                        />,
                      ],
                      ["Department", <OrMissing value={h.department} />],
                      ["Position", <OrMissing value={h.title} />],
                      ["Supervisor", <OrMissing value={h.supervisor_email} />],
                      ["Personio ID", h.personio_id],
                      ["Last observation", <Time iso={h.last_seen} />],
                    ]}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Open issues</CardTitle>
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
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {d.offboarding.history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Offboarding history</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {d.offboarding.history.map((e, i) => (
                <li key={i} className="flex flex-col gap-1 text-sm">
                  <span className="text-fg">
                    {OFFBOARD_EVENT[e.action] ?? e.action} ·{" "}
                    <span className="text-fg-muted">
                      {e.actor}, <Time iso={e.occurred_at} />
                    </span>
                  </span>
                  <span className="text-xs text-fg-secondary [overflow-wrap:anywhere]">
                    {eventText(e)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {d.security_actions && <SecurityActionsCard person={p} data={d.security_actions} officer={officer} me={email} />}

      <section className="flex flex-col gap-4" aria-labelledby="access-heading">
        <h2 id="access-heading" className="text-base font-semibold text-fg">
          Access
        </h2>
        <AccessTable scope={{ person_id: p.id }} />
      </section>

      <section
        className="flex flex-col gap-4"
        aria-labelledby="requests-heading"
      >
        <h2 id="requests-heading" className="text-base font-semibold text-fg">
          Access requests
        </h2>
        {d.requests.length === 0 ? (
          <p className="text-sm text-fg-secondary">
            No access requests for this person.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Access requests table"
            tabIndex={0}
            className="relative overflow-x-auto rounded-lg border border-line bg-surface"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ minWidth: 220 }}>Request</TableHead>
                  <TableHead style={{ minWidth: 150 }}>Decision</TableHead>
                  <TableHead style={{ minWidth: 130 }}>Execution</TableHead>
                  <TableHead style={{ minWidth: 240 }}>
                    Observed access
                  </TableHead>
                  <TableHead style={{ minWidth: 190 }}>Verification</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link
                          to={`/requests/${r.id}`}
                          className="font-medium text-fg underline-offset-4 hover:underline"
                        >
                          {REQUEST_TYPE[r.type]}: {r.app_name}
                        </Link>
                        <span className="text-xs text-fg-muted">
                          #{r.id} · <Time iso={r.requested_at} />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StateBadge map={DECISION} value={r.decision} />
                    </TableCell>
                    <TableCell>
                      <StateBadge map={EXECUTION} value={r.execution} />
                    </TableCell>
                    <TableCell>
                      <ObservationSummary obs={r.observed} />
                    </TableCell>
                    <TableCell>
                      <StateBadge map={VERIFICATION} value={r.verification} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </Page>
  );
}
