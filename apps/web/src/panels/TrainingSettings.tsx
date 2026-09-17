/**
 * Practice visibility.
 *
 * A training mode decides what the trader SEES and nothing else. Every figure
 * it hides is still computed by the server, still enforced by the rule engine
 * and still recorded in the journal - a mode that hides the money records every
 * cent of it. That is the whole reason it is safe to sit in Settings rather
 * than beside the order ticket.
 */
import type { JSX } from 'react';
import { TRAINING_MODES, useTraining, type TrainingModeId, type Visibility } from '../state/training';
import { Check, Group, Row } from '../settings/Controls';
import './EnvironmentPanel.css';

const TOGGLES: ReadonlyArray<{ key: keyof Visibility; label: string; hint: string }> = [
  { key: 'pnl', label: 'Profit and loss', hint: 'Open and closed results, on the chart and in the header' },
  { key: 'balance', label: 'Balance and equity', hint: 'Account money in the header and the ticket' },
  { key: 'tradeResults', label: 'Trade results', hint: 'Per-trade outcomes in the activity panel' },
  { key: 'dateTime', label: 'Date and clock', hint: 'The calendar on the axis and the header clock' },
  { key: 'rules', label: 'Rule progress', hint: 'Drawdown left, daily loss left, target progress' },
  { key: 'journal', label: 'Journal', hint: 'The journal drawer and its analytics' },
  { key: 'execution', label: 'Execution detail', hint: 'Fill prices, slippage and liquidity' },
];

export function TrainingSettings(): JSX.Element {
  const modeId = useTraining((s) => s.modeId);
  const setMode = useTraining((s) => s.setMode);
  const visibility = useTraining((s) => s.visibility);
  const setVisibility = useTraining((s) => s.setVisibility);
  const active = TRAINING_MODES.find((mode) => mode.id === modeId);

  return (
    <>
      <Group title="Practice mode">
        <div className="env-row env-presets">
          {TRAINING_MODES.map((mode) => (
            <button
              key={mode.id}
              className={`chip ${modeId === mode.id ? 'chip-on' : ''}`}
              title={mode.description}
              onClick={() => setMode(mode.id as TrainingModeId)}
            >
              {mode.name}
            </button>
          ))}
        </div>
        {active ? <p className="env-note">{active.description}</p> : null}
      </Group>

      <Group title="What is shown">
        {TOGGLES.map((toggle) => (
          <Row key={toggle.key} label={toggle.label} hint={toggle.hint}>
            <Check
              checked={visibility[toggle.key]}
              onChange={(value) => setVisibility({ [toggle.key]: value })}
            />
          </Row>
        ))}
        <p className="env-note">
          Hiding a figure changes the label, never the number. Fills, rules, drawdown, the
          journal and everything recorded behave identically in every mode, which is what makes
          a blind session comparable with a normal one.
        </p>
      </Group>
    </>
  );
}
