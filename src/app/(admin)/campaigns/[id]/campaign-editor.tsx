"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCampaign } from "../actions";
import type { CampaignConfig } from "@/lib/campaigns/config";

/**
 * The campaign configuration form.
 *
 * Grouped the way an operator thinks about a campaign rather than the way the
 * table is laid out: what the agent says, what it asks, how answers score,
 * when we may call, and where results go.
 */
export function CampaignEditor({
  tenantId,
  campaignId,
  initial,
  providers,
  hubspotIntegrations,
  versions,
  readOnly,
}: {
  tenantId: string;
  campaignId: string;
  initial: CampaignConfig;
  providers: string[];
  hubspotIntegrations: Array<{ id: string; name: string; status: string }>;
  versions: Array<{ version: number; createdAt: string; note: string | null; by: string | null }>;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<CampaignConfig>(initial);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof CampaignConfig>(key: K, value: CampaignConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
    setSaved(null);
  }

  async function onSave() {
    setBusy(true);
    setError(null);

    const result = await saveCampaign(tenantId, campaignId, config, note || null);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }

    setSaved(result.data.version);
    setNote("");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <Section title="Agent" hint="What the AI says, and the context it may rely on (PRD 10.1).">
        <Field label="Opening script">
          <textarea
            rows={3}
            value={config.script}
            disabled={readOnly}
            onChange={(e) => set("script", e.target.value)}
            style={textarea}
          />
        </Field>
        <Field
          label="Business context"
          hint="Grounds the model. PRD 10.2: it must never invent pricing, availability or policy terms."
        >
          <textarea
            rows={3}
            value={config.businessContext}
            disabled={readOnly}
            onChange={(e) => set("businessContext", e.target.value)}
            style={textarea}
          />
        </Field>
        <Row>
          <Field label="Domain">
            <input
              value={config.domain ?? ""}
              disabled={readOnly}
              onChange={(e) => set("domain", e.target.value || null)}
              style={input}
            />
          </Field>
          <Field label="Voice provider">
            <select
              value={config.voiceProvider}
              disabled={readOnly}
              onChange={(e) => set("voiceProvider", e.target.value)}
              style={input}
            >
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </Row>
      </Section>

      <Section
        title="Qualification questions"
        hint="Field names are the keys the model must return. A required field left unanswered sends the result to review (PRD 26.3)."
      >
        <QuestionEditor
          questions={config.questions}
          readOnly={readOnly}
          onChange={(q) => set("questions", q)}
        />
      </Section>

      <Section
        title="Scoring rubric"
        hint="PRD 11.2. Applied in code to the model's extracted fields, so a score is always reproducible."
      >
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          {(Object.keys(config.scoringRubric) as Array<keyof typeof config.scoringRubric>).map((k) => (
            <Field key={k} label={k.replace(/_/g, " ")} narrow>
              <input
                type="number"
                value={config.scoringRubric[k]}
                disabled={readOnly}
                onChange={(e) =>
                  set("scoringRubric", { ...config.scoringRubric, [k]: Number(e.target.value) })
                }
                style={{ ...input, width: 90 }}
              />
            </Field>
          ))}
        </div>
      </Section>

      <Section title="Routing and review" hint="PRD 11.3 thresholds and the PRD 26.3 review gate.">
        <Row>
          <Field label="Hot threshold" narrow>
            <input
              type="number"
              value={config.routingConfig.hot_threshold}
              disabled={readOnly}
              onChange={(e) =>
                set("routingConfig", {
                  ...config.routingConfig,
                  hot_threshold: Number(e.target.value),
                })
              }
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Interested threshold" narrow>
            <input
              type="number"
              value={config.routingConfig.interested_threshold}
              disabled={readOnly}
              onChange={(e) =>
                set("routingConfig", {
                  ...config.routingConfig,
                  interested_threshold: Number(e.target.value),
                })
              }
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Review below confidence" narrow hint="0-1">
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={config.reviewConfidenceThreshold}
              disabled={readOnly}
              onChange={(e) => set("reviewConfidenceThreshold", Number(e.target.value))}
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Boundary band" narrow hint="+/- points">
            <input
              type="number"
              min="0"
              value={config.reviewBoundaryBand}
              disabled={readOnly}
              onChange={(e) => set("reviewBoundaryBand", Number(e.target.value))}
              style={{ ...input, width: 90 }}
            />
          </Field>
        </Row>
      </Section>

      <Section
        title="Calling window and retries"
        hint="Times are in the campaign timezone, not the server's (FR-021)."
      >
        <Row>
          <Field label="Timezone">
            <input
              value={config.timezone}
              disabled={readOnly}
              onChange={(e) => set("timezone", e.target.value)}
              style={input}
            />
          </Field>
          <Field label="Window start" narrow>
            <input
              value={config.callingConfig.window_start}
              disabled={readOnly}
              placeholder="09:30"
              onChange={(e) =>
                set("callingConfig", { ...config.callingConfig, window_start: e.target.value })
              }
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Window end" narrow>
            <input
              value={config.callingConfig.window_end}
              disabled={readOnly}
              placeholder="18:30"
              onChange={(e) =>
                set("callingConfig", { ...config.callingConfig, window_end: e.target.value })
              }
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Country" narrow hint="For E.164">
            <input
              value={config.callingConfig.country}
              disabled={readOnly}
              maxLength={2}
              onChange={(e) =>
                set("callingConfig", {
                  ...config.callingConfig,
                  country: e.target.value.toUpperCase(),
                })
              }
              style={{ ...input, width: 70 }}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Max attempts" narrow>
            <input
              type="number"
              min="1"
              max="10"
              value={config.callingConfig.max_attempts}
              disabled={readOnly}
              onChange={(e) =>
                set("callingConfig", {
                  ...config.callingConfig,
                  max_attempts: Number(e.target.value),
                })
              }
              style={{ ...input, width: 90 }}
            />
          </Field>
          <Field label="Retry ladder (minutes, comma separated)">
            <input
              value={config.callingConfig.retry_minutes.join(", ")}
              disabled={readOnly}
              onChange={(e) =>
                set("callingConfig", {
                  ...config.callingConfig,
                  retry_minutes: e.target.value
                    .split(",")
                    .map((v) => Number(v.trim()))
                    .filter((v) => Number.isFinite(v) && v > 0),
                })
              }
              style={input}
            />
          </Field>
          <Field label="Concurrent calls" narrow>
            <input
              type="number"
              min="1"
              value={config.concurrencyLimit}
              disabled={readOnly}
              onChange={(e) => set("concurrencyLimit", Number(e.target.value))}
              style={{ ...input, width: 90 }}
            />
          </Field>
        </Row>
      </Section>

      <Section title="Destinations" hint="Where results are written (FR-004, FR-041, FR-042).">
        <Row>
          <Field label="Google Sheet ID">
            <input
              value={config.googleSheetId ?? ""}
              disabled={readOnly}
              onChange={(e) => set("googleSheetId", e.target.value || null)}
              style={input}
            />
          </Field>
          <Field label="Sheet range">
            <input
              value={config.googleSheetTab ?? ""}
              disabled={readOnly}
              onChange={(e) => set("googleSheetTab", e.target.value || null)}
              style={input}
            />
          </Field>
          <Field label="HubSpot integration">
            <select
              value={config.hubspotIntegrationId ?? ""}
              disabled={readOnly}
              onChange={(e) => set("hubspotIntegrationId", e.target.value || null)}
              style={input}
            >
              <option value="">None selected</option>
              {hubspotIntegrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.status !== "active" ? ` (${i.status})` : ""}
                </option>
              ))}
            </select>
          </Field>
        </Row>
      </Section>

      <Section
        title="Dial allowlist"
        hint="Leave empty in production. Fill it in when the provider account is a free trial, which can only reach numbers verified on it."
      >
        <Field label="Only dial these numbers (E.164, one per line)">
          <textarea
            rows={3}
            value={config.dialAllowlist.join("\n")}
            disabled={readOnly}
            placeholder="+919876543210"
            onChange={(e) =>
              set(
                "dialAllowlist",
                e.target.value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter((v) => v !== ""),
              )
            }
            style={textarea}
          />
        </Field>
        {config.dialAllowlist.length > 0 ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="pill warn">restricted</span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              Every other lead on this campaign is suppressed as{" "}
              <code>not_on_dial_allowlist</code> before a call is placed. Clear this before going
              live.
            </span>
          </div>
        ) : null}
      </Section>

      <Section
        title="Lead routing"
        hint="Which leads land in this campaign. A HubSpot private app has one webhook URL for the whole portal - the free tier has no workflows to give each campaign its own - so the campaign is read from a contact property."
      >
        <Row>
          <Field label="HubSpot contact property">
            <input
              value={config.intakeProperty ?? ""}
              disabled={readOnly}
              placeholder="product_interest"
              onChange={(e) => set("intakeProperty", e.target.value || null)}
              style={input}
            />
          </Field>
          <Field label="Route to this campaign when it is one of (one per line)">
            <textarea
              rows={3}
              value={config.intakeValues.join("\n")}
              disabled={readOnly}
              placeholder={"uPVC windows\naluminium doors"}
              onChange={(e) =>
                set(
                  "intakeValues",
                  e.target.value
                    .split("\n")
                    .map((v) => v.trim())
                    .filter((v) => v !== ""),
                )
              }
              style={textarea}
            />
          </Field>
        </Row>

        <label className="row" style={{ gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.intakeDefault}
            disabled={readOnly}
            onChange={(e) => set("intakeDefault", e.target.checked)}
          />
          Send unmatched leads from this client here
        </label>

        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Values are matched case-insensitively and trimmed. One campaign per client may be the
          default. With a single active campaign and nothing configured, every lead comes here
          anyway — a lead that matches nothing and has nowhere to default to is recorded as
          unrouted rather than called with another campaign&apos;s script.
        </span>
      </Section>

      <Section title="Analysis" hint="The model that reads transcripts and how hard it thinks.">
        <Row>
          <Field label="Model">
            <input
              value={config.analysisModel}
              disabled={readOnly}
              onChange={(e) => set("analysisModel", e.target.value)}
              style={input}
            />
          </Field>
          <Field label="Effort" narrow>
            <select
              value={config.analysisEffort}
              disabled={readOnly}
              onChange={(e) =>
                set("analysisEffort", e.target.value as CampaignConfig["analysisEffort"])
              }
              style={input}
            >
              {["low", "medium", "high", "xhigh", "max"].map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </Row>
      </Section>

      {!readOnly ? (
        <div className="card row" style={{ gap: 10, flexWrap: "wrap", position: "sticky", bottom: 12 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="change-note">Change note (kept with the version)</label>
            <input
              id="change-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={input}
            />
          </div>
          <button onClick={() => void onSave()} disabled={busy} style={{ alignSelf: "flex-end" }}>
            {busy ? "Saving..." : "Save configuration"}
          </button>
          {saved !== null ? (
            <span className="pill ok" style={{ alignSelf: "flex-end" }}>
              saved as v{saved}
            </span>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
        </div>
      ) : (
        <p className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
          Read-only. Editing a campaign is a Campaign Manager action (PRD 4).
        </p>
      )}

      {versions.length > 0 ? (
        <Section title="Version history" hint="PRD 9: each call records the config version it ran under.">
          <div className="stack" style={{ gap: 4 }}>
            {versions.map((v) => (
              <div key={v.version} className="row" style={{ fontSize: 12, gap: 8 }}>
                <span className="pill">v{v.version}</span>
                <span style={{ color: "var(--muted)" }}>
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                <span style={{ color: "var(--muted)" }}>{v.by ?? "system"}</span>
                <span>{v.note ?? ""}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function QuestionEditor({
  questions,
  readOnly,
  onChange,
}: {
  questions: CampaignConfig["questions"];
  readOnly: boolean;
  onChange: (q: CampaignConfig["questions"]) => void;
}) {
  function update(index: number, patch: Partial<CampaignConfig["questions"][number]>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {questions.map((q, i) => (
        <div key={i} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            value={q.fieldName}
            disabled={readOnly}
            placeholder="field_name"
            onChange={(e) => update(i, { fieldName: e.target.value })}
            style={{ ...input, width: 170, fontFamily: "ui-monospace, monospace" }}
          />
          <input
            value={q.question}
            disabled={readOnly}
            placeholder="What the agent asks"
            onChange={(e) => update(i, { question: e.target.value })}
            style={{ ...input, flex: 1, minWidth: 220 }}
          />
          <label
            style={{ display: "flex", alignItems: "center", gap: 5, margin: 0, whiteSpace: "nowrap" }}
          >
            <input
              type="checkbox"
              checked={q.required}
              disabled={readOnly}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            required
          </label>
          {!readOnly ? (
            <button
              className="ghost"
              type="button"
              onClick={() => onChange(questions.filter((_, j) => j !== i))}
              style={{ padding: "4px 9px", fontSize: 12 }}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}

      {!readOnly ? (
        <button
          className="ghost"
          type="button"
          onClick={() =>
            onChange([
              ...questions,
              { fieldName: "", question: "", required: false, position: questions.length + 1 },
            ])
          }
          style={{ alignSelf: "flex-start", padding: "5px 10px", fontSize: 12 }}
        >
          Add question
        </button>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
        {hint ? (
          <p style={{ margin: "3px 0 0", color: "var(--muted)", fontSize: 12 }}>{hint}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  narrow,
  children,
}: {
  label: string;
  hint?: string;
  narrow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: narrow ? "0 0 auto" : "1 1 200px" }}>
      <label>{label}</label>
      {children}
      {hint ? (
        <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 3 }}>{hint}</div>
      ) : null}
    </div>
  );
}

const input: React.CSSProperties = { width: "100%" };
const textarea: React.CSSProperties = { width: "100%", resize: "vertical", fontFamily: "inherit" };
