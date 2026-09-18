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
import {
  ENTRY,
  KIND_LABEL,
  STOP,
  TARGET,
  isPositionTool,
  positionMetrics,
  readLevels,
  type Drawing,
  type FibLevel,
} from './model';
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
  tickSize = 0.25,
  tickValueMicros = 0,
  pricePrecision = 2,
}: {
  drawingId: string;
  onClose: () => void;
  /** The instrument's tick, so a price can be typed in the steps it moves in. */
  tickSize?: number;
  tickValueMicros?: number;
  pricePrecision?: number;
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

          {/*
            Coordinates.

            A trader who knows the stop is at 29,687.25 should be able to TYPE
            it rather than drag a handle until the label reads the right thing.
            Every anchor's price is editable here; the time is shown because it
            is what the anchor is pinned to, and it is moved by dragging.
          */}
          <Group title="Coordinates">
            {drawing.anchors.map((anchor, index) => (
              <Row key={index} label={anchorLabel(drawing, index)}>
                <div className="dp-coord">
                  <Num
                    value={anchor.price}
                    step={tickSize}
                    onChange={(price) => {
                      const anchors = drawing.anchors.map((existing, at) =>
                        at === index ? { ...existing, price } : existing,
                      );
                      updateDrawing(drawing.id, { anchors });
                      commitHistory();
                    }}
                  />
                  <span className="dp-coord-time">{whenLabel(anchor.time)}</span>
                </div>
              </Row>
            ))}
            {isPositionTool(drawing.kind) ? (
              <p className="st-note">{riskLine(drawing, tickSize, tickValueMicros, pricePrecision)}</p>
            ) : null}
          </Group>

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
            <Colour
              value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#4d8dff'}
              label={`${prop.label} colour`}
              // The opacity beside it is this drawing's own field, so the
              // picker hands back a plain colour and does not fold one in.
              alpha={false}
              text={false}
              disabled={!on}
              onChange={(next) => set({ [prop.key]: next })}
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

    case 'SELECT':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Choice
            value={typeof value === 'string' ? value : (prop.options?.[0]?.id ?? '')}
            options={[...(prop.options ?? [])]}
            onChange={(next) => set({ [prop.key]: next })}
          />
        </Row>
      );

    case 'BOOLEAN':
      return (
        <Row label={prop.label} hint={prop.hint}>
          <Check
            checked={value === true}
            name={prop.label}
            onChange={(next) => set({ [prop.key]: next })}
          />
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
          <Colour
            value={/^#[0-9a-f]{6}$/i.test(level.color) ? level.color : '#6b7a94'}
            label="Level colour"
            alpha={false}
            text={false}
            onChange={(next) =>
              write(levels.map((item, i) => (i === index ? { ...item, color: next } : item)))
            }
          />
          {/* Each level's own opacity: the level that matters stays solid and
              the rest can sit back without being hidden altogether. */}
          <input
            className="dp-level-alpha"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={level.opacity ?? 1}
            aria-label={`Opacity of ${(level.value * 100).toFixed(1)}%`}
            onChange={(event) =>
              write(
                levels.map((item, i) =>
                  i === index ? { ...item, opacity: Number(event.target.value) } : item,
                ),
              )
            }
          />
          {/* Its own thickness, and its own line style. Zero and "—" both
              mean "the same as the object", so a set of seven levels does not
              become seven separate decisions unless the trader wants it to. */}
          <input
            className="num dp-level-width"
            type="number"
            min={0}
            max={6}
            step={1}
            value={level.width ?? 0}
            aria-label={`Thickness of ${(level.value * 100).toFixed(1)}%`}
            title="Thickness. 0 uses the object's own"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              write(levels.map((item, i) => (i === index ? { ...item, width: next } : item)));
            }}
          />
          <select
            className="dp-level-dash"
            value={level.dash ?? ''}
            aria-label={`Line style of ${(level.value * 100).toFixed(1)}%`}
            title="Line style"
            onChange={(event) =>
              write(
                levels.map((item, i) =>
                  i === index
                    ? {
                        ...item,
                        dash:
                          event.target.value === ''
                            ? undefined
                            : (event.target.value as 'SOLID' | 'DASHED' | 'DOTTED'),
                      }
                    : item,
                ),
              )
            }
          >
            <option value="">—</option>
            <option value="SOLID">Solid</option>
            <option value="DASHED">Dashed</option>
            <option value="DOTTED">Dotted</option>
          </select>
          <input
            className="dp-level-label"
            type="text"
            value={level.label ?? ''}
            placeholder="%"
            aria-label={`Name for ${(level.value * 100).toFixed(1)}%`}
            title="A name shown instead of the percentage"
            onChange={(event) =>
              write(
                levels.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)),
              )
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
          write([
            ...levels,
            { value: highest + 0.1, color: '#6b7a94', visible: true, opacity: 1, label: '' },
          ]);
        }}
      >
        Add level
      </button>
    </div>
  );
}

/** What an anchor is called in this tool's own terms. */
function anchorLabel(drawing: Drawing, index: number): string {
  if (isPositionTool(drawing.kind)) {
    if (index === ENTRY) return 'Entry';
    if (index === TARGET) return 'Target';
    if (index === STOP) return 'Stop';
  }
  return drawing.anchors.length === 1 ? 'Price' : `Point ${index + 1}`;
}

function whenLabel(timeMs: number): string {
  const when = new Date(timeMs);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The trade the position tool is describing, in one line.
 *
 * Read from the same pure function the painter uses, so the dialog and the
 * chart can never disagree about what the drawing says. It describes a PLAN:
 * no order exists, and nothing here can create one.
 */
function riskLine(
  drawing: Drawing,
  tickSize: number,
  tickValueMicros: number,
  pricePrecision: number,
): string {
  const metrics = positionMetrics(drawing, tickSize, tickValueMicros / 1_000_000);
  if (!metrics) return '';
  const parts = [
    `Risk ${metrics.riskTicks} ticks`,
    `reward ${metrics.rewardTicks} ticks`,
    metrics.ratio === null ? 'no risk set' : `R:R ${metrics.ratio.toFixed(2)}`,
  ];
  if (metrics.qty > 0 && tickValueMicros > 0) {
    parts.push(
      `${metrics.qty} contract${metrics.qty === 1 ? '' : 's'}: risk $${Math.round(metrics.riskMoney).toLocaleString('en-US')}, reward $${Math.round(metrics.rewardMoney).toLocaleString('en-US')}`,
    );
  }
  if (metrics.riskPercent !== null) parts.push(`${metrics.riskPercent.toFixed(2)}% of the account`);
  void pricePrecision;
  return `${parts.join(' · ')}. Planning only - this never places an order.`;
}
