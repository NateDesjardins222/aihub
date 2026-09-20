/**
 * A development-only gallery of every drawing-tool icon.
 *
 * Reached at /icons, never linked from the terminal. It exists to put the
 * recreated icons side by side - at the sizes the rail and pickers use, and in
 * the states the trader sees - so their geometry can be checked against the
 * reference screenshots rather than trusted because the name is right.
 *
 * The icons that map to a REAL Atlas tool are shown first. The ones whose tools
 * are not built yet are shown apart and labelled as such: their geometry is
 * defined so the family is complete, but nothing here arms them.
 */
import type { JSX } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import './IconGallery.css';

interface Item {
  readonly name: IconName;
  readonly label: string;
}

const REAL: readonly Item[] = [
  { name: 'cursor', label: 'Cursor' },
  { name: 'trend', label: 'Trend Line' },
  { name: 'ray', label: 'Ray' },
  { name: 'extended', label: 'Extended Line' },
  { name: 'horizontal', label: 'Horizontal Line' },
  { name: 'vertical', label: 'Vertical Line' },
  { name: 'rect', label: 'Rectangle' },
  { name: 'fib', label: 'Fib Retracement' },
  { name: 'position-long', label: 'Long Position' },
  { name: 'position-short', label: 'Short Position' },
  { name: 'text', label: 'Text' },
  { name: 'measure', label: 'Measure' },
  { name: 'magnet', label: 'Magnet' },
];

const FUTURE: readonly Item[] = [
  { name: 'cross-line', label: 'Cross Line' },
  { name: 'parallel-channel', label: 'Parallel Channel' },
  { name: 'regression-trend', label: 'Regression Trend' },
  { name: 'fib-extension', label: 'Trend-Based Fib Extension' },
  { name: 'fib-channel', label: 'Fib Channel' },
  { name: 'forecast', label: 'Forecast' },
  { name: 'rotated-rect', label: 'Rotated Rectangle' },
  { name: 'path-draw', label: 'Path' },
  { name: 'brush', label: 'Brush' },
  { name: 'highlighter', label: 'Highlighter' },
  { name: 'arrow-marker', label: 'Arrow Marker' },
  { name: 'anchored-text', label: 'Anchored Text' },
  { name: 'note', label: 'Note' },
];

const SIZES = [16, 18, 20, 24, 32];

function Row({ item }: { item: Item }): JSX.Element {
  return (
    <div className="ig-row">
      <div className="ig-label">{item.label}</div>
      <div className="ig-sizes">
        {SIZES.map((size) => (
          <div className="ig-cell" key={size}>
            <Icon name={item.name} size={size} />
            <span className="ig-px">{size}</span>
          </div>
        ))}
      </div>
      <div className="ig-states">
        <span className="ig-state ig-rest" title="rest">
          <Icon name={item.name} size={20} />
        </span>
        <span className="ig-state ig-hover" title="hover">
          <Icon name={item.name} size={20} />
        </span>
        <span className="ig-state ig-active" title="active">
          <Icon name={item.name} size={20} />
        </span>
        <span className="ig-state ig-disabled" title="disabled">
          <Icon name={item.name} size={20} />
        </span>
      </div>
    </div>
  );
}

export function IconGallery(): JSX.Element {
  return (
    <div className="ig">
      <header className="ig-head">
        <h1>Atlas drawing icons</h1>
        <p>
          Each icon at 16 / 18 / 20 / 24 / 32px, then rest · hover · active ·
          disabled at 20px. Rail default is 18px.
        </p>
      </header>

      <section>
        <h2 className="ig-section">Live tools</h2>
        <div className="ig-legend">
          <span className="ig-cellhead" />
          <div className="ig-sizes">
            {SIZES.map((s) => (
              <span className="ig-collabel" key={s}>
                {s}px
              </span>
            ))}
          </div>
          <div className="ig-states-head">rest · hover · active · disabled</div>
        </div>
        {REAL.map((item) => (
          <Row key={item.name} item={item} />
        ))}
      </section>

      <section>
        <h2 className="ig-section">
          Reference geometry for tools not yet built
          <span className="ig-note">defined for the family; not armable in the rail</span>
        </h2>
        {FUTURE.map((item) => (
          <Row key={item.name} item={item} />
        ))}
      </section>
    </div>
  );
}
