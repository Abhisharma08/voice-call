"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createStaffUser } from "./actions";

/**
 * New staff accounts start with no client assignments. PRD 8.2: scope is
 * granted deliberately, not inherited from being an employee.
 */
export function CreateUserForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await createStaffUser(new FormData(event.currentTarget));
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
    <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 620 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>Add agency staff</h3>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px" }}>
          <label htmlFor="u-name">Name</label>
          <input id="u-name" name="name" required maxLength={120} style={{ width: "100%" }} />
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <label htmlFor="u-email">Email</label>
          <input id="u-email" name="email" type="email" required style={{ width: "100%" }} />
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <label htmlFor="u-role">Role</label>
          <select id="u-role" name="role" defaultValue="campaign_manager">
            <option value="agency_admin">Agency Admin</option>
            <option value="campaign_manager">Campaign Manager</option>
            <option value="operations_manager">Operations Manager</option>
            <option value="analyst">Analyst</option>
          </select>
        </div>
      </div>

      <div style={{ maxWidth: 320 }}>
        <label htmlFor="u-password">Initial password (at least 12 characters)</label>
        <input
          id="u-password"
          name="password"
          type="password"
          required
          minLength={12}
          style={{ width: "100%" }}
        />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create account"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          Starts with no client assignments.
        </span>
      </div>
    </form>
  );
}
