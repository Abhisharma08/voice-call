"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * Choosing a client here only asks the server to enter that tenant. The server
 * re-checks the grant on every request, so a tampered value in this
 * control grants nothing.
 */
export function TenantSwitcher({
  tenants,
  activeTenantId,
  canSeeAll,
}: {
  tenants: Tenant[];
  activeTenantId: string | null;
  canSeeAll: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onChange(value: string) {
    setError(null);
    const response = await fetch("/api/tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: value === "" ? null : value }),
    });

    if (!response.ok) {
      setError("Not available");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div>
      <label htmlFor="tenant">Client</label>
      <select
        id="tenant"
        style={{ width: "100%" }}
        value={activeTenantId ?? ""}
        disabled={pending}
        onChange={(e) => void onChange(e.target.value)}
      >
        <option value="">{canSeeAll ? "All clients" : "Select a client"}</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
