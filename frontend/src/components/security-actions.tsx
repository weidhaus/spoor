import { useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { Field, FormErrors } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Notice } from "@/components/panels";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRefresh } from "@/hooks/use-refresh";
import { ApiError, api } from "@/lib/api";
import type { StateMap } from "@/lib/states";

type Target = { id: string; name: string };
type Action = {
  id: number;
  kind: string;
  target: string | null;
  reason: string;
  requested_by: string;
  requested_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
};
export type SecurityActions = {
  kinds: Record<string, string>;
  needs_target: string[];
  targets: Record<string, Target[]>;
  expiry_hours: number;
  history: Action[];
};

const STATUS: StateMap = {
  pending: ["Waiting for second officer", "attention"],
  running: ["Running", "info"],
  done: ["Done", "success"],
  failed: ["Failed", "failure"],
  rejected: ["Rejected", "neutral"],
};

/** Runs a call that needs a fresh Google sign-in; sends the user to re-authenticate when the server asks for it. */
function useStepUp() {
  const location = useLocation();
  return async <T,>(call: () => Promise<T>) => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.message === "stepup_required") {
        window.location.assign(`/login/google/stepup?next=${encodeURIComponent(location.pathname)}`);
        return new Promise<never>(() => {}); // navigating away
      }
      throw e;
    }
  };
}

/** Security actions on one person: requested by one officer, approved (and run immediately) by another. */
export function SecurityActionsCard({ person, data, officer, me }: { person: { id: number; email: string; name: string | null }; data: SecurityActions; officer: boolean; me: string }) {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const refresh = useRefresh();
  const stepUp = useStepUp();
  const label = (a: Action) => {
    const t = a.target && data.targets[a.kind]?.find((x) => x.id === a.target);
    return `${data.kinds[a.kind] ?? a.kind}${a.target ? `: ${t ? t.name : a.target}` : ""}`;
  };
  const decide = async (a: Action, verb: "approve" | "reject") => {
    setBusy(a.id);
    setError(null);
    try {
      const call = () => api<{ status?: string; result?: string | null }>(`/api/security-actions/${a.id}/${verb}`, { method: "POST" });
      const res = verb === "approve" ? await stepUp(call) : await call();
      if (res.status === "failed") setError(res.result ?? "The action failed in Google.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(null);
    }
  };

  if (!officer && data.history.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security actions</CardTitle>
        {officer && <RequestActionDialog person={person} data={data} stepUp={stepUp} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {params.get("stepup") === "failed" && (
          <Notice tone="attention">Google did not confirm a fresh sign-in, so no security action was unlocked. Try again and sign in when Google asks.</Notice>
        )}
        {error && <FormErrors errors={[error]} />}
        {officer && (
          <p className="text-sm text-fg-secondary">
            Each action needs a second security officer to approve it within {data.expiry_hours} hours; approval runs it immediately in Google. Requesting and approving both ask you to sign in with Google again.
          </p>
        )}
        {data.history.length === 0 ? (
          <p className="text-sm text-fg-secondary">No security actions for this person.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {data.history.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                  <span className="text-fg [overflow-wrap:anywhere]">{label(a)}</span>
                  <span className="text-xs text-fg-muted">
                    Requested by {a.requested_by}, <Time iso={a.requested_at} /> · {a.reason}
                    {a.decided_by && (
                      <>
                        {" "}
                        · {a.status === "rejected" ? "rejected" : "approved"} by {a.decided_by}
                      </>
                    )}
                  </span>
                  {a.result && <span className="text-xs text-fg-secondary [overflow-wrap:anywhere]">{a.result}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StateBadge map={STATUS} value={a.status} />
                  {officer && a.status === "pending" && (
                    <>
                      {a.requested_by !== me && (
                        <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => decide(a, "approve")}>
                          Approve and run
                        </Button>
                      )}
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide(a, "reject")}>
                        {a.requested_by === me ? "Withdraw" : "Reject"}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RequestActionDialog({
  person,
  data,
  stepUp,
}: {
  person: { id: number; email: string; name: string | null };
  data: SecurityActions;
  stepUp: ReturnType<typeof useStepUp>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = useRefresh();
  const needsTarget = data.needs_target.includes(kind);
  const options = data.targets[kind] ?? [];

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setKind("");
      setTarget("");
      setReason("");
      setConfirm("");
      setError(null);
    }
  };
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await stepUp(() =>
        api(`/api/people/${person.id}/security-actions`, { method: "POST", body: { kind, target: needsTarget ? target : null, reason, confirm } })
      );
      refresh();
      close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Request action
      </Button>
      <FormDialog
        open={open}
        onOpenChange={close}
        dirty={kind !== "" || reason !== "" || confirm !== ""}
        title={`Security action for ${person.name ?? person.email}`}
        description="Nothing runs yet: a second security officer must approve this request. Every step is recorded in the audit log."
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className="flex flex-col gap-6">
            {error && <FormErrors errors={[error]} />}
            <Field label="Action" required>
              {(a) => (
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v);
                    setTarget("");
                  }}
                >
                  <SelectTrigger {...a} className="w-full">
                    <SelectValue placeholder="Choose an action" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(data.kinds).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {needsTarget && (
              <Field label={kind === "revoke_grant" ? "Application" : "Licence"} required helper={options.length ? undefined : "Nothing to choose: discovery has not observed any for this person."}>
                {(a) => (
                  <Select value={target} onValueChange={setTarget} disabled={!options.length}>
                    <SelectTrigger {...a} className="w-full">
                      <SelectValue placeholder="Choose one" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
            <Field label="Reason" required helper="Shown to the approving officer and kept in the audit log.">
              {(a) => <Textarea {...a} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <Field label={`Type ${person.email} to confirm`} required>
              {(a) => <Input {...a} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || !kind || (needsTarget && !target) || !reason.trim() || confirm.trim().toLowerCase() !== person.email}
            >
              {pending ? "Requesting…" : "Request approval"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}
