/**
 * Trading audio.
 *
 * A trader watching a chart is not watching the blotter, and the sound of a
 * fill is how they find out without looking. That is the whole job, and it
 * puts one rule above every other consideration here:
 *
 *   THE SOUND FOLLOWS THE SERVER, NEVER THE CLICK.
 *
 * "Order filled" is played when authoritative state says an order reached
 * FILLED. Pressing BUY plays nothing. An order that never fills is never
 * announced. A rejected order says so, because that is also news.
 *
 * Partial fills do not repeat it. A 10-lot that fills in four pieces is one
 * order and gets one confirmation, when the last piece lands - four voices
 * saying "order filled" over eight seconds is how a trader learns to turn the
 * sound off, and an audio system nobody can bear to leave on is worse than
 * none.
 *
 * ---------------------------------------------------------------------------
 * ASSETS
 *
 * Final voice assets go in `apps/web/public/audio/` under exactly these names:
 *
 *   order-filled.(wav|mp3)      "Order filled."
 *   position-closed.(wav|mp3)   "Position closed."
 *   target-filled.(wav|mp3)     "Target filled."
 *   stop-filled.(wav|mp3)       "Stop loss filled."
 *   order-rejected.(wav|mp3)    "Order rejected."
 *
 * Nothing else needs to change: they are picked up by name, and the absence of
 * a file is handled rather than erroring. Until they are supplied, Atlas plays
 * a SYNTHESISED development tone per event - deliberately plain, deliberately
 * not a voice, and clearly marked as temporary in Settings so nobody ships it
 * believing it is finished.
 */

export type TradingSound =
  | 'ORDER_FILLED'
  | 'POSITION_CLOSED'
  | 'TARGET_FILLED'
  | 'STOP_FILLED'
  | 'ORDER_REJECTED';

export const SOUND_FILES: Record<TradingSound, string> = {
  ORDER_FILLED: 'order-filled',
  POSITION_CLOSED: 'position-closed',
  TARGET_FILLED: 'target-filled',
  STOP_FILLED: 'stop-filled',
  ORDER_REJECTED: 'order-rejected',
};

export const SOUND_LABEL: Record<TradingSound, string> = {
  ORDER_FILLED: 'Order filled',
  POSITION_CLOSED: 'Position closed',
  TARGET_FILLED: 'Target filled',
  STOP_FILLED: 'Stop loss filled',
  ORDER_REJECTED: 'Order rejected',
};

/**
 * The development tones.
 *
 * Two notes each, a few dozen milliseconds apart, at low amplitude with a soft
 * envelope: enough to tell the events apart in testing, quiet enough not to
 * be startling, and obviously not a finished voice. A fill rises, a close
 * settles, a stop falls, a rejection is flat and short.
 */
const TONES: Record<TradingSound, { readonly hz: readonly number[]; readonly ms: number }> = {
  ORDER_FILLED: { hz: [660, 880], ms: 110 },
  POSITION_CLOSED: { hz: [520, 392], ms: 130 },
  TARGET_FILLED: { hz: [784, 1046], ms: 120 },
  STOP_FILLED: { hz: [392, 294], ms: 140 },
  ORDER_REJECTED: { hz: [220, 220], ms: 90 },
};

export interface AudioSettings {
  readonly enabled: boolean;
  /** 0..1. */
  readonly volume: number;
  readonly events: Readonly<Record<TradingSound, boolean>>;
}

export const DEFAULT_AUDIO: AudioSettings = {
  // Off until a trader asks for it: a platform that starts making noises the
  // first time it is opened is a platform people mute before they trust it.
  enabled: false,
  volume: 0.6,
  events: {
    ORDER_FILLED: true,
    POSITION_CLOSED: true,
    TARGET_FILLED: true,
    STOP_FILLED: true,
    ORDER_REJECTED: true,
  },
};

/** Two sounds closer together than this are one event, not two. */
const COALESCE_MS = 250;

class TradingAudioPlayer {
  private settings: AudioSettings = DEFAULT_AUDIO;
  private context: AudioContext | null = null;
  private readonly buffers = new Map<TradingSound, AudioBuffer | null>();
  private readonly lastPlayed = new Map<TradingSound, number>();
  /** Every sound played, for tests and for the report. */
  private readonly log: Array<{ sound: TradingSound; at: number }> = [];

  configure(settings: AudioSettings): void {
    this.settings = settings;
  }

  current(): AudioSettings {
    return this.settings;
  }

  /**
   * Play one event.
   *
   * `force` is for the Settings preview, which must sound even when the event
   * itself is switched off - a trader auditioning a sound is asking to hear
   * it, not asking whether it is enabled.
   */
  play(sound: TradingSound, force = false): void {
    if (!force) {
      if (!this.settings.enabled) return;
      if (!this.settings.events[sound]) return;
      const last = this.lastPlayed.get(sound) ?? 0;
      if (Date.now() - last < COALESCE_MS) return;
    }
    this.lastPlayed.set(sound, Date.now());
    this.log.push({ sound, at: Date.now() });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    void this.emit(sound);
  }

  /** What has been played, newest last. Read by the browser suites. */
  history(): ReadonlyArray<{ sound: TradingSound; at: number }> {
    return this.log;
  }

  clearHistory(): void {
    this.log.length = 0;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor =
      typeof window === 'undefined'
        ? null
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
          null);
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
    } catch {
      return null;
    }
    return this.context;
  }

  /**
   * Load a voice asset if one has been supplied.
   *
   * A missing file is the expected case until the final assets land, so a 404
   * is remembered as "no asset" rather than retried on every fill.
   */
  private async load(sound: TradingSound): Promise<AudioBuffer | null> {
    if (this.buffers.has(sound)) return this.buffers.get(sound) ?? null;
    const context = this.ensureContext();
    if (!context) return null;
    const base = SOUND_FILES[sound];
    for (const extension of ['wav', 'mp3']) {
      try {
        const response = await fetch(`/audio/${base}.${extension}`);
        if (!response.ok) continue;
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        this.buffers.set(sound, buffer);
        return buffer;
      } catch {
        /* try the next extension, then fall back to the tone */
      }
    }
    this.buffers.set(sound, null);
    return null;
  }

  private async emit(sound: TradingSound): Promise<void> {
    const context = this.ensureContext();
    if (!context) return;
    // A browser will not start an audio context before the page has been
    // interacted with; by the time a fill exists, it has been.
    if (context.state === 'suspended') await context.resume().catch(() => undefined);

    const buffer = await this.load(sound);
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, this.settings.volume));
    gain.connect(context.destination);

    if (buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start();
      return;
    }

    // The development tone. Two short notes with a soft envelope so it does
    // not click on or off.
    const tone = TONES[sound];
    const step = tone.ms / 1000;
    tone.hz.forEach((hz, index) => {
      const osc = context.createOscillator();
      const envelope = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const start = context.currentTime + index * step;
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(0.5, start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + step * 0.92);
      osc.connect(envelope);
      envelope.connect(gain);
      osc.start(start);
      osc.stop(start + step);
    });
  }
}

export const tradingAudio = new TradingAudioPlayer();

if (typeof window !== 'undefined') {
  (window as unknown as { __atlasAudio?: unknown }).__atlasAudio = () => tradingAudio.history();
  (window as unknown as { __atlasAudioClear?: unknown }).__atlasAudioClear = () =>
    tradingAudio.clearHistory();
}
