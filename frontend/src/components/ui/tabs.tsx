import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex flex-col gap-6", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex w-full gap-1 overflow-x-auto border-b border-line", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-fg-secondary hover:text-fg max-md:min-h-11 data-[state=active]:border-primary data-[state=active]:text-selected-fg",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("flex flex-col gap-6", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
