/**
 * Happy Trader theme — a genuine dark AND light theme, persisted per viewer.
 *
 * The theme is expressed as CSS custom properties (see Portal.css) selected by
 * a `data-pt-theme` attribute on the portal root. The preference is stored in
 * localStorage, guarded so a private window or blocked storage never breaks the
 * page (it simply falls back to dark). The light theme is intentionally
 * designed, not dark-mode inverted by CSS.
 */
import { useEffect, useState } from 'react';

export type PortalTheme = 'dark' | 'light';
const KEY = 'ht.theme';

export function readTheme(): PortalTheme {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage blocked — fall through to the default */
  }
  return 'dark';
}

function persist(theme: PortalTheme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* best-effort only */
  }
}

/** A React hook that owns the theme and reflects it onto the document. */
export function usePortalTheme(): { theme: PortalTheme; toggle: () => void; set: (t: PortalTheme) => void } {
  const [theme, setTheme] = useState<PortalTheme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-pt-theme', theme);
    persist(theme);
    return () => {
      // Leave the attribute in place while the portal is mounted; on unmount the
      // terminal/admin surfaces manage their own theming.
    };
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    set: setTheme,
  };
}
