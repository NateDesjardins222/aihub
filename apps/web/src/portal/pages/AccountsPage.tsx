import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { AccountCard } from './AccountCard';
import { type AccountsView, EmptyState, money, msg, Skeleton, Toggle } from '../lib';

export function AccountsPage({
  onOpen, onToast, onChanged,
}: {
  onOpen: (id: string) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
}): JSX.Element {
  const [view, setView] = useState<AccountsView | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setView(null);
    void api.get<AccountsView>(`/api/v1/portal/accounts?includeArchived=${includeArchived}`).then(setView).catch((e: unknown) => setErr(msg(e)));
  }, [includeArchived]);
  useEffect(load, [load]);

  const saveNick = async (id: string, nickname: string): Promise<void> => {
    try { await api.patch(`/api/v1/portal/accounts/${id}/nickname`, { nickname }); onToast('Nickname saved'); }
    catch (e) { onToast(msg(e)); }
  };
  const archive = async (id: string, archived: boolean): Promise<void> => {
    setBusy(id);
    try { await api.post(`/api/v1/portal/accounts/${id}/${archived ? 'unarchive' : 'archive'}`); load(); onChanged(); }
    catch (e) { onToast(msg(e)); } finally { setBusy(null); }
  };
  const reset = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      const q = await api.get<{ priceMicros: number }>(`/api/v1/portal/accounts/${id}/reset-quote`);
      const r = await api.post<{ orderId: string }>(`/api/v1/portal/accounts/${id}/reset`, {});
      onToast(`Reset order created (${money(q.priceMicros)}). Redirecting…`);
      window.setTimeout(() => { window.location.href = `/checkout?order=${r.orderId}`; }, 900);
    } catch (e) { onToast(msg(e)); } finally { setBusy(null); }
  };

  if (err) return <p className="pt-error">{err}</p>;
  return (
    <>
      <h1 className="pt-h1">Accounts</h1>
      <p className="pt-sub">{view ? `${view.activeSlotsUsed} of ${view.maxActiveSlots} active slots used.` : 'Loading…'}</p>
      <div style={{ marginBottom: 18 }}>
        <Toggle on={includeArchived} onClick={() => setIncludeArchived((v) => !v)} label="Show archived & closed" />
      </div>
      {!view ? (
        <div className="pt-cards">{Array.from({ length: 2 }, (_, i) => <div className="pt-card" key={i}><Skeleton h={140} /></div>)}</div>
      ) : view.accounts.length === 0 ? (
        <EmptyState title="No accounts yet" hint="Buy an evaluation to get started." action={<button className="pt-btn primary" onClick={() => { window.location.href = '/onboarding'; }}>Get an account</button>} />
      ) : (
        <div className="pt-cards">
          {view.accounts.map((a) => (
            <AccountCard
              key={a.id}
              a={a}
              onOpen={onOpen}
              onNick={(nick) => void saveNick(a.id, nick)}
              onArchive={() => void archive(a.id, Boolean(a.archivedAt))}
              onReset={() => void reset(a.id)}
              busy={busy === a.id}
            />
          ))}
        </div>
      )}
    </>
  );
}
