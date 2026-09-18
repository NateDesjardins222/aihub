/**
 * One indicator's settings.
 *
 * Opened by the gear on its legend row, or by double-clicking the row. It is
 * generated from the indicator's own parameter list, so an indicator cannot
 * offer a setting it ignores, or ignore one it offers - and the LENGTH is the
 * first thing in it, because "I cannot confidently tell what EMA length I
 * have" was the complaint that prompted this.
 */
import { Fragment, useEffect, useRef, type JSX } from 'react';
import { useLayout } from '../state/layout-store';
import { indicatorDef, type ParamDef } from './indicators/registry';
import { Check, Choice, Colour, Num, Row } from '../settings/Controls';
import { Icon } from '../ui/Icon';
import '../settings/Settings.css';
import './IndicatorSettings.css';

const SOURCES = [
  { id: 'close', label: 'Close' },
  { id: 'open', label: 'Open' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
  { id: 'hl2', label: 'HL/2' },
  { id: 'hlc3', label: 'HLC/3' },
  { id: 'ohlc4', label: 'OHLC/4' },
];

const DASHES = [
  { id: 'SOLID', label: 'Solid' },
  { id: 'DASHED', label: 'Dashed' },
  { id: 'DOTTED', label: 'Dotted' },
];

export interface IndicatorSettingsProps {
  readonly instanceId: string;
  readonly onClose: () => void;
}

export function IndicatorSettings({ instanceId, onClose }: IndicatorSettingsProps): JSX.Element | null {
  const instance = useLayout(
    (s) =>
      s.panes
        .flatMap((pane) => pane.indicators)
        .find((candidate) => candidate.id === instanceId) ?? null,
  );
  const update = useLayout((s) => s.updateIndicator);
  const remove = useLayout((s) => s.removeIndicator);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!instance) return null;
  const def = indicatorDef(instance.kind);
  if (!def) return null;

  /*
   * Sections, in the order the indicator declares them.
   *
   * A parameter that names a group goes in that group; the rest fall into
   * Inputs or Style the way they always did. Bollinger bands declare Basis,
   * Upper band, Lower band and Fill, so each line's five controls sit
   * together instead of twenty controls sharing one list.
   */
  const sections: Array<{ title: string; params: ParamDef[] }> = [];
  const section = (title: string): ParamDef[] => {
    const found = sections.find((s) => s.title === title);
    if (found) return found.params;
    const made = { title, params: [] as ParamDef[] };
    sections.push(made);
    return made.params;
  };
  for (const param of def.params) {
    section(param.group ?? (isStyle(param) ? 'Style' : 'Inputs')).push(param);
  }
  // Inputs first whatever order the declaration happened to be in.
  sections.sort((a, b) => (a.title === 'Inputs' ? -1 : b.title === 'Inputs' ? 1 : 0));
  const takesInputs = def.params.some((p) => p.group === undefined && !isStyle(p));

  const control = (param: ParamDef): JSX.Element | null => {
    const value = instance.params[param.key];
    switch (param.type) {
      case 'NUMBER':
        return (
          <Num
            value={typeof value === 'number' ? value : (param.min ?? 1)}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(next) => update(instance.id, { [param.key]: next })}
          />
        );
      case 'SOURCE':
        return (
          <Choice
            value={typeof value === 'string' ? value : 'close'}
            options={SOURCES}
            onChange={(next) => update(instance.id, { [param.key]: next })}
          />
        );
      case 'LINE_STYLE':
        return (
          <Choice
            value={typeof value === 'string' ? value : 'SOLID'}
            options={DASHES}
            onChange={(next) => update(instance.id, { [param.key]: next })}
          />
        );
      case 'COLOR':
        return (
          <Colour
            value={typeof value === 'string' ? value : '#4d8dff'}
            onChange={(next) => update(instance.id, { [param.key]: next })}
          />
        );
      case 'TOGGLE':
        return (
          <Check
            checked={value !== 'off'}
            onChange={(next) => update(instance.id, { [param.key]: next ? 'on' : 'off' })}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="is-panel" data-testid="indicator-settings" role="dialog" aria-label={`${def.name} settings`}>
      <header className="is-head">
        <span className="is-title">{def.name}</span>
        <div className="hdr-spacer" />
        <button className="is-close" onClick={onClose} aria-label="Close indicator settings">
          <Icon name="close" size={11} />
        </button>
      </header>

      <div className="is-body">
        {sections.map((group) => (
          <Fragment key={group.title}>
            <h4 className="st-group-title">{group.title}</h4>
            {group.params.map((param) => (
              <Row key={param.key} label={param.label}>
                {control(param)}
              </Row>
            ))}
          </Fragment>
        ))}
        {!takesInputs ? <p className="st-note">This indicator takes no inputs.</p> : null}

        <h4 className="st-group-title">Visibility</h4>
        <Row label="Shown on the chart">
          <Check
            checked={instance.visible}
            name="Shown on the chart"
            onChange={(visible) => update(instance.id, { visible })}
          />
        </Row>
      </div>

      <footer className="is-foot">
        <button
          className="is-remove"
          onClick={() => {
            remove(instance.id);
            onClose();
          }}
        >
          <Icon name="trash" size={11} />
          Remove
        </button>
      </footer>
    </div>
  );
}

/** Appearance parameters, which belong under Style rather than under Inputs. */
function isStyle(param: ParamDef): boolean {
  return (
    param.key === 'color' ||
    param.key === 'lineWidth' ||
    param.key === 'lineStyle' ||
    param.key === 'opacity'
  );
}
