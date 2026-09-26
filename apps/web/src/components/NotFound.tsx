/**
 * Branded 404 (Phase 12.5, HTF-30).
 *
 * A genuinely unknown top-level URL used to fall through to the terminal or the
 * sign-in screen, which is confusing. This is an honest, branded "page not
 * found" with a way back, and it leaks nothing about internal routes.
 */
import type { JSX } from 'react';

export function NotFound(): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
        background: '#0b0e14',
        color: '#e6e9ef',
        fontFamily: "'DM Sans Variable', system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div style={{ fontSize: '3rem', fontWeight: 700, letterSpacing: '0.04em', color: '#7aa2f7' }}>
        404
      </div>
      <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>Page not found</div>
      <p style={{ maxWidth: '28rem', color: '#9aa4b2', lineHeight: 1.5, margin: 0 }}>
        The page you’re looking for doesn’t exist or has moved.
      </p>
      <a
        href="/"
        style={{
          marginTop: '0.5rem',
          padding: '0.65rem 1.4rem',
          borderRadius: '8px',
          border: '1px solid #2b3242',
          background: '#161b26',
          color: '#e6e9ef',
          fontSize: '0.95rem',
          textDecoration: 'none',
        }}
      >
        Return home
      </a>
    </div>
  );
}
