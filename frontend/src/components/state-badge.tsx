import { Badge } from "@/components/ui/badge";
import { type StateMap, stateOf } from "@/lib/states";

export function StateBadge({ map, value, prefix }: { map: StateMap; value: string | null | undefined; prefix?: string }) {
  const [label, tone] = stateOf(map, value);
  return <Badge tone={tone}>{prefix ? `${prefix}: ${label}` : label}</Badge>;
}
