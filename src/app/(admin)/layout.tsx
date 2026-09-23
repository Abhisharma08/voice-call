import { requireUser } from "@/lib/auth/current-user";
import { listAccessibleTenants } from "@/lib/auth/tenant";
import { can, hasGlobalScope, type Permission } from "@/lib/auth/rbac";
import { TenantSwitcher } from "./tenant-switcher";
import { SignOutButton } from "./sign-out-button";
import { NavLinks } from "./nav-links";

/**
 * Admin shell. Navigation is grouped the way the work runs: what is happening
 * now, what needs a person, and what is set up once.
 */
const NAV_GROUPS = [
  {
    title: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", needs: null },
      { href: "/analytics", label: "Analytics", needs: "analytics:read" },
    ],
  },
  {
    title: "Calling",
    items: [
      { href: "/leads", label: "Leads", needs: "lead:read" },
      { href: "/calls", label: "Calls", needs: "call:read" },
      { href: "/review", label: "Review Queue", needs: "review:read" },
      { href: "/callbacks", label: "Callbacks", needs: "call:read" },
    ],
  },
  {
    title: "Setup",
    items: [
      { href: "/clients", label: "Clients", needs: "tenant:read" },
      { href: "/campaigns", label: "Campaigns", needs: "campaign:read" },
      { href: "/integrations", label: "Integrations", needs: "integration:read" },
      { href: "/settings", label: "Settings", needs: "user:read" },
      { href: "/audit", label: "Audit Log", needs: "audit:read" },
    ],
  },
] as const satisfies ReadonlyArray<{
  title: string;
  items: ReadonlyArray<{ href: string; label: string; needs: Permission | null }>;
}>;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const tenants = await listAccessibleTenants(user);

  // Only show what this role can actually open. A nav entry that always
  // refuses reads as a broken link, not as a permission boundary.
  const groups = NAV_GROUPS.map((group) => ({
    title: group.title,
    items: group.items
      .filter((item) => item.needs === null || can(user.role, item.needs))
      .map((item) => ({ href: item.href, label: item.label })),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <span>
            Lead Calling
            <small>Control plane</small>
          </span>
        </div>

        <TenantSwitcher
          tenants={tenants}
          activeTenantId={user.activeTenantId}
          canSeeAll={hasGlobalScope(user.role)}
        />

        <NavLinks groups={groups} />

        <div className="spacer" />

        <div className="sidebar-foot">
          <div className="who">
            {user.name}
            <span>{user.role.replace(/_/g, " ")}</span>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
