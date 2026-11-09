import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Always carries visible text; colour only reinforces the explicitly labelled state.
const badgeVariants = cva(
  "inline-flex min-h-6 w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        success: "border-success-border bg-success-bg text-success-fg",
        attention: "border-attention-border bg-attention-bg text-attention-fg",
        failure: "border-failure-border bg-failure-bg text-failure-fg",
        info: "border-info-border bg-info-bg text-info-fg",
        neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
);

function Badge({ className, tone, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
