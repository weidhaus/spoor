import { Authenticated, CanAccess, Refine } from "@refinedev/core";
import routerProvider, { CatchAllNavigate, DocumentTitleHandler, UnsavedChangesNotifier } from "@refinedev/react-router";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";

import { AppShell } from "@/components/layout/app-shell";
import { NAV } from "@/components/layout/nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApplicationList } from "@/pages/applications/list";
import { ApplicationShow } from "@/pages/applications/show";
import { AuditPage } from "@/pages/audit";
import { Forbidden, NotFound } from "@/pages/errors";
import { IntegrationsPage } from "@/pages/integrations";
import { IssueList } from "@/pages/issues";
import { LicenseList } from "@/pages/licenses/list";
import { LicenseShow } from "@/pages/licenses/show";
import { Login } from "@/pages/login";
import { Overview } from "@/pages/overview";
import { PeopleList } from "@/pages/people/list";
import { PersonShow } from "@/pages/people/show";
import { RequestList } from "@/pages/requests/list";
import { RequestShow } from "@/pages/requests/show";
import { UsersPage } from "@/pages/users";
import { accessControlProvider, authProvider } from "@/providers/auth-provider";
import { dataProvider } from "@/providers/data-provider";

const resources = [
  { name: "applications", list: "/applications", show: "/applications/:id" },
  { name: "people", list: "/people", show: "/people/:id" },
  { name: "licenses", list: "/licenses", show: "/licenses/:id" },
  { name: "requests", list: "/requests", show: "/requests/:id" },
  { name: "issues", list: "/issues" },
  { name: "audit", list: "/audit" },
  { name: "integrations", list: "/integrations" },
  { name: "users", list: "/users" },
  { name: "accounts" },
];

const title = ({ pathname }: { pathname?: string }) => {
  const section = NAV.find((n) => pathname?.startsWith(n.to));
  return section ? `${section.label} · Spoor` : "Spoor";
};

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <Refine
          dataProvider={dataProvider}
          authProvider={authProvider}
          accessControlProvider={accessControlProvider}
          routerProvider={routerProvider}
          resources={resources}
          options={{
            syncWithLocation: true,
            warnWhenUnsavedChanges: true,
            disableTelemetry: true,
            reactQuery: { clientConfig: { defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } } },
          }}
        >
          <Routes>
            <Route
              element={
                <Authenticated key="app" fallback={<CatchAllNavigate to="/login" />}>
                  <AppShell>
                    <Outlet />
                  </AppShell>
                </Authenticated>
              }
            >
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<Overview />} />
              <Route path="/applications" element={<ApplicationList />} />
              <Route path="/applications/:id" element={<ApplicationShow />} />
              <Route path="/people" element={<PeopleList />} />
              <Route path="/people/:id" element={<PersonShow />} />
              <Route path="/licenses" element={<LicenseList />} />
              <Route path="/licenses/:id" element={<LicenseShow />} />
              <Route path="/requests" element={<RequestList />} />
              <Route path="/requests/:id" element={<RequestShow />} />
              <Route path="/issues" element={<IssueList />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route
                path="/users"
                element={
                  <CanAccess resource="users" action="list" fallback={<Forbidden />}>
                    <UsersPage />
                  </CanAccess>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Route>
            <Route
              element={
                <Authenticated key="login" fallback={<Outlet />}>
                  <Navigate to="/overview" replace />
                </Authenticated>
              }
            >
              <Route path="/login" element={<Login />} />
            </Route>
          </Routes>
          <UnsavedChangesNotifier />
          <DocumentTitleHandler handler={title} />
        </Refine>
      </TooltipProvider>
    </BrowserRouter>
  );
}
