# Portal V2 — Profile & Identity

The account center (`V2ProfilePage`, reached from the account menu → "Profile & security")
and the identity model behind it. The governing rule: the **public display identity is
separate from the legal identity**, and legal PII never appears in the portal or on a
certificate.

## Sections
A sub-rail switches between four panes, each backed by a real record/contract:

| Pane | Shows | Production source |
|---|---|---|
| **Profile** | public display name, sign-in email, legal-identity status (on file / not) | `GET/PATCH /api/v1/portal/profile` (`preferredDisplayName`, `displayName`) |
| **Security** | 2FA status, active sessions, last sign-in | MFA state + session read model; manage → onboarding/security |
| **Notifications** | delivery channels (email/SMS) + the categories the customer receives | notification preferences read model |
| **Verification** | KYC status (`VERIFIED` / `IN_REVIEW` / `ACTION_REQUIRED` / `NOT_STARTED`) | identity-verification provider; manage → onboarding |

## Identity model (hard constraint)
- **Public display name** (`preferredDisplayName`): what the customer chooses to show on
  certificates and public verification. Editable (production `PATCH`). Defaults to a derived
  `First L.` form of the legal name when unset.
- **Legal identity**: held for KYC/compliance. The portal surfaces only *whether* it is on
  file — **never the legal name itself**. It is never rendered on a certificate.
- **KYC** is a **distinct** contract from the display name. Verifying identity does not change
  the public display name, and vice-versa. Designing identity authoritatively means these are
  separate fields with separate flows — not a `firstName`/`lastName` bolted onto a frontend
  object.

## Honest seams (what is NOT faked)
`V2ProfilePage` is presentational and takes `view: ProfileView` + manage callbacks. The dev
review supplies `FIXTURE_PROFILE` and routes "Manage" actions to `/onboarding`. It does **not**:
- mutate identity in the review (no fake save),
- fake an MFA enable/disable toggle,
- fake a KYC decision,
- display any real or invented legal name.

Production wiring: Profile edit → `PATCH /api/v1/portal/profile` (display name only);
Security → the existing MFA panel + session management; Verification → the onboarding KYC flow.

## Zero-customer
`FIXTURE_PROFILE_EMPTY`: no display name (shows default/—), legal identity "Not provided",
2FA not enabled, verification "Not started" — a truthful brand-new-customer posture.
