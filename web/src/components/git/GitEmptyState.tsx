import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="git-empty">
      <h2>{title}</h2>
      <div className="git-empty-copy">{children}</div>
      {action && <div className="git-empty-action">{action}</div>}
    </div>
  );
}
