/**
 * The customer onboarding flow — VISITOR → verified contact → verified identity →
 * agreements → product → checkout → server-driven provisioning → account ready.
 *
 * A separate, lazily-loaded bundle reached at /onboarding, behind sign-in. It
 * drives the /api/v1/onboarding endpoints and never assumes readiness from a
 * checkout "success": the Processing screen is driven ENTIRELY by the server's
 * order status (GET /commerce/orders/:id/status). The mock checkout surface makes
 * clear it is not a real payment; provisioning happens only from a verified
 * server-side event.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../api/client';
import './Onboarding.css';

type Channel = 'EMAIL' | 'SMS';

interface OnboardingState {
  identity: { id: string; identityStatus: string; legalName: string | null; country: string | null };
  contacts: { email: boolean; sms: boolean };
  outstandingAgreements: Array<{ agreementType: string; versionId: string; version: number }>;
  gate: { satisfied: boolean; identityOk: boolean; contactOk: boolean; agreementsOk: boolean; blockedReasons: string[] };
}
interface Product {
  key: string;
  name: string;
  startingBalanceMicros: number | null;
  priceMicros: number;
  whopPlanId: string | null;
}
interface AgreementVersion {
  id: string;
  agreementType: string;
  version: number;
  title: string;
  body: string;
}
type OrderStatus = 'PENDING' | 'COMPLETED' | 'PROVISIONED' | 'PROVISION_BLOCKED' | 'PROVISION_FAILED' | 'REFUNDED';

const money = (micros: number | null): string =>
  micros == null ? '—' : `$${(micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function OnboardingApp(): JSX.Element {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api.get<OnboardingState>('/api/v1/onboarding/state'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (err) return <Shell><p className="ob-error">{err}</p></Shell>;
  if (!state) return <Shell><p className="ob-dim">Loading…</p></Shell>;

  // Route to the first unmet step; once the gate is satisfied, go to selection.
  const step: Step = !state.contacts.email || !state.contacts.sms
    ? 'CONTACT'
    : state.identity.identityStatus !== 'IDENTITY_VERIFIED'
      ? 'IDENTITY'
      : state.outstandingAgreements.length > 0
        ? 'AGREEMENTS'
        : 'SELECT';

  return (
    <Shell>
      <Stepper step={step} gate={state.gate} />
      {step === 'CONTACT' ? <ContactStep state={state} onDone={reload} /> : null}
      {step === 'IDENTITY' ? <IdentityStep state={state} onDone={reload} /> : null}
      {step === 'AGREEMENTS' ? <AgreementsStep onDone={reload} /> : null}
      {step === 'SELECT' ? <SelectAndCheckout onReload={reload} /> : null}
    </Shell>
  );
}

type Step = 'CONTACT' | 'IDENTITY' | 'AGREEMENTS' | 'SELECT';

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="ob" data-testid="onboarding-app">
      <header className="ob-top">
        <span className="ob-mark" />
        <span className="ob-brand">HAPPY TRADER</span>
        <span className="ob-sub">funding</span>
        <div className="ob-spacer" />
        <a className="ob-exit" href="/">Terminal</a>
      </header>
      <main className="ob-main">{children}</main>
    </div>
  );
}

function Stepper({ step, gate }: { step: Step; gate: OnboardingState['gate'] }): JSX.Element {
  const steps: Array<{ id: Step; label: string; done: boolean }> = [
    { id: 'CONTACT', label: 'Contact', done: gate.contactOk },
    { id: 'IDENTITY', label: 'Identity', done: gate.identityOk },
    { id: 'AGREEMENTS', label: 'Agreements', done: gate.agreementsOk },
    { id: 'SELECT', label: 'Account', done: false },
  ];
  return (
    <ol className="ob-steps" data-testid="onboarding-stepper">
      {steps.map((s) => (
        <li key={s.id} className={`ob-step ${s.id === step ? 'ob-step-on' : ''} ${s.done ? 'ob-step-done' : ''}`}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function ContactStep({ state, onDone }: { state: OnboardingState; onDone: () => void }): JSX.Element {
  return (
    <section className="ob-card" data-testid="step-contact">
      <h1>Verify how we reach you</h1>
      <p className="ob-dim">A verified email and phone are required before identity verification. Verified contact is not verified identity.</p>
      <ContactField channel="EMAIL" label="Email" done={state.contacts.email} onDone={onDone} />
      <ContactField channel="SMS" label="Phone" done={state.contacts.sms} onDone={onDone} />
    </section>
  );
}

function ContactField({ channel, label, done, onDone }: { channel: Channel; label: string; done: boolean; onDone: () => void }): JSX.Element {
  const [value, setValue] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ challengeId: string; devCode: string | null }>('/api/v1/onboarding/contact/start', { channel, value });
      setChallengeId(r.challengeId);
      if (r.devCode) setCode(r.devCode); // dev convenience only
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (): Promise<void> => {
    if (!challengeId) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/v1/onboarding/contact/confirm', { challengeId, code });
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="ob-row ob-row-done" data-testid={`contact-${channel.toLowerCase()}-done`}>{label} verified ✓</div>;
  return (
    <div className="ob-row" data-testid={`contact-${channel.toLowerCase()}`}>
      <label className="ob-field">
        <span>{label}</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={channel === 'EMAIL' ? 'you@example.com' : '+15551234567'} data-testid={`contact-${channel.toLowerCase()}-value`} />
      </label>
      {challengeId ? (
        <div className="ob-inline">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" data-testid={`contact-${channel.toLowerCase()}-code`} />
          <button className="ob-btn ob-btn-primary" disabled={busy || code.length < 4} onClick={() => void confirm()} data-testid={`contact-${channel.toLowerCase()}-confirm`}>Confirm</button>
        </div>
      ) : (
        <button className="ob-btn" disabled={busy || value.length < 3} onClick={() => void start()} data-testid={`contact-${channel.toLowerCase()}-send`}>Send code</button>
      )}
      {msg ? <p className="ob-error">{msg}</p> : null}
    </div>
  );
}

function IdentityStep({ state, onDone }: { state: OnboardingState; onDone: () => void }): JSX.Element {
  const [legalName, setLegalName] = useState(state.identity.legalName ?? '');
  const [dob, setDob] = useState('');
  const [country, setCountry] = useState(state.identity.country ?? 'US');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const status = state.identity.identityStatus;
  const pending = status === 'IDENTITY_PENDING' || status === 'STEP_UP_REQUIRED';
  const review = status === 'UNDER_REVIEW';
  const rejected = status === 'REJECTED';

  const start = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/v1/onboarding/identity/start', { legalName, dob: dob || undefined, country });
      await api.post('/api/v1/onboarding/identity/resolve', {});
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ob-card" data-testid="step-identity">
      <h1>Verify your identity</h1>
      <p className="ob-dim">We verify who you are through our identity provider. We never store your ID images. (Mock provider in this environment — not a real KYC check.)</p>
      {review ? <p className="ob-notice" data-testid="identity-review">Your verification is under review. This is not an accusation — a person will look shortly.</p> : null}
      {rejected ? <p className="ob-error" data-testid="identity-rejected">This attempt could not be verified. You may try again.</p> : null}
      <label className="ob-field"><span>Legal name</span><input value={legalName} onChange={(e) => setLegalName(e.target.value)} data-testid="identity-name" /></label>
      <label className="ob-field"><span>Date of birth</span><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} data-testid="identity-dob" /></label>
      <label className="ob-field"><span>Country</span><input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} data-testid="identity-country" /></label>
      <button className="ob-btn ob-btn-primary" disabled={busy || legalName.trim().length < 1} onClick={() => void start()} data-testid="identity-submit">
        {pending || review ? 'Re-run verification' : 'Verify identity'}
      </button>
      {msg ? <p className="ob-error">{msg}</p> : null}
    </section>
  );
}

function AgreementsStep({ onDone }: { onDone: () => void }): JSX.Element {
  const [current, setCurrent] = useState<AgreementVersion[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<{ current: AgreementVersion[]; outstanding: Array<{ versionId: string }> }>('/api/v1/onboarding/agreements')
      .then((r) => setCurrent(r.current))
      .catch((e) => setMsg((e as Error).message));
  }, []);

  const allChecked = current.length > 0 && current.every((a) => accepted[a.id]);
  const accept = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/v1/onboarding/agreements/accept', { versionIds: current.map((a) => a.id) });
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ob-card" data-testid="step-agreements">
      <h1>Review and accept</h1>
      {current.map((a) => (
        <label className="ob-agreement" key={a.id} data-testid={`agreement-${a.agreementType}`}>
          <input type="checkbox" checked={!!accepted[a.id]} onChange={(e) => setAccepted((s) => ({ ...s, [a.id]: e.target.checked }))} />
          <div>
            <strong>{a.title} <span className="ob-dim">v{a.version}</span></strong>
            <p className="ob-agreement-body">{a.body}</p>
          </div>
        </label>
      ))}
      <button className="ob-btn ob-btn-primary" disabled={busy || !allChecked} onClick={() => void accept()} data-testid="agreements-accept">Accept and continue</button>
      {msg ? <p className="ob-error">{msg}</p> : null}
    </section>
  );
}

function SelectAndCheckout({ onReload }: { onReload: () => void }): JSX.Element {
  const [products, setProducts] = useState<Product[]>([]);
  const [chosen, setChosen] = useState<Product | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'SELECT' | 'CHECKOUT' | 'PROCESSING'>('SELECT');
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ products: Product[] }>('/api/v1/onboarding/products').then((r) => setProducts(r.products)).catch((e) => setMsg((e as Error).message));
  }, []);

  const beginCheckout = async (p: Product): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post<{ orderId: string }>('/api/v1/checkout', { productKey: p.key });
      setChosen(p);
      setOrderId(res.orderId);
      setPhase('CHECKOUT');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Poll the SERVER's order status — the only source the Ready screen trusts.
  useEffect(() => {
    if (phase !== 'PROCESSING' || !orderId) return;
    let stop = false;
    const poll = async (): Promise<void> => {
      try {
        const r = await api.get<{ status: OrderStatus; accountId: string | null; provisionNote: string | null }>(`/api/v1/commerce/orders/${orderId}/status`);
        if (stop) return;
        setStatus(r.status);
        setAccountId(r.accountId);
        setNote(r.provisionNote);
      } catch {
        /* keep polling */
      }
    };
    void poll();
    const h = setInterval(() => void poll(), 1000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [phase, orderId]);

  const completeMockPayment = async (): Promise<void> => {
    if (!orderId) return;
    setBusy(true);
    setPhase('PROCESSING');
    try {
      // The SERVER simulates the provider webhook (a signed server-side event).
      // The browser never provisions; it triggers a verified server event and
      // then watches the server's own status.
      await api.post('/api/v1/onboarding/dev/simulate-payment', { orderId });
      onReload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'PROCESSING') {
    const ready = status === 'PROVISIONED';
    const blocked = status === 'PROVISION_BLOCKED' || status === 'PROVISION_FAILED';
    return (
      <section className="ob-card" data-testid="step-processing">
        <h1>{ready ? 'Your account is ready' : 'Setting up your account'}</h1>
        <ProcessingLadder status={status} />
        {blocked ? (
          <p className="ob-notice" data-testid="processing-blocked">
            Your payment was received. We could not finish setting up your account automatically
            ({note ?? 'pending review'}). Our team has been notified — do not pay again. This resolves on its own once your details clear.
          </p>
        ) : null}
        {ready ? (
          <div data-testid="step-ready">
            <p className="ob-dim">Account {accountId?.slice(0, 8)}… is active.</p>
            <a className="ob-btn ob-btn-primary" href="/" data-testid="go-terminal">Go to the terminal</a>
          </div>
        ) : null}
        {msg ? <p className="ob-error">{msg}</p> : null}
      </section>
    );
  }

  if (phase === 'CHECKOUT' && chosen) {
    return (
      <section className="ob-card" data-testid="step-checkout">
        <h1>Checkout — {chosen.name}</h1>
        <div className="ob-checkout-surface" data-testid="checkout-surface">
          <p className="ob-dim">
            This is a Happy Trader-branded checkout surface. In production, the provider's embedded
            checkout renders here and the card is entered inside the provider's frame — never in this page.
            <strong> Mock mode: no real payment. </strong>
          </p>
          <div className="ob-price">{money(chosen.priceMicros)}</div>
        </div>
        <p className="ob-dim">The account is not created by this screen. It is created only after a verified server-side payment event.</p>
        <button className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void completeMockPayment()} data-testid="checkout-complete">
          Complete mock payment
        </button>
        {msg ? <p className="ob-error">{msg}</p> : null}
      </section>
    );
  }

  return (
    <section className="ob-card" data-testid="step-select">
      <h1>Choose your account</h1>
      <div className="ob-products">
        {products.map((p) => (
          <button key={p.key} className="ob-product" data-testid={`product-${p.key}`} disabled={busy} onClick={() => void beginCheckout(p)}>
            <span className="ob-product-name">{p.name}</span>
            <span className="ob-product-size">{money(p.startingBalanceMicros)}</span>
            <span className="ob-product-price">{money(p.priceMicros)}</span>
          </button>
        ))}
      </div>
      {products.length === 0 ? <p className="ob-dim">No products available.</p> : null}
      {msg ? <p className="ob-error">{msg}</p> : null}
    </section>
  );
}

function ProcessingLadder({ status }: { status: OrderStatus | null }): JSX.Element {
  const steps = [
    { label: 'Payment received', on: status !== null && status !== 'PENDING' },
    { label: 'Verifying', on: status === 'COMPLETED' || status === 'PROVISIONED' },
    { label: 'Creating account', on: status === 'PROVISIONED' },
    { label: 'Account ready', on: status === 'PROVISIONED' },
  ];
  return (
    <ol className="ob-ladder" data-testid="processing-ladder">
      {steps.map((s) => (
        <li key={s.label} className={s.on ? 'ob-ladder-on' : ''}>{s.label}</li>
      ))}
    </ol>
  );
}
