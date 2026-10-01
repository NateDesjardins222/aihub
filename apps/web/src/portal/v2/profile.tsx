/**
 * Portal V2 — Profile & Account center (added at human-review #2).
 *
 * The customer's account-center: a sectioned surface for Profile, Security,
 * Notifications and Verification. It is PRESENTATIONAL — it renders an
 * already-projected `ProfileView` and never fetches or mutates. In production the
 * container hydrates `view` from authoritative endpoints and wires the manage
 * actions to the real flows (see PORTAL_V2_PROFILE_IDENTITY.md):
 *
 *   - Profile ........ GET/PATCH /api/v1/portal/profile (preferredDisplayName only)
 *   - Security ....... MFA panel + /onboarding security (password, sessions)
 *   - Verification ... /onboarding identity + agreements (KYC — a SEPARATE contract)
 *
 * Identity truth (hard constraint): the PUBLIC DISPLAY NAME shown on certificates is
 * deliberately separate from the customer's LEGAL identity. The legal name is held
 * for KYC/compliance and NEVER rendered in the portal or on a certificate. This page
 * surfaces only the display identity and the *status* of verification — never legal
 * PII — and it fabricates no identity, KYC decision, or security state.
 */
import { useState, type JSX } from 'react';
import { V2Section, V2Status, type StatusKind } from './primitives';
import './profile.css';

export type VerificationStatus = 'VERIFIED' | 'IN_REVIEW' | 'ACTION_REQUIRED' | 'NOT_STARTED';

export interface ProfileView {
  /** Sign-in email (read-only here; changing it is a security-sensitive flow). */
  email: string;
  /** Public display name shown on certificates/verification; null → system default. */
  publicDisplayName: string | null;
  /** The default display name derived from the legal name (first + last initial). */
  defaultDisplayName: string | null;
  /** Whether a legal identity is on file. The legal NAME itself is never exposed here. */
  legalNameOnFile: boolean;
  memberSinceMs: number;
  verification: VerificationStatus;
  security: { mfaEnabled: boolean; activeSessions: number; lastSignInMs: number | null };
  /** Delivery channels the customer currently receives alerts through. */
  notifications: { email: boolean; sms: boolean };
}

const VERIFY_META: Record<VerificationStatus, { kind: StatusKind; label: string; hint: string }> = {
  VERIFIED: { kind: 'funded', label: 'Verified', hint: 'Your identity is verified. Payouts and funding can proceed.' },
  IN_REVIEW: { kind: 'hold', label: 'In review', hint: 'Your verification is being reviewed. No action is needed right now.' },
  ACTION_REQUIRED: { kind: 'evaluation', label: 'Action required', hint: 'We need a little more to finish verifying your identity.' },
  NOT_STARTED: { kind: 'neutral', label: 'Not started', hint: 'Verification is required before a first payout.' },
};

/** The categories a funded trader receives — a truthful description of what the system
 *  sends, not an editable preference matrix (delivery preferences are desk-managed). */
const NOTIFICATION_CATEGORIES = [
  'Evaluation results and funding',
  'Payout eligibility and approvals',
  'Low drawdown-limit headroom',
  'Personal risk-control activations',
  'Account status and security',
];

type Pane = 'profile' | 'security' | 'notifications' | 'verification';
const PANES: Array<{ key: Pane; label: string }> = [
  { key: 'profile', label: 'Profile' },
  { key: 'security', label: 'Security' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'verification', label: 'Verification' },
];

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

export function V2ProfilePage({ view, onBack, onManageSecurity, onManageVerification }: {
  view: ProfileView;
  onBack: () => void;
  onManageSecurity: () => void;
  onManageVerification: () => void;
}): JSX.Element {
  const [pane, setPane] = useState<Pane>('profile');
  const verify = VERIFY_META[view.verification];
  const shownName = view.publicDisplayName ?? view.defaultDisplayName ?? '—';

  return (
    <div className="htv2-page">
      <header className="htv2-page-head">
        <button className="htv2-link ht-t-nav" onClick={onBack} data-testid="htv2-profile-back">← Dashboard</button>
        <h1 className="ht-t-page-title">Profile &amp; account</h1>
        <p className="ht-t-meta">{view.email} · member since {fmtDate(view.memberSinceMs)}</p>
      </header>

      <nav className="htv2-subrail" role="tablist" aria-label="Account sections">
        {PANES.map((p) => (
          <button
            key={p.key}
            role="tab"
            aria-selected={pane === p.key}
            className={`htv2-subrail-tab ht-t-nav${pane === p.key ? ' on' : ''}`}
            onClick={() => setPane(p.key)}
            data-testid={`htv2-profile-tab-${p.key}`}
          >
            {p.label}
          </button>
        ))}
      </nav>

      {pane === 'profile' && (
        <V2Section title="Public identity">
          <dl className="htv2-deflist" data-testid="htv2-profile-identity">
            <div className="htv2-def">
              <dt className="ht-t-label">Public display name</dt>
              <dd className="ht-t-fin-sm">{shownName}</dd>
              <p className="htv2-def-note ht-t-meta">Shown on certificates and public verification. Never your email, phone, or full legal name.</p>
            </div>
            <div className="htv2-def">
              <dt className="ht-t-label">Sign-in email</dt>
              <dd className="ht-t-fin-sm ht-num">{view.email}</dd>
            </div>
            <div className="htv2-def">
              <dt className="ht-t-label">Legal identity</dt>
              <dd className="ht-t-fin-sm">
                <V2Status kind={view.legalNameOnFile ? 'funded' : 'neutral'}>
                  {view.legalNameOnFile ? 'On file' : 'Not provided'}
                </V2Status>
              </dd>
              <p className="htv2-def-note ht-t-meta">Held securely for compliance. Your legal name is never displayed in the portal or on a certificate.</p>
            </div>
          </dl>
          <div className="htv2-page-actions">
            <button className="htv2-link ht-t-nav" onClick={onManageVerification} data-testid="htv2-profile-edit-identity">Manage display name &amp; identity →</button>
          </div>
        </V2Section>
      )}

      {pane === 'security' && (
        <V2Section title="Security">
          <dl className="htv2-deflist" data-testid="htv2-profile-security">
            <div className="htv2-def">
              <dt className="ht-t-label">Two-factor authentication</dt>
              <dd className="ht-t-fin-sm">
                <V2Status kind={view.security.mfaEnabled ? 'funded' : 'evaluation'}>
                  {view.security.mfaEnabled ? 'Enabled' : 'Not enabled'}
                </V2Status>
              </dd>
              <p className="htv2-def-note ht-t-meta">Protects sign-in and payout approvals. Enforced server-side.</p>
            </div>
            <div className="htv2-def">
              <dt className="ht-t-label">Active sessions</dt>
              <dd className="ht-t-fin-sm ht-num">{view.security.activeSessions}</dd>
            </div>
            <div className="htv2-def">
              <dt className="ht-t-label">Last sign-in</dt>
              <dd className="ht-t-fin-sm ht-num">{view.security.lastSignInMs == null ? '—' : fmtDate(view.security.lastSignInMs)}</dd>
            </div>
          </dl>
          <div className="htv2-page-actions">
            <button className="htv2-link ht-t-nav" onClick={onManageSecurity} data-testid="htv2-profile-manage-security">Manage security &amp; sessions →</button>
          </div>
        </V2Section>
      )}

      {pane === 'notifications' && (
        <V2Section title="Notifications">
          <div className="htv2-note-channels" data-testid="htv2-profile-notifications">
            <span className="ht-t-label">Delivered by</span>
            <span className="htv2-note-chips">
              <V2Status kind={view.notifications.email ? 'funded' : 'neutral'}>Email{view.notifications.email ? '' : ' off'}</V2Status>
              <V2Status kind={view.notifications.sms ? 'funded' : 'neutral'}>SMS{view.notifications.sms ? '' : ' off'}</V2Status>
            </span>
          </div>
          <ul className="htv2-note-list">
            {NOTIFICATION_CATEGORIES.map((c) => (
              <li className="htv2-note-item ht-t-body-sm" key={c}>{c}</li>
            ))}
          </ul>
          <p className="ht-t-meta">You receive the alerts above whenever they apply to your accounts. To change delivery channels, contact the desk from Support.</p>
        </V2Section>
      )}

      {pane === 'verification' && (
        <V2Section title="Verification">
          <div className="htv2-verify-head" data-testid="htv2-profile-verification">
            <V2Status kind={verify.kind}>{verify.label}</V2Status>
          </div>
          <p className="ht-t-body-sm htv2-verify-hint">{verify.hint}</p>
          <p className="ht-t-meta">Identity verification (KYC) is a separate compliance step from your public display name. It is required before a first payout and is managed in onboarding.</p>
          <div className="htv2-page-actions">
            <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={onManageVerification} data-testid="htv2-profile-open-verification">
              {view.verification === 'VERIFIED' ? 'Review verification' : 'Open verification'}
            </button>
          </div>
        </V2Section>
      )}
    </div>
  );
}
