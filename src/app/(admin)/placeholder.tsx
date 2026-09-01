/**
 * Navigation targets from PRD 14.1 that Phase 0 deliberately leaves empty.
 * Each names the phase and PRD section that fills it, so the shell documents
 * the plan rather than pretending to be finished.
 */
export function Placeholder({
  title,
  summary,
  arrives,
}: {
  title: string;
  summary: string;
  arrives: string;
}) {
  return (
    <>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">{summary}</p>
      <div className="empty">
        Not built yet. <span className="pill warn">{arrives}</span>
      </div>
    </>
  );
}
