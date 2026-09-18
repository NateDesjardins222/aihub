/**
 * Choosing a theme by looking at it.
 *
 * A row of colour chips is a guess about what a chart will look like, so this
 * does not make the trader guess: moving the pointer over a preset applies it
 * to the real terminal - the real chart, the real panels, the real P&L boxes -
 * and moving away puts back exactly what was there. Nothing is saved until a
 * preset is clicked, which is what makes the preview safe to wander through.
 *
 * The card still carries a small painting of the theme, because it has to say
 * something before the pointer reaches it.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { useChartStore } from '../state/chart-store';
import { resumeSaving, suspendSaving } from '../state/preferences';
import { applyTheme, matchesTheme, THEMES, type ThemeId } from '../chart/themes';
import './Settings.css';

export function ThemePicker(): JSX.Element {
  const themeId = useChartStore((s) => s.themeId);
  const appearance = useChartStore((s) => s.appearance);
  const setTheme = useChartStore((s) => s.setTheme);
  const [previewing, setPreviewing] = useState<ThemeId | null>(null);

  /**
   * What to put back when the pointer leaves.
   *
   * Captured on the way IN to a preview rather than read on the way out, so a
   * pointer that crosses three cards restores the trader's own theme rather
   * than the second card's.
   */
  const held = useRef<{ themeId: ThemeId; appearance: typeof appearance } | null>(null);

  const restore = (): void => {
    const previous = held.current;
    held.current = null;
    setPreviewing(null);
    if (!previous) return;
    applyTheme(previous.themeId);
    useChartStore.setState({ themeId: previous.themeId, appearance: previous.appearance });
    resumeSaving();
  };

  // A dialog closed mid-hover must not leave the workspace unsaveable.
  useEffect(() => restore, []);

  const preview = (id: ThemeId): void => {
    if (held.current === null) {
      held.current = { themeId, appearance };
      suspendSaving();
    }
    setPreviewing(id);
    setTheme(id);
  };

  const commit = (id: ThemeId): void => {
    held.current = null;
    setPreviewing(null);
    resumeSaving();
    setTheme(id);
  };

  const active = previewing ?? themeId;
  const edited = !matchesTheme(appearance, themeId) && previewing === null;

  return (
    <section className="st-group">
      <h4 className="st-group-title">Theme</h4>
      <p className="st-note">
        Hover to try one on the real terminal. Nothing is saved until you pick one.
      </p>
      <div className="th-grid" data-testid="theme-grid">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`th-card ${active === theme.id ? 'th-card-on' : ''}`}
            data-theme-card={theme.id}
            aria-pressed={themeId === theme.id}
            onMouseEnter={() => preview(theme.id)}
            onFocus={() => preview(theme.id)}
            onMouseLeave={restore}
            onBlur={restore}
            onClick={() => commit(theme.id)}
          >
            <span className="th-swatch" style={{ background: theme.chart.canvas.background }}>
              <span className="th-bar" style={{ background: theme.chart.symbol.upColor }} />
              <span
                className="th-bar th-bar-short"
                style={{ background: theme.chart.symbol.downColor }}
              />
              <span className="th-grid-line" style={{ background: theme.chart.scales.gridColor }} />
              <span
                className="th-chip"
                style={{
                  background: theme.surface['--bg-panel'],
                  borderColor: theme.surface['--border'],
                }}
              />
            </span>
            <span className="th-name">
              {theme.name}
              {themeId === theme.id && edited ? <em className="th-edited"> · edited</em> : null}
            </span>
            <span className="th-desc">{theme.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
