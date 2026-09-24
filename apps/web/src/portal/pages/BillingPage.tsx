import type { JSX } from 'react';
import { type AccountsView, Card, money } from '../lib';

export function BillingPage({ accounts }: { accounts: AccountsView | null }): JSX.Element {
  const list = accounts?.accounts ?? [];
  return (
    <>
      <h1 className="pt-h1">Billing</h1>
      <p className="pt-sub">Your account purchases and resets. Payments are processed on the secure checkout.</p>
      <Card>
        <h3>Buy an account</h3>
        <p className="muted">Choose from CORE, SELECT and DAILY programmes.</p>
        <div className="pt-actions"><button className="pt-btn primary" onClick={() => { window.location.href = '/onboarding'; }}>Browse programmes</button></div>
      </Card>
      <div className="pt-section-title">Your accounts</div>
      {list.length === 0 ? (
        <div className="pt-empty">No accounts yet.</div>
      ) : (
        <Card pad={false}>
          <table className="pt-table">
            <thead><tr><th>Account</th><th>Product</th><th>Purchased</th><th>Starting</th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>{a.nickname || a.name}</td>
                  <td>{a.product?.name ?? '—'}</td>
                  <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td>{money(a.startingBalanceMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
