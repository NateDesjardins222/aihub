/*
 * Centralized public-site configuration seam.
 *
 * Company/legal/social facts live here — ONE place — rather than being scattered
 * or invented. Anything not yet configured for the real business is a clearly
 * marked TODO placeholder and is NOT rendered as a fabricated fact (no invented
 * social URLs, addresses, counts, testimonials, or trust signals).
 */

export const SITE = {
  brand: 'Happy Trader Funding',
  brandShort: 'Happy Trader',
  tagline: 'Trade futures on our capital.',
  description:
    'Happy Trader Funding is a futures proprietary trading firm. Prove your edge on a simulated evaluation, get a funded performance account, and keep up to 90% of your profits — traded on Atlas, our own futures platform.',

  /** Where the primary CTAs route. These are the existing gated flows. */
  routes: {
    getStarted: '/onboarding',
    signIn: '/portal',
    affiliates: '/affiliates',
  },

  /**
   * Legal/business details are not yet configured for the real entity. They are
   * intentionally left null and are not rendered until provided — the footer shows
   * only what is real. Do not invent these.
   */
  legal: {
    entityName: null as string | null,
    supportEmail: null as string | null,
    address: null as string | null,
    social: {
      x: null as string | null,
      youtube: null as string | null,
      instagram: null as string | null,
      discord: null as string | null,
    },
  },

  /** SEO defaults. */
  seo: {
    title: 'Happy Trader Funding — Futures Prop Trading & Funded Accounts',
    ogType: 'website',
  },
} as const;

/** Current year, for the footer copyright line. */
export function copyrightYear(): number {
  return new Date().getFullYear();
}
