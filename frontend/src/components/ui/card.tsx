import * as React from "react";

import { cn } from "@/lib/utils";

// 1px border, 8px radius, no persistent shadow.
function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="card" className={cn("rounded-lg border border-line bg-surface", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-base font-semibold text-fg", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-4", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardContent };
