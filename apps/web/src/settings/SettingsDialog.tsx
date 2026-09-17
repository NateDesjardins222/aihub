/**
 * Settings.
 *
 * Everything that used to compete with the chart lives here: chart appearance
 * in the four sections of the reference (Symbol, Status line, Scales and lines,
 * Canvas), plus trading defaults, the simulation environment, the programme
 * rules and what a practice mode hides.
 *
 * All of it persists through the existing preferences blob, so a reload comes
 * back to the same chart.
 */
import { useState, type JSX } from 'react';
import { useWorkspace, type SettingsTab } from '../state/workspace';
import { useExecution } from '../state/execution';
import { useChartStore } from '../state/chart-store';
import { DEFAULT_APPEARANCE } from '../chart/appearance';
import { indicatorDef } from '../chart/indicators/registry';
import { RiskPanel } from '../panels/RiskPanel';
import { EnvironmentPanel } from '../panels/EnvironmentPanel';
import { TrainingSettings } from '../panels/TrainingSettings';
import { Check, Choice, Colour, Group, Num, Pick, Row, Slider } from './Controls';
import { Icon } from '../ui/Icon';
import './Settings.css';

const TABS: ReadonlyArray<{ id: SettingsTab; label: string; group: string }> = [
  { id: 'SYMBOL', label: 'Symbol', group: 'Chart' },
  { id: 'STATUS_LINE', label: 'Status line', group: 'Chart' },
  { id: 'SCALES', label: 'Scales and lines', group: 'Chart' },
  { id: 'CANVAS', label: 'Canvas', group: 'Chart' },
  { id: 'TRADING', label: 'Time and format', group: 'Terminal' },
  { id: 'EXECUTION', label: 'Execution defaults', group: 'Terminal' },
  { id: 'SIMULATION', label: 'Simulation', group: 'Terminal' },
  { id: 'RISK', label: 'Risk and programme', group: 'Terminal' },
  { id: 'PRACTICE_VISIBILITY', label: 'Practice visibility', group: 'Terminal' },
];

const ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'EXCHANGE', label: 'Exchange time' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'America/Chicago', label: 'Chicago' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'UTC', label: 'UTC' },
];

export function SettingsDialog(): JSX.Element | null {
  const tab = useWorkspace((s) => s.settingsTab);
  const openSettings = useWorkspace((s) => s.openSettings);
  const close = useWorkspace((s) => s.closeSettings);
  const appearance = useChartStore((s) => s.appearance);
  const set = useChartStore((s) => s.setAppearance);
  const reset = useChartStore((s) => s.resetAppearance);
  const indicators = useChartStore((s) => s.indicators);
  const updateIndicator = useChartStore((s) => s.updateIndicator);
  const removeIndicator = useChartStore((s) => s.removeIndicator);
  const [confirmReset, setConfirmReset] = useState(false);
  const execution = useExecution((s) => s.defaults);
  const setExecution = useExecution((s) => s.set);

  if (!tab) return null;

  const groups = [...new Set(TABS.map((entry) => entry.group))];

  return (
    <div className="st-scrim" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="st-dialog">
        <header className="st-head">
          <h3>Settings</h3>
          <div className="hdr-spacer" />
          <button className="st-close" onClick={close} aria-label="Close settings">
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="st-body">
          <nav className="st-nav">
            {groups.map((group) => (
              <div key={group}>
                <div className="st-nav-group">{group}</div>
                {TABS.filter((entry) => entry.group === group).map((entry) => (
                  <button
                    key={entry.id}
                    className={`st-nav-item ${tab === entry.id ? 'st-nav-on' : ''}`}
                    onClick={() => openSettings(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="st-content">
            {tab === 'SYMBOL' ? (
              <>
                <Group title="Candles">
                  <Row label="Bodies">
                    <Check
                      checked={appearance.symbol.bodyVisible}
                      onChange={(bodyVisible) => set({ symbol: { bodyVisible } })}
                    />
                  </Row>
                  <Row label="Up colour">
                    <Colour
                      value={appearance.symbol.upColor}
                      onChange={(upColor) => set({ symbol: { upColor } })}
                    />
                  </Row>
                  <Row label="Down colour">
                    <Colour
                      value={appearance.symbol.downColor}
                      onChange={(downColor) => set({ symbol: { downColor } })}
                    />
                  </Row>
                </Group>

                <Group title="Borders">
                  <Row label="Borders">
                    <Check
                      checked={appearance.symbol.borderVisible}
                      onChange={(borderVisible) => set({ symbol: { borderVisible } })}
                    />
                  </Row>
                  <Row label="Up border">
                    <Colour
                      value={appearance.symbol.borderUpColor}
                      onChange={(borderUpColor) => set({ symbol: { borderUpColor } })}
                    />
                  </Row>
                  <Row label="Down border">
                    <Colour
                      value={appearance.symbol.borderDownColor}
                      onChange={(borderDownColor) => set({ symbol: { borderDownColor } })}
                    />
                  </Row>
                </Group>

                <Group title="Wicks">
                  <Row label="Wicks">
                    <Check
                      checked={appearance.symbol.wickVisible}
                      onChange={(wickVisible) => set({ symbol: { wickVisible } })}
                    />
                  </Row>
                  <Row label="Up wick">
                    <Colour
                      value={appearance.symbol.wickUpColor}
                      onChange={(wickUpColor) => set({ symbol: { wickUpColor } })}
                    />
                  </Row>
                  <Row label="Down wick">
                    <Colour
                      value={appearance.symbol.wickDownColor}
                      onChange={(wickDownColor) => set({ symbol: { wickDownColor } })}
                    />
                  </Row>
                </Group>

                <Group title="Line and area styles">
                  <Row label="Line colour">
                    <Colour
                      value={appearance.symbol.lineColor}
                      onChange={(lineColor) => set({ symbol: { lineColor } })}
                    />
                  </Row>
                  <Row label="Line width">
                    <Num
                      value={appearance.symbol.lineWidth}
                      min={1}
                      max={6}
                      onChange={(lineWidth) => set({ symbol: { lineWidth } })}
                      suffix="px"
                    />
                  </Row>
                  <Row label="Area top">
                    <Colour
                      value={appearance.symbol.areaTopColor}
                      onChange={(areaTopColor) => set({ symbol: { areaTopColor } })}
                    />
                  </Row>
                  <Row label="Area bottom">
                    <Colour
                      value={appearance.symbol.areaBottomColor}
                      onChange={(areaBottomColor) => set({ symbol: { areaBottomColor } })}
                    />
                  </Row>
                </Group>

                <Group title="Volume">
                  <Row label="Show volume">
                    <Check
                      checked={appearance.symbol.volumeVisible}
                      onChange={(volumeVisible) => set({ symbol: { volumeVisible } })}
                    />
                  </Row>
                  <Row label="Up bars">
                    <Colour
                      value={appearance.symbol.volumeUpColor}
                      onChange={(volumeUpColor) => set({ symbol: { volumeUpColor } })}
                    />
                  </Row>
                  <Row label="Down bars">
                    <Colour
                      value={appearance.symbol.volumeDownColor}
                      onChange={(volumeDownColor) => set({ symbol: { volumeDownColor } })}
                    />
                  </Row>
                  <Row label="Last price line">
                    <Check
                      checked={appearance.symbol.lastPriceLineVisible}
                      onChange={(lastPriceLineVisible) => set({ symbol: { lastPriceLineVisible } })}
                    />
                  </Row>
                </Group>

                {indicators.length > 0 ? (
                  <Group title="Indicators on this chart">
                    {indicators.map((instance) => {
                      const def = indicatorDef(instance.kind);
                      if (!def) return null;
                      return (
                        <div className="st-ind" key={instance.id}>
                          <div className="st-ind-head">
                            <b>{def.name}</b>
                            <button
                              className="st-ind-remove"
                              onClick={() => removeIndicator(instance.id)}
                              title="Remove"
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                          {def.params.map((param) => (
                            <Row key={param.key} label={param.label}>
                              {param.type === 'NUMBER' ? (
                                <Num
                                  value={Number(instance.params[param.key] ?? def.defaults[param.key] ?? 0)}
                                  min={param.min}
                                  max={param.max}
                                  step={param.step}
                                  onChange={(value) => updateIndicator(instance.id, { [param.key]: value })}
                                />
                              ) : param.type === 'COLOR' ? (
                                <Colour
                                  value={String(instance.params[param.key] ?? '#4d8dff')}
                                  onChange={(value) => updateIndicator(instance.id, { [param.key]: value })}
                                />
                              ) : (
                                <Pick
                                  value={String(instance.params[param.key] ?? 'close')}
                                  options={[
                                    { id: 'close', label: 'Close' },
                                    { id: 'open', label: 'Open' },
                                    { id: 'high', label: 'High' },
                                    { id: 'low', label: 'Low' },
                                    { id: 'hl2', label: '(H+L)/2' },
                                    { id: 'hlc3', label: '(H+L+C)/3' },
                                    { id: 'ohlc4', label: '(O+H+L+C)/4' },
                                  ]}
                                  onChange={(value) => updateIndicator(instance.id, { [param.key]: value })}
                                />
                              )}
                            </Row>
                          ))}
                        </div>
                      );
                    })}
                  </Group>
                ) : null}
              </>
            ) : null}

            {tab === 'STATUS_LINE' ? (
              <Group title="What the status line shows">
                <Row label="Symbol and interval">
                  <Check
                    checked={appearance.statusLine.symbolVisible}
                    onChange={(symbolVisible) => set({ statusLine: { symbolVisible } })}
                  />
                </Row>
                <Row label="Open, high, low, close">
                  <Check
                    checked={appearance.statusLine.ohlcVisible}
                    onChange={(ohlcVisible) => set({ statusLine: { ohlcVisible } })}
                  />
                </Row>
                <Row label="Change on the day">
                  <Check
                    checked={appearance.statusLine.changeVisible}
                    onChange={(changeVisible) => set({ statusLine: { changeVisible } })}
                  />
                </Row>
                <Row label="Volume">
                  <Check
                    checked={appearance.statusLine.volumeVisible}
                    onChange={(volumeVisible) => set({ statusLine: { volumeVisible } })}
                  />
                </Row>
                <Row label="Bar close countdown">
                  <Check
                    checked={appearance.statusLine.barCloseCountdownVisible}
                    onChange={(barCloseCountdownVisible) =>
                      set({ statusLine: { barCloseCountdownVisible } })
                    }
                  />
                </Row>
                <Row label="Indicator values">
                  <Check
                    checked={appearance.statusLine.indicatorTitlesVisible}
                    onChange={(indicatorTitlesVisible) =>
                      set({ statusLine: { indicatorTitlesVisible } })
                    }
                  />
                </Row>
                <Row label="Bars loaded" hint="Diagnostic: how much history the chart holds">
                  <Check
                    checked={appearance.statusLine.barCountVisible}
                    onChange={(barCountVisible) => set({ statusLine: { barCountVisible } })}
                  />
                </Row>
                <Row label="Last update time">
                  <Check
                    checked={appearance.statusLine.updatedAtVisible}
                    onChange={(updatedAtVisible) => set({ statusLine: { updatedAtVisible } })}
                  />
                </Row>
              </Group>
            ) : null}

            {tab === 'SCALES' ? (
              <>
                <Group title="Price scale">
                  <Row label="Visible">
                    <Check
                      checked={appearance.scales.priceScaleVisible}
                      onChange={(priceScaleVisible) => set({ scales: { priceScaleVisible } })}
                    />
                  </Row>
                  <Row label="Side">
                    <Choice
                      value={appearance.scales.priceScaleSide}
                      options={[
                        { id: 'RIGHT', label: 'Right' },
                        { id: 'LEFT', label: 'Left' },
                      ]}
                      onChange={(priceScaleSide) => set({ scales: { priceScaleSide } })}
                    />
                  </Row>
                  <Row label="Logarithmic">
                    <Check
                      checked={appearance.scales.logScale}
                      onChange={(logScale) => set({ scales: { logScale, percentScale: false } })}
                    />
                  </Row>
                  <Row label="Percent">
                    <Check
                      checked={appearance.scales.percentScale}
                      onChange={(percentScale) => set({ scales: { percentScale, logScale: false } })}
                    />
                  </Row>
                  <Row label="Top margin">
                    <Slider
                      value={appearance.scales.scaleMarginTop}
                      min={0}
                      max={0.4}
                      step={0.01}
                      onChange={(scaleMarginTop) => set({ scales: { scaleMarginTop } })}
                      format={(value) => `${Math.round(value * 100)}%`}
                    />
                  </Row>
                  <Row label="Bottom margin">
                    <Slider
                      value={appearance.scales.scaleMarginBottom}
                      min={0}
                      max={0.6}
                      step={0.01}
                      onChange={(scaleMarginBottom) => set({ scales: { scaleMarginBottom } })}
                      format={(value) => `${Math.round(value * 100)}%`}
                    />
                  </Row>
                </Group>

                <Group title="Time scale">
                  <Row label="Visible">
                    <Check
                      checked={appearance.scales.timeScaleVisible}
                      onChange={(timeScaleVisible) => set({ scales: { timeScaleVisible } })}
                    />
                  </Row>
                  <Row label="Session breaks" hint="Gaps where the market was shut">
                    <Check
                      checked={appearance.scales.sessionBreaksVisible}
                      onChange={(sessionBreaksVisible) => set({ scales: { sessionBreaksVisible } })}
                    />
                  </Row>
                </Group>

                <Group title="Scale text and lines">
                  <Row label="Text colour">
                    <Colour
                      value={appearance.scales.scaleTextColor}
                      onChange={(scaleTextColor) => set({ scales: { scaleTextColor } })}
                    />
                  </Row>
                  <Row label="Line colour">
                    <Colour
                      value={appearance.scales.scaleLineColor}
                      onChange={(scaleLineColor) => set({ scales: { scaleLineColor } })}
                    />
                  </Row>
                  <Row label="Font size">
                    <Num
                      value={appearance.scales.scaleFontSize}
                      min={8}
                      max={18}
                      onChange={(scaleFontSize) => set({ scales: { scaleFontSize } })}
                      suffix="px"
                    />
                  </Row>
                </Group>

                <Group title="Grid">
                  <Row label="Vertical lines">
                    <Check
                      checked={appearance.scales.gridVerticalVisible}
                      onChange={(gridVerticalVisible) => set({ scales: { gridVerticalVisible } })}
                    />
                  </Row>
                  <Row label="Horizontal lines">
                    <Check
                      checked={appearance.scales.gridHorizontalVisible}
                      onChange={(gridHorizontalVisible) => set({ scales: { gridHorizontalVisible } })}
                    />
                  </Row>
                  <Row label="Grid colour">
                    <Colour
                      value={appearance.scales.gridColor}
                      onChange={(gridColor) => set({ scales: { gridColor } })}
                    />
                  </Row>
                  <Row label="Pane separator">
                    <Colour
                      value={appearance.scales.paneSeparatorColor}
                      onChange={(paneSeparatorColor) => set({ scales: { paneSeparatorColor } })}
                    />
                  </Row>
                </Group>

                <Group title="Crosshair">
                  <Row label="Style">
                    <Choice
                      value={appearance.scales.crosshairStyle}
                      options={[
                        { id: 'CROSS', label: 'Cross' },
                        { id: 'MAGNET', label: 'Magnet', hint: 'Snaps to the nearest bar' },
                        { id: 'HIDDEN', label: 'Hidden' },
                      ]}
                      onChange={(crosshairStyle) => set({ scales: { crosshairStyle } })}
                    />
                  </Row>
                  <Row label="Colour">
                    <Colour
                      value={appearance.scales.crosshairColor}
                      onChange={(crosshairColor) => set({ scales: { crosshairColor } })}
                    />
                  </Row>
                  <Row label="Label background">
                    <Colour
                      value={appearance.scales.crosshairLabelBackground}
                      onChange={(crosshairLabelBackground) =>
                        set({ scales: { crosshairLabelBackground } })
                      }
                    />
                  </Row>
                </Group>
              </>
            ) : null}

            {tab === 'CANVAS' ? (
              <Group title="Canvas">
                <Row label="Background">
                  <Colour
                    value={appearance.canvas.background}
                    onChange={(background) => set({ canvas: { background } })}
                  />
                </Row>
                <Row label="Gradient to" hint="Set a second colour for a vertical gradient">
                  <Colour
                    value={appearance.canvas.backgroundGradientTo ?? appearance.canvas.background}
                    onChange={(backgroundGradientTo) => set({ canvas: { backgroundGradientTo } })}
                  />
                </Row>
                <Row label="Use a gradient">
                  <Check
                    checked={appearance.canvas.backgroundGradientTo !== null}
                    onChange={(on) =>
                      set({ canvas: { backgroundGradientTo: on ? appearance.canvas.background : null } })
                    }
                  />
                </Row>
                <Row label="Text colour">
                  <Colour
                    value={appearance.canvas.textColor}
                    onChange={(textColor) => set({ canvas: { textColor } })}
                  />
                </Row>
                <Row label="Font size">
                  <Num
                    value={appearance.canvas.fontSize}
                    min={8}
                    max={18}
                    onChange={(fontSize) => set({ canvas: { fontSize } })}
                    suffix="px"
                  />
                </Row>
                <div className="st-actions">
                  {confirmReset ? (
                    <>
                      <span className="st-warn">Reset every chart appearance setting?</span>
                      <button
                        className="st-danger"
                        onClick={() => {
                          reset();
                          setConfirmReset(false);
                        }}
                      >
                        Reset
                      </button>
                      <button onClick={() => setConfirmReset(false)}>Keep mine</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmReset(true)}>Reset to defaults</button>
                  )}
                </div>
              </Group>
            ) : null}

            {tab === 'TRADING' ? (
              <Group title="Time">
                <Row label="Clock" hint="Applies to the axis, the status line and the header">
                  <Choice
                    value={appearance.timeFormat}
                    options={[
                      { id: '12H', label: '12-hour' },
                      { id: '24H', label: '24-hour' },
                    ]}
                    onChange={(timeFormat) => set({ timeFormat })}
                  />
                </Row>
                <Row label="Time zone">
                  <Pick
                    value={appearance.timeZone}
                    options={ZONES}
                    onChange={(timeZone) => set({ timeZone })}
                  />
                </Row>
                <p className="st-note">
                  Exchange time follows the instrument, which is what the session boundaries and the
                  trading date are measured in. Changing the displayed zone changes labels only -
                  never a bar, a fill or a trading date.
                </p>
                <Row label="Defaults" hint="What a fresh chart starts from">
                  <span className="st-note-inline">
                    {appearance.timeFormat === DEFAULT_APPEARANCE.timeFormat ? 'unchanged' : 'edited'}
                  </span>
                </Row>
              </Group>
            ) : null}

            {tab === 'EXECUTION' ? (
              <>
                <Group title="Order defaults">
                  <Row label="Time in force" hint="What a new order uses unless it is changed">
                    <Choice
                      value={execution.tif}
                      options={[
                        { id: 'DAY', label: 'Day' },
                        { id: 'GTC', label: 'GTC' },
                      ]}
                      onChange={(tif) => setExecution({ tif })}
                    />
                  </Row>
                </Group>

                <Group title="Position bracket">
                  <Row
                    label="On a fill"
                    hint="Off is the default: protection is created by dragging it off the position marker"
                  >
                    <Choice
                      value={execution.bracketMode}
                      options={[
                        { id: 'OFF', label: 'Nothing' },
                        { id: 'AUTO', label: 'Attach a stop and target' },
                      ]}
                      onChange={(bracketMode) => setExecution({ bracketMode })}
                    />
                  </Row>
                  <Row label="Stop distance">
                    <Num
                      value={execution.stopTicks}
                      min={0}
                      max={100000}
                      onChange={(stopTicks) => setExecution({ stopTicks })}
                      suffix="ticks"
                    />
                  </Row>
                  <Row label="Target distance">
                    <Num
                      value={execution.targetTicks}
                      min={0}
                      max={100000}
                      onChange={(targetTicks) => setExecution({ targetTicks })}
                      suffix="ticks"
                    />
                  </Row>
                  <p className="st-note">
                    These distances are also where a level first lands when it is dragged off the
                    position marker. Whatever creates them, they are real working orders in an OCO
                    pair, sized to the position and matched by the same engine as everything else.
                  </p>
                </Group>
              </>
            ) : null}

            {tab === 'SIMULATION' ? <EnvironmentPanel /> : null}
            {tab === 'RISK' ? <RiskPanel /> : null}
            {tab === 'PRACTICE_VISIBILITY' ? <TrainingSettings /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
