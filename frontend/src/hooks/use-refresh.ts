import { useQueryClient } from "@tanstack/react-query";

/**
 * After a write, refetch every data query from Refine's single query client (no second cache).
 * Auth queries ("auth" keys) are left alone: re-running the session check would remount the page and lose
 * on-screen results such as per-target outcomes.
 */
export function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ predicate: (q) => q.queryKey[0] === "data" });
}
