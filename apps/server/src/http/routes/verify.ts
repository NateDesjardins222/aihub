/**
 * Public certificate verification — GET /api/v1/verify/:token
 *
 * Unauthenticated and rate-limited. Returns ONLY the safe public projection
 * (VERIFIED HAPPY TRADER CERTIFICATE, public display name, type, amount where
 * applicable, issued month, public id, status). Never the legal name, email,
 * phone, KYC, or internal account/risk data. An unknown or revoked token returns
 * an explicit invalid state with no enumeration signal beyond valid/invalid
 * (tokens are random).
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/client.js';
import { publicVerification } from '../../platform/certificates.js';

export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  // No requireUser: this is a public, shareable, QR-compatible endpoint.
  app.get<{ Params: { token: string } }>(
    '/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = request.params.token ?? '';
      // Bound the token length so a huge path can't reach the query.
      if (token.length === 0 || token.length > 64) {
        return reply.send({
          valid: false,
          status: 'UNKNOWN',
          certificatePublicId: null,
          type: null,
          publicDisplayName: null,
          amountMicros: null,
          issuedMonth: null,
        });
      }
      const result = await publicVerification(db, token);
      return reply.send(result);
    },
  );
}
