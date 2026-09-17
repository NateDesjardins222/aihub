/**
 * Where the price-line labels go.
 *
 * Every marker belongs at its own price, and several of them can share almost
 * the same price - an entry with a stop two ticks below it, a target next to a
 * working limit. Drawn naively the labels overlap into an unreadable pile,
 * which is exactly what the old overlay did.
 *
 * The RULE, and it matters: the horizontal RULE is always drawn at the true
 * price, never moved. Only the LABEL is nudged, and only far enough to stop it
 * covering its neighbour, with a leader offset recorded so the label can be
 * tied back to the line it belongs to. A trader reading a level off the chart
 * is reading the rule; nudging that would be lying.
 *
 * Pure and unit-tested: this is a one-dimensional packing problem, and getting
 * it wrong is the difference between a professional chart and the screenshot
 * that prompted the rebuild.
 */

export interface MarkerInput {
  readonly id: string;
  /** Where the line belongs, in pixels from the top of the chart. */
  readonly y: number;
  /** Higher wins a tie and keeps its natural place. Position > stop > order. */
  readonly priority: number;
  readonly height: number;
}

export interface MarkerPlacement {
  readonly id: string;
  /** The rule's y. Always the true one. */
  readonly y: number;
  /** Where the label's centre is drawn, after de-overlapping. */
  readonly labelY: number;
  /** labelY - y. Non-zero means the label is offset from its line. */
  readonly leader: number;
  /** False when the level is outside the visible price range. */
  readonly visible: boolean;
}

export interface LayoutOptions {
  /** Chart height in pixels. Labels are kept inside it. */
  readonly height: number;
  /** Vertical breathing room between two labels. */
  readonly gap?: number;
}

/**
 * Lay out marker labels so that none overlaps another.
 *
 * Works in two passes: cluster the markers whose labels would touch, then
 * spread each cluster around its own centre of mass, so a group of four levels
 * two ticks apart fans out symmetrically rather than all sliding downwards.
 * Finally the whole result is clamped into the chart, which cannot reintroduce
 * an overlap because the clamp moves the block, not its members.
 */
export function layoutMarkers(
  markers: readonly MarkerInput[],
  options: LayoutOptions,
): MarkerPlacement[] {
  const gap = options.gap ?? 2;
  const visible = markers.filter((marker) => Number.isFinite(marker.y));

  // Sorted by position, with priority breaking ties so the order is stable and
  // does not depend on which order the server happened to return the orders in.
  const sorted = [...visible].sort(
    (a, b) => a.y - b.y || b.priority - a.priority || a.id.localeCompare(b.id),
  );

  interface Slot {
    marker: MarkerInput;
    labelY: number;
  }
  const slots: Slot[] = sorted.map((marker) => ({ marker, labelY: marker.y }));

  // One relaxation pass down the list: push each label below the previous one
  // if they would touch. Then a pass back up, recentring each cluster so the
  // group straddles the prices it describes instead of drifting off the bottom.
  for (let i = 1; i < slots.length; i += 1) {
    const previous = slots[i - 1]!;
    const current = slots[i]!;
    const minimum = previous.labelY + previous.marker.height / 2 + gap + current.marker.height / 2;
    if (current.labelY < minimum) current.labelY = minimum;
  }

  // Recentre: walk backwards, and wherever a run of labels was pushed, shift
  // the run up by half of what it was pushed by, bounded by its neighbour
  // above, so the cluster is centred on its own natural position.
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const current = slots[i]!;
    const drift = current.labelY - current.marker.y;
    if (drift <= 0) continue;
    const previous = slots[i - 1]!;
    const room =
      previous.labelY -
      previous.marker.height / 2 -
      gap -
      (current.labelY - current.marker.height / 2);
    // `room` is negative when they are already touching; there is nothing to
    // give back. Otherwise give back the smaller of half the drift and the gap.
    const giveBack = Math.min(drift / 2, Math.max(0, -room) === 0 ? drift / 2 : 0);
    if (giveBack > 0) {
      current.labelY -= giveBack;
      // Moving this one up may now crowd the one above, so pull that up too.
      for (let j = i - 1; j >= 0; j -= 1) {
        const above = slots[j]!;
        const below = slots[j + 1]!;
        const maximum =
          below.labelY - below.marker.height / 2 - gap - above.marker.height / 2;
        if (above.labelY > maximum) above.labelY = maximum;
        else break;
      }
    }
  }

  // Keep the block on screen. Shifting every label by the same amount cannot
  // create an overlap, so this is safe to do last.
  if (slots.length > 0) {
    const first = slots[0]!;
    const last = slots[slots.length - 1]!;
    const topOverflow = first.marker.height / 2 - first.labelY;
    if (topOverflow > 0) for (const slot of slots) slot.labelY += topOverflow;
    const bottomOverflow = last.labelY + last.marker.height / 2 - options.height;
    if (bottomOverflow > 0) {
      const shift = Math.min(
        bottomOverflow,
        // Never push the top label off the top to make room at the bottom.
        Math.max(0, slots[0]!.labelY - slots[0]!.marker.height / 2),
      );
      for (const slot of slots) slot.labelY -= shift;
    }
  }

  const placements = new Map<string, MarkerPlacement>();
  for (const slot of slots) {
    placements.set(slot.marker.id, {
      id: slot.marker.id,
      y: slot.marker.y,
      labelY: slot.labelY,
      leader: slot.labelY - slot.marker.y,
      visible: true,
    });
  }

  return markers.map(
    (marker) =>
      placements.get(marker.id) ?? {
        id: marker.id,
        y: marker.y,
        labelY: marker.y,
        leader: 0,
        visible: false,
      },
  );
}

/** Do any two placements overlap? Used by the tests and by nothing else. */
export function hasOverlap(
  placements: readonly MarkerPlacement[],
  heights: ReadonlyMap<string, number>,
  gap = 0,
): boolean {
  const shown = placements
    .filter((placement) => placement.visible)
    .sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < shown.length; i += 1) {
    const a = shown[i - 1]!;
    const b = shown[i]!;
    const halfA = (heights.get(a.id) ?? 0) / 2;
    const halfB = (heights.get(b.id) ?? 0) / 2;
    if (b.labelY - halfB < a.labelY + halfA + gap - 1e-9) return true;
  }
  return false;
}
