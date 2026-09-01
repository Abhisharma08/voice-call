"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createCampaign } from "../clients/actions";

export function NewCampaignForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    data.set("tenantId", tenantId);

    const result = await createCampaign(data);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }

    // New campaigns start inactive and unapproved; go straight to the editor.
    router.push(`/campaigns/${result.data.id}`);
  }

  return (
    <form className="card row" onSubmit={onSubmit} style={{ gap: 10, maxWidth: 560 }}>
      <div style={{ flex: 1 }}>
        <label htmlFor="campaign-name">New campaign</label>
        <input
          id="campaign-name"
          name="name"
          required
          maxLength={120}
          placeholder="Noida 2BHK"
          style={{ width: "100%" }}
        />
        {error ? <p className="error">{error}</p> : null}
      </div>
      <button type="submit" disabled={busy} style={{ alignSelf: "flex-end" }}>
        {busy ? "Creating..." : "Create"}
      </button>
    </form>
  );
}
