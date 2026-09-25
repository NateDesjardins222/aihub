/*
 * Design lab (NON-PRODUCTION) — /design-lab/homepage.
 *
 * A scrollable board of homepage direction experiments so we can choose and combine
 * a visual language before committing anything to the real homepage. Nothing here is
 * wired to production; the production homepage at "/" is untouched.
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import { HeroChrome, HeroType, HeroAtlas } from './heroes';
import { AccountExpA, AccountExpB } from './accounts';
import { AtlasGrow, BigNumbers, PayoutPath } from './scenes';

function Scene({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="lab-scene">
      <div className="lab-label">{label}</div>
      {children}
    </div>
  );
}

export function DesignLab(): JSX.Element {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Happy Trader — Design Lab';
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="ht lab">
      <div className="lab-banner">
        <span className="dot" />
        <b>Design Lab</b>
        <span>· non-production experiments — the production homepage is unchanged</span>
        <span style={{ flex: 1 }} />
        <a href="/">← back to site</a>
      </div>

      <Scene label="Hero A — Chrome object"><HeroChrome /></Scene>
      <Scene label="Hero B — Kinetic type"><HeroType /></Scene>
      <Scene label="Hero C — Product / Atlas"><HeroAtlas /></Scene>
      <Scene label="Account experiment A — Word switcher + field"><AccountExpA /></Scene>
      <Scene label="Account experiment B — Rail + morphing spec"><AccountExpB /></Scene>
      <Scene label="Atlas — scroll-grow into the viewport"><AtlasGrow /></Scene>
      <Scene label="Big numbers — $0 / 90%"><BigNumbers /></Scene>
      <Scene label="Payout — travelling chrome arrow"><PayoutPath /></Scene>
    </div>
  );
}
