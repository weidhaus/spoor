import { zodResolver } from "@hookform/resolvers/zod";
import { useOne } from "@refinedev/core";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useParams } from "react-router";
import { z } from "zod";

import { Field, FormErrors } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Missing } from "@/components/missing";
import { type Observation, ObservationSummary } from "@/components/observation";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel } from "@/components/panels";
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
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { DECISION, EXECUTION, REQUEST_TYPE, SOURCE_LABEL, VERIFICATION } from "@/lib/states";
import { ActivityList, type AuditEvent } from "@/pages/applications/show";

type Req = {
  id: number;
  type: "grant" | "revoke";
  person_id: number;
  person_name: string | null;
  person_email: string;
  app_id: number;
  app_name: string;
  requested_access: string | null;
  justification: string;
  requested_by: string;
  requested_at: string;
  decision: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  execution: string;
  executed_by: string | null;
  executed_at: string | null;
  execution_note: string | null;
  observed: Observation;
  verification: string;
};
type Detail = { request: Req; events: AuditEvent[]; freshness_policy: string };

function verificationText(r: Req) {
  const want = r.type === "grant" ? "Present" : "Absent";
  switch (r.verification) {
    case "not_applicable":
      return "Verification starts once an approved change is recorded as completed.";
    case "awaiting":
      return `No observation newer than the recorded completion is available yet. The requested state is ${want}; the next sync${r.observed.source ? ` of ${SOURCE_LABEL[r.observed.source] ?? r.observed.source}` : ""} provides the comparison.`;
    case "matched":
      return `An observation made after the recorded completion shows access ${want}, as requested.`;
    case "mismatch":
      return `An observation made after the recorded completion does not show access ${want}. Check ${r.app_name} directly.`;
    case "unavailable":
      return `Account presence cannot confirm the requested access level “${r.requested_access}”. Check the role in ${r.app_name} directly.`;
    default:
      return "";
  }
}

export function RequestShow() {
  const { id } = useParams();
  const { isAdmin } = useRole();
  const { query, result } = useOne<Detail>({ resource: "requests", id: id! });
  const d = result as Detail | undefined;
  if (query.isLoading) return <LoadingPanel label="Loading request…" />;
  if (query.isError || !d) return <ErrorPanel message={query.error?.message} onRetry={() => query.refetch()} />;
  const r = d.request;
  const person = r.person_name ?? r.person_email;

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link to="/requests" className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
            <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
            Access requests
          </Link>
        }
        title={`${REQUEST_TYPE[r.type]}: ${r.app_name} for ${person}`}
        description={`Request #${r.id}`}
        actions={isAdmin ? <RequestActions r={r} /> : undefined}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatePanel title="Decision">
          <StateBadge map={DECISION} value={r.decision} />
          {r.decided_at ? (
            <p className="text-xs text-fg-muted">
              {r.decided_by} · <Time iso={r.decided_at} />
            </p>
          ) : (
            <p className="text-xs text-fg-muted">Waiting for an administrator.</p>
          )}
          {r.decision_note && <p className="text-sm text-fg">“{r.decision_note}”</p>}
        </StatePanel>
        <StatePanel title="Execution">
          <StateBadge map={EXECUTION} value={r.execution} />
          <p className="text-xs text-fg-muted">
            Automatic execution: Not supported. The connectors only read, so the change is made in {r.app_name} and its outcome recorded here.
          </p>
          {r.executed_at && (
            <p className="text-xs text-fg-muted">
              Recorded by {r.executed_by} · <Time iso={r.executed_at} />
            </p>
          )}
          {r.execution_note && <p className="text-sm text-fg">“{r.execution_note}”</p>}
        </StatePanel>
        <StatePanel title="Observed access">
          <ObservationSummary obs={r.observed} />
        </StatePanel>
        <StatePanel title="Verification">
          <StateBadge map={VERIFICATION} value={r.verification} />
          <p className="text-xs text-fg-muted">{verificationText(r)}</p>
        </StatePanel>
      </div>
      <p className="text-xs text-fg-muted">{d.freshness_policy}</p>

      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
        </CardHeader>
        <CardContent>
          <Details
            items={[
              ["Change", REQUEST_TYPE[r.type]],
              [
                "Person",
                <Link to={`/people/${r.person_id}`} className="text-primary underline-offset-4 hover:underline">
                  {person} ({r.person_email})
                </Link>,
              ],
              [
                "Application",
                <Link to={`/applications/${r.app_id}`} className="text-primary underline-offset-4 hover:underline">
                  {r.app_name}
                </Link>,
              ],
              ["Requested access", r.requested_access ?? <Missing>Any access</Missing>],
              ["Justification", r.justification],
              ["Submitted", <>{r.requested_by} · <Time iso={r.requested_at} /></>],
            ]}
          />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-base font-semibold text-fg">
          History
        </h2>
        <ActivityList events={d.events} empty="No recorded events." />
      </section>
    </Page>
  );
}

function StatePanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4" aria-label={title}>
      <h2 className="text-sm font-medium text-fg-secondary">{title}</h2>
      {children}
    </section>
  );
}

function RequestActions({ r }: { r: Req }) {
  const person = r.person_name ?? r.person_email;
  const what = `${r.type === "grant" ? "grant" : "revoke"} ${r.app_name} access for ${person}`;
  if (r.decision === "pending") {
    return (
      <>
        <NoteDialog
          action="Approve"
          title={`Approve: ${what}?`}
          description="Approval records the decision only. Nothing changes in the application until someone makes the change there and records the outcome."
          url={`/api/requests/${r.id}/decision`}
          body={(note) => ({ decision: "approved", note })}
        />
        <NoteDialog
          action="Reject"
          variant="outline"
          title={`Reject: ${what}?`}
          description="The requester can see the reason you give."
          url={`/api/requests/${r.id}/decision`}
          body={(note) => ({ decision: "rejected", note })}
        />
        <CancelRequest id={r.id} what={what} />
      </>
    );
  }
  if (r.decision === "approved" && r.execution !== "completed") {
    return (
      <>
        <NoteDialog
          action="Record as completed"
          title={`Record that you made the change: ${what}`}
          description={`Confirm only after the change was made in ${r.app_name}. Verification then waits for the next observation.`}
          url={`/api/requests/${r.id}/execution`}
          body={(note) => ({ outcome: "completed", note })}
        />
        <NoteDialog
          action="Record as failed"
          variant="outline"
          noteRequired
          title={`Record that the change failed: ${what}`}
          description="Describe what failed. You can record a completed outcome later."
          url={`/api/requests/${r.id}/execution`}
          body={(note) => ({ outcome: "failed", note })}
        />
      </>
    );
  }
  return null;
}

/** Confirmation with an optional (or required) note. Shows the server's result; never assumes success. */
function NoteDialog({
  action,
  title,
  description,
  url,
  body,
  variant = "default",
  noteRequired,
}: {
  action: string;
  title: string;
  description: string;
  url: string;
  body: (note: string | null) => unknown;
  variant?: "default" | "outline";
  noteRequired?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const refresh = useRefresh();
  const schema = z.object({
    note: noteRequired ? z.string().trim().min(3, "Describe what failed (at least 3 characters).").max(2000) : z.string().max(2000, "Keep the note under 2,000 characters."),
  });
  const { register, handleSubmit, formState, reset } = useForm<{ note: string }>({ resolver: zodResolver(schema), defaultValues: { note: "" } });
  const submit = handleSubmit(async ({ note }) => {
    setServerError(null);
    try {
      await api(url, { method: "POST", body: body(note.trim() || null) });
      setOpen(false);
      reset();
      refresh();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "The request failed.");
    }
  });
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {action}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            reset();
            setServerError(null);
          }
        }}
        dirty={formState.isDirty}
        title={title}
        description={description}
        size="confirm"
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-4">
            {serverError && <FormErrors errors={[serverError]} />}
            <Field label="Note" required={noteRequired} error={formState.errors.note?.message}>
              {(a) => <Textarea {...a} {...register("note")} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? "Saving…" : action}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}

function CancelRequest({ id, what }: { id: number; what: string }) {
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost">Cancel request</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel the request to {what}?</AlertDialogTitle>
          <AlertDialogDescription>The request is closed without a decision. This is recorded in the audit log.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <ErrorPanel message={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep request</AlertDialogCancel>
          <AlertDialogAction
            destructive
            onClick={async (e) => {
              e.preventDefault();
              try {
                await api(`/api/requests/${id}/cancel`, { method: "POST" });
                refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not cancel.");
              }
            }}
          >
            Cancel request
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
