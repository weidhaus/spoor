// Same-origin JSON client. The server keeps the session; the CSRF token from /api/session is sent as a
// header on every state-changing call (which also makes cross-site requests impossible without CORS).

let csrfToken = "";

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  status: number;
  statusCode: number; // Refine's HttpError shape
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

type Query = Record<string, string | number | undefined | null>;

async function errorMessage(res: Response) {
  try {
    const body = await res.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d: { loc?: string[]; msg: string }) => `${d.loc?.slice(-1)[0] ?? "Field"}: ${d.msg}`)
        .join(" ");
    }
  } catch {
    /* not JSON */
  }
  return res.status >= 500 ? "The server could not complete the request." : `Request failed (HTTP ${res.status}).`;
}

export async function request(
  path: string,
  { method = "GET", body, query, headers: extra }: { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> } = {}
): Promise<Response> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { ...extra };
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res;
}

export async function api<T = unknown>(path: string, options?: Parameters<typeof request>[1]): Promise<T> {
  return (await request(path, options)).json() as Promise<T>;
}
