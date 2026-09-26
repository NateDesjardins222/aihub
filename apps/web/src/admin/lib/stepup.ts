/**
 * Operator step-up (reauthentication) helper, shared across Owner OS pages.
 *
 * Elevated mutations (kill switches, financial corrections, staff changes)
 * require a fresh step-up token: the operator re-enters their password, the
 * server mints a short-lived token for a reauth CLASS, and the mutation carries
 * it in the `x-stepup-token` header. This is the SAME reauth the server enforces
 * (`requireReauth`) — the UI only collects the password and relays the token; it
 * never makes an authorization decision of its own.
 */
import { api, request } from '../../api/client';

/** Exchange the operator's password for a short-lived step-up token of a class. */
export async function mintStepUp(password: string, cls: string): Promise<string> {
  const r = await api.post<{ token: string }>('/api/v1/admin/security/reauth', { password, class: cls });
  return r.token;
}

/** POST a mutation with a step-up token attached. */
export function stepUpPost<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-stepup-token': token } });
}
