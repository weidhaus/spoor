import { Page, PageHeader } from "@/components/page";
import { RequestDialog } from "@/components/request-dialog";
import { RequestsTable } from "@/components/requests-table";
import { useRole } from "@/hooks/use-role";

export function RequestList() {
  const { isAdmin } = useRole();
  return (
    <Page>
      <PageHeader
        title="Access requests"
        description="Requests to grant or revoke access, with the decision and the recorded execution kept separate. Connectors only read, so an approved change is made in the application itself and its outcome is recorded here; verification then compares it with the next observation."
        actions={isAdmin ? <RequestDialog label="New request" /> : undefined}
      />
      <RequestsTable syncWithLocation />
    </Page>
  );
}
