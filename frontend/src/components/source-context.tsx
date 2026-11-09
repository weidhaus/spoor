import { useCustom } from "@refinedev/core";
import { Link } from "react-router";

import { Time } from "@/components/time";
import { CONNECTION, FRESHNESS, stateOf } from "@/lib/states";

type Integration = {
  name: string;
  label: string;
  connection: string;
  freshness: string;
  last_success_at: string | null;
};

/** One line of data-source context for list pages: which connectors feed the data and how fresh it is. */
export function SourceContext() {
  const { query } = useCustom<{ integrations: Integration[] }>({ url: "/api/integrations", method: "get" });
  if (query.isLoading) return <span>Loading data sources…</span>;
  if (query.isError) return <span>Could not load data-source status.</span>;
  const list = (query.data?.data.integrations ?? []).filter((i) => i.connection !== "not_configured");
  return (
    <span>
      {list.length === 0 ? (
        "No connector is configured; data comes from CSV imports and manual records only."
      ) : (
        <>
          Data sources:{" "}
          {list.map((i, n) => (
            <span key={i.name}>
              {n > 0 && " · "}
              {i.label}: {stateOf(CONNECTION, i.connection)[0]}, last successful sync{" "}
              {i.last_success_at ? <Time iso={i.last_success_at} /> : "never"} ({stateOf(FRESHNESS, i.freshness)[0]})
            </span>
          ))}
        </>
      )}{" "}
      · CSV imports and manual records.{" "}
      <Link to="/integrations" className="text-primary underline-offset-4 hover:underline">
        Integration status
      </Link>
    </span>
  );
}
