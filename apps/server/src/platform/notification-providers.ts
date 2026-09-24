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

export function emailProviderFromEnv(): EmailProvider {
  return resendEmail.isConfigured() ? resendEmail : mockEmail;
}
export function smsProviderFromEnv(): SmsProvider {
  return twilioSms.isConfigured() ? twilioSms : mockSms;
}
export function activeEmailProviderName(): 'mock' | 'resend' {
  return resendEmail.isConfigured() ? 'resend' : 'mock';
}
export function activeSmsProviderName(): 'mock' | 'twilio' {
  return twilioSms.isConfigured() ? 'twilio' : 'mock';
}
