/**
 * The secondary surface.
 *
 * Practice, the journal and the ladder open here rather than beside the chart,
 * because the chart is the application. A drawer slides over the right of the
 * workspace, dismisses on Escape, and leaves the chart mounted behind it - so
 * closing it does not cost a reload of the history.
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import './Drawer.css';

export interface DrawerProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly width?: number;
  readonly testId?: string;
}

export function Drawer({ title, onClose, children, width = 520, testId }: DrawerProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <aside className="drawer" style={{ width }} aria-label={title} data-testid={testId}>
      <header className="drawer-head">
        <h3>{title}</h3>
        <div className="hdr-spacer" />
        <button className="drawer-close" onClick={onClose} aria-label={`Close ${title}`}>
          <Icon name="close" size={12} />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
