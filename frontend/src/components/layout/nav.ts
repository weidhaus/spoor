import { AppWindow, FileText, Inbox, KeyRound, LayoutDashboard, type LucideIcon, Plug, ShieldCheck, TriangleAlert, Users } from "lucide-react";

export type NavItem = { label: string; to: string; icon: LucideIcon; adminOnly?: boolean; workflows?: boolean };

// Stable order.
export const NAV: NavItem[] = [
  { label: "Overview", to: "/overview", icon: LayoutDashboard },
  { label: "Applications", to: "/applications", icon: AppWindow },
  { label: "People and access", to: "/people", icon: Users },
  { label: "Licenses", to: "/licenses", icon: KeyRound },
  { label: "Access requests", to: "/requests", icon: Inbox, workflows: true },
  { label: "Issues", to: "/issues", icon: TriangleAlert },
  { label: "Audit and exports", to: "/audit", icon: FileText },
  { label: "Integrations", to: "/integrations", icon: Plug },
  { label: "Users and roles", to: "/users", icon: ShieldCheck, adminOnly: true },
];
