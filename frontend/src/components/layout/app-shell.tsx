import { useGetIdentity, useLogout } from "@refinedev/core";
import { ChevronDown, Menu } from "lucide-react";
import { type ReactNode, useState } from "react";
import { NavLink, useLocation } from "react-router";

import { NAV, type NavItem } from "@/components/layout/nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { Session } from "@/providers/session";

const PRODUCT = "Spoor";

/** 240px sidebar from 1280px, 72px icon rail from 1024px, drawer below. Header is 56px, in normal flow. */
export function AppShell({ children }: { children: ReactNode }) {
  const { data: session } = useGetIdentity<Session>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery("(min-width: 1280px)");
  const location = useLocation();
  const items = NAV.filter((i) => (!i.adminOnly || session?.role === "admin") && (!i.workflows || session?.workflows));
  const section = items.find((i) => location.pathname.startsWith(i.to));

  return (
    <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <div className="min-h-dvh bg-canvas">
        <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
          Skip to content
        </a>

        <aside className="fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-surface lg:flex lg:w-[72px] xl:w-60">
          <div className="flex h-14 shrink-0 items-center border-b border-line px-4 max-xl:justify-center">
            <span className="flex items-center gap-2 text-sm font-semibold text-fg xl:text-base" aria-label={PRODUCT}>
              <img src="/spoor.svg" alt="" aria-hidden className="size-7 shrink-0" />
              <span className="max-xl:sr-only">{PRODUCT}</span>
            </span>
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
            <NavList items={items} rail={!wide} />
          </nav>
        </aside>

        <SheetContent side="left" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>{PRODUCT}</SheetTitle>
          </SheetHeader>
          <SheetBody className="p-2">
            <nav aria-label="Main">
              <NavList items={items} onNavigate={() => setDrawerOpen(false)} />
            </nav>
          </SheetBody>
        </SheetContent>

        <div className="flex min-h-dvh flex-col lg:pl-[72px] xl:pl-60">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4 md:px-6 xl:px-8">
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu className="size-[18px]" strokeWidth={1.75} />
              </Button>
            </SheetTrigger>
            <p className="min-w-0 truncate text-sm font-medium text-fg">
              <span className="text-fg-muted lg:hidden">{PRODUCT} / </span>
              {section?.label ?? ""}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {session?.demo && <Badge tone="attention">Demo data</Badge>}
              {session && <AccountMenu session={session} />}
            </div>
          </header>
          {session?.demo && (
            <div
              role="note"
              className="border-b border-attention-border bg-attention-bg px-4 py-2 text-sm text-attention-fg md:px-6 xl:px-8"
            >
              Demo data mode: every person, application and connector state is a fictional fixture. No real integration is connected, and
              request outcomes are recorded by hand, never executed.
            </div>
          )}
          <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6 xl:p-8">
            {children}
          </main>
        </div>
      </div>
    </Sheet>
  );
}

function NavList({ items, rail, onNavigate }: { items: NavItem[]; rail?: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        // Plain string className: Radix's asChild (tooltip trigger) cannot merge NavLink's function form.
        const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`);
        const link = (
          <NavLink
            to={item.to}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-fg-secondary hover:bg-surface-subtle hover:text-fg max-lg:min-h-11 pointer-coarse:min-h-11",
              rail && "justify-center px-0",
              isActive &&
                "bg-selected text-selected-fg before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary hover:bg-selected hover:text-selected-fg",
            )}
          >
            <item.icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
            <span className={cn(rail && "sr-only")}>{item.label}</span>
          </NavLink>
        );
        return (
          <li key={item.to}>
            {rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AccountMenu({ session }: { session: Session }) {
  const { mutate: logout } = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-[260px]" aria-label={`Account: ${session.email}`}>
          <span className="truncate max-sm:sr-only">{session.email}</span>
          <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="text-sm font-medium [overflow-wrap:anywhere] text-fg">{session.email}</span>
          <span className="text-xs text-fg-muted">{session.role === "admin" ? "Administrator" : "Auditor (read and export only)"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
