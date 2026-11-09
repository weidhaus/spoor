import { ApiError, api, setCsrfToken } from "@/lib/api";

export type Session = { email: string; role: "admin" | "auditor"; csrf: string; demo: boolean; workflows: boolean; security_officer: boolean };

let current: Session | null = null;

/** Fetches the server-side session (verified role, CSRF token). Returns null when not signed in. */
export async function loadSession(): Promise<Session | null> {
  try {
    current = await api<Session>("/api/session");
    setCsrfToken(current.csrf);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) current = null;
    else throw e;
  }
  return current;
}

export function cachedSession() {
  return current;
}
