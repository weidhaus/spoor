import { zodResolver } from "@hookform/resolvers/zod";
import { useCustom } from "@refinedev/core";
import { Upload } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { Field, FormErrors } from "@/components/field";
import { FormDialog, errorList } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRefresh } from "@/hooks/use-refresh";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";

const schema = z
  .object({
    app_id: z.string(),
    new_app: z.string().trim().max(200, "Keep the name under 200 characters."),
    file: z.instanceof(FileList).refine((f) => f.length === 1, "Choose a CSV file.").refine((f) => !f[0] || f[0].size <= 5 * 1024 * 1024, "The file is larger than 5 MB."),
  })
  .refine((v) => !!v.app_id !== !!v.new_app, { message: "Choose an existing application or enter a new name (not both).", path: ["app_id"] });
type Values = z.infer<typeof schema>;

/** Imports one application's user export as a full snapshot of its accounts. */
export function ImportDialog({ appId, variant = "default" }: { appId?: number; variant?: "default" | "outline" }) {
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ app_id: number; imported: number; skipped: number } | null>(null);
  const refresh = useRefresh();
  const { query: optionsQuery } = useCustom<{ apps: { id: number; name: string }[] }>({
    url: "/api/options",
    method: "get",
    queryOptions: { enabled: open },
  });
  const defaults = { app_id: appId ? String(appId) : "", new_app: "" } as Partial<Values>;
  const { register, control, handleSubmit, formState, reset } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });
  const summary = errorList(formState.errors as never, serverError);

  const submit = handleSubmit(async (values) => {
    setServerError(null);
    const body = new FormData();
    body.set("file", values.file[0]!);
    if (values.new_app) body.set("new_app", values.new_app);
    else body.set("app_id", values.app_id);
    try {
      setResult(await api("/api/import", { method: "POST", body }));
      reset(defaults);
      refresh();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Import failed.");
    }
  });

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Upload strokeWidth={1.75} aria-hidden />
        Import accounts from CSV
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            reset(defaults);
            setResult(null);
            setServerError(null);
          }
        }}
        dirty={formState.isDirty && !result}
        title="Import accounts from CSV"
        description="Use one application's user export. Each import replaces the previous snapshot for that application: accounts missing from the file are marked removed and kept as history."
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-6">
            {formState.submitCount > 0 && (summary.length > 1 || serverError) && <FormErrors errors={summary} />}
            {result && (
              <div role="status" className="rounded-lg border border-line bg-canvas p-4 text-sm">
                <p className="font-semibold text-fg">Import recorded</p>
                <p className="text-fg-secondary">
                  {formatNumber(result.imported)} accounts imported, {formatNumber(result.skipped)} rows skipped (no valid email).{" "}
                  <Link className="text-primary underline-offset-4 hover:underline" to={`/applications/${result.app_id}?tab=access`}>
                    View accounts
                  </Link>
                </p>
              </div>
            )}
            <Field label="Existing application" error={formState.errors.app_id?.message}>
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
            {!appId && (
              <Field label="Or a new application" helper="Creates the application when no existing one fits." error={formState.errors.new_app?.message}>
                {(a) => <Input {...a} {...register("new_app")} />}
              </Field>
            )}
            <Field
              label="CSV file"
              required
              helper="UTF-8, header row with email (required) and optional name, role, plan or licence, status, last_activity or last_login, external_id. Max 5 MB."
              error={formState.errors.file?.message as string | undefined}
            >
              {(a) => <Input {...a} type="file" accept=".csv,text/csv" {...register("file")} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {result ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </FormDialog>
    </>
  );
}
