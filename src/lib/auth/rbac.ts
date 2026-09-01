/**
 * Role-based access control.
 *
 * Roles come from PRD 4 (Personas & Users). Two things shape this model:
 *
 *  1. Clients never log in (PRD 14.3). Every account here is agency staff or a
 *     service identity, so there is no "client admin" role.
 *  2. PRD 8.2: agency staff are scoped to their assigned tenants *by default*.
 *     Being an employee of the agency is not itself authorisation to open a
 *     given client's leads. Only Agency Admin holds global scope; everyone
 *     else needs an assignment or a logged elevation.
 */

export const ROLES = [
  "agency_admin",
  "campaign_manager",
  "operations_manager",
  "analyst",
  "service",
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Tenancy
  "tenant:read",
  "tenant:write",
  "user:read",
  "user:write",
  "elevation:grant",
  // Configuration
  "campaign:read",
  "campaign:write",
  "integration:read",
  "integration:write",
  "secret:write",
  // Operations
  "lead:read",
  "lead:write",
  "call:read",
  "review:read",
  "review:resolve",
  "callback:write",
  "dnc:write",
  // Sensitive reads, each one audited (PRD 26.2)
  "pii:reveal",
  "transcript:read",
  "recording:read",
  // Reporting and oversight
  "analytics:read",
  "audit:read",
  "compliance:approve",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  agency_admin: PERMISSIONS,

  campaign_manager: [
    "tenant:read",
    "campaign:read",
    "campaign:write",
    "integration:read",
    "integration:write",
    "secret:write",
    "lead:read",
    "call:read",
    "review:read",
    "pii:reveal",
    "transcript:read",
    "analytics:read",
  ],

  operations_manager: [
    "tenant:read",
    "campaign:read",
    "lead:read",
    "lead:write",
    "call:read",
    // PRD 4: the Operations Manager owns the human-review queue (PRD 26.3)
    "review:read",
    "review:resolve",
    "callback:write",
    "dnc:write",
    "pii:reveal",
    "transcript:read",
    "recording:read",
    "analytics:read",
  ],

  analyst: ["tenant:read", "campaign:read", "lead:read", "call:read", "analytics:read"],

  // PRD 4: "Service identity only" - workflows, never a human surface.
  service: ["lead:read", "lead:write", "call:read", "callback:write", "dnc:write"],
};

/** Only this role may operate without a single pinned tenant. */
export function hasGlobalScope(role: Role): boolean {
  return role === "agency_admin";
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export class AuthorizationError extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: Role,
  ) {
    // Deliberately vague: PRD 23.3 wants cross-tenant probing to yield no
    // information about what exists.
    super("Not authorized");
    this.name = "AuthorizationError";
  }
}

export function require_(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(permission, role);
}
