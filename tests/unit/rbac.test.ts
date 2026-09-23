import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  ROLES,
  can,
  hasGlobalScope,
  permissionsFor,
  require_,
  type Role,
} from "@/lib/auth/rbac";

describe("RBAC", () => {
  it("grants global scope to the Agency Admin alone", () => {
    for (const role of ROLES) {
      expect(hasGlobalScope(role)).toBe(role === "agency_admin");
    }
  });

  it("gives the Operations Manager the review queue", () => {
    expect(can("operations_manager", "review:read")).toBe(true);
    expect(can("operations_manager", "review:resolve")).toBe(true);
  });

  it("does not let a Campaign Manager resolve review items", () => {
    // The human-review queue belongs to the Operations Manager.
    expect(can("campaign_manager", "review:resolve")).toBe(false);
  });

  it("keeps the analyst read-only", () => {
    const readOnly: Role = "analyst";
    for (const permission of permissionsFor(readOnly)) {
      expect(permission.endsWith(":write")).toBe(false);
    }
    expect(can(readOnly, "pii:reveal")).toBe(false);
    expect(can(readOnly, "transcript:read")).toBe(false);
  });

  it("keeps the service identity off human and config surfaces", () => {
    // "Service identity only".
    expect(can("service", "user:write")).toBe(false);
    expect(can("service", "campaign:write")).toBe(false);
    expect(can("service", "audit:read")).toBe(false);
    expect(can("service", "elevation:grant")).toBe(false);
  });

  it("reserves compliance approval for the Agency Admin", () => {
    for (const role of ROLES) {
      expect(can(role, "compliance:approve")).toBe(role === "agency_admin");
    }
  });

  it("reserves elevation granting for the Agency Admin", () => {
    for (const role of ROLES) {
      expect(can(role, "elevation:grant")).toBe(role === "agency_admin");
    }
  });

  it("throws a non-disclosing error", () => {
    try {
      require_("analyst", "lead:write");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as Error).message).toBe("Not authorized");
    }
  });
});
