"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addIntegration } from "../clients/actions";
import { VoiceCredentialFields } from "./voice-credential-fields";

const PLACEHOLDERS: Record<string, string> = {
  hubspot: '{"accessToken": "pat-na1-...", "clientSecret": "..."}',
  google_sheets: '{"client_email": "...@....iam.gserviceaccount.com", "private_key": "-----BEGIN PRIVATE KEY-----\\n..."}',
  notification: '{"webhookUrl": "https://hooks.slack.com/..."}',
};

/**
 * PRD 14.3 steps 2-3. The credential is validated for shape here, while the
 * plaintext is still in hand - finding out a service-account key is malformed
 * during a 2am sync is strictly worse than refusing it at paste time.
 */
export function AddIntegrationForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [type, setType] = useState("hubspot");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    data.set("tenantId", tenantId);

    const result = await addIntegration(data);
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
    <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 640 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>Add a credential</h3>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 auto" }}>
          <label htmlFor="type">Type</label>
          <select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="hubspot">HubSpot</option>
            <option value="google_sheets">Google Sheets</option>
            <option value="voice_provider">Voice provider</option>
            <option value="notification">Notification (Slack)</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="int-name">Label</label>
          <input id="int-name" name="name" required maxLength={120} style={{ width: "100%" }} />
        </div>
      </div>

      {/* A voice provider is a handful of values read off a dashboard, so it
          gets real fields. The others arrive as a file or a URL already. */}
      {type === "voice_provider" ? (
        <VoiceCredentialFields />
      ) : (
        <div>
          <label htmlFor="credential">Credential JSON</label>
          <textarea
            id="credential"
            name="credential"
            required
            rows={4}
            placeholder={PLACEHOLDERS[type]}
            style={{ width: "100%", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          />
        </div>
      )}

      <div style={{ color: "var(--muted)", fontSize: 11 }}>
        Sealed with a per-secret data key before it reaches the database, and never shown again.
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button type="submit" disabled={busy} style={{ alignSelf: "flex-start" }}>
        {busy ? "Sealing..." : "Add credential"}
      </button>
    </form>
  );
}
