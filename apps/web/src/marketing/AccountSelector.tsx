/*
 * The account-selection centerpiece.
 *
 * CORE / SELECT / DAILY as a segmented selector over a cursor-reactive particle
 * field. Hovering a family biases the field toward that tab, so the background
 * subtly gathers around the account the visitor is weighing. Pricing and rules are
 * always visible — never hidden behind the animation. All figures come from the
 * authoritative catalog module.
 */
import { useRef, useState, type JSX } from 'react';
import { FAMILIES, type Family, type FamilyKey, usd, price, sizeLabel } from './catalog';
import { ParticleField, type ParticleFieldHandle } from './ParticleField';
import { Reveal } from './motion';
import { goExternal } from './components';
import { SITE } from './site';

function AccountCard({ family, account }: { family: Family; account: Family['accounts'][number] }): JSX.Element {
  const gold = account.gold === true;
  return (
    <div className="ht-acct-card" data-gold={gold ? 'true' : 'false'}>
      <div className="ht-acct-top">
        <span className="ht-acct-size">{sizeLabel(account)}</span>
        {gold ? <span className="ht-acct-badge">Gold</span> : null}
      </div>
      <div className="ht-acct-price">
        {price(account.priceUsd)} <span className="per">one-time</span>
      </div>
      <div className="ht-acct-specs">
        <div className="ht-acct-spec"><span className="l">Profit target</span><span className="v">{usd(account.targetUsd)}</span></div>
        <div className="ht-acct-spec"><span className="l">EOD drawdown</span><span className="v">{usd(account.eodDrawdownUsd)}</span></div>
        <div className="ht-acct-spec"><span className="l">Contracts</span><span className="v">{account.minis} minis · {account.micros} micros</span></div>
        {account.bufferUsd != null ? (
          <div className="ht-acct-spec"><span className="l">Payout buffer</span><span className="v">{usd(account.bufferUsd)}</span></div>
        ) : null}
        <div className="ht-acct-spec"><span className="l">Profit split</span><span className="v">{family.splitPct}%</span></div>
      </div>
      <div className="ht-acct-cta">
        <button
          className={`ht-btn ${gold ? 'ht-btn--gold' : 'ht-btn--ghost'}`}
          onClick={() => goExternal(SITE.routes.getStarted)}
        >
          Start {family.name} {sizeLabel(account)}
        </button>
      </div>
    </div>
  );
}

export function AccountSelector(): JSX.Element {
  const [active, setActive] = useState<FamilyKey>('CORE');
  const focusRef = useRef<ParticleFieldHandle | null>(null);
  const fam = FAMILIES.find((f) => f.key === active)!;
  const activeIsGold = fam.accounts.some((a) => a.gold);

  const biasTo = (index: number): void => {
    // Tabs sit near the top-centre; map the tab index to a normalized focus point.
    const x = 0.5 + (index - 1) * 0.16;
    focusRef.current?.setFocus(x, 0.22);
  };
  const clearBias = (): void => focusRef.current?.setFocus(null, null);

  return (
    <section id="accounts" className="ht-section ht-accounts">
      <ParticleField className="ht-accounts-canvas" focusRef={focusRef} />
      <div className="ht-wrap ht-accounts-inner">
        <Reveal>
          <span className="ht-eyebrow">Choose your account</span>
        </Reveal>
        <Reveal delay={1}>
          <h2 className="ht-h2" style={{ marginTop: 18 }}>
            Three programs. One <span className="ht-chrome-text">90% split</span>.
          </h2>
        </Reveal>
        <Reveal delay={2}>
          <p className="ht-lead" style={{ marginTop: 16 }}>
            Every account is a one-time evaluation with a $0 activation fee. Pick the ruleset that
            matches how you trade — then scale from $25K to $300K.
          </p>
        </Reveal>

        <Reveal delay={2}>
          <div className="ht-family-tabs" role="tablist" aria-label="Account family" style={{ marginTop: 28 }}>
            {FAMILIES.map((f, i) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={active === f.key}
                className="ht-family-tab"
                data-active={active === f.key ? 'true' : 'false'}
                data-gold={f.accounts.some((a) => a.gold) ? 'true' : 'false'}
                onMouseEnter={() => biasTo(i)}
                onFocus={() => biasTo(i)}
                onMouseLeave={clearBias}
                onBlur={clearBias}
                onClick={() => setActive(f.key)}
              >
                {f.name}
              </button>
            ))}
          </div>
        </Reveal>

        <div className="ht-family-panel" data-gold={activeIsGold ? 'true' : 'false'}>
          <Reveal className="ht-family-about" key={`about-${fam.key}`}>
            <div className="ht-family-about">
              <h3>{fam.name}</h3>
              <div className="tag">{fam.tagline}</div>
              <p className="sum">{fam.summary}</p>
              <ul className="ht-rulelist">
                {fam.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={1} key={`grid-${fam.key}`}>
            <div className="ht-acct-grid">
              {fam.accounts.map((a) => (
                <AccountCard key={`${fam.key}-${a.size}`} family={fam} account={a} />
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
