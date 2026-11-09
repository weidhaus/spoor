import { zodResolver } from "@hookform/resolvers/zod";
import { useCustom } from "@refinedev/core";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Field, FormErrors } from "@/components/field";
import { Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel } from "@/components/panels";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRefresh } from "@/hooks/use-refresh";
import { api } from "@/lib/api";
import { cachedSession } from "@/providers/session";

type Role = { email: string; role: string; granted_by: string | null; granted_at: string | null };
const ROLE_LABEL: Record<string, string> = { admin: "Administrator", auditor: "Auditor (read and export)" };

const schema = z.object({
  email: z.string().trim().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Enter a valid email address."),
  role: z.string().min(1, "Choose a role."),
});

export function UsersPage() {
  const { query } = useCustom<{ roles: Role[]; bootstrap: string[] }>({ url: "/api/users", method: "get" });
  const d = query.data?.data; // result.data is {} while loading; query.data is undefined until loaded
  return (
    <Page narrow>
      <PageHeader
        title="Users and roles"
        description="Only people listed here can sign in. Administrators can change records; auditors can read and export everything. Revoking a role signs the person out immediately."
      />
      <GrantForm />
      {query.isLoading && <LoadingPanel label="Loading roles…" />}
      {query.isError && <ErrorPanel message={query.error?.message} onRetry={() => query.refetch()} />}
      {d && (
        <>
          <div role="region" aria-label="Roles table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ minWidth: 240 }}>Email</TableHead>
                  <TableHead style={{ minWidth: 160 }}>Role</TableHead>
                  <TableHead style={{ minWidth: 220 }}>Granted</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.roles.map((r) => (
                  <TableRow key={r.email}>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>{ROLE_LABEL[r.role] ?? r.role}</TableCell>
                    <TableCell>
                      {r.granted_by ?? "Unknown"} · <Time iso={r.granted_at} />
                    </TableCell>
                    <TableCell>
                      {r.email === cachedSession()?.email ? (
                        <span className="text-xs text-fg-muted">You cannot revoke your own role</span>
                      ) : (
                        <Revoke role={r} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {d.bootstrap.length > 0 && (
            <p className="text-xs text-fg-muted">
              Always administrators through BOOTSTRAP_ADMINS in the server configuration: {d.bootstrap.join(", ")}.
            </p>
          )}
        </>
      )}
    </Page>
  );
}

function GrantForm() {
  const refresh = useRefresh();
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const { register, control, handleSubmit, formState, reset } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", role: "" },
  });
  const submit = handleSubmit(async (v) => {
    setResult(null);
    try {
      await api("/api/users", { method: "POST", body: v });
      setResult({ error: false, text: `${v.email} is now ${ROLE_LABEL[v.role]}.` });
      reset();
      refresh();
    } catch (e) {
      setResult({ error: true, text: e instanceof Error ? e.message : "Could not grant the role." });
    }
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Grant a role</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          {result?.error && <FormErrors errors={[result.text]} />}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Field label="Work email" required error={formState.errors.email?.message} helper="Must match the address used to sign in with Google or Microsoft.">
              {(a) => <Input {...a} type="email" autoComplete="off" {...register("email")} />}
            </Field>
            <Field label="Role" required error={formState.errors.role?.message}>
              {(a) => (
                <Controller
                  control={control}
                  name="role"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger ref={field.ref} {...a} className="w-full">
                        <SelectValue placeholder="Choose a role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auditor">{ROLE_LABEL.auditor}</SelectItem>
                        <SelectItem value="admin">{ROLE_LABEL.admin}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? "Granting…" : "Grant role"}
            </Button>
            {result && !result.error && (
              <p role="status" className="text-sm text-fg-secondary">
                {result.text}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Revoke({ role }: { role: Role }) {
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          Revoke role<span className="sr-only"> for {role.email}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke the {ROLE_LABEL[role.role]} role for {role.email}?</AlertDialogTitle>
          <AlertDialogDescription>They are signed out immediately and can no longer sign in. You can grant a role again later.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <ErrorPanel message={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep role</AlertDialogCancel>
          <AlertDialogAction
            destructive
            onClick={async (e) => {
              e.preventDefault();
              try {
                await api(`/api/users/${encodeURIComponent(role.email)}`, { method: "DELETE" });
                refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not revoke the role.");
              }
            }}
          >
            Revoke role
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
