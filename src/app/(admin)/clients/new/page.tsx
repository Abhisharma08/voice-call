import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/rbac";
import { CAMPAIGN_TEMPLATES } from "@/lib/onboarding/templates";
import { AccessDenied } from "../../access-denied";
import { OnboardForm } from "./onboard-form";

export const dynamic = "force-dynamic";

/**
 * Onboard a client (PRD 14.3).
 *
 * The permission check is here as well as in the action because rendering a
 * form someone cannot submit is its own kind of bug - and the action is the
 * boundary that actually matters, so it checks both permissions again.
 */
export default async function NewClientPage() {
  const user = await requireUser();

  if (!can(user.role, "tenant:write") || !can(user.role, "campaign:write")) {
    return <AccessDenied title="Onboard a client" needs="tenant:write and campaign:write" />;
  }

  // Only the picker's own fields cross to the client bundle. The scripts,
  // rubrics and questions stay on the server, where they are applied.
  const templates = CAMPAIGN_TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    summary: t.summary,
  }));

  return (
    <>
      <h1 className="page-title">Onboard a client</h1>
      <p className="page-sub">
        Creates the client, its first campaign from a template, and the credential its HubSpot
        posts leads with — in one step. <Link href="/clients">Back to clients</Link>
      </p>

      <OnboardForm templates={templates} />
    </>
  );
}
