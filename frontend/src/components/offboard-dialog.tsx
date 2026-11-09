import { useState } from "react";

import { Field, FormErrors } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Notice } from "@/components/panels";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRefresh } from "@/hooks/use-refresh";
import { api } from "@/lib/api";
import { OFFBOARD_STEP } from "@/lib/states";

export type OffboardStep = { key: string; label: string; system: string; available: boolean; reason: string | null };
type Result = { step: string; label: string; status: string; detail: string | null };

const MAIL_STEPS = ["out_of_office", "forward_mail"];
const NEEDS_RECIPIENT = ["forward_mail", "transfer_drive"];

/** Runs the chosen offboarding steps now. Nothing is preselected and nothing runs without typing the person's email. */
export function OffboardDialog({ person, steps, defaultRecipient }: { person: { id: number; email: string; name: string | null }; steps: OffboardStep[]; defaultRecipient: string | null }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [recipient, setRecipient] = useState(defaultRecipient ?? "");
  const [message, setMessage] = useState(
    `${person.name ?? person.email} is no longer with the company. Please contact ${defaultRecipient ?? "your other contacts"} instead.`
  );
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const refresh = useRefresh();

  const has = (k: string) => chosen.includes(k);
  const conflict = has("suspend") && MAIL_STEPS.some(has);
  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setChosen([]);
      setConfirm("");
      setError(null);
      setResults(null);
    }
  };
  const run = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await api<{ results: Result[] }>(`/api/people/${person.id}/offboard`, {
        method: "POST",
        body: { steps: chosen, recipient_email: NEEDS_RECIPIENT.some(has) ? recipient : null, message: has("out_of_office") ? message : null, confirm },
      });
      setResults(res.results);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offboarding failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Offboard
      </Button>
      <FormDialog
        open={open}
        onOpenChange={close}
        dirty={!results && (chosen.length > 0 || confirm !== "")}
        title={`Offboard ${person.name ?? person.email}`}
        description="The chosen steps run immediately in Google Workspace and Entra ID, in the order listed, and stop at the first failure. Every step is recorded in the audit log."
      >
        {results ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <ul className="flex flex-col gap-3">
                {results.map((r) => (
                  <li key={r.step} className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-fg">
                      <StateBadge map={OFFBOARD_STEP} value={r.status} />
                      {r.label}
                    </span>
                    {r.detail && <span className="text-xs text-fg-secondary [overflow-wrap:anywhere]">{r.detail}</span>}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-fg-secondary">Account status and issues update after the next sync.</p>
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button">Close</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <DialogBody className="flex flex-col gap-6">
              {error && <FormErrors errors={[error]} />}
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium text-fg">Steps</legend>
                {steps.map((s) => (
                  <label key={s.key} className={`flex items-start gap-3 text-sm ${s.available ? "cursor-pointer text-fg" : "text-fg-muted"}`}>
                    <Checkbox
                      className="mt-0.5"
                      disabled={!s.available}
                      checked={has(s.key)}
                      onCheckedChange={(v) => setChosen((c) => (v ? [...c, s.key] : c.filter((k) => k !== s.key)))}
                    />
                    <span>
                      {s.label}
                      {s.reason && <span className="text-xs"> ({s.reason})</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
              {conflict && (
                <Notice tone="attention">
                  Google bounces mail sent to a suspended account, so forwarding and the out-of-office reply would stop working. Run them now and suspend in a later run.
                </Notice>
              )}
              {NEEDS_RECIPIENT.some(has) && (
                <Field label="Recipient" required helper="Another active person with a Google account. Mail and files never go outside the company.">
                  {(a) => <Input {...a} type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} />}
                </Field>
              )}
              {has("out_of_office") && (
                <Field label="Out-of-office message" required>
                  {(a) => <Textarea {...a} value={message} onChange={(e) => setMessage(e.target.value)} />}
                </Field>
              )}
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
              <Button type="submit" variant="destructive" disabled={pending || !chosen.length || conflict || confirm.trim().toLowerCase() !== person.email}>
                {pending ? "Running…" : `Run ${chosen.length || ""} step${chosen.length === 1 ? "" : "s"} now`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </FormDialog>
    </>
  );
}
