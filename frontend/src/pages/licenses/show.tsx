import { useOne } from "@refinedev/core";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { type LicenseRecord, LicenseFormDialog } from "@/components/license-form";
import { Availability, Cost, type PlanRow, Usage } from "@/components/license-plans";
import { Missing, OrMissing } from "@/components/missing";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel, Notice } from "@/components/panels";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { PERSON_STATUS, SOURCE_LABEL } from "@/lib/states";

type Detail = {
  license: PlanRow & LicenseRecord & { owner_email: string | null; notes: string | null; external_id: string | null; last_seen: string | null };
  seats: { id: number; email: string | null; person_id: number | null; name: string | null; person_status: string | null; source: string; last_activity: string | null }[];
  has_activity: boolean;
  inactivity_days: number;
  cutoff: string;
};

export function LicenseShow() {
  const { id } = useParams();
  const { isAdmin } = useRole();
  const { query, result } = useOne<Detail>({ resource: "licenses", id: id! });
  const d = result as Detail | undefined;
  if (query.isLoading) return <LoadingPanel label="Loading licence plan…" />;
  if (query.isError || !d) return <ErrorPanel message={query.error?.message} onRetry={() => query.refetch()} />;
  const l = d.license;
  const discrepancy = l.observed_consumed !== null && l.observed_consumed !== l.assigned;

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link to="/licenses" className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
            <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
            Licenses
          </Link>
        }
        title={l.name}
        description={
          <>
            Plan of{" "}
            <Link to={`/applications/${l.app_id}`} className="text-primary underline-offset-4 hover:underline">
              {l.app_name}
            </Link>{" "}
            · {SOURCE_LABEL[l.source] ?? l.source}
          </>
        }
        actions={
          isAdmin ? (
            <>
              <LicenseFormDialog license={l} variant="outline" />
              {l.source === "manual" && <DeletePlan id={l.id} name={l.name} />}
            </>
          ) : undefined
        }
      />
      {discrepancy && (
        <Notice tone="attention">
          The source reports {formatNumber(l.observed_consumed!)} consumed seats, but {formatNumber(l.assigned)} assignments are observed. Both values
          are shown as reported; neither is corrected.
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Seats and cost</CardTitle>
        </CardHeader>
        <CardContent>
          <Details
            items={[
              ["Purchased", l.quantity === null ? <Missing reason="not_reported" /> : <span className="tabular">{formatNumber(l.quantity)}</span>],
              ["Assigned (observed)", <span className="tabular">{formatNumber(l.assigned)}</span>],
              ["Available or over-allocated", <Availability plan={l} />],
              ["Consumed (reported by source)", l.observed_consumed === null ? <Missing reason="not_applicable" /> : <span className="tabular">{formatNumber(l.observed_consumed)}</span>],
              ["Usage", <Usage plan={l} inactivityDays={d.inactivity_days} />],
              ["Cost", <Cost plan={l} />],
              [
                "Annual cost",
                l.annual_cost === null ? (
                  <Missing reason="not_reported" />
                ) : (
                  <span className="tabular">
                    {formatMoney(l.annual_cost, l.currency)} ({l.quantity === null ? "cost × assigned seats" : "cost × purchased seats"}, per year)
                  </span>
                ),
              ],
              ["Renewal date", <Time iso={l.renewal_date} dateOnly missing="not_reported" />],
              ["Owner", <OrMissing value={l.owner_email} reason="not_reported" />],
              ["Notes", <OrMissing value={l.notes} reason="not_applicable" />],
              ["Last reported by source", <Time iso={l.last_seen} missing="not_applicable" />],
            ]}
          />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4" aria-labelledby="seats-heading">
        <div className="flex flex-col gap-1">
          <h2 id="seats-heading" className="text-base font-semibold text-fg">
            Assigned seats ({formatNumber(d.seats.length)})
          </h2>
          <p className="text-sm text-fg-secondary">
            {d.has_activity
              ? `Last activity is the latest activity for that person in ${l.app_name} from any source. Inactive for ${d.inactivity_days} days marks a reclaim candidate, not proof of waste.`
              : `No source reports activity for ${l.app_name}, so usage is not reported. A missing value is not inactivity.`}
          </p>
        </div>
        {d.seats.length === 0 ? (
          <p className="text-sm text-fg-secondary">No active assignment is linked to this plan.</p>
        ) : (
          <div role="region" aria-label="Seats table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ minWidth: 240 }}>Person</TableHead>
                  <TableHead style={{ minWidth: 140 }}>Account status</TableHead>
                  <TableHead style={{ minWidth: 160 }}>Source</TableHead>
                  <TableHead style={{ minWidth: 200 }}>Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.seats.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      {s.person_id ? (
                        <div className="flex flex-col">
                          <Link to={`/people/${s.person_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                            {s.name ?? s.email}
                          </Link>
                          {s.name && <span className="text-xs text-fg-muted">{s.email}</span>}
                        </div>
                      ) : (
                        <div className="flex flex-col">
                          <span className="font-medium">{s.email}</span>
                          <span className="text-xs text-fg-muted">Not matched to a known person</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{s.person_status ? <StateBadge map={PERSON_STATUS} value={s.person_status} /> : <Missing reason="unknown" />}</TableCell>
                    <TableCell>{SOURCE_LABEL[s.source] ?? s.source}</TableCell>
                    <TableCell>
                      {s.last_activity ? (
                        <div className="flex flex-col">
                          <Time iso={s.last_activity} />
                          {s.last_activity < d.cutoff && <span className="text-xs text-attention-fg">No activity in {d.inactivity_days} days</span>}
                        </div>
                      ) : (
                        <Missing reason="not_reported" />
                      )}
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

function DeletePlan({ id, name }: { id: number; name: string }) {
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Delete plan</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the plan “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The plan record is removed. Accounts linked to it stay, without a plan. The deletion, with the plan’s previous values, is recorded
            in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <ErrorPanel message={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep plan</AlertDialogCancel>
          <AlertDialogAction
            destructive
            onClick={async (e) => {
              e.preventDefault();
              try {
                await api(`/api/licenses/${id}`, { method: "DELETE" });
                refresh();
                navigate("/licenses");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Delete failed.");
              }
            }}
          >
            Delete plan
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
