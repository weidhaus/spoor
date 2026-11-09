import { useCustom } from "@refinedev/core";
import { Link } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";

import { Page, PageHeader } from "@/components/page";
import { ErrorPanel, LoadingPanel } from "@/components/panels";
import { StateBadge } from "@/components/state-badge";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRole } from "@/hooks/use-role";
import { formatNumber } from "@/lib/format";
import {
  CONNECTION,
  DECISION,
  FRESHNESS,
  ISSUE_KIND,
  REQUEST_TYPE,
  SEVERITY,
  SYNC,
} from "@/lib/states";

type Overview = {
  cards: {
    applications: number;
    people: number;
    pending_requests: number;
    integration_issues: number;
    integrations_enabled: number;
  };
  pending_requests: {
    id: number;
    type: string;
    person_name: string | null;
    person_email: string;
    app_name: string;
    requested_at: string;
    decision: string;
  }[];
  integrations: {
    name: string;
    label: string;
    connection: string;
    sync: string;
    freshness: string;
    last_success_at: string | null;
    needs_attention: boolean;
  }[];
  findings: { id: number; kind: string; severity: string; title: string }[];
  findings_total: number;
  top_apps: { id: number; name: string; people: number }[];
  generated_at: string;
};

const chartConfig = {
  people: { label: "People with access", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function Overview() {
  const { query } = useCustom<Overview>({
    url: "/api/overview",
    method: "get",
  });
  const { workflows } = useRole();
  const d = query.data?.data; // result.data is {} while loading; query.data is undefined until loaded
  if (query.isLoading) return <LoadingPanel label="Loading overview…" />;
  if (query.isError || !d)
    return (
      <ErrorPanel
        message={query.error?.message}
        onRetry={() => query.refetch()}
      />
    );
  const attention = d.integrations.filter((i) => i.needs_attention);

  const cards = [
    {
      label: "Applications",
      value: d.cards.applications,
      href: "/applications",
      definition:
        "Applications from all sources, excluding those marked ignored.",
    },
    {
      label: "People",
      value: d.cards.people,
      href: "/people",
      definition:
        "Active employees from Google Workspace and Entra ID; guests excluded.",
    },
    ...(workflows
      ? [
          {
            label: "Pending requests",
            value: d.cards.pending_requests,
            href: "/requests?filters[0][field]=decision&filters[0][operator]=eq&filters[0][value]=pending",
            definition: "Access requests waiting for an approval decision.",
          },
        ]
      : []),
    {
      label: "Integration issues",
      value: d.cards.integrations_enabled ? d.cards.integration_issues : null,
      href: "/integrations",
      definition: d.cards.integrations_enabled
        ? `Of ${d.cards.integrations_enabled} configured connectors: needing reauthentication, failed or partial last sync, never synced, or stale data.`
        : "Not applicable: no connector is configured.",
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="What needs attention across applications, access requests and data sources."
        context={
          <>
            Generated <Time iso={d.generated_at} />
          </>
        }
      />

      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <li key={c.label}>
            <Link
              to={c.href}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface p-4 hover:border-primary"
            >
              <span className="text-sm font-medium text-fg-secondary">
                {c.label}
              </span>
              <span className="tabular text-2xl font-semibold text-fg">
                {c.value === null ? (
                  <span className="text-base text-fg-muted">
                    Not applicable
                  </span>
                ) : (
                  formatNumber(c.value)
                )}
              </span>
              <span className="text-xs text-fg-muted">{c.definition}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {workflows && (
          <Card>
            <CardHeader>
              <CardTitle>Pending requests</CardTitle>
              <Link
                to="/requests"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                All requests
              </Link>
            </CardHeader>
            <CardContent>
              {d.pending_requests.length === 0 ? (
                <p className="text-sm text-fg-secondary">
                  No request is waiting for a decision.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {d.pending_requests.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 flex-col">
                        <Link
                          to={`/requests/${r.id}`}
                          className="font-medium text-fg underline-offset-4 hover:underline"
                        >
                          {REQUEST_TYPE[r.type]}: {r.app_name}
                        </Link>
                        <span className="text-xs text-fg-muted">
                          {r.person_name ?? r.person_email} ·{" "}
                          <Time iso={r.requested_at} />
                        </span>
                      </div>
                      <StateBadge map={DECISION} value={r.decision} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Integrations needing attention</CardTitle>
            <Link
              to="/integrations"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              Integrations
            </Link>
          </CardHeader>
          <CardContent>
            {attention.length === 0 ? (
              <p className="text-sm text-fg-secondary">
                {d.cards.integrations_enabled
                  ? "All configured connectors synced successfully and their data is current."
                  : "No connector is configured."}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {attention.map((i) => (
                  <li
                    key={i.name}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="font-medium text-fg">{i.label}</span>
                    <div className="flex flex-wrap gap-1">
                      <StateBadge map={CONNECTION} value={i.connection} />
                      <StateBadge
                        map={SYNC}
                        value={i.sync}
                        prefix="Last sync"
                      />
                      <StateBadge map={FRESHNESS} value={i.freshness} />
                    </div>
                    <span className="text-xs text-fg-muted">
                      Last successful sync{" "}
                      <Time iso={i.last_success_at} missing="not_synced" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open issues ({formatNumber(d.findings_total)})</CardTitle>
          <Link
            to="/issues"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            All issues
          </Link>
        </CardHeader>
        <CardContent>
          {d.findings.length === 0 ? (
            <p className="text-sm text-fg-secondary">No open issues.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {d.findings.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <StateBadge map={SEVERITY} value={f.severity} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm text-fg">{f.title}</span>
                    <span className="text-xs text-fg-muted">
                      {ISSUE_KIND[f.kind] ?? f.kind}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {d.top_apps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              People with access, top {d.top_apps.length} applications
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <figure className="flex flex-col gap-2">
              <figcaption className="text-xs text-fg-muted">
                Distinct people with current access evidence (account, licence,
                OAuth grant, SSO assignment or sign-in) per application. Access
                is not usage; see each application for activity. Bars start at
                zero.
              </figcaption>
              <ChartContainer
                config={chartConfig}
                className="w-full"
                style={{ height: Math.max(220, d.top_apps.length * 36) }}
                aria-hidden
              >
                <BarChart
                  data={d.top_apps}
                  layout="vertical"
                  margin={{ left: 8, right: 40 }}
                >
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type="number"
                    domain={[0, "auto"]}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    label={{
                      value: "People",
                      position: "insideBottomRight",
                      offset: -4,
                    }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={150}
                    tickLine={false}
                    axisLine={false}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent />}
                  />
                  <Bar dataKey="people" fill="var(--color-people)" radius={4}>
                    <LabelList
                      dataKey="people"
                      position="right"
                      className="fill-fg"
                      fontSize={12}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
            </figure>
            <details>
              <summary className="cursor-pointer text-sm text-primary">
                Show the data as a table
              </summary>
              <div
                role="region"
                aria-label="Chart data table"
                tabIndex={0}
                className="mt-3 overflow-x-auto rounded-lg border border-line"
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Application</TableHead>
                      <TableHead className="text-right">
                        People with access
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.top_apps.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <Link
                            to={`/applications/${a.id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {a.name}
                          </Link>
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {formatNumber(a.people)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
