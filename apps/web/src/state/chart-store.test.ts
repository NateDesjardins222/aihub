/**
 * The drawing side of the chart store.
 *
 * Covers what the property editor, the context menu, the object tree and the
 * templates rely on: each edit is one undo step, paint order is array order,
 * templates change appearance and never geometry, and a restored workspace
 * cannot smuggle in a drawing or a template that the tools do not understand.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChartStore } from './chart-store';
import { DEFAULT_STYLE, type Drawing, type DrawingKind } from '../chart/drawings/model';

function make(kind: DrawingKind, id: string, patch: Partial<Drawing> = {}): Drawing {
  return {
    id,
    kind,
    symbol: 'NQ',
    anchors: [
      { time: 0, price: 100 },
      { time: 60_000, price: 110 },
    ].slice(0, kind === 'HORIZONTAL_LINE' ? 1 : 2),
    style: DEFAULT_STYLE,
    options: {},
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
    ...patch,
  };
}

function reset(): void {
  useChartStore.setState({
    drawings: [],
    templates: [],
    toolDefaults: {},
    selectedDrawingId: null,
    propertiesFor: null,
    defaultStyle: DEFAULT_STYLE,
    history: [[]],
    historyIndex: 0,
    tool: 'CURSOR',
    toolSticky: false,
  });
}

beforeEach(reset);

describe('style and option edits', () => {
  it('records exactly one undo step per edit', () => {
    const store = useChartStore.getState();
    store.addDrawing(make('TREND_LINE', 'a'));
    const afterAdd = useChartStore.getState().historyIndex;

    useChartStore.getState().setDrawingStyle('a', { color: '#ff0000' });
    expect(useChartStore.getState().historyIndex).toBe(afterAdd + 1);
    expect(useChartStore.getState().drawings[0]!.style.color).toBe('#ff0000');

    useChartStore.getState().undo();
    expect(useChartStore.getState().drawings[0]!.style.color).toBe(DEFAULT_STYLE.color);
    useChartStore.getState().redo();
    expect(useChartStore.getState().drawings[0]!.style.color).toBe('#ff0000');
  });

  it('merges an option patch rather than replacing the bag', () => {
    useChartStore.getState().addDrawing(make('FIB_RETRACEMENT', 'f', { options: { reverse: true } }));
    useChartStore.getState().setDrawingOptions('f', { showPrices: false });
    expect(useChartStore.getState().drawings[0]!.options).toEqual({
      reverse: true,
      showPrices: false,
    });
  });

  it('ignores an edit to a drawing that is not there', () => {
    useChartStore.getState().setDrawingStyle('ghost', { color: '#fff' });
    expect(useChartStore.getState().drawings).toEqual([]);
  });
});

describe('paint order', () => {
  it('brings a drawing to the end of the array, which is the top of the chart', () => {
    const store = useChartStore.getState();
    store.addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().addDrawing(make('TREND_LINE', 'b'));
    useChartStore.getState().addDrawing(make('TREND_LINE', 'c'));

    useChartStore.getState().reorderDrawing('a', 'FRONT');
    expect(useChartStore.getState().drawings.map((d) => d.id)).toEqual(['b', 'c', 'a']);

    useChartStore.getState().reorderDrawing('c', 'BACK');
    expect(useChartStore.getState().drawings.map((d) => d.id)).toEqual(['c', 'b', 'a']);
  });

  it('is undoable', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().addDrawing(make('TREND_LINE', 'b'));
    useChartStore.getState().reorderDrawing('a', 'FRONT');
    useChartStore.getState().undo();
    expect(useChartStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('templates', () => {
  it('saves what a drawing looks like and applies it to another of the same tool', () => {
    useChartStore.getState().addDrawing(
      make('FIB_RETRACEMENT', 'source', {
        style: { ...DEFAULT_STYLE, color: '#00ff00', width: 3 },
        options: { reverse: true },
      }),
    );
    useChartStore.getState().addDrawing(make('FIB_RETRACEMENT', 'target'));
    useChartStore.getState().saveTemplate('source', 'Green fib');

    const template = useChartStore.getState().templates[0]!;
    expect(template.name).toBe('Green fib');

    const before = useChartStore.getState().drawings.find((d) => d.id === 'target')!.anchors;
    useChartStore.getState().applyTemplate(template.id, 'target');
    const after = useChartStore.getState().drawings.find((d) => d.id === 'target')!;
    expect(after.style.color).toBe('#00ff00');
    expect(after.options).toEqual({ reverse: true });
    // A template is appearance only: it must never move what it is applied to.
    expect(after.anchors).toEqual(before);
  });

  it('refuses to apply a template across tools', () => {
    useChartStore.getState().addDrawing(
      make('FIB_RETRACEMENT', 'fib', { style: { ...DEFAULT_STYLE, color: '#00ff00' } }),
    );
    useChartStore.getState().addDrawing(make('TREND_LINE', 'line'));
    useChartStore.getState().saveTemplate('fib', 'Green fib');
    const template = useChartStore.getState().templates[0]!;

    useChartStore.getState().applyTemplate(template.id, 'line');
    expect(useChartStore.getState().drawings.find((d) => d.id === 'line')!.style.color).toBe(
      DEFAULT_STYLE.color,
    );
  });

  it('will not save a template with a blank name', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().saveTemplate('a', '   ');
    expect(useChartStore.getState().templates).toEqual([]);
  });

  it('removes a template by id', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().saveTemplate('a', 'Mine');
    const id = useChartStore.getState().templates[0]!.id;
    useChartStore.getState().removeTemplate(id);
    expect(useChartStore.getState().templates).toEqual([]);
  });
});

describe('tool defaults', () => {
  it('makes a drawing the starting point for the next one of its kind', () => {
    useChartStore.getState().addDrawing(
      make('TREND_LINE', 'a', { style: { ...DEFAULT_STYLE, color: '#123456', width: 4 } }),
    );
    useChartStore.getState().setToolDefault('a');

    const defaults = useChartStore.getState().newDrawingDefaults('TREND_LINE');
    expect(defaults.style.color).toBe('#123456');
    expect(defaults.style.width).toBe(4);
    // Only that tool: a rectangle still starts from the workspace style.
    expect(useChartStore.getState().newDrawingDefaults('RECTANGLE').style.color).toBe(
      DEFAULT_STYLE.color,
    );
  });

  it('hands out a copy, so a new drawing cannot edit the default', () => {
    useChartStore.getState().addDrawing(make('FIB_RETRACEMENT', 'f', { options: { levels: [] } }));
    useChartStore.getState().setToolDefault('f');
    const first = useChartStore.getState().newDrawingDefaults('FIB_RETRACEMENT');
    (first.options['levels'] as unknown[]).push({ value: 9 });
    const second = useChartStore.getState().newDrawingDefaults('FIB_RETRACEMENT');
    expect(second.options['levels']).toEqual([]);
  });

  it('goes back to the tool defaults when reset', () => {
    useChartStore.getState().addDrawing(
      make('TREND_LINE', 'a', { style: { ...DEFAULT_STYLE, color: '#123456' } }),
    );
    useChartStore.getState().setToolDefault('a');
    useChartStore.getState().resetToolDefault('TREND_LINE');
    expect(useChartStore.getState().newDrawingDefaults('TREND_LINE').style.color).toBe(
      DEFAULT_STYLE.color,
    );
  });
});

describe('the settings dialog target', () => {
  it('closes when its drawing is deleted', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().openProperties('a');
    expect(useChartStore.getState().propertiesFor).toBe('a');
    useChartStore.getState().removeDrawing('a');
    expect(useChartStore.getState().propertiesFor).toBeNull();
  });

  it('closes when every drawing on the instrument is cleared', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().openProperties('a');
    useChartStore.getState().clearDrawings('NQ');
    expect(useChartStore.getState().propertiesFor).toBeNull();
  });

  it('closes when an undo takes the drawing away', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().openProperties('a');
    useChartStore.getState().undo();
    expect(useChartStore.getState().propertiesFor).toBeNull();
  });
});

describe('restoring a workspace', () => {
  it('keeps templates and tool defaults that make sense', () => {
    useChartStore.getState().restore({
      templates: [
        { id: 't1', kind: 'TREND_LINE', name: 'Mine', style: { color: '#abcdef' }, options: {} },
        { id: 't2', kind: 'NOT_A_TOOL', name: 'Junk', style: {}, options: {} },
        { id: 't3', kind: 'TREND_LINE', name: '', style: {}, options: {} },
      ],
      toolDefaults: {
        TREND_LINE: { style: { width: 3 }, options: {} },
        NOT_A_TOOL: { style: { width: 9 }, options: {} },
      },
    } as never);

    const state = useChartStore.getState();
    expect(state.templates.map((template) => template.id)).toEqual(['t1']);
    expect(state.templates[0]!.style.color).toBe('#abcdef');
    expect(Object.keys(state.toolDefaults)).toEqual(['TREND_LINE']);
    expect(state.newDrawingDefaults('TREND_LINE').style.width).toBe(3);
  });

  it('drops options that are not an object', () => {
    useChartStore.getState().restore({
      drawings: [
        {
          id: 'd',
          kind: 'TREND_LINE',
          symbol: 'NQ',
          anchors: [
            { time: 0, price: 1 },
            { time: 1, price: 2 },
          ],
          options: 'nonsense',
          timeframes: 'nonsense',
        },
      ],
    } as never);
    const drawing = useChartStore.getState().drawings[0]!;
    expect(drawing.options).toEqual({});
    expect(drawing.timeframes).toEqual([]);
  });

  it('round-trips through a snapshot', () => {
    useChartStore.getState().addDrawing(make('TREND_LINE', 'a'));
    useChartStore.getState().saveTemplate('a', 'Mine');
    useChartStore.getState().setToolDefault('a');
    const snapshot = useChartStore.getState().snapshot();

    reset();
    expect(useChartStore.getState().templates).toEqual([]);

    useChartStore.getState().restore(snapshot);
    expect(useChartStore.getState().templates.map((t) => t.name)).toEqual(['Mine']);
    expect(Object.keys(useChartStore.getState().toolDefaults)).toEqual(['TREND_LINE']);
    expect(useChartStore.getState().drawings.map((d) => d.id)).toEqual(['a']);
  });
});
