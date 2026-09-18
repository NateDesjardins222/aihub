/**
 * The shaded area between two indicator lines.
 *
 * Bollinger bands are two lines and the space between them, and the space is
 * not decoration: it is how a trader sees the volatility widen. The renderer
 * has no "band" series, so this is a pane primitive that fills between two
 * series it is given.
 *
 * It draws and nothing else. It holds no data of its own, reads the two
 * series' own coordinate converters every frame, and cannot influence a bar, a
 * price or a value in the legend. If either series has no coordinate for a
 * point - scrolled off, or not computed yet - that point is skipped and the
 * band simply starts where both lines exist.
 */

/**
 * The drawing target, described by what is used rather than imported.
 *
 * `fancy-canvas` is the renderer's own dependency, not ours, and taking a type
 * from it would make an undeclared package part of our build. This is the
 * whole surface this file touches.
 */
interface BitmapTarget {
  useBitmapCoordinateSpace(
    handler: (scope: {
      readonly context: CanvasRenderingContext2D;
      readonly horizontalPixelRatio: number;
      readonly verticalPixelRatio: number;
    }) => void,
  ): void;
}

export interface BandPoint {
  readonly time: number;
  readonly upper: number;
  readonly lower: number;
}

/** Everything the fill needs, read fresh on every frame. */
export interface BandFillHost {
  /** The x coordinate for a time, or null when it is off screen. */
  xAt(timeMs: number): number | null;
  /** The y coordinate for a price on the upper line's scale. */
  yAt(price: number): number | null;
  points(): readonly BandPoint[];
  /** CSS colour, already carrying its alpha. */
  colour(): string;
  visible(): boolean;
}

export class BandFill {
  constructor(private readonly host: BandFillHost) {}

  paneViews(): readonly { zOrder(): 'bottom'; renderer(): { draw(target: BitmapTarget): void } | null }[] {
    return [
      {
        // Under the lines and under the candles' own wicks: a fill that paints
        // over price is a fill that hides the thing being measured.
        zOrder: () => 'bottom' as const,
        renderer: () => {
          if (!this.host.visible()) return null;
          const points = this.host.points();
          if (points.length < 2) return null;
          return { draw: (target: BitmapTarget) => this.draw(target, points) };
        },
      },
    ];
  }

  private draw(target: BitmapTarget, points: readonly BandPoint[]): void {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      /*
       * One contiguous run at a time.
       *
       * A gap in either line - a session break, or the leading bars before
       * the average can be computed - must break the polygon, or the fill
       * bridges across the hole and shades a region the data says nothing
       * about.
       */
      const runs: Array<Array<{ x: number; top: number; bottom: number }>> = [];
      let run: Array<{ x: number; top: number; bottom: number }> = [];

      for (const point of points) {
        const x = this.host.xAt(point.time);
        const top = this.host.yAt(point.upper);
        const bottom = this.host.yAt(point.lower);
        if (x === null || top === null || bottom === null) {
          if (run.length > 1) runs.push(run);
          run = [];
          continue;
        }
        run.push({
          x: x * horizontalPixelRatio,
          top: top * verticalPixelRatio,
          bottom: bottom * verticalPixelRatio,
        });
      }
      if (run.length > 1) runs.push(run);
      if (runs.length === 0) return;

      context.save();
      context.fillStyle = this.host.colour();
      for (const shape of runs) {
        context.beginPath();
        context.moveTo(shape[0]!.x, shape[0]!.top);
        for (let i = 1; i < shape.length; i += 1) context.lineTo(shape[i]!.x, shape[i]!.top);
        for (let i = shape.length - 1; i >= 0; i -= 1) context.lineTo(shape[i]!.x, shape[i]!.bottom);
        context.closePath();
        context.fill();
      }
      context.restore();
    });
  }
}
