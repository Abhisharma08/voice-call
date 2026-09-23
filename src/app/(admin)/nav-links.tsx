"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sidebar links, grouped by what an operator is doing rather than by table.
 * Active state lives here because it needs the current path, which the server
 * shell does not have.
 */
export function NavLinks({
  groups,
}: {
  groups: Array<{ title: string; items: Array<{ href: string; label: string }> }>;
}) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {groups.map((group) => (
        <div key={group.title}>
          <div className="nav-group">{group.title}</div>
          {group.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
