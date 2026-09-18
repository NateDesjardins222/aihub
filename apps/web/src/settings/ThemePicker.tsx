/**
 * Choosing a theme by looking at it, and making one of your own.
 *
 * A row of colour chips is a guess about what a chart will look like, so this
 * does not make the trader guess: moving the pointer over a preset applies it
 * to the real terminal - the real chart, the real panels, the real P&L boxes -
 * and moving away puts back exactly what was there. Nothing is saved until a
 * preset is clicked, which is what makes the preview safe to wander through.
 *
 * Below the presets are the seven colours the whole terminal is built from.
 * Changing one applies at once and everywhere it is used: the accent moves the
 * selection tint and the working-order line with it, profit moves the filled
 * P&L box and the take-profit level, loss moves the stop. Then "Save as my
 * theme" turns what is on the screen into a theme like any other, which can be
 * renamed, duplicated, deleted and set as the default.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { useChartStore } from '../state/chart-store';
import { resumeSaving, suspendSaving } from '../state/preferences';
import {
  applyTheme,
  EDITABLE_TOKENS,
  matchesTheme,
  themeById,
  THEMES,
  tokenValue,
  type ThemeId,
} from '../chart/themes';
import { Colour } from './ColourPicker';
import { Icon } from '../ui/Icon';
import './Settings.css';

export function ThemePicker(): JSX.Element {
  const themeId = useChartStore((s) => s.themeId);
  const appearance = useChartStore((s) => s.appearance);
  const customThemes = useChartStore((s) => s.customThemes);
  const overrides = useChartStore((s) => s.surfaceOverrides);
  const defaultThemeId = useChartStore((s) => s.defaultThemeId);
  const setTheme = useChartStore((s) => s.setTheme);
  const setSurfaceToken = useChartStore((s) => s.setSurfaceToken);
  const saveCustomTheme = useChartStore((s) => s.saveCustomTheme);
  const renameCustomTheme = useChartStore((s) => s.renameCustomTheme);
  const duplicateCustomTheme = useChartStore((s) => s.duplicateCustomTheme);
  const deleteCustomTheme = useChartStore((s) => s.deleteCustomTheme);
  const setDefaultTheme = useChartStore((s) => s.setDefaultTheme);

  const [previewing, setPreviewing] = useState<ThemeId | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /**
   * What to put back when the pointer leaves.
   *
   * Captured on the way IN to a preview rather than read on the way out, so a
   * pointer that crosses three cards restores the trader's own theme rather
   * than the second card's.
   */
  const held = useRef<{
    themeId: ThemeId;
    appearance: typeof appearance;
    overrides: typeof overrides;
  } | null>(null);

  const restore = (): void => {
    const previous = held.current;
    held.current = null;
    setPreviewing(null);
    if (!previous) return;
    applyTheme(previous.themeId, useChartStore.getState().customThemes, previous.overrides);
    useChartStore.setState({
      themeId: previous.themeId,
      appearance: previous.appearance,
      surfaceOverrides: previous.overrides,
    });
    resumeSaving();
  };

  // A dialog closed mid-hover must not leave the workspace unsaveable.
  useEffect(() => restore, []);

  const preview = (id: ThemeId): void => {
    if (held.current === null) {
      held.current = { themeId, appearance, overrides };
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
  const edited =
    previewing === null &&
    (Object.keys(overrides).length > 0 || !matchesTheme(appearance, themeId, customThemes));

  const cards = [
    ...THEMES.map((theme) => ({ ...theme, mine: false })),
    ...customThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      description: `Yours, from ${themeById(theme.base).name}`,
      light: theme.light,
      surface: theme.surface,
      chart: theme.chart,
      mine: true,
    })),
  ];

  return (
    <>
      <section className="st-group">
        <h4 className="st-group-title">Theme</h4>
        <p className="st-note">
          Hover to try one on the real terminal. Nothing is saved until you pick one.
        </p>
        <div className="th-grid" data-testid="theme-grid" onMouseLeave={restore}>
          {cards.map((theme) => (
            <div key={theme.id} className={`th-card ${active === theme.id ? 'th-card-on' : ''}`}>
              <button
                type="button"
                className="th-pick"
                data-theme-card={theme.id}
                aria-pressed={themeId === theme.id}
                onMouseEnter={() => preview(theme.id)}
                onFocus={() => preview(theme.id)}
                onBlur={restore}
                onClick={() => commit(theme.id)}
              >
                <span className="th-swatch" style={{ background: theme.chart.canvas.background }}>
                  <span className="th-bar" style={{ background: theme.chart.symbol.upColor }} />
                  <span
                    className="th-bar th-bar-short"
                    style={{ background: theme.chart.symbol.downColor }}
                  />
                  <span
                    className="th-grid-line"
                    style={{ background: theme.chart.scales.gridColor }}
                  />
                  <span
                    className="th-chip"
                    style={{
                      background: theme.surface['--bg-panel'],
                      borderColor: theme.surface['--border'],
                    }}
                  />
                </span>
                {renaming === theme.id ? null : (
                  <span className="th-name">
                    {theme.name}
                    {defaultThemeId === theme.id ? <em className="th-tag"> · default</em> : null}
                    {themeId === theme.id && edited ? <em className="th-tag"> · edited</em> : null}
                  </span>
                )}
                {renaming === theme.id ? null : (
                  <span className="th-desc">{theme.description}</span>
                )}
              </button>

              {renaming === theme.id ? (
                <form
                  className="th-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameCustomTheme(theme.id, draftName);
                    setRenaming(null);
                  }}
                >
                  <input
                    autoFocus
                    value={draftName}
                    aria-label="Theme name"
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                  <button type="submit" className="chip">
                    Rename
                  </button>
                </form>
              ) : (
                <div className="th-actions">
                  {defaultThemeId === theme.id ? null : (
                    <button
                      type="button"
                      className="th-action"
                      title="Open new sessions on this theme, and reset back to it"
                      onClick={() => setDefaultTheme(theme.id)}
                    >
                      Set default
                    </button>
                  )}
                  {theme.mine ? (
                    <>
                      <button
                        type="button"
                        className="th-action"
                        onClick={() => {
                          setDraftName(theme.name);
                          setRenaming(theme.id);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="th-action"
                        onClick={() => duplicateCustomTheme(theme.id)}
                      >
                        Duplicate
                      </button>
                      {confirmDelete === theme.id ? (
                        <>
                          <button
                            type="button"
                            className="th-action th-action-danger"
                            onClick={() => {
                              deleteCustomTheme(theme.id);
                              setConfirmDelete(null);
                            }}
                          >
                            Delete it
                          </button>
                          <button
                            type="button"
                            className="th-action"
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="th-action"
                          onClick={() => setConfirmDelete(theme.id)}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="st-group" data-testid="terminal-colours">
        <h4 className="st-group-title">This terminal</h4>
        <p className="st-note">
          Seven colours the whole terminal is built from. Every change applies at once, everywhere
          the colour is used.
        </p>
        {EDITABLE_TOKENS.map((entry) => (
          <div className="st-row" key={entry.token} title={entry.hint}>
            <span className="st-row-label">{entry.label}</span>
            <div className="st-row-control">
              <Colour
                label={entry.label}
                value={overrides[entry.token] ?? tokenValue(entry.token)}
                onChange={(value) => setSurfaceToken(entry.token, value)}
              />
              {overrides[entry.token] ? (
                <button
                  type="button"
                  className="th-action"
                  title="Back to the theme's own colour"
                  onClick={() => setSurfaceToken(entry.token, null)}
                >
                  <Icon name="undo" size={11} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <div className="st-actions">
          <button data-testid="save-theme" onClick={() => saveCustomTheme()}>
            Save as my theme
          </button>
          {Object.keys(overrides).length > 0 ? (
            <button
              onClick={() => {
                for (const entry of EDITABLE_TOKENS) setSurfaceToken(entry.token, null);
              }}
            >
              Back to {themeById(themeId, customThemes).name}
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
