/*
 * Public marketing site entry (its own lazy bundle).
 *
 * Rendered at "/" (and "/home") for visitors who are not signed in — before the
 * sign-in gate, like /verify and /affiliates — so the homepage is the public front
 * door. Signed-in users at "/" still get the Atlas terminal; the authenticated
 * product is untouched. CTAs navigate into the existing gated flows.
 */
import type { JSX } from 'react';
import { HomePage } from './HomePage';
import './marketing.css';

export function MarketingApp(): JSX.Element {
  return <HomePage />;
}
