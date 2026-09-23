"use client";

import { useState } from "react";
import { VOICE_PROVIDER_SPECS, specFor } from "@/lib/providers/voice/credentials";

/**
 * A voice credential entered as fields rather than pasted as JSON.
 *
 * The other three integrations are pasted because that is the shape they
 * arrive in - a downloaded service-account file, a copied webhook URL. A voice
 * provider is six or seven values read off a console one at a time, and asking
 * someone to assemble JSON by hand from a dashboard is how a stray quote
 * becomes a campaign that cannot dial.
 *
 * The fields are assembled back into the credential JSON the action already
 * validates and seals, so there is one storage format and one validator.
 */
export function VoiceCredentialFields({
  name = "credential",
  onChange,
}: {
  name?: string;
  onChange?: (json: string) => void;
}) {
  const [provider, setProvider] = useState(VOICE_PROVIDER_SPECS[0]!.provider);
  const [values, setValues] = useState<Record<string, string>>({});

  const spec = specFor(provider);
  const json = JSON.stringify({ provider, ...trimmed(values) });

  function update(key: string, value: string) {
    const next = { ...values, [key]: value };
    setValues(next);
    onChange?.(JSON.stringify({ provider, ...trimmed(next) }));
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <input type="hidden" name={name} value={json} readOnly />

      <div>
        <label htmlFor="voice-provider">Provider</label>
        <select
          id="voice-provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setValues({});
            onChange?.(JSON.stringify({ provider: e.target.value }));
          }}
        >
          {VOICE_PROVIDER_SPECS.map((s) => (
            <option key={s.provider} value={s.provider}>
              {s.label}
            </option>
          ))}
        </select>
        {spec ? (
          <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>{spec.note}</div>
        ) : null}
      </div>

      {/* A grid rather than a wrapping row: the hints under some fields and
          not others make flex rows sit at different heights, which reads as a
          broken form rather than an optional field. */}
      <div
        style={{
          display: "grid",
          gap: "10px 12px",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          alignItems: "start",
        }}
      >
        {spec?.fields.map((field) => (
          <div key={field.key}>
            <label htmlFor={`voice-${field.key}`}>
              {field.label}
              {field.optional ? " (optional)" : ""}
            </label>
            <input
              id={`voice-${field.key}`}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              value={values[field.key] ?? ""}
              onChange={(e) => update(field.key, e.target.value)}
              style={{ width: "100%" }}
            />
            {field.hint ? (
              <div style={{ color: "var(--faint)", fontSize: 11, marginTop: 3 }}>{field.hint}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Empty strings are left out entirely, so an optional field stays optional. */
function trimmed(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v !== ""),
  );
}
