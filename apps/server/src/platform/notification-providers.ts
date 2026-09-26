/**
 * The notification provider boundary — Email (Resend) and SMS (Twilio).
 *
 * The deterministic MOCK providers are the working default: a "delivered" mock
 * notification is the notification_messages row (SENT, provider MOCK) — the owner
 * console and tests read that. The Resend/Twilio adapters are SEAMS: with no
 * credentials they report unconfigured and return a non-retryable failure so the
 * message is marked SUPPRESSED (a visible, honest "not delivered"), NEVER a fake
 * SENT. No live call is made in this build.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { emailMode, smsMode } from '../config/provider-safety.js';

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}
export interface OutboundSms {
  readonly to: string;
  readonly body: string;
}
export type ProviderSendResult =
  | { ok: true; providerRef: string }
  | { ok: false; retryable: boolean; error: string };

export interface EmailProvider {
  readonly name: 'MOCK' | 'RESEND';
  isConfigured(): boolean;
  send(msg: OutboundEmail): Promise<ProviderSendResult>;
}
export interface SmsProvider {
  readonly name: 'MOCK' | 'TWILIO';
  isConfigured(): boolean;
  send(msg: OutboundSms): Promise<ProviderSendResult>;
}

function mockRef(kind: string): string {
  return `mock_${kind}_${randomBytes(6).toString('hex')}`;
}

export class MockEmailProvider implements EmailProvider {
  readonly name = 'MOCK' as const;
  isConfigured(): boolean {
    return true;
  }
  async send(_msg: OutboundEmail): Promise<ProviderSendResult> {
    return { ok: true, providerRef: mockRef('email') };
  }
}

export class MockSmsProvider implements SmsProvider {
  readonly name = 'MOCK' as const;
  isConfigured(): boolean {
    return true;
  }
  async send(_msg: OutboundSms): Promise<ProviderSendResult> {
    return { ok: true, providerRef: mockRef('sms') };
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'RESEND' as const;
  isConfigured(): boolean {
    return Boolean(env().RESEND_API_KEY && env().RESEND_FROM);
  }
  async send(_msg: OutboundEmail): Promise<ProviderSendResult> {
    // Seam only: no live Resend call in this build. Unconfigured -> a clear,
    // non-retryable failure so the message is SUPPRESSED, never faked as SENT.
    return { ok: false, retryable: false, error: 'RESEND_UNCONFIGURED' };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'TWILIO' as const;
  isConfigured(): boolean {
    const e = env();
    return Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM);
  }
  async send(_msg: OutboundSms): Promise<ProviderSendResult> {
    return { ok: false, retryable: false, error: 'TWILIO_UNCONFIGURED' };
  }
}

const mockEmail = new MockEmailProvider();
const resendEmail = new ResendEmailProvider();
const mockSms = new MockSmsProvider();
const twilioSms = new TwilioSmsProvider();

/**
 * Provider selection via the central provider-safety boundary.
 *
 * - REAL → the real adapter (Resend/Twilio).
 * - MOCK (development/test only) → the deterministic mock (records a SENT row).
 * - UNAVAILABLE (production, no real config) → the real adapter's seam, which
 *   returns a non-retryable failure so the message is marked SUPPRESSED (an
 *   honest "not delivered"), NEVER a faked SENT. The mock is never selected in
 *   production. This is "suppress, don't fake." See config/provider-safety.ts.
 */
export function emailProviderFromEnv(): EmailProvider {
  return emailMode() === 'MOCK' ? mockEmail : resendEmail;
}
export function smsProviderFromEnv(): SmsProvider {
  return smsMode() === 'MOCK' ? mockSms : twilioSms;
}
export function activeEmailProviderName(): 'mock' | 'resend' | 'suppressed' {
  const mode = emailMode();
  return mode === 'REAL' ? 'resend' : mode === 'MOCK' ? 'mock' : 'suppressed';
}
export function activeSmsProviderName(): 'mock' | 'twilio' | 'suppressed' {
  const mode = smsMode();
  return mode === 'REAL' ? 'twilio' : mode === 'MOCK' ? 'mock' : 'suppressed';
}
