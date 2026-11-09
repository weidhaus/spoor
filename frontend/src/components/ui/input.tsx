import * as React from "react";

import { cn } from "@/lib/utils";

// 40px high, 12px padding, identifiable border-control boundary, 16px text below 768px (prevents iOS zoom).
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex min-h-10 w-full min-w-0 rounded-md border border-line-control bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted max-md:min-h-11 max-md:text-base pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className
      )}
      {...props}
    />
  );
}

export { Input };
