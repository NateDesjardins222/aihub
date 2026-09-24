/**
 * The application navigation rail.
 *
 * Far left, full height, 44px wide. The brief asked for application-level
 * navigation to live here and be about as narrow and unobtrusive as the
 * reference platform's at the same viewport - it costs 44 of 1680 pixels, or
 * 2.6% of the width, and it replaces four icons that were competing for space
 * in the account bar.
 *
 * The distinction it exists to make: THIS IS NOT THE DRAWING TOOLBAR. Chart
 * drawing tools are chart-specific and stay in their own rail beside the plot,
 * which is why that rail can be collapsed and this one cannot - navigating out
 * of the charts is not something a trader should have to find a control to be
 * allowed to do.
 */
import type { JSX } from 'react';
import { useWorkspace } from '../state/workspace';
import { useSession } from '../state/session';
import { useTraining } from '../state/training';
import { Icon, type IconName } from '../ui/Icon';
import './AppRail.css';

interface Destination {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly hint: string;
}

/**
 * Charts first, because that is the application. Everything else is somewhere
 * a trader goes and comes back from.
 */
const DESTINATIONS: readonly Destination[] = [
  { id: 'CHARTS', label: 'Trade', icon: 'chart', hint: 'The charts and the order ticket' },
  { id: 'JOURNAL', label: 'Journal', icon: 'journal', hint: 'Journal, calendar and analytics' },
  { id: 'PAYOUT', label: 'Payouts', icon: 'wallet', hint: 'Payout eligibility and requests' },
];

export function AppRail(): JSX.Element {
  const surface = useWorkspace((s) => s.surface);
  const openSurface = useWorkspace((s) => s.openSurface);
  const openSettings = useWorkspace((s) => s.openSettings);
  const signOut = useSession((s) => s.signOut);
  const journalAllowed = useTraining((s) => s.visibility.journal);

  // "Trade" is where you are when no drawer is over the charts.
  const active = surface ?? 'CHARTS';

  return (
    <nav className="apprail" aria-label="Atlas navigation">
      {/*
        The mark only. The wordmark and the SIM qualifier are in the account
        bar a few pixels to the right, and printing "SIM" twice within 60px
        does not make the simulation any clearer.
      */}
      <div className="apprail-brand" title="Atlas — simulated futures trading">
        <span className="apprail-mark" aria-hidden="true" />
      </div>

      <div className="apprail-items">
        {DESTINATIONS.map((item) => (
          <button
            key={item.id}
            className={`apprail-btn ${active === item.id ? 'apprail-btn-on' : ''}`}
            onClick={() => openSurface(item.id === 'CHARTS' ? null : (item.id as 'JOURNAL' | 'PAYOUT'))}
            title={item.hint}
            aria-label={item.label}
            aria-current={active === item.id ? 'page' : undefined}
            data-testid={`apprail-${item.id.toLowerCase()}`}
            disabled={item.id === 'JOURNAL' && !journalAllowed}
          >
            <Icon name={item.icon} size={15} />
            <span className="apprail-label">{item.label}</span>
          </button>
        ))}
      </div>

      <div className="apprail-foot">
        <button
          className="apprail-btn"
          onClick={() => openSettings('SYMBOL')}
          title="Settings"
          aria-label="Settings"
          data-testid="apprail-settings"
        >
          <Icon name="gear" size={15} />
          <span className="apprail-label">Settings</span>
        </button>
        <button
          className="apprail-btn apprail-btn-out"
          onClick={signOut}
          title="Sign out"
          aria-label="Sign out"
          data-testid="apprail-signout"
        >
          <Icon name="close" size={13} />
          <span className="apprail-label">Sign out</span>
        </button>
      </div>
    </nav>
  );
}
