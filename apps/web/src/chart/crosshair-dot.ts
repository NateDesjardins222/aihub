/**
 * The crosshair as a point rather than two lines.
 *
 * Some traders read structure better without a full cross over the candles -
 * the lines cross exactly the wicks being inspected - so the brief asked for a
 * dot alongside cross, vertical, horizontal and hidden. The renderer has four
 * of those five; a dot is not one of its crosshair modes, so both lines are
 * hidden and this primitive draws the point.
 *
 * It is told where the pointer is by the adapter, which already subscribes to
 * the crosshair for the legend. It reads that position and nothing else: no
 * bar, no price, no series data.
 */

/** The drawing target, described by the little of it this file uses. */
interface BitmapTarget {
  useBitmapCoordinateSpace(
    handler: (scope: {
      readonly context: CanvasRenderingContext2D;
      readonly horizontalPixelRatio: number;
      readonly verticalPixelRatio: number;
    }) => void,
  ): void;
}

export interface CrosshairDotHost {
  /** Pointer position in CSS pixels within the pane, or null when off it. */
  at(): { x: number; y: number } | null;
  colour(): string;
  /** Radius in CSS pixels, taken from the crosshair's own thickness. */
  radius(): number;
  visible(): boolean;
}

export class CrosshairDot {
  private request: (() => void) | null = null;

  constructor(private readonly host: CrosshairDotHost) {}

  attached(param: { requestUpdate: () => void }): void {
    this.request = param.requestUpdate;
  }

  detached(): void {
    this.request = null;
  }

  /** The adapter calls this when the pointer moves, so the dot follows it. */
  redraw(): void {
    this.request?.();
  }

  paneViews(): readonly { zOrder(): 'top'; renderer(): { draw(target: BitmapTarget): void } | null }[] {
    return [
      {
        zOrder: () => 'top' as const,
        renderer: () => {
          if (!this.host.visible()) return null;
          const point = this.host.at();
          if (point === null) return null;
          return { draw: (target: BitmapTarget) => this.draw(target, point) };
        },
      },
    ];
  }

  private draw(target: BitmapTarget, point: { x: number; y: number }): void {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      // One ratio for the radius: a dot drawn with two is an ellipse on any
      // display whose pixel ratios differ.
      const radius = this.host.radius() * Math.min(horizontalPixelRatio, verticalPixelRatio);
      context.save();
      context.beginPath();
      context.arc(
        point.x * horizontalPixelRatio,
        point.y * verticalPixelRatio,
        Math.max(1.5, radius),
        0,
        Math.PI * 2,
      );
      context.fillStyle = this.host.colour();
      context.fill();
      context.restore();
    });
  }
}
