import { Missing, type MissingReason } from "@/components/missing";
import { formatDate, formatDateTime } from "@/lib/format";

export function Time({ iso, dateOnly, missing = "unknown" }: { iso?: string | null; dateOnly?: boolean; missing?: MissingReason }) {
  if (!iso) return <Missing reason={missing} />;
  return (
    <time dateTime={iso} className="tabular">
      {dateOnly ? formatDate(iso) : formatDateTime(iso)}
    </time>
  );
}
