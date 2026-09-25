/*
 * The one reveal language, repeated coherently across the page.
 *
 * A thin IntersectionObserver wrapper that flips `data-shown` when an element
 * scrolls into view; the actual transition lives in CSS (.ht-reveal). Under
 * prefers-reduced-motion the CSS shows everything immediately, and we also mark it
 * shown on mount so nothing ever depends on the observer firing.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

function prefersReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Reveal({
  children,
  delay = 0,
  as = 'div',
  className,
}: {
  children: ReactNode;
  delay?: 0 | 1 | 2 | 3 | 4;
  as?: 'div' | 'section' | 'li' | 'span';
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (prefersReduced()) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const Tag = as as 'div';
  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={`ht-reveal${className ? ` ${className}` : ''}`}
      data-shown={shown ? 'true' : 'false'}
      data-delay={delay || undefined}
    >
      {children}
    </Tag>
  );
}
