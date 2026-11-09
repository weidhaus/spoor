import { useCustom } from "@refinedev/core";
import { Download } from "lucide-react";
import { useId, useState } from "react";

import { ErrorPanel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { request } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

const EXPORT_RESOURCES: Record<string, string> = {
  applications: "Applications",
  people: "People",
  accounts: "Access evidence (accounts)",
  licenses: "Licence plans",
  requests: "Access requests",
  issues: "Issues",
  audit: "Audit events",
};

type Job =
  | { state: "idle" }
  | { state: "generating" }
  | {
      state: "ready";
      url: string;
      filename: string;
      count: number;
      generatedAt: string;
      scope: string;
    }
  | { state: "failed"; message: string };

/**
 * Export scope dialog. The server applies the same filters as the table, so "all matching records" is every match,
 * never just the loaded page. Generation is synchronous; the status shown is the real request state.
 */
export function ExportDialog({
  resource: initialResource,
  filters = {},
  matchingCount,
  selectedIds = [],
  chooseResource = false,
}: {
  resource: string;
  filters?: Record<string, string>;
  matchingCount?: number;
  selectedIds?: string[];
  chooseResource?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState(initialResource);
  const [scope, setScope] = useState<"matching" | "selected" | "archive">(
    "matching",
  );
  const [fields, setFields] = useState<string[] | null>(null);
  const [job, setJob] = useState<Job>({ state: "idle" });
  const ids = useId();

  const { query: fieldsQuery } = useCustom<Record<string, string[]>>({
    url: "/api/exports/fields",
    method: "get",
    queryOptions: { enabled: open, staleTime: Infinity },
  });
  const available = fieldsQuery.data?.data[resource] ?? [];
  const chosen = fields ?? available;
  const ownResource = resource === initialResource;
  const activeFilters = ownResource
    ? Object.entries(filters).filter(([, v]) => v)
    : [];

  function onOpenChange(next: boolean) {
    if (next) {
      setResource(initialResource);
      setFields(null);
      setScope(selectedIds.length ? "selected" : "matching");
    } else if (job.state === "ready") {
      URL.revokeObjectURL(job.url);
    }
    if (!next) setJob({ state: "idle" });
    setOpen(next);
  }

  async function generate() {
    setJob({ state: "generating" });
    const scopeText =
      scope === "archive"
        ? "All audit events, signed archive"
        : scope === "selected"
          ? `${selectedIds.length} selected records`
          : activeFilters.length
            ? `All records matching ${activeFilters.map(([k, v]) => `${k}=${v}`).join(", ")}`
            : "All records";
    try {
      const res =
        scope === "archive"
          ? await request("/api/audit/archive", { method: "POST" })
          : await request("/api/exports", {
              method: "POST",
              body: {
                resource,
                filters: Object.fromEntries(activeFilters),
                ids: scope === "selected" ? selectedIds.map(Number) : undefined,
                fields: chosen,
              },
            });
      const blob = await res.blob();
      const filename =
        /filename="([^"]+)"/.exec(
          res.headers.get("content-disposition") ?? "",
        )?.[1] ?? `${resource}.csv`;
      setJob({
        state: "ready",
        url: URL.createObjectURL(blob),
        filename,
        count: Number(res.headers.get("x-export-count") ?? 0),
        generatedAt:
          res.headers.get("x-export-generated-at") ?? new Date().toISOString(),
        scope: scopeText,
      });
    } catch (e) {
      setJob({
        state: "failed",
        message: e instanceof Error ? e.message : "Export failed.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download strokeWidth={1.75} aria-hidden />
          Export
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={`${ids}-desc`}>
        <DialogHeader>
          <DialogTitle>Export data</DialogTitle>
          <DialogDescription id={`${ids}-desc`}>
            Choose what to export. The file is generated on the server from the
            current data.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          {chooseResource && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-res`}>Resource</Label>
              <Select
                value={resource}
                onValueChange={(v) => {
                  setResource(v);
                  setFields(null);
                  setScope("matching");
                  setJob({ state: "idle" });
                }}
              >
                <SelectTrigger id={`${ids}-res`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPORT_RESOURCES)
                    .filter(
                      ([k]) => !fieldsQuery.data || k in fieldsQuery.data.data,
                    )
                    .map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium text-fg">
              Records
            </legend>
            <ScopeOption
              name={`${ids}-scope`}
              checked={scope === "matching"}
              onSelect={() => setScope("matching")}
            >
              All records matching the current filters
              {ownResource && matchingCount !== undefined
                ? ` (${formatNumber(matchingCount)})`
                : ""}
              <span className="block text-xs text-fg-muted">
                {activeFilters.length
                  ? `Filters: ${activeFilters.map(([k, v]) => `${k} = ${v}`).join(" · ")}`
                  : ownResource
                    ? "No filters applied: every record is included."
                    : "Filters from this page do not apply to this resource: every record is included."}
              </span>
            </ScopeOption>
            {ownResource && selectedIds.length > 0 && (
              <ScopeOption
                name={`${ids}-scope`}
                checked={scope === "selected"}
                onSelect={() => setScope("selected")}
              >
                Only the {formatNumber(selectedIds.length)} selected records
              </ScopeOption>
            )}
            {resource === "audit" && (
              <ScopeOption
                name={`${ids}-scope`}
                checked={scope === "archive"}
                onSelect={() => setScope("archive")}
              >
                Signed archive of all audit events
                <span className="block text-xs text-fg-muted">
                  ZIP with events.jsonl and a manifest holding a SHA-256
                  checksum, the chain head and an HMAC signature. Ignores
                  filters.
                </span>
              </ScopeOption>
            )}
          </fieldset>

          {scope !== "archive" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-fg">
                Fields
              </legend>
              {fieldsQuery.isError ? (
                <ErrorPanel
                  message="Could not load the field list."
                  onRetry={() => fieldsQuery.refetch()}
                />
              ) : (
                <>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setFields(available)}
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setFields([])}
                    >
                      Select none
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                    {available.map((f) => (
                      <div key={f} className="flex items-center gap-3">
                        <Checkbox
                          id={`${ids}-f-${f}`}
                          checked={chosen.includes(f)}
                          onCheckedChange={(v) =>
                            setFields(
                              v
                                ? [...chosen, f]
                                : chosen.filter((x) => x !== f),
                            )
                          }
                        />
                        <Label
                          htmlFor={`${ids}-f-${f}`}
                          className="font-normal"
                        >
                          {f}
                        </Label>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
          )}

          <p className="text-sm text-fg-secondary">
            Format:{" "}
            {scope === "archive"
              ? "ZIP (JSON Lines + signed manifest)"
              : "CSV, UTF-8. Cells starting with = + - @ are prefixed with ' to prevent formula injection."}
          </p>

          <div role="status" aria-live="polite">
            {job.state === "generating" && (
              <p className="text-sm text-fg-secondary">Generating…</p>
            )}
            {job.state === "failed" && (
              <ErrorPanel
                title="Export failed"
                message={job.message}
                onRetry={generate}
              />
            )}
            {job.state === "ready" && (
              <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4 text-sm">
                <p className="font-semibold text-fg">Ready</p>
                <p className="text-fg-secondary">
                  {formatNumber(job.count)} records · generated{" "}
                  {formatDateTime(job.generatedAt)} · {job.scope}
                </p>
                <p className="text-xs text-fg-muted">
                  The export, its filters and row count are recorded in the
                  audit log.
                </p>
                <Button asChild className="w-fit">
                  <a href={job.url} download={job.filename}>
                    <Download strokeWidth={1.75} aria-hidden />
                    Download {job.filename}
                  </a>
                </Button>
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={generate}
            disabled={
              job.state === "generating" ||
              (scope !== "archive" && chosen.length === 0) ||
              !fieldsQuery.data
            }
          >
            {job.state === "generating" ? "Generating…" : "Generate export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOption({
  name,
  checked,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-primary has-[:checked]:bg-selected">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 size-4 accent-[var(--primary)]"
      />
      <span className="text-sm text-fg">{children}</span>
    </label>
  );
}
