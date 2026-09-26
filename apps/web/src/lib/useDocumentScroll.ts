import { useEffect } from 'react';

/**
 * Put the page into normal document-scrolling mode for the lifetime of the
 * calling surface (RC0 repair 1).
 *
 * The global stylesheet locks `body { overflow: hidden }` for the TRADING
 * TERMINAL, whose chart-centred layout must not scroll. Every other top-level
 * surface (customer portal, marketing site, checkout, onboarding, affiliate
 * pages, certificate verification) is a tall document that must scroll with the
 * mouse wheel. Adding `doc-scroll` to <html> releases the lock (see theme.css);
 * removing it on unmount restores the terminal's fixed layout.
 *
 * This mirrors exactly what the Owner Console already does with `owner-console`,
 * so there is one clear scrolling architecture: the terminal is viewport-locked,
 * everything else document-scrolls.
 */
export function useDocumentScroll(): void {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('doc-scroll');
    return () => html.classList.remove('doc-scroll');
  }, []);
}
