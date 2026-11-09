import { useCustom } from "@refinedev/core";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { ErrorPanel, LoadingPanel, Notice } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const ERRORS: Record<string, string> = {
  organisation: "This account is not part of an allowed organisation.",
  role: "Your account has no role in this application. Ask an administrator to grant one.",
  failed: "Sign-in failed. Please try again.",
};

export function Login() {
  const [params] = useSearchParams();
  const { query } = useCustom<{ google: boolean; microsoft: boolean; demo: boolean }>({ url: "/api/auth/methods", method: "get" });
  const [demoError, setDemoError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const methods = query.data?.data;
  const error = ERRORS[params.get("error") ?? ""];

  async function enterDemo(role: "admin" | "auditor") {
    setPending(true);
    setDemoError(null);
    try {
      await api("/api/auth/demo", { method: "POST", body: { role }, headers: { "X-Requested-With": "fetch" } });
      window.location.assign("/overview");
    } catch (e) {
      setDemoError(e instanceof Error ? e.message : "Could not start the demo session.");
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-lg border border-line bg-surface p-6">
        <div className="flex flex-col gap-1">
          <img src="/spoor.svg" alt="" aria-hidden className="mb-3 size-12" />
          <h1 className="text-2xl font-semibold text-fg">Spoor</h1>
          <p className="text-sm text-fg-secondary">Sign in with your company account.</p>
        </div>
        {error && <ErrorPanel title="Not signed in" message={error} />}
        {query.isLoading && <LoadingPanel label="Loading sign-in options…" />}
        {query.isError && <ErrorPanel message="Could not load sign-in options." onRetry={() => query.refetch()} />}
        {methods && (
          <div className="flex flex-col gap-2">
            {methods.google && (
              <Button asChild size="lg">
                <a href="/login/google">Continue with Google Workspace</a>
              </Button>
            )}
            {methods.microsoft && (
              <Button asChild size="lg" variant={methods.google ? "outline" : "default"}>
                <a href="/login/microsoft">Continue with Microsoft Entra ID</a>
              </Button>
            )}
            {methods.demo && (
              <div className="flex flex-col gap-2">
                <Notice tone="attention">
                  Demo data mode is on. Sign-in without a password uses fictional records only. Never expose this instance.
                </Notice>
                <Button size="lg" disabled={pending} onClick={() => enterDemo("admin")}>
                  Enter demo as administrator
                </Button>
                <Button size="lg" variant="outline" disabled={pending} onClick={() => enterDemo("auditor")}>
                  Enter demo as auditor (read-only)
                </Button>
                {demoError && <ErrorPanel message={demoError} />}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
