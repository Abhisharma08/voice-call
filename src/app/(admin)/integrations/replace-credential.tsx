"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { replaceIntegrationCredential } from "./actions";
import { VoiceCredentialFields } from "./voice-credential-fields";

/**
 * Rotate an integration's secret without disturbing the integration.
 *
 * A credential is write-only by design - PRD 17.1 keeps the plaintext out of
 * every read path, so there is nothing to show and nothing to edit in place.
 * What an operator actually needs is to replace it: a token expired, a secret
 * leaked, or the original was pasted without the `clientSecret` that inbound
 * webhooks need and there was no way to add one afterwards.
 *
 * Deliberately not "add another": campaigns point at an integration id, and
 * `app.hubspot_portal_lookup` picks one row for a portal with no ordering, so
 * a duplicate makes both ambiguous.
 */
const PLACEHOLDERS: Record<string, string> = {
  hubspot: '{"accessToken": "pat-na1-...", "clientSecret": "..."}',
  google_sheets:
    '{"client_email": "...@....iam.gserviceaccount.com", "private_key": "-----BEGIN PRIVATE KEY-----\\n..."}',
  notification: '{"webhookUrl": "https://hooks.slack.com/..."}',
};

export function ReplaceCredential({
  tenantId,
  integrationId,
  type,
}: {
  tenantId: string;
  integrationId: string;
  type: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);

    const data = new FormData(event.currentTarget);
    data.set("tenantId", tenantId);
    data.set("integrationId", integrationId);

    const result = await replaceIntegrationCredential(data);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setDone(
      result.data.portalId
        ? `Replaced. Portal ${result.data.portalId} recorded.`
        : "Replaced.",
    );
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button
          className="ghost"
          onClick={() => {
            setOpen(true);
            setDone(null);
          }}
          style={{ padding: "3px 8px", fontSize: 12 }}
        >
          Replace credential
        </button>
        {done ? <span className="pill ok">{done}</span> : null}
      </div>
    );
  }

  return (
    <form className="stack" style={{ gap: 8, marginTop: 4 }} onSubmit={onSubmit}>
      {type === "voice_provider" ? (
        <VoiceCredentialFields />
      ) : (
        <>
          <label htmlFor={`cred-${integrationId}`} style={{ fontSize: 12 }}>
            New credential JSON
          </label>
          <textarea
            id={`cred-${integrationId}`}
            name="credential"
            required
            rows={4}
            placeholder={PLACEHOLDERS[type]}
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
            }}
          />
        </>
      )}
      <span style={{ fontSize: 11, color: "var(--muted)" }}>
        Replaces the stored secret and deletes the old one. The integration keeps its id, so every
        campaign pointing at it follows the new credential.
      </span>
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" disabled={busy}>
          {busy ? "Sealing..." : "Replace"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
