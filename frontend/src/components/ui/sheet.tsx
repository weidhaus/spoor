import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

// side="left": navigation drawer, min(320px, 100vw - 32px). side="right": 520px detail sheet, full width below 768px.
function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: "left" | "right" }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/40 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <SheetPrimitive.Content
        className={cn(
          "fixed inset-y-0 z-50 flex h-dvh flex-col border-line bg-surface shadow-float duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out",
          side === "left"
            ? "left-0 w-[min(320px,calc(100vw-32px))] rounded-r-xl border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left"
            : "right-0 w-full rounded-l-xl border-l md:w-[520px] data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-2.5 right-2 inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-fg-secondary hover:bg-surface-subtle pointer-coarse:size-11 max-md:size-11">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-h-14 flex-col justify-center gap-1 border-b border-line px-4 py-3 pr-14", className)} {...props} />;
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto p-4", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn("text-base font-semibold text-fg", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn("text-sm text-fg-secondary", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetBody, SheetTitle, SheetDescription };
