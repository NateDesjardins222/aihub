/**
 * The native checkout page — Whop's checkout embedded inside Atlas.
 *
 * A separate, lazily-loaded bundle reached at /checkout?product=<key>, so the
 * trading terminal never downloads the payment component. Atlas creates the
 * PENDING order and a Whop checkout SESSION server-side, then mounts Whop's
 * embedded iframe here: the card is entered inside Whop's frame and never
 * touches Atlas. The account is not granted here — a verified server-side Whop
 * webhook does that. This page only starts the payment and reports the outcome.
 *
 * SANDBOX ONLY in this milestone: the session comes back with
 * environment: "sandbox", which is what the embed renders against.
 */
import { Suspense, lazy, useEffect, useState, type JSX } from 'react';
import { api } from '../api/client';
import './Checkout.css';

const WhopCheckoutEmbed = lazy(() =>
  import('@whop/checkout/react').then((m) => ({ default: m.WhopCheckoutEmbed })),
);

interface CheckoutSession {
  orderId: string;
  configured: boolean;
  environment?: 'sandbox' | 'production';
  sessionId?: string;
  planId?: string;
  returnUrl?: string | null;
  product?: { key: string; name: string };
  message?: string;
}

type Phase =
  | { name: 'LOADING' }
  | { name: 'READY'; session: CheckoutSession }
  | { name: 'NOT_CONFIGURED'; message: string }
  | { name: 'DONE'; receiptId?: string }
  | { name: 'ERROR'; message: string };

function productKeyFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('product');
}

export function CheckoutApp(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'LOADING' });

  useEffect(() => {
    const productKey = productKeyFromUrl();
    if (!productKey) {
      setPhase({ name: 'ERROR', message: 'No product was specified.' });
      return;
    }
    let cancelled = false;
    api
      .post<CheckoutSession>('/api/v1/checkout', { productKey })
      .then((session) => {
        if (cancelled) return;
        if (!session.configured || !session.sessionId || !session.planId) {
          setPhase({
            name: 'NOT_CONFIGURED',
            message: session.message ?? 'Checkout is not available for this product yet.',
          });
          return;
        }
        setPhase({ name: 'READY', session });
      })
      .catch((err: Error) => {
        if (!cancelled) setPhase({ name: 'ERROR', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="checkout-page">
      <header className="checkout-head">
        <span className="checkout-mark" />
        <span className="checkout-brand">ATLAS</span>
        <span className="checkout-sub">checkout</span>
        <a className="checkout-exit" href="/">
          Back to terminal
        </a>
      </header>

      <main className="checkout-main">
        {phase.name === 'LOADING' ? <p className="checkout-muted">Starting checkout…</p> : null}

        {phase.name === 'NOT_CONFIGURED' ? (
          <div className="checkout-card">
            <h1>Checkout unavailable</h1>
            <p className="checkout-muted">{phase.message}</p>
          </div>
        ) : null}

        {phase.name === 'ERROR' ? (
          <div className="checkout-card">
            <h1>Something went wrong</h1>
            <p className="checkout-error">{phase.message}</p>
          </div>
        ) : null}

        {phase.name === 'DONE' ? (
          <div className="checkout-card">
            <h1>Payment received</h1>
            <p className="checkout-muted">
              Your evaluation is being set up. It will appear in your account selector shortly.
            </p>
            <a className="checkout-btn" href="/">
              Go to the terminal
            </a>
          </div>
        ) : null}

        {phase.name === 'READY' ? (
          <div className="checkout-embed-wrap">
            {phase.session.product ? <h1>{phase.session.product.name}</h1> : null}
            {phase.session.environment === 'sandbox' ? (
              <p className="checkout-badge">Sandbox — no real payment is taken</p>
            ) : null}
            <Suspense fallback={<p className="checkout-muted">Loading secure checkout…</p>}>
              <WhopCheckoutEmbed
                planId={phase.session.planId!}
                sessionId={phase.session.sessionId!}
                environment={phase.session.environment ?? 'sandbox'}
                theme="dark"
                {...(phase.session.returnUrl ? { returnUrl: phase.session.returnUrl } : {})}
                onComplete={(_planId, receiptId) => setPhase({ name: 'DONE', receiptId })}
              />
            </Suspense>
            <p className="checkout-fineprint">
              Payment is processed by Whop. Your card details are entered in Whop's secure frame and
              never touch Atlas. Your evaluation is granted only after Whop confirms the payment.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
