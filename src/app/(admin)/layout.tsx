import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listAccessibleTenants } from "@/lib/auth/tenant";
import { hasGlobalScope } from "@/lib/auth/rbac";
import { TenantSwitcher } from "./tenant-switcher";
import { SignOutButton } from "./sign-out-button";

/**
 * Admin shell. Navigation follows PRD 14.1, plus a Review Queue entry - PRD
 * 26.3 makes the human-review queue an Operations Manager surface, and PRD
 * 14.1 predates that section.
 */
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Leads" },
  { href: "/calls", label: "Calls" },
  { href: "/review", label: "Review Queue" },
  { href: "/callbacks", label: "Callbacks" },
  { href: "/analytics", label: "Analytics" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
  { href: "/audit", label: "Audit Log" },
] as const;

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

        <nav className="nav">
          {NAV.map((item) => (
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
