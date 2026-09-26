/**
 * Development-seed production guard (Phase 4).
 *
 * The `db:seed` script creates known demo/owner credentials (a working
 * `owner@atlasfutures.local` SUPER_ADMIN, a `demo@atlasfutures.local` trader) so a
 * developer can clone and sign in. Those credentials are public — they are in the
 * repository — so running the development seed against a production environment
 * would hand anyone a SUPER_ADMIN login. Production must therefore refuse the
 * development seed with a HARD FAILURE, not a silent skip, so a half-seeded prod
 * database never happens quietly. Pure and exported so it is unit-testable.
 */
export class DevSeedForbiddenError extends Error {
  constructor() {
    super(
      'refusing to run the development seed in production (NODE_ENV=production): ' +
        'it creates known demo/owner credentials. Create the first operator out of band.',
    );
    this.name = 'DevSeedForbiddenError';
  }
}

/** Throws in production; a no-op in development/test. */
export function assertDevSeedAllowed(nodeEnv: string | undefined = process.env['NODE_ENV']): void {
  if (nodeEnv === 'production') throw new DevSeedForbiddenError();
}
