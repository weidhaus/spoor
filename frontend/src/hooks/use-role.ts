import { usePermissions } from "@refinedev/core";

import { cachedSession } from "@/providers/session";

/** Presentation only: the API rejects every change an auditor attempts. */
export function useRole() {
  const { data, isLoading } = usePermissions<"admin" | "auditor" | null>({});
  return { isAdmin: data === "admin", role: data ?? null, isLoading, workflows: cachedSession()?.workflows ?? false, officer: cachedSession()?.security_officer ?? false, email: cachedSession()?.email ?? "" };
}

export const READ_ONLY_REASON = "Your auditor role can read and export records, but not change them.";
