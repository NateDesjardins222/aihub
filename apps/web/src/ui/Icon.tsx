/**
 * Icons.
 *
 * Drawn here as inline SVG paths rather than taken from any product's icon set,
 * and deliberately simple: 14px, 1.4px stroke, no fills, so they read at the
 * control heights this terminal uses. All original geometry.
 */
import type { JSX } from 'react';

export type IconName =
  | 'candles'
  | 'hollow'
  | 'bars'
  | 'line'
  | 'line-markers'
  | 'area'
  | 'baseline'
  | 'heikin'
  | 'search'
  | 'gear'
  | 'more'
  | 'camera'
  | 'target'
  | 'crosshair'
  | 'magnet'
  | 'trash'
  | 'copy'
  | 'lock'
  | 'unlock'
  | 'eye'
  | 'eye-off'
  | 'star'
  | 'cursor'
  | 'trend'
  | 'ray'
  | 'horizontal'
  | 'vertical'
  | 'rect'
  | 'fib'
  | 'text'
  | 'measure'
  | 'chart'
  | 'journal'
  | 'practice'
  | 'ladder'
  | 'close'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'plus'
  | 'minus'
  | 'play'
  | 'pause'
  | 'indicators'
  | 'reset'
  | 'now'
  | 'undo'
  | 'redo'
  | 'layers'
  | 'position-long'
  | 'position-short'
  // Drawing tools not yet wired to real behaviour: their geometry lives here so
  // the family is complete and the gallery can show it, but nothing in the rail
  // arms them until the tool exists.
  | 'extended'
  | 'cross-line'
  | 'parallel-channel'
  | 'regression-trend'
  | 'fib-extension'
  | 'fib-channel'
  | 'forecast'
  | 'rotated-rect'
  | 'path-draw'
  | 'brush'
  | 'highlighter'
  | 'arrow-marker'
  | 'anchored-text'
  | 'note'
  | 'maximize'
  | 'minimize'
  | 'layout-1'
  | 'layout-2v'
  | 'layout-2h'
  | 'layout-3'
  | 'layout-4';

const PATHS: Record<IconName, string> = {
  candles: 'M4 5v6M4 2v1M4 13v1M8 4v8M8 2v2M8 12v2M12 6v4M12 3v3M12 10v3',
  hollow: 'M2.5 5.5h3v5h-3zM6.5 4h3v8h-3zM10.5 6.5h3v4h-3z',
  bars: 'M4 3v10M4 6h2.5M1.5 9H4M9 3v10M9 5h2.5M6.5 11H9',
  line: 'M2 11l3.5-4L8 9l4.5-6',
  'line-markers': 'M2 11l3.5-4L8 9l4.5-6M2 11v.01M5.5 7v.01M8 9v.01M12.5 3v.01',
  area: 'M2 11l3.5-4L8 9l4.5-6v9H2z',
  baseline: 'M1.5 8h13M2 11l3.5-4L8 9l4.5-6',
  heikin: 'M4 4v8M4 2v2M4 12v2M9 6v4M9 3v3M9 10v3M11.5 5h1',
  search: 'M6.8 2.2a4.6 4.6 0 100 9.2 4.6 4.6 0 000-9.2zM10.3 10.3L14 14',
  gear:
    'M8 5.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM8 1.5v1.6M8 12.9v1.6M2.9 2.9l1.2 1.2M11.9 11.9l1.2 1.2M1.5 8h1.6M12.9 8h1.6M2.9 13.1l1.2-1.2M11.9 4.1l1.2-1.2',
  more: 'M3.4 8h.01M8 8h.01M12.6 8h.01',
  camera: 'M2 5.2h2.4l1-1.6h5.2l1 1.6H14v7.3H2zM8 7a2.3 2.3 0 100 4.6A2.3 2.3 0 008 7z',
  target: 'M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M8 6.4A1.6 1.6 0 108 9.6 1.6 1.6 0 008 6.4z',
  crosshair: 'M8 1.5v13M1.5 8h13',
  magnet: 'M4 13V6.5a4 4 0 018 0V13M4 10h3M9 10h3',
  trash: 'M2.8 4.5h10.4M6 4.5V3h4v1.5M4.2 4.5l.7 9.3h6.2l.7-9.3M6.6 7v4M9.4 7v4',
  copy: 'M5.5 5.5h7.5v8.5H5.5zM10.5 5.5V2H3v8.5h2.5',
  lock: 'M4 7.2h8v6.3H4zM5.8 7.2V5a2.2 2.2 0 014.4 0v2.2',
  unlock: 'M4 7.2h8v6.3H4zM5.8 7.2V5a2.2 2.2 0 014.4-.4',
  eye: 'M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z',
  'eye-off': 'M2 2l12 12M6.3 6.4a1.8 1.8 0 002.4 2.5M3.6 4.9C2.2 6.1 1.5 8 1.5 8s2.5 4.2 6.5 4.2c1 0 1.9-.2 2.7-.6M12.8 10.6c1.1-1.1 1.7-2.6 1.7-2.6S12 3.8 8 3.8c-.4 0-.8 0-1.2.1',
  star: 'M8 2.2l1.8 3.7 4 .6-2.9 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1L2.2 6.5l4-.6z',
  cursor: 'M8 1.5v5M8 9.5v5M1.5 8h5M9.5 8h5',
  // A diagonal line whose ends stop at two hollow anchor circles (drawn from
  // ANCHORS). The line is broken so it touches, never crosses, each circle.
  trend: 'M4.4 11.6L11.6 4.4',
  ray: 'M4.4 11.6L6.9 9.1M9.1 6.9L13.5 2.5',
  extended: 'M1.8 12.5L4.3 10.7M6.7 8.9L9.3 7.1M11.7 5.3L14.2 3.5',
  horizontal: 'M2 8H6.5M9.5 8H14',
  vertical: 'M8 2V6.5M8 9.5V14',
  'cross-line': 'M8 2V6.5M8 9.5V14M2 8H6.5M9.5 8H14',
  rect: 'M5.5 4H10.5M12 5.5V10.5M10.5 12H5.5M4 10.5V5.5',
  fib: 'M4.4 3.2H14M2 6.4H14M2 9.6H14M4.4 12.8H14',
  text: 'M3.5 4H12.5M8 4V13M6 13H10M3.5 4V5.2M12.5 4V5.2',
  measure: 'M8 2v12M5.6 4.4L8 2l2.4 2.4M5.6 11.6L8 14l2.4-2.4',
  chart: 'M2 13.5h12M4 11V6M7.3 11V3.5M10.6 11V8',
  journal: 'M3.5 2h9v12h-9zM6 5h4.5M6 7.6h4.5M6 10.2h3',
  practice: 'M8 2.2a5.8 5.8 0 100 11.6 5.8 5.8 0 000-11.6zM6.4 5.6l4.6 2.4-4.6 2.4z',
  ladder: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M8 2.5v11',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  'chevron-down': 'M4 6.2L8 10l4-3.8',
  'chevron-up': 'M4 9.8L8 6l4 3.8',
  undo: 'M3 7.5h6.5a3.2 3.2 0 110 6.4H6M3 7.5l3-3M3 7.5l3 3',
  redo: 'M13 7.5H6.5a3.2 3.2 0 100 6.4H10M13 7.5l-3-3M13 7.5l-3 3',
  layers: 'M8 2L2 5.2 8 8.4l6-3.2L8 2zM2.6 8.4L8 11.3l5.4-2.9M2.6 11.2L8 14.1l5.4-2.9',
  'chevron-right': 'M6.2 4L10 8l-3.8 4',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  play: 'M5 3l7 5-7 5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  indicators: 'M2 12l3-5 2.5 2.5L10 4l4 6M2 2v12h12',
  reset: 'M13 8a5 5 0 11-1.6-3.7M13 2v3h-3',
  now: 'M3 8h7M8 4.5L11.5 8 8 11.5M13 3v10',
  // A reward zone and a risk zone that meet at the entry line, with a hollow
  // handle on that line (from ANCHORS) and an arrow pointing the trade's way.
  'position-long': 'M4 3H13V8H4ZM4 8H13V13H4ZM8 6.5V4M6.6 5.4L8 4L9.4 5.4',
  'position-short': 'M4 3H13V8H4ZM4 8H13V13H4ZM8 9.5V12M6.6 10.6L8 12L9.4 10.6',
  // --- tools not yet built: geometry only, never armed by the rail ----------
  'parallel-channel': 'M3 10.5L12.5 4M3.5 13.5L13 7',
  'regression-trend': 'M3 9L11 3M5 13L13 7M3 9L5 13M11 3L13 7',
  'fib-extension': 'M3.6 3.3L6.9 6.4M6.9 6.4H14M3 9.8H14M3 12.9H14',
  'fib-channel': 'M2.6 11L11.4 4.6M2.6 13.4L11.4 7M2.6 8.6L11.4 2.2',
  forecast: 'M5.5 4V12M5.5 6H7.5M5.5 10H7.5M9 9.5L12.5 5M12.5 5L10.8 5.2M12.5 5L12.3 6.7',
  'rotated-rect': 'M5.4 3.4L12.6 5.2M12.6 5.2L10.6 12.6M10.6 12.6L3.4 10.8M3.4 10.8L5.4 3.4',
  'path-draw': 'M2.8 12L6 8L9 10.5L12.3 4.2M12.3 4.2L10.6 4.5M12.3 4.2L12 5.9',
  brush: 'M3.5 13C6 8.5 5 7 8 6.2M8 6.2C7.4 8 8.7 8.9 10 8.2C11.2 7.6 11 5.6 9.6 5.2',
  highlighter: 'M4 13L9 8M9 8L11.5 10.5M11.5 10.5L6.5 15.5M9 8L11 6L13 8L11 10M3.4 13.6L5.2 15.4',
  'arrow-marker': 'M3.5 12.5L12 4M12 4L8.3 4M12 4L12 7.7',
  'anchored-text': 'M4 4H10M7 4V10.5M5.6 12.2H8.4M7 10.5V13.4',
  note: 'M3.5 3H12.5V11H3.5ZM6 5.5H10M8 5.5V9M8 11V13.5',
  maximize: 'M3 6.5V3h3.5M13 9.5V13H9.5M3 3l4 4M13 13l-4-4',
  minimize: 'M6.5 3v3.5H3M9.5 13V9.5H13M3 6.5l4-4M13 9.5l-4 4',
  // The layout chooser: the same 11x11 frame divided the way each one divides it.
  'layout-1': 'M2.5 2.5h11v11h-11z',
  'layout-2v': 'M2.5 2.5h11v11h-11zM8 2.5v11',
  'layout-2h': 'M2.5 2.5h11v11h-11zM2.5 8h11',
  'layout-3': 'M2.5 2.5h11v11h-11zM2.5 8h11M8 8v5.5',
  'layout-4': 'M2.5 2.5h11v11h-11zM2.5 8h11M8 2.5v11',
};

/**
 * Hollow anchor circles, as [cx, cy, r].
 *
 * The drawing tools carry small circular control points at their anchors - a
 * trend line's two ends, a rectangle's four corners, a fib's two handles. They
 * are drawn as fill-none rings in the same stroke as the path, and the path is
 * broken so it meets each ring rather than running through it. An icon without
 * an entry here is just its path.
 */
const ANCHORS: Partial<Record<IconName, ReadonlyArray<readonly [number, number, number]>>> = {
  trend: [[3.3, 12.7, 1.5], [12.7, 3.3, 1.5]],
  ray: [[3.3, 12.7, 1.5], [8, 8, 1.5]],
  extended: [[5.5, 9.8, 1.5], [10.5, 6.2, 1.5]],
  horizontal: [[8, 8, 1.5]],
  vertical: [[8, 8, 1.5]],
  'cross-line': [[8, 8, 1.5]],
  rect: [[4, 4, 1.5], [12, 4, 1.5], [12, 12, 1.5], [4, 12, 1.5]],
  fib: [[2.8, 3.2, 1.4], [2.8, 12.8, 1.4]],
  'position-long': [[4, 8, 1.5]],
  'position-short': [[4, 8, 1.5]],
  'parallel-channel': [[3, 10.5, 1.4], [12.5, 4, 1.4]],
  'regression-trend': [[3, 9, 1.3], [13, 7, 1.3]],
  'fib-extension': [[3.6, 3.3, 1.3], [6.9, 6.4, 1.3]],
  'fib-channel': [[2.6, 11, 1.3], [11.4, 4.6, 1.3]],
  'rotated-rect': [[5.4, 3.4, 1.3], [12.6, 5.2, 1.3], [10.6, 12.6, 1.3], [3.4, 10.8, 1.3]],
  'path-draw': [[2.8, 12, 1.2], [6, 8, 1.2], [9, 10.5, 1.2]],
  'anchored-text': [[7, 14, 0.9]],
  note: [[8, 14, 0.85]],
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
      {(ANCHORS[name] ?? []).map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none" />
      ))}
    </svg>
  );
}
