import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listAccessibleTenants } from "@/lib/auth/tenant";
import { can, hasGlobalScope, type Permission } from "@/lib/auth/rbac";
import { TenantSwitcher } from "./tenant-switcher";
import { SignOutButton } from "./sign-out-button";

/**
 * Admin shell. Navigation follows PRD 14.1, plus a Review Queue entry - PRD
 * 26.3 makes the human-review queue an Operations Manager surface, and PRD
 * 14.1 predates that section.
 */
const NAV = [
  { href: "/dashboard", label: "Dashboard", needs: null },
  { href: "/clients", label: "Clients", needs: "tenant:read" },
  { href: "/campaigns", label: "Campaigns", needs: "campaign:read" },
  { href: "/leads", label: "Leads", needs: "lead:read" },
  { href: "/calls", label: "Calls", needs: "call:read" },
  { href: "/review", label: "Review Queue", needs: "review:read" },
  { href: "/callbacks", label: "Callbacks", needs: "call:read" },
  { href: "/analytics", label: "Analytics", needs: "analytics:read" },
  { href: "/integrations", label: "Integrations", needs: "integration:read" },
  { href: "/settings", label: "Settings", needs: "user:read" },
  { href: "/audit", label: "Audit Log", needs: "audit:read" },
] as const satisfies ReadonlyArray<{ href: string; label: string; needs: Permission | null }>;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const tenants = await listAccessibleTenants(user);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Lead Calling
          <small>Control plane</small>
        </div>

        <TenantSwitcher
          tenants={tenants}
          activeTenantId={user.activeTenantId}
          canSeeAll={hasGlobalScope(user.role)}
        />

        {/* Only show what this role can actually open. A nav entry that always
            refuses reads as a broken link, not as a permission boundary. */}
        <nav className="nav">
          {NAV.filter((item) => item.needs === null || can(user.role, item.needs)).map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="spacer" />

        <div className="stack" style={{ gap: 8 }}>
          <div style={{ fontSize: 12 }}>
            {user.name}
            <div style={{ color: "var(--muted)", fontSize: 11 }}>{user.role.replace(/_/g, " ")}</div>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
