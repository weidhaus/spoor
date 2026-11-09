import { useCustom } from "@refinedev/core";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { ImportDialog } from "@/components/import-dialog";
import { Missing } from "@/components/missing";
import { Details, Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel, Notice } from "@/components/panels";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRefresh } from "@/hooks/use-refresh";
import { useRole } from "@/hooks/use-role";
import { api } from "@/lib/api";
import { CONNECTION, FRESHNESS, SYNC } from "@/lib/states";

type Run = { id: number; integration: string; started_at: string; finished_at: string | null; status: string; stats: string | null; warnings: string | null; error: string | null };
type Integration = {
  name: string;
  label: string;
  connection: string;
  sync: string;
  freshness: string;
  last_success_at: string | null;
  last_error: string | null;
  last_run: Run | null;
  capabilities: { read: string[]; write: string[] };
  permissions: string[];
  demo_fixture: boolean;
};
type Data = { integrations: Integration[]; runs: Run[]; running: boolean; interval_hours: number; freshness_policy: string };

const RUN_STATE: Record<string, string> = { ok: "successful", error: "failed", running: "syncing" };

function stageOf(run: Run): string | null {
  return (JSON.parse(run.stats || "{}") as { stage?: string }).stage ?? null;
}

export function IntegrationsPage() {
  const { isAdmin } = useRole();
  // While a sync runs, refresh every 10 seconds so its current step and counts stay visible.
  const { query } = useCustom<Data>({
    url: "/api/integrations",
    method: "get",
    queryOptions: { refetchInterval: (q) => ((q.state.data?.data as Data | undefined)?.running ? 10_000 : false) },
  });
  const d = query.data?.data; // result.data is {} while loading; query.data is undefined until loaded

  return (
    <Page>
      <PageHeader
        title="Integrations"
        description="Where the inventory comes from. Connection, last sync, freshness and capabilities are reported separately. Discovery only reads. Changes happen only in offboarding, started by an administrator."
        actions={isAdmin ? <SyncNow running={!!d?.running} configured={!!d?.integrations.some((i) => i.connection !== "not_configured" && !i.demo_fixture)} /> : undefined}
        context={d && <>Automatic sync every {d.interval_hours} hours. {d.freshness_policy}</>}
      />
      {query.isLoading && <LoadingPanel label="Loading integrations…" />}
      {query.isError && <ErrorPanel message={query.error?.message} onRetry={() => query.refetch()} />}
      {d && (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {d.integrations.map((i) => (
              <IntegrationCard key={i.name} i={i} />
            ))}
            <Card>
              <CardHeader>
                <CardTitle>CSV import</CardTitle>
                {isAdmin && <ImportDialog variant="outline" />}
              </CardHeader>
              <CardContent>
                <Details
                  items={[
                    ["Connection", "Not applicable: files are uploaded by an administrator."],
                    ["Can read", "Accounts of any application, from its user export."],
                    ["Can change", "Nothing. This integration supports reading access only."],
                    ["Freshness", "Unknown freshness: an import is current only as of the export it came from."],
                  ]}
                />
              </CardContent>
            </Card>
          </div>
          <section className="flex flex-col gap-4" aria-labelledby="runs-heading">
            <h2 id="runs-heading" className="text-base font-semibold text-fg">
              Recent sync runs
            </h2>
            {d.runs.length === 0 ? (
              <p className="text-sm text-fg-secondary">No sync has run yet.</p>
            ) : (
              <div role="region" aria-label="Sync runs table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line bg-surface">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead style={{ minWidth: 150 }}>Integration</TableHead>
                      <TableHead style={{ minWidth: 190 }}>Started</TableHead>
                      <TableHead style={{ minWidth: 140 }}>Result</TableHead>
                      <TableHead style={{ minWidth: 200 }}>Records</TableHead>
                      <TableHead style={{ minWidth: 280 }}>Warnings and errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.runs.map((r) => {
                      const warnings: string[] = JSON.parse(r.warnings || "[]");
                      const { stage, ...stats }: Record<string, number | string> = JSON.parse(r.stats || "{}");
                      const state = r.status === "ok" && warnings.length ? "partial" : RUN_STATE[r.status];
                      return (
                        <TableRow key={r.id}>
                          <TableCell>{d.integrations.find((i) => i.name === r.integration)?.label ?? r.integration}</TableCell>
                          <TableCell>
                            <Time iso={r.started_at} />
                          </TableCell>
                          <TableCell>
                            <StateBadge map={SYNC} value={state} />
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.status === "running" && stage && <p className="text-fg-secondary">Now {stage}</p>}
                            {Object.keys(stats).length ? (
                              Object.entries(stats).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")
                            ) : r.status === "running" ? null : (
                              <Missing reason="not_reported" />
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.error && <p className="text-failure-fg">{r.error}</p>}
                            {warnings.map((w) => (
                              <p key={w} className="text-attention-fg">
                                {w}
                              </p>
                            ))}
                            {!r.error && !warnings.length && <span className="text-fg-muted">None</span>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

function IntegrationCard({ i }: { i: Integration }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{i.label}</CardTitle>
        {i.demo_fixture && <span className="text-xs text-fg-muted">Demo fixture, not a real connection</span>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Details
          items={[
            ["Connection", <StateBadge map={CONNECTION} value={i.connection} />],
            [
              "Last sync",
              <span className="flex flex-col gap-1">
                <StateBadge map={SYNC} value={i.sync} />
                {i.sync === "syncing" && i.last_run && (
                  <span className="text-xs text-fg-muted">
                    Started <Time iso={i.last_run.started_at} />
                    {stageOf(i.last_run) && <> · now {stageOf(i.last_run)}</>}
                  </span>
                )}
              </span>,
            ],
            [
              "Freshness",
              <span className="flex flex-wrap items-center gap-2">
                <StateBadge map={FRESHNESS} value={i.freshness} />
                <span className="text-xs text-fg-muted">
                  last successful sync <Time iso={i.last_success_at} missing="not_synced" />
                </span>
              </span>,
            ],
            ["Can read", <ul className="list-disc pl-5">{i.capabilities.read.map((c) => <li key={c}>{c}</li>)}</ul>],
            [
              "Can change",
              i.capabilities.write.length ? (
                <span className="flex flex-col gap-1">
                  <span>Offboarding only, with separate write credentials. Each run is started and confirmed by an administrator.</span>
                  <ul className="list-disc pl-5">{i.capabilities.write.map((c) => <li key={c}>{c}</li>)}</ul>
                </span>
              ) : (
                "Nothing. Discovery only reads; no write credentials are configured."
              ),
            ],
          ]}
        />
        {i.connection === "reauth_required" && (
          <Notice tone="attention">
            The source rejected the credentials: {i.last_error}. Previously observed data stays visible with its observation time; nothing is
            marked absent. Renew the credentials or the granted scopes in .env, then run a sync.
          </Notice>
        )}
        {i.connection === "connected" && i.last_error && <ErrorPanel title="Last sync failed" message={`${i.last_error}. Earlier data stays visible.`} />}
        {i.connection === "not_configured" && <p className="text-sm text-fg-secondary">Not configured. The README describes the read-only credentials this connector needs.</p>}
        <details className="text-sm">
          <summary className="cursor-pointer text-primary">Permissions this connector requests</summary>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-xs [overflow-wrap:anywhere] text-fg-secondary">
            {i.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}

function SyncNow({ running, configured }: { running: boolean; configured: boolean }) {
  const refresh = useRefresh();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const reason = !configured ? "No connector is configured, so there is nothing to sync." : running ? "A sync is already running." : null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={!!reason}
        aria-describedby="sync-reason"
        onClick={async () => {
          setMessage(null);
          try {
            await api("/api/integrations/sync", { method: "POST" });
            setMessage({ error: false, text: "Sync started. Results appear under Recent sync runs." });
            setTimeout(refresh, 3000);
          } catch (e) {
            setMessage({ error: true, text: e instanceof Error ? e.message : "Could not start the sync." });
          }
        }}
      >
        <RefreshCw strokeWidth={1.75} aria-hidden />
        Run sync now
      </Button>
      <p id="sync-reason" role="status" className={`max-w-xs text-xs ${message?.error ? "text-failure-fg" : "text-fg-muted"}`}>
        {message?.text ?? reason}
      </p>
    </div>
  );
}
