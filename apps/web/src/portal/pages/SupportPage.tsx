import type { JSX } from 'react';
import { Card } from '../lib';

export function SupportPage(): JSX.Element {
  return (
    <>
      <h1 className="pt-h1">Support</h1>
      <p className="pt-sub">We are here when you need us. Most questions are answered in the rules and FAQ.</p>
      <div className="pt-cards">
        <Card>
          <h3>Email</h3>
          <p className="muted">Reach the desk for account, payout or verification questions.</p>
          <div className="pt-actions"><a className="pt-link" href="mailto:support@happytrader.example">support@happytrader.example</a></div>
        </Card>
        <Card>
          <h3>Rules &amp; FAQ</h3>
          <p className="muted">Evaluation targets, drawdown, consistency and payout terms.</p>
          <div className="pt-actions"><button className="pt-link" onClick={() => { window.location.href = '/onboarding'; }}>Open onboarding</button></div>
        </Card>
      </div>
    </>
  );
}
