import type { JSX, ReactNode } from 'react';
/**
 * Placeholder for a region whose feature has not been built yet.
 *
 * Deliberately not a dead button: it names the capability and the milestone
 * that delivers it, so nothing in this terminal looks functional before it is.
 */
export function Pending({
  title,
  milestone,
  children,
}: {
  title: string;
  milestone: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="pending">
      <span className="pending-tag">{milestone}</span>
      <div className="pending-title">{title}</div>
      {children ? <div className="pending-body">{children}</div> : null}
    </div>
  );
}
