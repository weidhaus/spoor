import { zodResolver } from "@hookform/resolvers/zod";
import { type BaseRecord, type HttpError, useCustom } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { type ReactNode, useEffect, useState } from "react";
import { Controller } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";

import { Field, FormErrors } from "@/components/field";
import { FormDialog, errorList } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const schema = z.object({
  person_id: z.string().min(1, "Choose the person the change is for."),
  app_id: z.string().min(1, "Choose an application."),
  type: z.string().refine((v) => v === "grant" || v === "revoke", "Choose whether access is granted or revoked."),
  requested_access: z.string().max(200, "Keep the access level under 200 characters."),
  justification: z
    .string()
    .trim()
    .min(5, "Give a justification of at least 5 characters.")
    .max(2000, "Keep the justification under 2,000 characters."),
});
type Values = { person_id: string; app_id: string; type: string; requested_access: string; justification: string };
type Options = { apps: { id: number; name: string }[]; people: { id: number; name: string | null; email: string; status: string }[] };

/** Records a request for a decision. Nothing is executed: connectors are read-only. */
export function RequestDialog({
  label,
  variant = "default",
  preset = {},
}: {
  label: ReactNode;
  variant?: "default" | "outline";
  preset?: { person_id?: number; app_id?: number; type?: "grant" | "revoke" };
}) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { query: optionsQuery } = useCustom<Options>({ url: "/api/options", method: "get", queryOptions: { enabled: open } });
  const defaults: Values = {
    person_id: preset.person_id ? String(preset.person_id) : "",
    app_id: preset.app_id ? String(preset.app_id) : "",
    type: preset.type ?? "",
    requested_access: "",
    justification: "",
  };
  const form = useForm<BaseRecord, HttpError, Values>({
    refineCoreProps: {
      resource: "requests",
      action: "create",
      redirect: false,
      successNotification: false,
      errorNotification: false,
      onMutationSuccess: (res) => {
        setOpen(false);
        navigate(`/requests/${res.data.id}`);
      },
      onMutationError: (e) => setServerError(e.message),
    },
    resolver: zodResolver(schema),
    defaultValues: defaults,
    warnWhenUnsavedChanges: false,
    shouldFocusError: false, // focus follows visual order instead (see onInvalid)
  });
  const { register, control, handleSubmit, formState, reset, refineCore } = form;
  const errors = formState.errors;
  const summary = errorList(errors as never, serverError);
  useEffect(() => {
    if (serverError) document.getElementById("request-errors")?.focus();
  }, [serverError]);

  const submit = handleSubmit(
    (values) => {
      setServerError(null);
      return refineCore.onFinish({
        person_id: Number(values.person_id),
        app_id: Number(values.app_id),
        type: values.type,
        requested_access: values.requested_access.trim() || null,
        justification: values.justification.trim(),
      } as never);
    },
    // Move focus to the first invalid control in visual order, once the error states have rendered.
    () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')?.focus()),
  );

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            reset(defaults);
            setServerError(null);
          }
        }}
        dirty={formState.isDirty}
        title="New access request"
        description="Records the request for a decision. Approval does not change access anywhere: connectors only read, so the change is made in the application itself and its outcome is recorded here."
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-6">
            {formState.submitCount > 0 && (summary.length > 1 || serverError) && <FormErrors id="request-errors" errors={summary} />}
            {optionsQuery.isError && <FormErrors errors={["Could not load people and applications. Close and try again."]} />}
            <Field label="Person" required error={errors.person_id?.message}>
              {(a) => (
                <Controller
                  control={control}
                  name="person_id"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!!preset.person_id}>
                      <SelectTrigger ref={field.ref} {...a} className="w-full">
                        <SelectValue placeholder={optionsQuery.isLoading ? "Loading…" : "Choose a person"} />
                      </SelectTrigger>
                      <SelectContent>
                        {optionsQuery.data?.data.people.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name ? `${p.name} (${p.email})` : p.email}
                            {p.status !== "active" ? ` · ${p.status}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
            <Field label="Application" required error={errors.app_id?.message}>
              {(a) => (
                <Controller
                  control={control}
                  name="app_id"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!!preset.app_id}>
                      <SelectTrigger ref={field.ref} {...a} className="w-full">
                        <SelectValue placeholder={optionsQuery.isLoading ? "Loading…" : "Choose an application"} />
                      </SelectTrigger>
                      <SelectContent>
                        {optionsQuery.data?.data.apps.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
            <fieldset className="flex flex-col gap-2" aria-describedby={errors.type ? "type-error" : undefined}>
              <legend className="mb-2 text-sm font-medium text-fg">
                Change <span className="text-fg-secondary">(required)</span>
              </legend>
              {[
                ["grant", "Grant access"],
                ["revoke", "Revoke access"],
              ].map(([value, text]) => (
                <label key={value} className="flex min-h-10 cursor-pointer items-center gap-3 text-sm text-fg">
                  <input
                    type="radio"
                    value={value}
                    {...register("type")}
                    aria-invalid={errors.type ? true : undefined}
                    aria-describedby={errors.type ? "type-error" : undefined}
                    className="size-4 accent-[var(--primary)]"
                  />
                  {text}
                </label>
              ))}
              {errors.type && (
                <p id="type-error" className="text-sm text-failure-fg">
                  {errors.type.message}
                </p>
              )}
            </fieldset>
            <Field
              label="Requested access level"
              helper="Optional, for example “Editor”. Leave empty for any access. A specific level cannot be verified automatically."
              error={errors.requested_access?.message}
            >
              {(a) => <Input {...a} {...register("requested_access")} />}
            </Field>
            <Field label="Justification" required error={errors.justification?.message}>
              {(a) => <Textarea {...a} {...register("justification")} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={refineCore.formLoading}>
              {refineCore.formLoading ? "Submitting…" : "Submit request"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}
