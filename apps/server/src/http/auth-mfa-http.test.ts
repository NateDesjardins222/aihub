/**
 * The MFA login contract at the HTTP boundary (Phase 12.5).
 *
 * This is the exact sequence the web client drives: register, enroll a second
 * factor, then a fresh login that returns a challenge instead of a session, and
 * a second call that exchanges the challenge + code for real tokens. It also
 * proves the negative paths the UI relies on (a bad code is 401, management
 * endpoints require a session).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { totpCode } from '../auth/totp.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function registerUser(): Promise<{ token: string; email: string }> {
  const email = `mfahttp-${crypto.randomUUID()}@atlas.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password-12chars', displayName: 'MFA HTTP' },
  });
  expect(res.statusCode).toBe(201);
  return { token: JSON.parse(res.body).accessToken, email };
}

describe('MFA over HTTP', () => {
  it('drives register → enroll → challenged login → verify', async () => {
    const { token, email } = await registerUser();

    const begin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll/begin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(begin.statusCode).toBe(200);
    const secret: string = JSON.parse(begin.body).secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const activate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll/activate',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: totpCode(secret, Date.now()) },
    });
    expect(activate.statusCode).toBe(200);
    expect(JSON.parse(activate.body).recoveryCodes).toHaveLength(10);

    // A fresh login now returns a challenge, not a session.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'password-12chars' },
    });
    expect(login.statusCode).toBe(200);
    const challenge = JSON.parse(login.body);
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.accessToken).toBeUndefined();
    expect(typeof challenge.challengeToken).toBe('string');

    // A wrong code is rejected.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challengeToken: challenge.challengeToken, code: '000000' },
    });
    expect(bad.statusCode).toBe(401);

    // The right code completes the login.
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challengeToken: challenge.challengeToken, code: totpCode(secret, Date.now()) },
    });
    expect(verify.statusCode).toBe(200);
    const session = JSON.parse(verify.body);
    expect(typeof session.accessToken).toBe('string');
    expect(session.user.email).toBe(email);
  });

  it('requires a session to manage MFA', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/status' });
    expect(res.statusCode).toBe(401);
  });

  it('an un-enrolled user logs in with password alone (no challenge)', async () => {
    const { email } = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'password-12chars' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mfaRequired).toBeUndefined();
    expect(typeof body.accessToken).toBe('string');
  });
});
