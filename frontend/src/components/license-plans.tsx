import { Link } from "react-router";

import { Missing } from "@/components/missing";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatNumber } from "@/lib/format";

export type PlanRow = {
  id: number;
  app_id: number;
  app_name: string;
  name: string;
  source: string;
  quantity: number | null;
  assigned: number;
  available: number | null;
  active: number | null;
  usage_coverage: "none" | "partial" | "complete";
  usage_since: string | null;
  observed_consumed: number | null;
  unit_cost: number | null;
  currency: string;
  billing_period: string;
  renewal_date: string | null;
  annual_cost: number | null;
};

/** Purchased vs assigned on the same plan. Over-allocation is shown as such, never clamped to zero. */
export function Availability({ plan }: { plan: Pick<PlanRow, "quantity" | "available"> }) {
  if (plan.quantity === null || plan.available === null) return <Missing>Not reported (purchased quantity unknown)</Missing>;
  if (plan.available < 0) return <Badge tone="failure">Over-allocated by {formatNumber(-plan.available)}</Badge>;
  return <span className="tabular">{formatNumber(plan.available)}</span>;
}

export function Cost({ plan }: { plan: Pick<PlanRow, "unit_cost" | "currency" | "billing_period"> }) {
  if (plan.unit_cost === null) return <Missing reason="not_reported" />;
  return (
    <span className="tabular">
      {formatMoney(plan.unit_cost, plan.currency)} per seat per {plan.billing_period}
    </span>
  );
}

export function Usage({
  plan,
  inactivityDays,
}: {
  plan: Pick<PlanRow, "active" | "assigned" | "usage_coverage" | "usage_since">;
  inactivityDays: number;
}) {
  if (plan.active === null || plan.usage_coverage === "none") return <Missing>Not reported: no source supplies activity for this application</Missing>;
  if (plan.usage_coverage === "partial")
    return (
      <span className="tabular">
        {formatNumber(plan.active)} of {formatNumber(plan.assigned)} active, observed since{" "}
        {plan.usage_since ? <Time iso={plan.usage_since} dateOnly /> : "an unknown date"} (less than {inactivityDays} days)
      </span>
    );
  return (
    <span className="tabular">
      {formatNumber(plan.active)} of {formatNumber(plan.assigned)} active in the last {inactivityDays} days
    </span>
  );
}

export function LicensePlansTable({ plans, inactivityDays }: { plans: PlanRow[]; inactivityDays: number }) {
  if (!plans.length) return <p className="text-sm text-fg-secondary">No licence plan is recorded for this application.</p>;
  return (
    <div role="region" aria-label="Licence plans table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead style={{ minWidth: 200 }}>Plan</TableHead>
            <TableHead className="text-right">Purchased</TableHead>
            <TableHead className="text-right">Assigned</TableHead>
            <TableHead style={{ minWidth: 160 }}>Available or over-allocated</TableHead>
            <TableHead style={{ minWidth: 200 }}>Usage</TableHead>
            <TableHead style={{ minWidth: 180 }}>Cost</TableHead>
            <TableHead style={{ minWidth: 140 }}>Renewal date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <Link to={`/licenses/${p.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                  {p.name}
                </Link>
              </TableCell>
              <TableCell className="tabular text-right">{p.quantity === null ? <Missing reason="not_reported" /> : formatNumber(p.quantity)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(p.assigned)}</TableCell>
              <TableCell>
                <Availability plan={p} />
              </TableCell>
              <TableCell>
                <Usage plan={p} inactivityDays={inactivityDays} />
              </TableCell>
              <TableCell>
                <Cost plan={p} />
              </TableCell>
              <TableCell>
                <Time iso={p.renewal_date} dateOnly missing="not_reported" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
