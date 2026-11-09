import { zodResolver } from "@hookform/resolvers/zod";
import { type BaseRecord, type HttpError, useCustom } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useEffect, useState } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";

import { Field, FormErrors } from "@/components/field";
import { FormDialog, errorList } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRefresh } from "@/hooks/use-refresh";

const optionalNumber = (label: string, integer: boolean) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || (integer ? /^\d+$/ : /^\d+(\.\d{1,4})?$/).test(v), `${label} must be ${integer ? "a whole number" : "a number"} of 0 or more.`);

const schema = z
  .object({
    app_id: z.string(),
    name: z.string().trim().min(1, "Enter the plan name.").max(200),
    quantity: optionalNumber("Purchased seats", true),
    unit_cost: optionalNumber("Cost per seat", false),
    currency: z.string().trim().toUpperCase().refine((v) => v === "" || /^[A-Z]{3}$/.test(v), "Currency must be a 3-letter ISO code, for example EUR."),
    billing_period: z.string(),
    renewal_date: z.string(),
    owner_email: z.string().trim().refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address."),
    notes: z.string().max(2000),
  })
  .refine((v) => v.app_id !== "", { message: "Choose an application.", path: ["app_id"] })
  .refine((v) => v.unit_cost === "" || v.currency !== "", { message: "A cost needs its currency.", path: ["currency"] })
  .refine((v) => v.unit_cost === "" || v.billing_period !== "", { message: "A cost needs its billing period.", path: ["billing_period"] });
type Values = z.infer<typeof schema>;

export type LicenseRecord = {
  id: number;
  app_id: number;
  app_name: string;
  name: string;
  source: string;
  quantity: number | null;
  unit_cost: number | null;
  currency: string;
  billing_period: string;
  renewal_date: string | null;
  owner_email: string | null;
  notes: string | null;
};

/** Create a manual plan, or edit an existing one. Quantities reported by a connector are not editable. */
export function LicenseFormDialog({ license, appId, variant = "default" }: { license?: LicenseRecord; appId?: number; variant?: "default" | "outline" }) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const refresh = useRefresh();
  const editing = !!license;
  const reported = editing && license.source !== "manual";
  const { query: optionsQuery } = useCustom<{ apps: { id: number; name: string }[] }>({
    url: "/api/options",
    method: "get",
    queryOptions: { enabled: open && !editing },
  });
  const defaults: Values = {
    app_id: String(license?.app_id ?? appId ?? ""),
    name: license?.name ?? "",
    quantity: license?.quantity?.toString() ?? "",
    unit_cost: license?.unit_cost?.toString() ?? "",
    currency: license?.unit_cost != null ? license.currency : "",
    billing_period: license?.unit_cost != null ? license.billing_period : "",
    renewal_date: license?.renewal_date ?? "",
    owner_email: license?.owner_email ?? "",
    notes: license?.notes ?? "",
  };
  const form = useForm<BaseRecord, HttpError, Values>({
    refineCoreProps: {
      resource: "licenses",
      action: editing ? "edit" : "create",
      id: license?.id,
      redirect: editing ? false : "show",
      queryOptions: { enabled: false },
      successNotification: false,
      errorNotification: false,
      onMutationSuccess: () => {
        setOpen(false);
        refresh();
      },
      onMutationError: (e) => setServerError(e.message),
    },
    resolver: zodResolver(schema),
    defaultValues: defaults,
    warnWhenUnsavedChanges: false,
  });
  const { register, control, handleSubmit, formState, reset, refineCore } = form;
  const errors = formState.errors;
  const summary = errorList(errors as never, serverError);
  useEffect(() => {
    if (open) reset(defaults);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = handleSubmit((v) => {
    setServerError(null);
    const hasCost = v.unit_cost !== "";
    return refineCore.onFinish({
      ...(editing ? {} : { app_id: Number(v.app_id) }),
      name: v.name,
      quantity: v.quantity === "" ? null : Number(v.quantity),
      unit_cost: hasCost ? Number(v.unit_cost) : null,
      currency: hasCost ? v.currency : (license?.currency ?? "EUR"),
      billing_period: hasCost ? v.billing_period : (license?.billing_period ?? "month"),
      renewal_date: v.renewal_date || null,
      owner_email: v.owner_email || null,
      notes: v.notes || null,
    } as never);
  });

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {editing ? "Edit plan" : "Add plan"}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        dirty={formState.isDirty}
        title={editing ? `Edit ${license.name}` : "Add licence plan"}
        description={editing ? undefined : "Record a plan that no connector reports, such as a direct SaaS subscription."}
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-6">
            {formState.submitCount > 0 && (summary.length > 1 || serverError) && <FormErrors errors={summary} />}
            {!editing && (
              <Field label="Application" required error={errors.app_id?.message}>
                {(a) => (
                  <Controller
                    control={control}
                    name="app_id"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange} disabled={!!appId}>
                        <SelectTrigger ref={field.ref} {...a} className="w-full">
                          <SelectValue placeholder="Choose an application" />
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
            )}
            <Field label="Plan name" required error={errors.name?.message} helper={editing ? "Plan names are fixed after creation." : undefined}>
              {(a) => <Input {...a} {...register("name")} readOnly={editing} />}
            </Field>
            <Field
              label="Purchased seats"
              helper={reported ? "Reported by the source system; not editable here." : "Leave empty when the purchased quantity is not known."}
              error={errors.quantity?.message}
            >
              {(a) => <Input {...a} inputMode="numeric" {...register("quantity")} readOnly={reported} />}
            </Field>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="Cost per seat" helper="Leave empty when unknown." error={errors.unit_cost?.message}>
                {(a) => <Input {...a} inputMode="decimal" {...register("unit_cost")} />}
              </Field>
              <Field label="Currency" helper="ISO code, for example EUR." error={errors.currency?.message}>
                {(a) => <Input {...a} maxLength={3} autoCapitalize="characters" {...register("currency")} />}
              </Field>
            </div>
            <Field label="Billing period" helper="Required when a cost is entered." error={errors.billing_period?.message}>
              {(a) => (
                <Controller
                  control={control}
                  name="billing_period"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger ref={field.ref} {...a} className="w-full">
                        <SelectValue placeholder="Choose a period" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="month">Per month</SelectItem>
                        <SelectItem value="year">Per year</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
            <Field label="Renewal date" error={errors.renewal_date?.message}>
              {(a) => <Input {...a} type="date" {...register("renewal_date")} />}
            </Field>
            <Field label="Owner email" error={errors.owner_email?.message}>
              {(a) => <Input {...a} type="email" autoComplete="off" {...register("owner_email")} />}
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
              {refineCore.formLoading ? "Saving…" : editing ? "Save changes" : "Add plan"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}
