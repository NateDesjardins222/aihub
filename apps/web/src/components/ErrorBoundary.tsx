/**
 * Top-level error boundary (Phase 12.5, HTF-30).
 *
 * Before this, a render error anywhere in the tree unmounted the whole app and
 * left the customer staring at a blank white page. This catches it, shows a
 * calm branded surface with a way forward, and — critically — never prints a
 * stack trace or error message to the customer. The detail goes to the console
 * for an operator, not to the screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Operator-facing only. Deliberately not surfaced to the customer.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
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
          fontFamily:
            "'DM Sans Variable', system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ fontSize: '1.5rem', fontWeight: 600, letterSpacing: '0.02em' }}>
          Something went wrong
        </div>
        <p style={{ maxWidth: '30rem', color: '#9aa4b2', lineHeight: 1.5, margin: 0 }}>
          The page hit an unexpected error. Your account and data are safe — nothing you did
          caused this. Reloading usually clears it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: '0.5rem',
            padding: '0.65rem 1.4rem',
            borderRadius: '8px',
            border: '1px solid #2b3242',
            background: '#161b26',
            color: '#e6e9ef',
            fontSize: '0.95rem',
            cursor: 'pointer',
          }}
        >
          Reload the page
        </button>
        <a href="/" style={{ color: '#7aa2f7', fontSize: '0.9rem', textDecoration: 'none' }}>
          Return home
        </a>
      </div>
    );
  }
}
