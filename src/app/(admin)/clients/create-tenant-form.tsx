"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createTenant } from "./actions";

/**
 * Create the tenant and its timezone for a client account.
 * The timezone matters beyond display - it is the default for campaign calling
 * windows, so getting it wrong means calling people at the wrong hour.
 */
export function CreateTenantForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await createTenant(new FormData(event.currentTarget));
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }

    (event.target as HTMLFormElement).reset();
    setBusy(false);
    router.refresh();
  }

  return (
    <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 560 }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px" }}>
          <label htmlFor="name">Client name</label>
          <input id="name" name="name" required maxLength={120} style={{ width: "100%" }} />
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <label htmlFor="slug">Identifier</label>
          <input
            id="slug"
            name="slug"
            required
            pattern="[a-z0-9][a-z0-9-]*"
            placeholder="acme-real-estate"
            style={{ width: "100%" }}
          />
        </div>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px" }}>
          <label htmlFor="timezone">Timezone (drives calling windows)</label>
          <input
            id="timezone"
            name="timezone"
            required
            defaultValue="Asia/Kolkata"
            placeholder="Asia/Kolkata"
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: "2 1 260px" }}>
          <label htmlFor="notes">Notes (optional)</label>
          <input id="notes" name="notes" maxLength={2000} style={{ width: "100%" }} />
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create client"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          You are assigned to the new client automatically; nobody else gains access.
        </span>
      </div>
    </form>
  );
}
