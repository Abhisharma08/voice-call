import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, resolveSession, type AuthenticatedUser } from "@/lib/auth/session";
import { require_, type Permission } from "@/lib/auth/rbac";

/** Server-side session resolution for App Router pages and route handlers. */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requirePermission(permission: Permission): Promise<AuthenticatedUser> {
  const user = await requireUser();
  require_(user.role, permission);
  return user;
}
