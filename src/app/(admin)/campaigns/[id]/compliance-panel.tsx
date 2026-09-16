"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  approveCompliance,
  declareConsentBasis,
  revokeCompliance,
  setCampaignActive,
} from "../actions";

/**
 * The gate between a configured campaign and a dialling one (PRD 14.3 steps
 * 10-12, PRD 17.3, PRD 26.1).
 *
 * This panel is deliberately unglamorous and hard to skim past. PRD 17.3 makes
 * the point that provider and registration questions are a compliance
 * decision, not a technology default, and PRD 26.1 that a client's verbal
 * assurance is not evidence. The UI's job is to make the person clicking
 * "approve" state what they actually checked.
 */

const BASES = [
  ["opt_in_form", "Opt-in form"],
  ["existing_customer", "Existing customer relationship"],
  ["service_call", "Service call (not promotional)"],
  ["ivr_confirmation", "Recorded IVR confirmation"],
  ["other", "Other"],
] as const;

export function CompliancePanel({
  tenantId,
  campaignId,
  active,
  blockers,
  consent,
  approval,
  canConfigure,
  canApprove,
}: {
  tenantId: string;
  campaignId: string;
  active: boolean;
  blockers: string[];
  consent: {
    basis: string | null;
    source: string | null;
    evidenceRef: string | null;
    declaredAt: string | null;
    declaredBy: string | null;
    origin: string | null;
  };
  approval: { approvedAt: string | null; approvedBy: string | null };
  canConfigure: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Naming the consent origin is optional documentation, so the form stays
  // closed until someone asks for it (migration 0008).
  const [showConsent, setShowConsent] = useState(false);
  const [attestation, setAttestation] = useState("");

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    if (!result.ok) setError(result.error ?? "Failed");
    setBusy(false);
    router.refresh();
  }

  const dialable = active && approval.approvedAt !== null;

  return (
    <div className="card stack" style={{ gap: 14, borderColor: dialable ? undefined : "var(--border)" }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Calling status</strong>
        <span className={`pill ${dialable ? "ok" : "warn"}`}>
          {dialable ? "dialling" : active ? "active but blocked" : "not calling"}
        </span>
        <div className="spacer" />
        {canConfigure ? (
          <button
            className="ghost"
            disabled={busy || (!active && blockers.length > 0)}
            onClick={() =>
              void run(async () => {
                const data = new FormData();
                data.set("tenantId", tenantId);
                data.set("campaignId", campaignId);
                data.set("active", String(!active));
                return setCampaignActive(data);
              })
            }
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {active ? "Deactivate" : "Activate"}
          </button>
        ) : null}
      </div>

      {blockers.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 5 }}>
            Outstanding before this campaign can call:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {blockers.map((b) => (
              <li key={b} style={{ marginBottom: 3 }}>
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Consent basis for the client's list (PRD 14.3 step 10) ────────── */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div className="row" style={{ gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Consent basis for this client&rsquo;s lead list</strong>
          <div className="spacer" />
          {canConfigure ? (
            <button
              className="ghost"
              onClick={() => setShowConsent((s) => !s)}
              style={{ padding: "3px 8px", fontSize: 12 }}
            >
              {showConsent ? "Cancel" : consent.basis ? "Change" : "Record origin"}
            </button>
          ) : null}
        </div>

        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <span className="pill ok">inherited from source</span>
        </div>

        {consent.basis ? (
          <div style={{ fontSize: 12, marginTop: 6 }}>
            <span className="pill">{consent.basis}</span>{" "}
            <span style={{ color: "var(--muted)" }}>
              via {consent.source}
              {consent.evidenceRef ? ` · evidence ${consent.evidenceRef}` : " · no evidence reference"}
              {consent.declaredBy
                ? ` · recorded by ${consent.declaredBy} on ${new Date(consent.declaredAt!).toLocaleDateString()}`
                : ""}
            </span>
          </div>
        ) : (
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
            Consent is collected upstream at the landing page or lead form, and recorded on each lead
            at intake as <code>inherited_upstream</code>. Nothing blocks here. Naming the origin below
            is optional, and only makes the audit trail easier to read later.
          </p>
        )}

        {showConsent && canConfigure ? (
          <form
            className="stack"
            style={{ marginTop: 10, gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              data.set("tenantId", tenantId);
              data.set("campaignId", campaignId);
              void run(() => declareConsentBasis(data)).then(() => setShowConsent(false));
            }}
          >
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "0 0 auto" }}>
                <label htmlFor="basis">Basis</label>
                <select id="basis" name="basis" defaultValue={consent.basis ?? "opt_in_form"}>
                  {BASES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <label htmlFor="source">Where it was obtained</label>
                <input
                  id="source"
                  name="source"
                  required
                  defaultValue={consent.source ?? ""}
                  placeholder="landing_page_form"
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <label htmlFor="evidenceRef">Evidence reference</label>
                <input
                  id="evidenceRef"
                  name="evidenceRef"
                  defaultValue={consent.evidenceRef ?? ""}
                  placeholder="form submission ID, IVR recording ref"
                  style={{ width: "100%" }}
                />
              </div>
            </div>
            <button type="submit" disabled={busy} style={{ alignSelf: "flex-start" }}>
              Record consent basis
            </button>
          </form>
        ) : null}
      </div>

      {/* ── Compliance sign-off (PRD 17.3) ────────────────────────────────── */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <strong style={{ fontSize: 13 }}>Compliance review</strong>

        {approval.approvedAt ? (
          <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            <span className="pill ok">approved</span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {approval.approvedBy} on {new Date(approval.approvedAt).toLocaleDateString()}
            </span>
            <div className="spacer" />
            {canApprove ? (
              <button
                className="ghost"
                disabled={busy}
                onClick={() => {
                  const reason = prompt("Why is this approval being revoked?");
                  if (!reason) return;
                  void run(async () => {
                    const data = new FormData();
                    data.set("tenantId", tenantId);
                    data.set("campaignId", campaignId);
                    data.set("reason", reason);
                    return revokeCompliance(data);
                  });
                }}
                style={{ padding: "3px 8px", fontSize: 12 }}
              >
                Revoke
              </button>
            ) : null}
          </div>
        ) : canApprove ? (
          <form
            className="stack"
            style={{ marginTop: 8, gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              data.set("tenantId", tenantId);
              data.set("campaignId", campaignId);
              void run(() => approveCompliance(data));
            }}
          >
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
              PRD 17.3 requires a review of the agency&rsquo;s own sender/telemarketer registration and
              calling category, the consent basis and evidence for this list, the provider
              arrangement, DNC handling, recording notices and retention. Record what was checked and
              by whom &mdash; this attestation is kept in the audit log.
            </p>
            <textarea
              name="attestation"
              required
              minLength={20}
              rows={3}
              value={attestation}
              onChange={(e) => setAttestation(e.target.value)}
              placeholder="Reviewed by ... on ...; header registration ...; consent evidence ...; provider ...; retention ..."
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
            />
            <button type="submit" disabled={busy || attestation.trim().length < 20}>
              Record compliance approval
            </button>
          </form>
        ) : (
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
            Not approved. Approving is an Agency Admin action.
          </p>
        )}
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
