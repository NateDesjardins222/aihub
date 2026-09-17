/**
 * The tool catalogue.
 *
 * These tests exist to stop the two failures the registry was built to make
 * impossible: a property editor offering a setting the tool ignores, and two
 * drawings sharing one mutable options object.
 */
import { describe, expect, it } from 'vitest';
import {
  FIB_PRESETS,
  TOOLS,
  fibPreset,
  normalizeLevels,
  option,
  optionsFor,
  styleFor,
  templateFrom,
  toolDef,
  toolsByFamily,
} from './registry';
import { ANCHOR_COUNT, DEFAULT_STYLE, type Drawing, type DrawingKind } from './model';

function drawingOf(kind: DrawingKind, options: Record<string, unknown> = {}): Drawing {
  return {
    id: 'd1',
    kind,
    symbol: 'NQ',
    anchors: [{ time: 0, price: 100 }],
    style: DEFAULT_STYLE,
    options,
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
  };
}

describe('the catalogue', () => {
  it('has an entry for every kind, with the right anchor count', () => {
    for (const kind of Object.keys(ANCHOR_COUNT) as DrawingKind[]) {
      const def = toolDef(kind);
      expect(def, kind).not.toBeNull();
      expect(def!.anchors).toBe(ANCHOR_COUNT[kind]);
    }
  });

  it('declares no property twice for one tool', () => {
    for (const tool of TOOLS) {
      const keys = tool.props.map((prop) => `${prop.on}:${prop.key}`);
      expect(new Set(keys).size, tool.kind).toBe(keys.length);
    }
  });

  /**
   * The editor writes an OPTIONS property straight into `options`, so a tool
   * that offers one without a default would produce a control with nothing in
   * it until the trader touched it.
   */
  it('gives every options property a default', () => {
    for (const tool of TOOLS) {
      for (const prop of tool.props) {
        if (prop.on !== 'OPTIONS') continue;
        expect(tool.options[prop.key], `${tool.kind}.${prop.key}`).not.toBeUndefined();
      }
    }
  });

  it('only declares STYLE properties that exist on a style', () => {
    for (const tool of TOOLS) {
      for (const prop of tool.props) {
        if (prop.on !== 'STYLE') continue;
        expect(Object.keys(DEFAULT_STYLE), `${tool.kind}.${prop.key}`).toContain(prop.key);
      }
    }
  });

  it('puts every tool in exactly one displayed family', () => {
    const grouped = toolsByFamily().flatMap((group) => group.tools.map((tool) => tool.kind));
    expect(new Set(grouped).size).toBe(TOOLS.length);
  });
});

describe('defaults for a new drawing', () => {
  it('lays the tool style over the workspace style', () => {
    const style = styleFor('HORIZONTAL_LINE', { ...DEFAULT_STYLE, color: '#ff0000' });
    expect(style.color).toBe('#ff0000');
    // The tool's own preference wins where it states one.
    expect(style.showPrice).toBe(true);
  });

  it('never hands two drawings the same options object', () => {
    const first = optionsFor('FIB_RETRACEMENT');
    const second = optionsFor('FIB_RETRACEMENT');
    expect(first).toEqual(second);
    expect(first['levels']).not.toBe(second['levels']);
    (first['levels'] as unknown[]).pop();
    expect((second['levels'] as unknown[]).length).toBeGreaterThan(
      (first['levels'] as unknown[]).length,
    );
  });

  it('reads an option the drawing lacks from the tool default', () => {
    const fib = drawingOf('FIB_RETRACEMENT');
    expect(option(fib, 'trendLine', false)).toBe(true);
    expect(option(drawingOf('FIB_RETRACEMENT', { trendLine: false }), 'trendLine', true)).toBe(false);
  });

  it('falls back to the caller value for an option no tool declares', () => {
    expect(option(drawingOf('TREND_LINE'), 'nothingLikeThis', 42)).toBe(42);
  });
});

describe('fib presets', () => {
  it('includes the optimal-trade-entry band', () => {
    const ote = fibPreset('ote');
    expect(ote).not.toBeNull();
    expect(ote!.levels.map((level) => level.value)).toContain(0.705);
    expect(ote!.levels.map((level) => level.value)).toEqual([0, 0.5, 0.62, 0.705, 0.79, 1]);
  });

  it('gives nothing for a preset that does not exist', () => {
    expect(fibPreset('nope')).toBeNull();
  });

  it('keeps every preset sorted and free of duplicates', () => {
    for (const preset of FIB_PRESETS) {
      expect(normalizeLevels(preset.levels), preset.id).toEqual([...preset.levels]);
    }
  });
});

describe('normalizing levels', () => {
  it('sorts, de-duplicates and drops what is not a number', () => {
    const levels = normalizeLevels([
      { value: 1, color: '#fff', visible: true },
      { value: 0, color: '#fff', visible: true },
      { value: Number.NaN, color: '#fff', visible: true },
      { value: 0.5, color: '#aaa', visible: false },
      { value: 0.5, color: '#bbb', visible: true },
    ]);
    expect(levels.map((level) => level.value)).toEqual([0, 0.5, 1]);
    // The later of two equal levels wins, which is what an edit means.
    expect(levels[1]!.color).toBe('#bbb');
  });

  it('rounds away floating-point noise so two edits do not become two levels', () => {
    const levels = normalizeLevels([
      { value: 0.1 + 0.2, color: '#fff', visible: true },
      { value: 0.3, color: '#000', visible: true },
    ]);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.value).toBe(0.3);
  });
});

describe('templates', () => {
  it('captures style and options but never the anchors', () => {
    const fib = drawingOf('FIB_RETRACEMENT', { reverse: true });
    const template = templateFrom(fib, 'My fib', 'tpl-1');
    expect(template).toEqual({
      id: 'tpl-1',
      kind: 'FIB_RETRACEMENT',
      name: 'My fib',
      style: DEFAULT_STYLE,
      options: { reverse: true },
    });
    expect(template).not.toHaveProperty('anchors');
  });

  it('copies the options, so editing the drawing does not edit the template', () => {
    const fib = drawingOf('FIB_RETRACEMENT', { levels: [{ value: 0.5, color: '#fff', visible: true }] });
    const template = templateFrom(fib, 'Half', 'tpl-2');
    (fib.options['levels'] as unknown[]).pop();
    expect((template.options['levels'] as unknown[]).length).toBe(1);
  });
});
