/**
 * Settings controls.
 *
 * A handful of tiny components so every settings row looks and behaves the
 * same: label on the left, control on the right, 24px tall.
 */
import type { JSX, ReactNode } from 'react';
import './Settings.css';

// The colour control lives in its own file; re-exported so every settings
// surface keeps importing `Colour` from one place.
export { Colour } from './ColourPicker';

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="st-row" title={hint}>
      <span className="st-row-label">{label}</span>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="st-group">
      <h4 className="st-group-title">{title}</h4>
      {children}
    </section>
  );
}

export function Check({
  checked,
  onChange,
  label,
  name,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  /**
   * An accessible name for a checkbox with no visible text of its own.
   *
   * A checkbox whose only label is a table cell beside it has no name at all
   * to a screen reader, and nothing for a test to address it by either.
   */
  name?: string;
}): JSX.Element {
  return (
    <label className="st-check">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label ? undefined : name}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Num({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}): JSX.Element {
  return (
    <div className="st-num">
      <input
        className="num"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {suffix ? <span className="st-suffix">{suffix}</span> : null}
    </div>
  );
}

export function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="st-choice">
      {options.map((option) => (
        <button
          key={option.id}
          className={`st-choice-btn ${value === option.id ? 'st-choice-on' : ''}`}
          onClick={() => onChange(option.id)}
          title={option.hint}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}): JSX.Element {
  return (
    <div className="st-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="num st-slider-value">{format ? format(value) : value}</span>
    </div>
  );
}

export function Pick<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as T)} className="st-pick">
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
