import './DrawingRail.css';
import type { JSX } from 'react';

/**
 * Left drawing toolbar.
 *
 * The rail renders the tool taxonomy the drawing engine is being built against
 * (Milestone 4). Tools are shown disabled until the engine behind them exists —
 * a toolbar of buttons that select nothing would be worse than an empty one.
 */
const TOOL_GROUPS: Array<{ group: string; tools: Array<{ id: string; label: string; glyph: string }> }> = [
  {
    group: 'Cursor',
    tools: [
      { id: 'cursor', label: 'Cross cursor', glyph: '✛' },
      { id: 'pointer', label: 'Arrow cursor', glyph: '↖' },
    ],
  },
  {
    group: 'Trend',
    tools: [
      { id: 'trendline', label: 'Trend line', glyph: '╱' },
      { id: 'ray', label: 'Ray', glyph: '↗' },
      { id: 'horizontal-line', label: 'Horizontal line', glyph: '─' },
      { id: 'vertical-line', label: 'Vertical line', glyph: '│' },
      { id: 'parallel-channel', label: 'Parallel channel', glyph: '⫽' },
    ],
  },
  {
    group: 'Fibonacci',
    tools: [
      { id: 'fib-retracement', label: 'Fib retracement', glyph: '≡' },
      { id: 'fib-extension', label: 'Trend-based fib extension', glyph: '⋮' },
      { id: 'gann-box', label: 'Gann box', glyph: '⊞' },
    ],
  },
  {
    group: 'Shapes',
    tools: [
      { id: 'rectangle', label: 'Rectangle', glyph: '▭' },
      { id: 'ellipse', label: 'Ellipse', glyph: '◯' },
      { id: 'triangle', label: 'Triangle', glyph: '△' },
      { id: 'polyline', label: 'Polyline', glyph: '⋀' },
    ],
  },
  {
    group: 'Annotation',
    tools: [
      { id: 'text', label: 'Text', glyph: 'T' },
      { id: 'callout', label: 'Callout', glyph: '💬' },
      { id: 'arrow', label: 'Arrow marker', glyph: '➤' },
      { id: 'flag', label: 'Flag', glyph: '⚑' },
    ],
  },
  {
    group: 'Measure',
    tools: [
      { id: 'price-range', label: 'Price range', glyph: '↕' },
      { id: 'date-range', label: 'Date range', glyph: '↔' },
      { id: 'long-position', label: 'Long position', glyph: '⬆' },
      { id: 'short-position', label: 'Short position', glyph: '⬇' },
    ],
  },
];

export function DrawingRail(): JSX.Element {
  return (
    <nav className="drawing-rail" aria-label="Drawing tools">
      {TOOL_GROUPS.map((group, index) => (
        <div className="rail-group" key={group.group}>
          {index > 0 ? <div className="rail-divider" /> : null}
          {group.tools.map((tool) => (
            <button
              key={tool.id}
              className="rail-tool"
              disabled
              title={`${tool.label} — drawing engine arrives in Milestone 4`}
              aria-label={tool.label}
            >
              <span aria-hidden="true">{tool.glyph}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
