"use client";

import { useState } from "react";
import Link from "next/link";
import { onboardClient, type OnboardedClient } from "../actions";

/**
 * the wizard, as one form.
 *
 * The steps it collapses - create tenant, create campaign, write a script and
 * questions, mint the credential HubSpot posts with - were previously four
 * places, one of which was a file in `scripts/`. They are one transaction now,
 * so the form is one screen.
 *
 * The result panel matters as much as the form: it is the only time the
 * service token is visible (only its hash is stored), and it is where the
 * webhook URL to paste into HubSpot comes from.
 */

export interface TemplateChoice {
  id: string;
  label: string;
  summary: string;
}

export function OnboardForm({ templates }: { templates: TemplateChoice[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardedClient | null>(null);
  const [template, setTemplate] = useState(templates[0]?.id ?? "generic");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const outcome = await onboardClient(new FormData(event.currentTarget));
    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setResult(outcome.data);
  }

  if (result) return <Result result={result} />;

  const chosen = templates.find((t) => t.id === template);

  return (
    <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 640 }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px" }}>
          <label htmlFor="name">Client name</label>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            placeholder="Alu Empire"
            style={{ width: "100%" }}
            onChange={(e) => {
              // A slug is a URL-safe restatement of the name, so deriving it
              // saves a field that is only ever typed wrong. Still editable:
              // it is permanent once leads reference the tenant.
              const form = e.currentTarget.form;
              const slug = form?.elements.namedItem("slug") as HTMLInputElement | null;
              if (slug && !slug.dataset.touched) {
                slug.value = e.currentTarget.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 60);
              }
            }}
          />
        </div>
        <div style={{ flex: "1 1 180px" }}>
          <label htmlFor="slug">Identifier</label>
          <input
            id="slug"
            name="slug"
            required
            pattern="[a-z0-9][a-z0-9-]*"
            maxLength={60}
            placeholder="alu-empire"
            style={{ width: "100%" }}
            onChange={(e) => {
              e.currentTarget.dataset.touched = "1";
            }}
          />
        </div>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px" }}>
          <label htmlFor="campaignName">First campaign</label>
          <input
            id="campaignName"
            name="campaignName"
            required
            maxLength={120}
            placeholder="Website quote requests"
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: "1 1 180px" }}>
          <label htmlFor="timezone">Timezone</label>
          <input
            id="timezone"
            name="timezone"
            required
            defaultValue="Asia/Kolkata"
            maxLength={64}
            style={{ width: "100%" }}
          />
          <p style={{ color: "var(--muted)", fontSize: 11, margin: "4px 0 0" }}>
            Drives the calling window, so this decides what hour people are called at.
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="template">Campaign template</label>
        <select
          id="template"
          name="template"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          style={{ width: "100%" }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {chosen ? (
          <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>{chosen.summary}</p>
        ) : null}
      </div>

      <div>
        <label htmlFor="testNumber">Dial allowlist — your own number, for the first test</label>
        <input
          id="testNumber"
          name="testNumber"
          pattern="\+[1-9][0-9]{6,14}"
          placeholder="+919876543210"
          style={{ width: "100%" }}
        />
        <p style={{ color: "var(--muted)", fontSize: 11, margin: "4px 0 0" }}>
          While this list is non-empty, every other lead is suppressed before a call is placed.
          It is what stands between activating a campaign and ringing a real customer. Clear it
          when the client goes live.
        </p>
      </div>

      <div>
        <label htmlFor="notes">Notes (optional)</label>
        <input id="notes" name="notes" maxLength={2000} style={{ width: "100%" }} />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create client"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          The campaign starts inactive, on the mock provider. Nobody is called until you say so.
        </span>
      </div>
    </form>
  );
}

function Result({ result }: { result: OnboardedClient }) {
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="card stack">
        <div className="row">
          <span className="pill ok">Client created</span>
        </div>

        <strong>Connect the client&apos;s HubSpot — free plan</strong>
        <p style={{ margin: 0, fontSize: 13 }}>
          Free HubSpot has no workflows, so leads come from a{" "}
          <strong>private app subscription</strong>. Private apps are available on every plan.
        </p>

        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
          <li>
            In the client&apos;s HubSpot: <em>Settings → Integrations → Private apps → Create</em>.
            Give it the <code>crm.objects.contacts.read</code> and{" "}
            <code>crm.objects.contacts.write</code> scopes.
          </li>
          <li>
            Copy the <strong>access token</strong> and the <strong>client secret</strong>, and add
            them here as a HubSpot integration:{" "}
            <code>{'{"accessToken": "pat-na1-...", "clientSecret": "..."}'}</code>
          </li>
          <li>
            Press <em>Test connection</em> on <Link href="/integrations">Integrations</Link>. That
            records the portal id, which is how an inbound event finds this client — leads cannot
            arrive until it has run once.
          </li>
          <li>
            Back in the private app, open the <em>Webhooks</em> tab, set the target URL below, and
            subscribe to <code>contact.creation</code>.
          </li>
        </ol>

        <Field label="Webhook target URL (private app → Webhooks)" value={result.appWebhookUrl} />

        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          No token in this URL, and none to configure: HubSpot signs each delivery with the private
          app&apos;s client secret, and the payload&apos;s portal id names the client. Which
          campaign a lead lands in is read from a contact property — set that under{" "}
          <em>Lead routing</em> on the campaign. With one active campaign, every lead goes there.
        </p>
      </div>

      <details className="card">
        <summary style={{ cursor: "pointer" }}>
          If this client is on Professional or Enterprise instead
        </summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            A plan with workflows can post directly, with the campaign in the URL and no contact
            fetch: <em>Workflow → Send a webhook → POST</em>.
          </p>
          <Field label="Webhook URL" value={result.webhookUrl} />
          <Field
            label="Authorization header — shown once, and only the hash is stored"
            value={`Bearer ${result.token}`}
            secret
          />
          <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
            Copy the token now if you need it. It cannot be shown again; a lost one is replaced by
            minting another, not recovered. Confirm the client&apos;s plan allows a custom header on
            the webhook action before relying on this.
          </p>
        </div>
      </details>

      <div className="card stack">
        <strong>Before this campaign can dial</strong>
        {result.blockers.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing outstanding.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
            {result.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          The script and questions came from the template and are yours to edit. A real voice
          provider has to be selected too - the campaign starts on <code>mock</code>, which places
          no calls.
        </p>
        <div className="row" style={{ gap: 12 }}>
          <Link href={`/campaigns/${result.campaignId}`}>Configure the campaign</Link>
          <Link href="/integrations">Add HubSpot and Sheets credentials</Link>
          <Link href="/clients">All clients</Link>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <label>{label}</label>
      <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
        <code
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 12,
            wordBreak: "break-all",
            background: secret ? "var(--warn-bg, transparent)" : "transparent",
          }}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => setCopied(true),
              // A denied clipboard permission must not look like a copy that
              // worked; the value is on screen to select by hand either way.
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
