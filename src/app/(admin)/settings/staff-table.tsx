"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  assignUserToTenant,
  grantElevation,
  removeAssignment,
  setUserStatus,
} from "./actions";
import { ROLES } from "@/lib/auth/rbac";

export interface TenantOption {
  id: string;
  name: string;
}

export interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  assignments: Array<{ tenantId: string; tenantName: string; role: string }>;
}

export function StaffTable({
  staff,
  tenants,
  currentUserId,
  editable,
  canElevate,
}: {
  staff: StaffRow[];
  tenants: TenantOption[];
  currentUserId: string;
  editable: boolean;
  canElevate: boolean;
}) {
  return (
    <div className="stack">
      {staff.map((s) => (
        <StaffCard
          key={s.id}
          staff={s}
          tenants={tenants}
          isSelf={s.id === currentUserId}
          editable={editable}
          canElevate={canElevate}
        />
      ))}
    </div>
  );
}

function StaffCard({
  staff,
  tenants,
  isSelf,
  editable,
  canElevate,
}: {
  staff: StaffRow;
  tenants: TenantOption[];
  isSelf: boolean;
  editable: boolean;
  canElevate: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elevating, setElevating] = useState(false);

  async function run(build: () => FormData, action: (d: FormData) => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await action(build());
    if (!result.ok) setError(result.error ?? "Failed");
    setBusy(false);
    router.refresh();
  }

  const global = staff.role === "agency_admin";
  const unassigned = tenants.filter((t) => !staff.assignments.some((a) => a.tenantId === t.id));

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong>{staff.name}</strong>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{staff.email}</span>
        <span className="pill">{staff.role.replace(/_/g, " ")}</span>
        <span className={`pill ${staff.status === "active" ? "ok" : "warn"}`}>{staff.status}</span>
        <div className="spacer" />
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          {staff.lastLoginAt ? `last login ${new Date(staff.lastLoginAt).toLocaleDateString()}` : "never signed in"}
        </span>
        {editable && !isSelf ? (
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => {
                  const d = new FormData();
                  d.set("userId", staff.id);
                  d.set("status", staff.status === "active" ? "disabled" : "active");
                  return d;
                },
                setUserStatus,
              )
            }
            style={{ padding: "3px 8px", fontSize: 12 }}
          >
            {staff.status === "active" ? "Disable" : "Enable"}
          </button>
        ) : null}
      </div>

      {global ? (
        // PRD 4 gives the Agency Admin global scope; assignments would be
        // misleading here, since they do not constrain anything.
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          Global scope: reaches every client without an assignment.
        </div>
      ) : (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Assigned to:</span>
          {staff.assignments.length === 0 ? (
            <span className="pill warn">no clients</span>
          ) : (
            staff.assignments.map((a) => (
              <span key={a.tenantId} className="pill">
                {a.tenantName}
                {editable ? (
                  <button
                    className="ghost"
                    disabled={busy}
                    title={`Remove ${staff.email} from ${a.tenantName}`}
                    onClick={() =>
                      void run(
                        () => {
                          const d = new FormData();
                          d.set("userId", staff.id);
                          d.set("tenantId", a.tenantId);
                          return d;
                        },
                        removeAssignment,
                      )
                    }
                    style={{
                      border: "none",
                      background: "none",
                      padding: "0 0 0 6px",
                      color: "inherit",
                      fontSize: 12,
                    }}
                  >
                    &times;
                  </button>
                ) : null}
              </span>
            ))
          )}

          {editable && unassigned.length > 0 ? (
            <select
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                const tenantId = e.target.value;
                if (!tenantId) return;
                e.target.value = "";
                void run(
                  () => {
                    const d = new FormData();
                    d.set("userId", staff.id);
                    d.set("tenantId", tenantId);
                    d.set("role", staff.role);
                    return d;
                  },
                  assignUserToTenant,
                );
              }}
              style={{ fontSize: 12, padding: "3px 6px" }}
            >
              <option value="">+ assign client</option>
              {unassigned.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : null}

          {canElevate && !global && unassigned.length > 0 ? (
            <button
              className="ghost"
              onClick={() => setElevating((v) => !v)}
              style={{ padding: "3px 8px", fontSize: 12 }}
            >
              {elevating ? "Cancel" : "Grant temporary access"}
            </button>
          ) : null}
        </div>
      )}

      {elevating ? (
        <form
          className="row"
          style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void run(
              () => {
                const d = new FormData(form);
                d.set("userId", staff.id);
                return d;
              },
              grantElevation,
            ).then(() => setElevating(false));
          }}
        >
          <div style={{ flex: "0 0 auto" }}>
            <label htmlFor={`tenant-${staff.id}`}>Client</label>
            <select id={`tenant-${staff.id}`} name="tenantId" required>
              {unassigned.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: "1 1 240px" }}>
            <label htmlFor={`reason-${staff.id}`}>Reason (recorded in the audit log)</label>
            <input
              id={`reason-${staff.id}`}
              name="reason"
              required
              minLength={10}
              placeholder="Covering incident triage while the assigned manager is away"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <label htmlFor={`hours-${staff.id}`}>Hours</label>
            <input
              id={`hours-${staff.id}`}
              name="hours"
              type="number"
              min={1}
              max={72}
              defaultValue={8}
              style={{ width: 80 }}
            />
          </div>
          <button type="submit" disabled={busy}>
            Grant
          </button>
        </form>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export { ROLES };
