/**
 * /api/v1/provisioning
 *
 * The machine-to-machine seam. This is where a firm's purchase flow will call
 * when a customer buys a product:
 *
 *   customer pays -> that system's webhook -> POST /accounts here -> the
 *   account exists -> the customer signs in and it is simply there.
 *
 * No payment provider is implemented, and none is implied: this endpoint knows
 * nothing about money changing hands. It authenticates with an organisation
 * key, validates everything it is given, and calls the same provisioning
 * service an administrator does.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { provisioningKeys, users } from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { ProvisioningError, provisionAccount } from '../../platform/provisioning.js';

const bodySchema = z.object({
  /** Who the account is for. Either the user's id or their e-mail address. */
  userId: z.string().uuid().optional(),
  email: z.string().email().max(254).optional(),
  profileKey: z.string().min(1).max(60),
  displayName: z.string().min(1).max(80).optional(),
  startingBalanceMicros: z.number().int().positive().optional(),
  instrumentLimits: z.record(z.string(), z.unknown()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  activate: z.boolean().optional(),
});

export function hashProvisioningKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The organisation a presented key belongs to, or null. */
async function authenticateKey(request: FastifyRequest): Promise<{ organizationId: string; name: string } | null> {
  const header = request.headers['x-api-key'];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented) return null;

  const { db } = getDb();
  const [row] = await db
    .select()
    .from(provisioningKeys)
    .where(
      and(
        eq(provisioningKeys.keyHash, hashProvisioningKey(presented)),
        isNull(provisioningKeys.revokedAt),
      ),
    );
  if (!row) return null;
  await db
    .update(provisioningKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(provisioningKeys.id, row.id));
  return { organizationId: row.organizationId, name: row.name };
}

export async function provisioningRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  app.post(
    '/accounts',
    {
      // Deliberately tight. A provisioning endpoint is the most valuable thing
      // in the platform to a caller who should not have it.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const caller = await authenticateKey(request);
      if (!caller) throw ApiError.unauthorized('A valid provisioning key is required.');

      const body = bodySchema.parse(request.body);
      if (!body.userId && !body.email) {
        throw ApiError.badRequest('USER_REQUIRED', 'Name the user by id or by e-mail.');
      }

      // Idempotency is the caller's key, and it is REQUIRED: a webhook that
      // fires twice must not hand a customer two accounts, and that guarantee
      // cannot be made without one.
      const header = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(header) ? header[0] : header;
      if (!idempotencyKey) {
        throw ApiError.badRequest(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Send an Idempotency-Key header so a retry cannot create a second account.',
        );
      }

      const [user] = body.userId
        ? await db.select().from(users).where(eq(users.id, body.userId))
        : await db.select().from(users).where(eq(users.email, body.email!.trim().toLowerCase()));
      if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'No such user.');

      try {
        const result = await provisionAccount(db, {
          organizationId: caller.organizationId,
          userId: user.id,
          profileKey: body.profileKey,
          displayName: body.displayName,
          startingBalanceMicros: body.startingBalanceMicros,
          instrumentLimits: body.instrumentLimits ?? null,
          metadata: body.metadata ?? null,
          activate: body.activate,
          idempotencyKey,
          actor: { type: 'SERVICE', label: caller.name, ip: request.ip },
        });
        return reply.code(result.reused ? 200 : 201).send({
          accountId: result.accountId,
          publicId: result.publicId,
          product: { key: result.profile.profileKey, version: result.profile.version },
          reused: result.reused,
        });
      } catch (err) {
        if (err instanceof ProvisioningError) {
          const status =
            err.code === 'USER_NOT_FOUND' || err.code === 'PROFILE_NOT_FOUND'
              ? 404
              : err.code === 'IDEMPOTENCY_CONFLICT'
                ? 409
                : 400;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );
}
