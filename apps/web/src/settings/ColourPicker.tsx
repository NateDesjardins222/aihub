/**
 * Picking a colour without the operating system's dialog.
 *
 * The native `<input type="color">` was the main experience and is the wrong
 * one for a terminal: it looks like a different application, it cannot express
 * the rgba() values half these settings hold, and on most platforms it opens a
 * modal window over the chart the trader is trying to see the colour against.
 *
 * So the swatch opens a small popover instead: a palette that covers what
 * charts are actually coloured with, an opacity slider (which is what makes a
 * fill a fill), the hex to type into when the exact value matters, and the
 * colours this trader used last. The native picker is still reachable, as one
 * button among the swatches, for the one case the palette cannot serve - an
 * arbitrary hue - and never as the front door.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import './Settings.css';

/**
 * A palette, not a spectrum.
 *
 * Five rows: greys for structure, then the six hues a chart uses, each at
 * three weights. Every one of them is legible on both a dark and a light
 * canvas, which is the property a random spectrum pick does not have.
 */
const PALETTE: readonly string[] = [
  '#ffffff', '#c7cedb', '#9aa6bd', '#67758f', '#3a4459', '#1a2231', '#0b0e14', '#000000',
  '#8ab4ff', '#5b9dff', '#4d8dff', '#2f6fd0', '#2a5199', '#1d3a70', '#0f2247', '#071530',
  '#7ef0d0', '#3ef0bd', '#29d3a5', '#2ec4a6', '#11845e', '#0f6b4d', '#0a4a36', '#052f22',
  '#ffb3b3', '#ff7a7a', '#ff5a5a', '#f2544b', '#d93a31', '#b23a33', '#7d2822', '#4d1a16',
  '#ffe08a', '#ffc95c', '#f7b23b', '#e0a030', '#c98a1e', '#8a5f14', '#f0a5d8', '#b184f5',
];

/** rgba() when it has to be, #rrggbb when it can be. */
function compose(hex: string, opacity: number): string {
  if (opacity >= 100) return hex;
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${(opacity / 100).toFixed(2)})`;
}

/** Split a stored value back into a hex and an opacity for the controls. */
function decompose(value: string): { hex: string; opacity: number } {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return { hex: trimmed.toLowerCase(), opacity: 100 };
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [r, g, b] = [trimmed[1]!, trimmed[2]!, trimmed[3]!];
    return { hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase(), opacity: 100 };
  }
  const rgba = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i.exec(trimmed);
  if (rgba) {
    const part = (n: string): string => Number(n).toString(16).padStart(2, '0');
    return {
      hex: `#${part(rgba[1]!)}${part(rgba[2]!)}${part(rgba[3]!)}`,
      opacity: rgba[4] === undefined ? 100 : Math.round(Number(rgba[4]) * 100),
    };
  }
  return { hex: '#000000', opacity: 100 };
}

/**
 * The colours this trader reached for, most recent first.
 *
 * Module state rather than a store: it is a convenience within a session, not
 * part of the workspace, and it must never be something that fails to save.
 */
const recent: string[] = [];
function remember(value: string): void {
  const at = recent.indexOf(value);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(value);
  recent.length = Math.min(recent.length, 8);
}

export function Colour({
  value,
  onChange,
  label = 'Colour',
  /**
   * Some callers keep the opacity in a field of their own - a drawing's fill,
   * a Fibonacci level - and for those the picker must hand back a plain hex
   * and leave the alpha alone rather than folding it into an rgba().
   */
  alpha = true,
  /** The hex field beside the swatch, which a dense row has no space for. */
  text = true,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  alpha?: boolean;
  text?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const { hex, opacity } = decompose(value);
  const [typed, setTyped] = useState(value);

  useEffect(() => setTyped(value), [value]);

  /*
   * Positioned against the viewport, in a portal.
   *
   * These controls live inside dialogs and popovers that clip and scroll, and
   * a picker that opens inside one of those is a picker with half of itself
   * cut off. It is placed below the swatch, or above it when there is no room.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const width = 236;
    const height = 268;
    const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
    const below = box.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : below;
    setAt({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popover.current?.contains(target) || anchor.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The settings dialog closes on Escape too; the picker is in front, so
      // it takes the key and the dialog stays open.
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const commit = (next: string): void => {
    remember(next);
    onChange(next);
  };

  /** What a palette click sends: with the opacity folded in, or without. */
  const pick = (colour: string): void => commit(alpha ? compose(colour, opacity) : colour);

  return (
    <div className="cp">
      <button
        ref={anchor}
        type="button"
        className="cp-swatch"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        data-testid="colour-swatch"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="cp-swatch-ink" style={{ background: value }} />
      </button>
      {text ? (
        <input
          className="num cp-text"
          value={typed}
          aria-label={`${label} value`}
          disabled={disabled}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => commit(typed)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(typed);
          }}
        />
      ) : null}

      {open && at
        ? createPortal(
            <div
              ref={popover}
              className="cp-pop"
              style={{ left: at.left, top: at.top }}
              data-testid="colour-popover"
            >
              <div className="cp-grid">
                {PALETTE.map((colour) => (
                  <button
                    key={colour}
                    type="button"
                    className={`cp-cell ${hex === colour ? 'cp-cell-on' : ''}`}
                    style={{ background: colour }}
                    aria-label={colour}
                    onClick={() => pick(colour)}
                  />
                ))}
              </div>

              {alpha ? (
              <label className="cp-opacity">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={opacity}
                  aria-label="Opacity"
                  onChange={(event) => commit(compose(hex, Number(event.target.value)))}
                />
                <span className="num cp-opacity-value">{opacity}%</span>
              </label>
              ) : null}

              {recent.length > 0 ? (
                <div className="cp-recent">
                  <span className="cp-recent-label">Recent</span>
                  <div className="cp-recent-row">
                    {recent.map((colour) => (
                      <button
                        key={colour}
                        type="button"
                        className="cp-cell cp-cell-sm"
                        style={{ background: colour }}
                        aria-label={colour}
                        onClick={() => commit(colour)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="cp-foot">
                <label className="cp-custom" title="Any colour at all">
                  <input
                    type="color"
                    value={hex}
                    aria-label="Custom colour"
                    onChange={(event) => pick(event.target.value)}
                  />
                  <span>Custom</span>
                </label>
                <span className="num cp-value">{value}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
