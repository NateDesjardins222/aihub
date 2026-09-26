/**
 * Web runtime-environment boundary (Phase 4).
 *
 * The single place the SPA decides whether it is a development build. Vite sets
 * `import.meta.env.MODE` to `production` for `vite build` (the deployable bundle)
 * and to `development`/`test` otherwise. Non-production-only surfaces gate on
 * `isDevBuild()` so they cannot be reached in a production build — not even by
 * typing the URL directly.
 */
export function isDevBuild(): boolean {
  return import.meta.env.MODE !== 'production';
}

/**
 * The homepage Design Lab (/design-lab) contains fabricated demo values and is a
 * development-only surface. In a production build the route is inert (the app
 * falls through to its normal handling), so a direct URL cannot render it.
 */
export function designLabEnabled(): boolean {
  return isDevBuild();
}
