/**
 * A clean refusal for a surface the signed-in role may not use.
 *
 * Distinct from the 404 that a cross-tenant request gets: PRD 23.3's
 * non-disclosure rule is about not revealing whether another client's data
 * exists. Which *features* a role holds is not a secret from that role, and
 * pretending a page does not exist would just look like a bug.
 */
export function AccessDenied({ title, needs }: { title: string; needs: string }) {
  return (
    <>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">Not available to your role.</p>
      <div className="empty">
        This page needs the <code>{needs}</code> permission. An Agency Admin can change your role or
        grant access.
      </div>
    </>
  );
}
