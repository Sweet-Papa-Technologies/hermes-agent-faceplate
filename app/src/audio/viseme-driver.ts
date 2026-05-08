// Viseme driver — converts an AnalyserNode's amplitude + spectrum into a
// 6-shape mouth schedule + silence. Per design §4.5: amplitude-driven openness
// with a critically-damped spring, plus three FFT bands (low / mid / high)
// to discriminate rounded (C) vs wide-thin (D) vs lower-lip-on-teeth (F).

import type { VisemeCode } from '../hermes/event-schema';
import { useThemeStore } from '../stores/theme';
import { eventBus } from '../boot/event-bus';

export interface DriverThresholds {
  high: number;
  mid: number;
  low: number;
  silence: number;
}

export interface DriverConfig {
  spring_k: number;          // stiffness
  spring_c: number;          // damping
  silence_ms: number;        // sub-threshold dwell before viseme X
  thresholds: DriverThresholds;
}

const DEFAULT_CONFIG: DriverConfig = {
  spring_k: 18,
  spring_c: 6,
  silence_ms: 80,
  thresholds: { high: 0.55, mid: 0.28, low: 0.08, silence: 0.04 },
};

interface DriverState {
  openness: number;
  velocity: number;
  belowSilenceSince: number | null;
}

export interface DriverHandle {
  stop(): void;
}

export function startVisemeDriver(
  analyser: AnalyserNode,
  configOverride?: Partial<DriverConfig>,
): DriverHandle {
  const cfg: DriverConfig = mergeConfig(DEFAULT_CONFIG, configOverride);
  const theme = useThemeStore();

  const time = new Uint8Array(analyser.fftSize);
  const freq = new Uint8Array(analyser.frequencyBinCount);

  const state: DriverState = {
    openness: 0,
    velocity: 0,
    belowSilenceSince: null,
  };

  let raf = 0;
  let lastEnvelopePost = 0;
  let lastFrame = performance.now();
  let stopped = false;

  function tick(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(tick);

    const dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp to 50 ms
    lastFrame = now;

    analyser.getByteTimeDomainData(time);
    analyser.getByteFrequencyData(freq);

    const amp = rms(time);
    const lo = avgBand(freq, 0, 8);     // ~0–500 Hz
    const midLow = avgBand(freq, 8, 24);
    const mid = avgBand(freq, 24, 64);  // ~500 Hz–2 kHz
    const hi = avgBand(freq, 64, freq.length); // ~4 kHz+

    // Spring towards target derived from amplitude.
    const target = clamp01(amp * 4);
    const a = cfg.spring_k * (target - state.openness) - cfg.spring_c * state.velocity;
    state.velocity += a * dt;
    state.openness = clamp01(state.openness + state.velocity * dt);

    let viseme: VisemeCode;
    if (amp < cfg.thresholds.silence) {
      if (state.belowSilenceSince === null) state.belowSilenceSince = now;
      viseme = now - state.belowSilenceSince >= cfg.silence_ms ? 'X' : 'E';
    } else {
      state.belowSilenceSince = null;
      viseme = classify(state.openness, lo, mid, hi, cfg.thresholds);
    }

    theme.setViseme(viseme);

    // Post envelope events at ~30 Hz so an external mirror or captions panel
    // can hook in. Internal viseme rendering is unthrottled (uses RAF).
    if (now - lastEnvelopePost > 33) {
      lastEnvelopePost = now;
      eventBus.emit({
        type: 'tts.audio.envelope',
        ts: Date.now(),
        payload: {
          amp,
          bands: [lo, midLow, mid, hi],
        },
      });
    }
  }

  raf = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      // Settle the mouth so we don't leave it half-open.
      theme.setViseme('X');
    },
  };
}

// ----------------------------------------------------------------- helpers

function rms(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] ?? 128) - 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length) / 128; // 0..1
}

function avgBand(freq: Uint8Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  let count = 0;
  for (let i = start; i < end && i < freq.length; i++) {
    sum += freq[i] ?? 0;
    count += 1;
  }
  return count > 0 ? sum / count / 255 : 0; // 0..1
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function classify(
  openness: number,
  lo: number,
  mid: number,
  hi: number,
  t: DriverThresholds,
): VisemeCode {
  // High-frequency hiss + narrow mouth → /f/, /v/.
  if (openness < 0.25 && hi > 0.45 && hi > lo + 0.05) return 'F';
  if (openness > t.high) return 'A';
  if (openness > t.mid) {
    // Decide rounded vs neutral by low-band dominance.
    if (lo > mid + 0.12) return 'C';
    return 'B';
  }
  if (openness > t.low) {
    if (lo > mid) return 'C';
    if (mid > lo + 0.05) return 'D';
    return 'B';
  }
  return 'E';
}

function mergeConfig(base: DriverConfig, patch?: Partial<DriverConfig>): DriverConfig {
  if (!patch) return base;
  return {
    spring_k: patch.spring_k ?? base.spring_k,
    spring_c: patch.spring_c ?? base.spring_c,
    silence_ms: patch.silence_ms ?? base.silence_ms,
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
  };
}
