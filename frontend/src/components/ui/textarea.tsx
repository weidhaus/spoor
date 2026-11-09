import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-28 w-full resize-y rounded-md border border-line-control bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted max-md:text-base disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
