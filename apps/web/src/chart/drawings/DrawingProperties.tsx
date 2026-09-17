/**
 * The object settings dialog.
 *
 * Every control in it is GENERATED from the tool's `props` in the registry, so
 * a tool cannot offer a setting it ignores and cannot ignore a setting it
 * offers. Adding a property to a tool adds its editor; there is no second list
 * to keep in step.
 *
 * Opened by a double-click on an object, or from its context menu.
 */
import { useState, type JSX } from 'react';
import { useChartStore } from '../../state/chart-store';
import { KIND_LABEL, readLevels, type Drawing, type FibLevel } from './model';
import {
  FIB_PRESETS,
  normalizeLevels,
  toolDef,
  type PropDef,
} from './registry';
import { Check, Choice, Colour, Group, Num, Row } from '../../settings/Controls';
import { Icon } from '../../ui/Icon';
import '../../settings/Settings.css';
import './DrawingProperties.css';

const DASHES = [
  { id: 'SOLID' as const, label: 'Solid' },
  { id: 'DASHED' as const, label: 'Dashed' },
  { id: 'DOTTED' as const, label: 'Dotted' },
];

const GROUP_ORDER = ['Appearance', 'Levels', 'Labels', 'Extend', 'Text'] as const;

export function DrawingProperties({
  drawingId,
  onClose,
}: {
  drawingId: string;
  onClose: () => void;
}): JSX.Element | null {
  const drawing = useChartStore((s) => s.drawings.find((item) => item.id === drawingId) ?? null);
  const templates = useChartStore((s) => s.templates);
  const setDrawingStyle = useChartStore((s) => s.setDrawingStyle);
  const setDrawingOptions = useChartStore((s) => s.setDrawingOptions);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const commitHistory = useChartStore((s) => s.commitHistory);
  const saveTemplate = useChartStore((s) => s.saveTemplate);
  const applyTemplate = useChartStore((s) => s.applyTemplate);
  const removeTemplate = useChartStore((s) => s.removeTemplate);
  const setToolDefault = useChartStore((s) => s.setToolDefault);
  const resetToolDefault = useChartStore((s) => s.resetToolDefault);
  const hasToolDefault = useChartStore((s) => (drawing ? s.toolDefaults[drawing.kind] : undefined));
  const [templateName, setTemplateName] = useState('');

  if (!drawing) return null;
  const def = toolDef(drawing.kind);
  if (!def) return null;

  const mine = templates.filter((template) => template.kind === drawing.kind);
  const groups = GROUP_ORDER.map((name) => ({
    name,
    props: def.props.filter((prop) => prop.group === name),
  })).filter((group) => group.props.length > 0);

  return (
    <div className="dp-scrim" role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[drawing.kind]} settings`}>
      <div className="dp-dialog" data-testid="drawing-properties">
        <header className="st-head">
          <h3>{KIND_LABEL[drawing.kind]}</h3>
          <div className="hdr-spacer" />
          <button className="st-close" onClick={onClose} aria-label="Close object settings">
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="dp-body">
          {groups.map((group) => (
            <Group key={group.name} title={group.name}>
              {group.props.map((prop) => (
                <PropRow
                  key={`${prop.on}:${prop.key}`}
                  prop={prop}
                  drawing={drawing}
                  onStyle={(patch) => setDrawingStyle(drawing.id, patch)}
                  onOptions={(patch) => setDrawingOptions(drawing.id, patch)}
                  onText={(text) => {
                    updateDrawing(drawing.id, { text });
                    commitHistory();
                  }}
                />
              ))}
            </Group>
          ))}

          <Group title="Visibility">
            <Row label="Locked" hint="A locked object can be selected but not moved">
              <Check
                checked={drawing.locked}
                onChange={(locked) => {
                  updateDrawing(drawing.id, { locked });
                  commitHistory();
                }}
              />
            </Row>
            <Row label="Hidden">
              <Check
                checked={drawing.hidden}
                onChange={(hidden) => {
                  updateDrawing(drawing.id, { hidden });
                  commitHistory();
                }}
              />
            </Row>
          </Group>

          <Group title="Templates">
            {mine.length > 0 ? (
              <div className="dp-templates">
                {mine.map((template) => (
                  <div className="dp-template" key={template.id}>
                    <button
                      className="dp-template-apply"
                      onClick={() => applyTemplate(template.id, drawing.id)}
                    >
                      <span className="dp-template-dot" style={{ background: template.style.color }} />
                      {template.name}
                    </button>
                    <button
                      className="dp-template-del"
                      onClick={() => removeTemplate(template.id)}
                      aria-label={`Delete template ${template.name}`}
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="st-note">No templates saved for this tool yet.</p>
            )}
            <div className="dp-save">
              <input
                className="dp-save-name"
                value={templateName}
                placeholder="Template name"
                aria-label="Template name"
                onChange={(event) => setTemplateName(event.target.value)}
              />
              <button
                className="dp-btn"
                disabled={templateName.trim().length === 0}
                onClick={() => {
                  saveTemplate(drawing.id, templateName);
                  setTemplateName('');
                }}
              >
                Save template
              </button>
            </div>
            <div className="dp-save">
              <button className="dp-btn" onClick={() => setToolDefault(drawing.id)}>
                Use as default for this tool
              </button>
              {hasToolDefault ? (
                <button className="dp-btn" onClick={() => resetToolDefault(drawing.kind)}>
                  Reset default
                </button>
              ) : null}
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

function PropRow({
  prop,
  drawing,
  onStyle,
  onOptions,
  onText,
}: {
  prop: PropDef;
  drawing: Drawing;
  onStyle: (patch: Record<string, unknown>) => void;
  onOptions: (patch: Record<string, unknown>) => void;
  onText: (text: string) => void;
}): JSX.Element | null {
  const style = drawing.style as unknown as Record<string, unknown>;
  const fromStyle = style[prop.key];
  const fromOptions = drawing.options[prop.key];
  const fallback = toolDef(drawing.kind)?.options[prop.key];
  const value = prop.on === 'STYLE' ? fromStyle : (fromOptions ?? fallback);
  const set = prop.on === 'STYLE' ? onStyle : onOptions;

  switch (prop.type) {
    case 'COLOR':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Colour value={typeof value === 'string' ? value : '#4d8dff'} onChange={(next) => set({ [prop.key]: next })} />
        </Row>
      );

    case 'COLOR_ALPHA': {
      /*
       * A colour and its own opacity, side by side.
       *
       * They are one control because a trader thinks of them as one decision -
       * "white border, fully opaque; grey fill, barely there" - and two
       * separate rows an inch apart makes that decision harder than it is.
       */
      const alphaKey = prop.alphaKey ?? 'opacity';
      const alpha = typeof style[alphaKey] === 'number' ? (style[alphaKey] as number) : 1;
      const toggleKey = prop.toggleKey;
      const on = toggleKey ? style[toggleKey] === true : true;
      return (
        <Row label={prop.label} hint={prop.hint}>
          <div className="dp-colour-alpha">
            {toggleKey ? (
              <input
                type="checkbox"
                checked={on}
                aria-label={`${prop.label} on`}
                onChange={(event) => set({ [toggleKey]: event.target.checked })}
              />
            ) : null}
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#4d8dff'}
              aria-label={`${prop.label} colour`}
              disabled={!on}
              onChange={(event) => set({ [prop.key]: event.target.value })}
            />
            <input
              className="dp-alpha"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(alpha * 100)}
              aria-label={`${prop.label} opacity`}
              disabled={!on}
              onChange={(event) => set({ [alphaKey]: Number(event.target.value) / 100 })}
            />
            <span className="num dp-alpha-value">{Math.round(alpha * 100)}%</span>
          </div>
        </Row>
      );
    }

    case 'NUMBER':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Num
            value={typeof value === 'number' ? value : (prop.min ?? 1)}
            min={prop.min}
            max={prop.max}
            step={prop.step}
            onChange={(next) => set({ [prop.key]: next })}
          />
        </Row>
      );

    case 'DASH':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Choice
            value={(typeof value === 'string' ? value : 'SOLID') as 'SOLID' | 'DASHED' | 'DOTTED'}
            options={DASHES}
            onChange={(next) => set({ [prop.key]: next })}
          />
        </Row>
      );

    case 'BOOLEAN':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Check checked={value === true} onChange={(next) => set({ [prop.key]: next })} />
        </Row>
      );

    case 'TEXT':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <input
            className="dp-text"
            value={drawing.text}
            aria-label={prop.label}
            onChange={(event) => onText(event.target.value)}
          />
        </Row>
      );

    case 'LEVELS':
      return <LevelEditor drawing={drawing} propKey={prop.key} onOptions={onOptions} />;

    default:
      return null;
  }
}

/**
 * The level editor.
 *
 * Levels are the whole tool for a Fibonacci trader: they must be addable,
 * removable, recolourable and hideable one by one, and a set worth keeping
 * must be a preset. A level is stored as a FRACTION - 0.705, not 70.5 - and
 * shown as a percentage, because that is how it is spoken about.
 */
function LevelEditor({
  drawing,
  propKey,
  onOptions,
}: {
  drawing: Drawing;
  propKey: string;
  onOptions: (patch: Record<string, unknown>) => void;
}): JSX.Element {
  const levels = readLevels(drawing);
  const write = (next: readonly FibLevel[]): void =>
    onOptions({ [propKey]: normalizeLevels(next) });

  return (
    <div className="dp-levels" data-testid="level-editor">
      <div className="dp-presets">
        {FIB_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="dp-preset"
            onClick={() => write(preset.levels)}
            title={`Replace the levels with ${preset.name}`}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {levels.map((level, index) => (
        <div className="dp-level" key={`${level.value}-${index}`}>
          <input
            type="checkbox"
            checked={level.visible}
            aria-label={`Show ${(level.value * 100).toFixed(1)}%`}
            onChange={(event) =>
              write(levels.map((item, i) => (i === index ? { ...item, visible: event.target.checked } : item)))
            }
          />
          <input
            className="num dp-level-value"
            type="number"
            step="0.1"
            value={Number((level.value * 100).toFixed(4))}
            aria-label="Level"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              write(levels.map((item, i) => (i === index ? { ...item, value: next / 100 } : item)));
            }}
          />
          <span className="dp-level-pct">%</span>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(level.color) ? level.color : '#6b7a94'}
            aria-label="Level colour"
            onChange={(event) =>
              write(levels.map((item, i) => (i === index ? { ...item, color: event.target.value } : item)))
            }
          />
          <button
            className="dp-level-del"
            aria-label={`Remove ${(level.value * 100).toFixed(1)}%`}
            onClick={() => write(levels.filter((_, i) => i !== index))}
          >
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}

      <button
        className="dp-btn dp-level-add"
        onClick={() => {
          const highest = levels.reduce((max, level) => Math.max(max, level.value), 0);
          write([...levels, { value: highest + 0.1, color: '#6b7a94', visible: true }]);
        }}
      >
        Add level
      </button>
    </div>
  );
}
