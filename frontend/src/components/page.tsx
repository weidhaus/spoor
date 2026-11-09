import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Title, one short sentence, the page's single primary action, then data-source context. */
export function PageHeader({
  title,
  description,
  actions,
  context,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  context?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow}
          <h1 className="text-2xl font-semibold [overflow-wrap:anywhere] text-fg">{title}</h1>
          {description && <p className="max-w-3xl text-sm text-fg-secondary">{description}</p>}
        </div>
        {actions && (
          <div className="flex flex-col gap-2 max-md:[&>*]:w-full md:flex-row md:flex-wrap md:items-center">{actions}</div>
        )}
      </div>
      {context && <div className="text-xs text-fg-muted">{context}</div>}
    </div>
  );
}

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={cn("flex flex-col gap-6", narrow && "max-w-[960px]")}>{children}</div>;
}

/** Label/value list for record details. */
export function Details({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(140px,200px)_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-sm text-fg-secondary">{k}</dt>
          <dd className="text-sm [overflow-wrap:anywhere] text-fg max-sm:mb-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
