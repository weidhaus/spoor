import { Link } from "react-router";

import { Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";

export function Forbidden() {
  return (
    <Page narrow>
      <PageHeader title="Access denied" description="This page requires the administrator role. No data from it has been loaded." />
      <Button asChild variant="outline" className="w-fit">
        <Link to="/overview">Go to overview</Link>
      </Button>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page narrow>
      <PageHeader title="Page not found" description="The address does not match a page or record." />
      <Button asChild variant="outline" className="w-fit">
        <Link to="/overview">Go to overview</Link>
      </Button>
    </Page>
  );
}
