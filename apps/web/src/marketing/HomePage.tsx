/*
 * Happy Trader Funding — the homepage.
 *
 * Composed from small reusable sections and one coherent motion language. Every
 * product figure comes from the authoritative catalog; nothing on the page is a
 * fabricated statistic, testimonial, or trust signal.
 */
import { useEffect, useState, type JSX } from 'react';
import { Nav, Footer, goExternal, scrollToId } from './components';
import { Reveal } from './motion';
import { CandleCanvas } from './CandleCanvas';
import { AccountSelector } from './AccountSelector';
import { SITE } from './site';

function Band(): JSX.Element {
  return (
    <div className="ht-band" aria-label="Happy Trader Funding">
      <CandleCanvas className="ht-band-canvas" ariaLabel="Decorative synthetic candlestick motion" />
      <div className="ht-band-wordmark">
        <div className="line1 ht-chrome-text">HAPPY TRADER</div>
        <div className="line2">Funding</div>
      </div>
      <div className="ht-band-fade" />
    </div>
  );
}

function Hero(): JSX.Element {
  const facts: readonly { k: string; l: string }[] = [
    { k: '90%', l: 'Profit split to you' },
    { k: '$0', l: 'Activation fee' },
    { k: '$25K–$300K', l: 'Account sizes' },
    { k: 'Atlas', l: 'Our own platform' },
  ];
  return (
    <section className="ht-hero">
      <div className="ht-wrap">
        <Reveal>
          <span className="ht-eyebrow">Futures proprietary trading</span>
        </Reveal>
        <Reveal delay={1}>
          <h1 style={{ marginTop: 20 }}>
            Trade futures on <span className="ht-chrome-text">our capital.</span>
          </h1>
        </Reveal>
        <Reveal delay={2}>
          <p>
            Prove your edge on a simulated evaluation, earn a funded performance account, and keep
            up to 90% of what you make — traded on Atlas, a futures platform we built ourselves.
          </p>
        </Reveal>
        <Reveal delay={3}>
          <div className="ht-hero-actions">
            <button className="ht-btn ht-btn--primary" onClick={() => goExternal(SITE.routes.getStarted)}>
              Get funded
            </button>
            <button className="ht-btn ht-btn--ghost" onClick={() => scrollToId('accounts')}>
              Compare accounts
            </button>
          </div>
        </Reveal>
        <Reveal delay={4}>
          <p className="ht-hero-note">One-time evaluation fee · No monthly subscription · Simulated capital</p>
        </Reveal>

        <Reveal delay={2}>
          <div className="ht-hero-strip">
            {facts.map((f) => (
              <div className="ht-hero-stat" key={f.l}>
                <div className="k">{f.k}</div>
                <div className="l">{f.l}</div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function HowItWorks(): JSX.Element {
  const steps: readonly { n: string; h: string; p: string }[] = [
    {
      n: '01',
      h: 'Pass the evaluation',
      p: 'Pick an account and hit its profit target while respecting the trailing drawdown and consistency rule. No time limit, no daily loss limit.',
    },
    {
      n: '02',
      h: 'Get your funded account',
      p: 'Clear the objective and your simulated-funded performance account is provisioned automatically — same platform, same instruments.',
    },
    {
      n: '03',
      h: 'Get paid',
      p: 'Put in your winning days and request a payout. You keep 90% of the profit on every program.',
    },
  ];
  return (
    <section id="how" className="ht-section">
      <div className="ht-wrap">
        <Reveal><span className="ht-eyebrow">How it works</span></Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>From evaluation to payout, without the noise.</h2>
        </Reveal>
        <div className="ht-steps">
          {steps.map((s, i) => (
            <Reveal delay={(i + 1) as 1 | 2 | 3} key={s.n}>
              <div className="ht-step">
                <div className="step-n">{s.n}</div>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Atlas(): JSX.Element {
  const points: readonly { t: string; d: string }[] = [
    { t: 'Chart-first', d: 'A fast, clean charting surface with the tools futures traders actually use — nothing you have to fight.' },
    { t: 'Futures-focused', d: 'Built specifically for index and commodity futures, with the contract and risk model baked in.' },
    { t: 'One workflow', d: 'Order entry, brackets, positions and P&L in a single, quiet interface. No tab-hopping.' },
    { t: 'Account-native', d: 'Atlas knows your program: rules, drawdown and payout progress are always in view — enforced server-side.' },
  ];
  return (
    <section id="atlas" className="ht-section">
      <div className="ht-wrap">
        <Reveal><span className="ht-eyebrow">The platform</span></Reveal>
        <div className="ht-atlas">
          <div>
            <Reveal delay={1}>
              <h2 className="ht-h2">Meet <span className="ht-chrome-text">Atlas</span>.</h2>
            </Reveal>
            <Reveal delay={2}>
              <p className="ht-lead" style={{ marginTop: 16 }}>
                Most prop firms rent someone else's terminal. We built our own — so the account, the
                rules and the chart are one system, tuned for speed and clarity.
              </p>
            </Reveal>
            <ul className="ht-atlas-points">
              {points.map((p, i) => (
                <Reveal as="li" delay={((i % 4) + 1) as 1 | 2 | 3 | 4} key={p.t}>
                  <span className="ic" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  <span className="tx"><b>{p.t}</b><span>{p.d}</span></span>
                </Reveal>
              ))}
            </ul>
          </div>
          <Reveal delay={2}>
            <div className="ht-atlas-frame">
              <div className="ht-atlas-chrome">
                <span className="ht-atlas-dot" /><span className="ht-atlas-dot" /><span className="ht-atlas-dot" />
                <span className="ht-atlas-tab">ATLAS · NQ · 1m</span>
              </div>
              <div className="ht-atlas-body">
                <CandleCanvas
                  grid
                  bodyRatio={0.56}
                  engineConfig={{ visible: 40, baseVol: 30, seed: 0x2211ff }}
                  ariaLabel="Illustrative Atlas chart with synthetic motion"
                />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Payouts(): JSX.Element {
  return (
    <section id="payouts" className="ht-section">
      <div className="ht-wrap">
        <Reveal><span className="ht-eyebrow">Payouts</span></Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>You did the work. You keep the profit.</h2>
        </Reveal>
        <div className="ht-payout">
          <Reveal delay={1}>
            <div className="ht-payout-card">
              <div className="big ht-chrome-text">90%</div>
              <div className="cap">Your profit split on every program — Core, Select and Daily alike. No tiered games, no reduced first payout.</div>
            </div>
          </Reveal>
          <Reveal delay={2}>
            <div className="ht-payout-card">
              <div className="big">Daily</div>
              <div className="cap">
                On the Daily program, clear your initial winning days and loss buffer to unlock daily
                payout eligibility. Each successive payout requires your balance to have grown to a
                higher threshold first — so payouts scale with the account instead of draining it.
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Rules(): JSX.Element {
  const rules: readonly { n: string; h: string; p: string }[] = [
    { n: '01', h: 'Trailing EOD drawdown', p: 'Your drawdown trails your end-of-day balance up to the profit target, then locks. It is always shown live in Atlas.' },
    { n: '02', h: 'No daily loss limit', p: 'None of the programs impose a daily loss limit. Manage your own risk within the account drawdown.' },
    { n: '03', h: 'Consistency', p: 'A consistency rule keeps a single outsized day from carrying the account — 50% on Core, 40% on Select and Daily.' },
    { n: '04', h: 'Winning days', p: 'Reach the required winning days before a payout. Core counts winning days of $150 or more.' },
    { n: '05', h: 'One-time fee', p: 'Every account is a single evaluation fee with a $0 activation fee. No monthly subscription.' },
    { n: '06', h: 'Server-enforced', p: 'Every rule is evaluated server-side by the same engine that runs the accounts — not by the honor system.' },
  ];
  return (
    <section id="rules" className="ht-section">
      <div className="ht-wrap">
        <Reveal><span className="ht-eyebrow">The rules, plainly</span></Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>Clear rules. No fine-print traps.</h2>
        </Reveal>
        <div className="ht-grid-3">
          {rules.map((r) => (
            <div className="ht-cell" key={r.n}>
              <div className="n">{r.n}</div>
              <h3>{r.h}</h3>
              <p>{r.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Why(): JSX.Element {
  const cells: readonly { h: string; p: string }[] = [
    { h: 'We built the platform', p: 'Atlas is ours. The chart, the rules and the account are one system — not a skin over rented software.' },
    { h: 'Honest by construction', p: 'No fabricated payouts, trader counts, or reviews. What you see is the product, stated accurately.' },
    { h: 'Rules that protect you', p: 'Select turns a broken consistency day into a delayed payout, not a failed account. The rules are on your side.' },
  ];
  return (
    <section className="ht-section">
      <div className="ht-wrap">
        <Reveal><span className="ht-eyebrow">Why Happy Trader</span></Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>A prop firm that behaves like a product company.</h2>
        </Reveal>
        <div className="ht-grid-3">
          {cells.map((c) => (
            <div className="ht-cell" key={c.h}>
              <h3>{c.h}</h3>
              <p>{c.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ_ITEMS: readonly { q: string; a: string }[] = [
  { q: 'What is Happy Trader Funding?', a: 'A futures proprietary trading firm. You pass a simulated evaluation to earn a simulated-funded performance account, and you keep up to 90% of the profit you generate on it.' },
  { q: 'Is this real money?', a: 'Trading on the platform is simulated. You trade a simulated-funded account under real rules; payouts are based on the performance of that account. Nothing here is a live brokerage account or financial advice.' },
  { q: 'How much do I keep?', a: 'You keep 90% of the profit on every program — Core, Select and Daily.' },
  { q: 'What is the consistency rule?', a: 'It prevents one enormous day from carrying an otherwise thin account. Core requires 50% consistency; Select and Daily require 40%. On Select, exceeding it delays a payout rather than failing the account.' },
  { q: 'How does the Daily program pay out?', a: 'Clear your initial winning days and loss buffer to unlock daily payout eligibility. Each successive payout requires your balance to have grown to a higher threshold first, so payouts scale with account growth.' },
  { q: 'Is there a monthly fee?', a: 'No. Each account is a one-time evaluation fee with a $0 activation fee — no subscription.' },
  { q: 'What do I trade on?', a: 'Atlas, our own chart-first futures platform. Your account rules, drawdown and payout progress are always in view and enforced server-side.' },
];

function Faq(): JSX.Element {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="ht-section">
      <div className="ht-wrap" style={{ maxWidth: 900 }}>
        <Reveal><span className="ht-eyebrow">Questions</span></Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>Frequently asked.</h2>
        </Reveal>
        <div className="ht-faq">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div className="ht-faq-item" data-open={isOpen ? 'true' : 'false'} key={item.q}>
                <button
                  className="ht-faq-q"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  <span>{item.q}</span>
                  <span className="sign" aria-hidden="true">+</span>
                </button>
                <div className="ht-faq-a" style={{ maxHeight: isOpen ? 300 : 0 }}>
                  <div className="ht-faq-a-inner">{item.a}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta(): JSX.Element {
  return (
    <section className="ht-final">
      <div className="ht-wrap">
        <Reveal>
          <h2>Your capital is waiting.</h2>
        </Reveal>
        <Reveal delay={1}>
          <p>Choose an account, pass the evaluation, and start trading futures on our capital.</p>
        </Reveal>
        <Reveal delay={2}>
          <div className="ht-final-actions">
            <button className="ht-btn ht-btn--primary" onClick={() => goExternal(SITE.routes.getStarted)}>
              Get funded
            </button>
            <button className="ht-btn ht-btn--ghost" onClick={() => scrollToId('accounts')}>
              See the accounts
            </button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function HomePage(): JSX.Element {
  useEffect(() => {
    const prev = document.title;
    document.title = SITE.seo.title;
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="ht">
      <Nav />
      <main>
        <Band />
        <Hero />
        <hr className="ht-hr" />
        <AccountSelector />
        <hr className="ht-hr" />
        <HowItWorks />
        <Atlas />
        <Payouts />
        <Rules />
        <Why />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
