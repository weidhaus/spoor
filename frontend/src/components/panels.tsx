import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export function ErrorPanel({ title = "Could not load", message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 [overflow-wrap:anywhere] rounded-lg border border-failure-border bg-failure-bg p-4">
      <div className="flex items-start gap-2 text-failure-fg">
        <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">{title}</p>
          {message && <p className="text-sm">{message}</p>}
        </div>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-surface p-4 text-sm text-fg-secondary">
      <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden />
      {label}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "attention"; children: ReactNode }) {
  const cls = tone === "info" ? "border-info-border bg-info-bg text-info-fg" : "border-attention-border bg-attention-bg text-attention-fg";
  return <div className={`rounded-lg border px-4 py-3 text-sm [overflow-wrap:anywhere] ${cls}`}>{children}</div>;
}
