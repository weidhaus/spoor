import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// 36px desktop height, 12px padding, 8px icon gap; 44px on narrow screens and coarse pointers.
const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-pressed",
        destructive: "bg-danger text-on-primary hover:bg-danger-hover",
        outline: "border border-line-control bg-surface text-fg hover:bg-surface-subtle",
        secondary: "border border-line-control bg-surface text-fg hover:bg-surface-subtle",
        ghost: "text-fg hover:bg-surface-subtle",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-3 py-1.5 max-md:min-h-11 pointer-coarse:min-h-11",
        sm: "min-h-8 px-2.5 py-1 max-md:min-h-11 pointer-coarse:min-h-11",
        lg: "min-h-10 px-4 py-2 max-md:min-h-11 pointer-coarse:min-h-11",
        icon: "size-9 max-md:size-11 pointer-coarse:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
