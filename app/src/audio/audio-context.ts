// Single AudioContext per renderer. Created lazily on first user gesture
// (Chromium will reject `new AudioContext()` from autoplay policy otherwise).
//
// One shared AnalyserNode is exposed for the viseme driver to tap; speech
// playback connects through it on its way to `destination`.

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

export function getAudioContext(): AudioContext {
  if (ctx === null) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
  return ctx;
}

export function getSharedAnalyser(): AnalyserNode {
  const c = getAudioContext();
  if (analyser === null) {
    analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
  }
  return analyser;
}

export async function suspendAudio(): Promise<void> {
  if (ctx && ctx.state === 'running') {
    await ctx.suspend();
  }
}

export async function resumeAudio(): Promise<void> {
  if (ctx && ctx.state !== 'closed') {
    await ctx.resume();
  }
}

export function isAudioReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}
