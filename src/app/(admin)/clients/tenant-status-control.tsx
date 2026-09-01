"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setTenantStatus } from "./actions";

/**
 * Suspending a client stops calling immediately: queued leads are suppressed
 * and campaigns deactivated, rather than draining whatever was already in
 * flight.
 */
export function TenantStatusControl({ tenantId, status }: { tenantId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (next === status) return;
    if (next !== "active" && !confirm("Suspend calling for this client? Queued leads will be suppressed.")) {
      return;
    }

    setBusy(true);
    setError(null);

    const data = new FormData();
    data.set("tenantId", tenantId);
    data.set("status", next);

    const result = await setTenantStatus(data);
    if (!result.ok) setError(result.error);
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <select
        aria-label="Client status"
        value={status}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        style={{ fontSize: 12, padding: "3px 6px" }}
      >
        <option value="active">active</option>
        <option value="inactive">inactive</option>
        <option value="suspended">suspended</option>
      </select>
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
