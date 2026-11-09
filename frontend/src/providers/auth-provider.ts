import type { AccessControlProvider, AuthProvider } from "@refinedev/core";

import { ApiError, api } from "@/lib/api";
import { cachedSession, loadSession } from "@/providers/session";

// Sign-in happens through server-side OIDC redirects (/login/google, /login/microsoft), never in this code.
export const authProvider: AuthProvider = {
  login: async () => ({ success: false }),
  logout: async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    return { success: true, redirectTo: "/login" };
  },
  check: async () => {
    const session = await loadSession().catch(() => null);
    return session ? { authenticated: true } : { authenticated: false, redirectTo: "/login", logout: true };
  },
  getIdentity: async () => cachedSession() ?? (await loadSession()),
  getPermissions: async () => (cachedSession() ?? (await loadSession()))?.role ?? null,
  onError: async (error) => {
    if (error instanceof ApiError && error.status === 401) return { logout: true, redirectTo: "/login" };
    return {};
  },
};

const READ_ACTIONS = new Set(["list", "show", "export"]);

/** Presentation only. The API enforces the same rules on every request. */
export const accessControlProvider: AccessControlProvider = {
  can: async ({ resource, action }) => {
    const role = (cachedSession() ?? (await loadSession()))?.role;
    if (!role) return { can: false, reason: "Not signed in." };
    if (resource === "users") return { can: role === "admin", reason: "Administrator role required." };
    if (READ_ACTIONS.has(action) || role === "admin") return { can: true };
    return { can: false, reason: "Your auditor role can read and export records, but not change them." };
  },
  options: { buttons: { enableAccessControl: true, hideIfUnauthorized: false } },
};
