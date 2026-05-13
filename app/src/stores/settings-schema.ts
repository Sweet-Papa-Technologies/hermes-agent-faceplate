// Faceplate settings schema. See DESIGN.md §9.9 + DESIGN-ADDENDUM-01.md cross-cutting changelog.
//
// Persisted to `app.getPath('userData')/settings.yaml`. Renderer never touches
// disk directly — main process owns the file via IPC (see preload `settings.get/set`).

import { z } from 'zod';

const HotkeyAccelerator = z.string().min(1);

export const HotkeyNames = [
  'show_hide',
  'typing_bar',
  'push_to_talk',
  'captions',
  'cycle_monitor',
  'replay',
  'interrupt',
  'conversation_panel',
  'canvas',
  'show_all',
] as const;
export type HotkeyName = (typeof HotkeyNames)[number];

export const HermesSettings = z.object({
  base_url: z.string().url().default('http://127.0.0.1:8642/v1'),
  api_key: z.string().default(''),
  config_path: z.string().default('~/.hermes/config.yaml'),
  install_shell_hook: z.boolean().default(false),
  /**
   * When true (default) the Faceplate auto-installs the `faceplate-canvas`
   * skill into ~/.hermes/skills/ on every boot. The skill teaches Hermes
   * the inline <artifact> tag protocol so visualizations render in the
   * canvas window without each user having to hand-edit their prompt.
   *
   * Idempotent: missing → write; older version → upgrade; same/newer → leave.
   */
  install_canvas_skill: z.boolean().default(true),
  /**
   * How many prior turns to send back as `conversation_history` on each
   * `/v1/runs` POST. Higher = more memory but more tokens + a higher chance
   * the model gets distracted iterating over old turns rather than focusing
   * on the latest input. 0 disables history entirely (every turn amnesic).
   */
  max_history_turns: z.number().int().min(0).max(50).default(10),
});

// Paraphrase model routing.
//
//   local_litert     → POST to host-native `litert-lm serve` (default).
//                       URL is paraphrase.litert_lm_url, default
//                       http://127.0.0.1:7860/v1.
//                       Started outside the Faceplate via `make litert-up`.
//   reuse_hermes_llm → POST direct to the underlying LLM provider hermes is
//                       configured with. Requires read access to local
//                       ~/.hermes/ to pick up provider/base_url/api_key.
//                       Bypasses hermes-agent's /v1/chat/completions because
//                       that runs the agent loop (would corrupt session memory).
//   disabled         → never paraphrase; speak the full text.
const ParaphraseModelEnum = z.enum(['local_litert', 'reuse_hermes_llm', 'disabled']);

// Backward-compat: existing settings.yaml files may carry the legacy
// 'sidecar_fallback' value. Map it to 'local_litert' on read.
const paraphraseModelInput = z.preprocess(
  (v) => (v === 'sidecar_fallback' ? 'local_litert' : v),
  ParaphraseModelEnum,
);

/**
 * The literal previous default. When users have this exact string in their
 * settings.yaml, the boot-time migration upgrades them to the new default
 * (DEFAULT_PARAPHRASE_PROMPT). Customized prompts are left alone.
 *
 * Add older defaults to PARAPHRASE_PROMPT_LEGACY_DEFAULTS as we evolve so
 * users from any prior version get migrated forward.
 */
export const PARAPHRASE_PROMPT_LEGACY_DEFAULTS: readonly string[] = [
  'Rewrite the following assistant message as natural spoken English in <= 25 words. Preserve meaning, drop code blocks and URLs.',
  "Summarize this assistant reply as 1-2 conversational sentences (max 20 words) for text-to-speech. " +
  "DO NOT enumerate long lists — if more than 5 items, mention the first 2-3 then say 'and several more' or 'etc.'. " +
  "Drop code blocks, URLs, JSON, and parenthetical artifact references like '(chart: ...)'. " +
  "Keep a natural conversational tone — the user is hearing this aloud, not reading it.",
];

export const DEFAULT_PARAPHRASE_PROMPT =
  "You are a TTS narrator. Output ONE OR TWO short spoken sentences (15 words MAX, hard limit). " +
  "Do NOT list items. Do NOT enumerate. If the reply contains a list of any size, say what KIND of list it is and the rough count, e.g. 'I found seven options — the highlights are X and Y' or 'There are about a dozen — want me to read them?'. " +
  "Do NOT include numbers, bullets, code, URLs, JSON, or parenthetical asides like '(chart: …)'. " +
  "Sound conversational — the user is HEARING this, not reading it. " +
  "If the reply is mostly a table, chart, or artifact, say one sentence summarizing what was made, e.g. 'I drew you a bar chart of quarterly sales.'";

export const ParaphraseSettings = z.object({
  enabled: z.boolean().default(true),
  trigger_chars: z.number().int().nonnegative().default(140),
  target_words: z.number().int().positive().default(15),
  model: paraphraseModelInput.default('reuse_hermes_llm'),
  /** Endpoint the local_litert mode posts to. Defaults to the litert-lm
   *  serve port set by scripts/start-litert.sh. */
  litert_lm_url: z.string().url().default('http://127.0.0.1:7860/v1'),
  system_prompt: z.string().default(DEFAULT_PARAPHRASE_PROMPT),
});

export const TtsSettings = z.object({
  /** Which TTS engine to call. 'piper' keeps the existing bundled-sidecar
   * path (model + voice fields below). 'kokoro' routes to a separate
   * kokoro-fastapi instance (default localhost:8880) using
   * kokoro_voice + 'kokoro' as the model id. Both engines speak the same
   * OpenAI-compatible /v1/audio/speech wire format, so the renderer's
   * MSE streaming pipeline is unchanged. */
  engine: z.enum(['piper', 'kokoro']).default('piper'),
  model: z.string().default('piper:en_US-amy-medium'),
  voice: z.string().default('en_US-amy-medium'),
  rate: z.number().positive().default(1.0),
  // Addendum #1: pinned to MP3 for v1 (MSE).
  format: z.enum(['mp3', 'opus', 'wav', 'aac']).default('mp3'),
  /** Base URL of the Kokoro FastAPI sidecar (or any OpenAI-compat server
   * that exposes /v1/audio/speech with the Kokoro model). Used only when
   * engine === 'kokoro'. */
  kokoro_url: z.string().url().default('http://127.0.0.1:8880'),
  /** Kokoro voice id (see VOICES.md in hexgrad/Kokoro-82M). 'af_*' = American
   * female, 'am_*' = American male, etc. A-grade English voices are
   * generally the best quality. */
  kokoro_voice: z.string().default('af_bella'),
});

export const AsrSettings = z.object({
  model: z.string().default('faster-whisper-small.en'),
  language: z.string().default('auto'),
});

export const SpeechSettings = z.object({
  sidecar_mode: z.enum(['bundled', 'external', 'disabled']).default('bundled'),
  sidecar_url: z.string().url().default('http://127.0.0.1:8080'),
  sidecar_token: z.string().default(''),
  // Addendum #4: cpu-slim is opt-out for users with no offline paraphrase need.
  sidecar_image: z.enum(['cpu', 'cpu-slim', 'cuda']).default('cpu'),
  tts: TtsSettings.default({}),
  asr: AsrSettings.default({}),
});

export const WakeSettings = z.object({
  model_path: z.string().default('/wakewords/hey_hermes.onnx'),
  threshold: z.number().min(0).max(1).default(0.5),
});

/** Sentinel deviceId meaning "follow the OS default device, even if it
 * changes mid-session." Stored as 'system' so it persists across launches
 * unaffected by deviceId churn (Chromium re-issues a new opaque id when a
 * device is unplugged + replugged). The audio pipeline interprets this as
 * "don't pass deviceId — let the browser pick." */
export const SYSTEM_DEFAULT_DEVICE = 'system';

export const InputSettings = z.object({
  mode: z.enum(['push_to_talk', 'wake_word', 'off']).default('push_to_talk'),
  ptt_hotkey: HotkeyAccelerator.default('CommandOrControl+Shift+Space'),
  wake: WakeSettings.default({}),
  /** Microphone deviceId for ASR (push-to-talk + wake-word). 'system' means
   * "use whatever the OS default is right now." */
  device_id: z.string().default(SYSTEM_DEFAULT_DEVICE),
});

export const OutputSettings = z.object({
  /** Speaker/headphone deviceId for TTS playback. 'system' means follow OS
   * default. Applied via HTMLMediaElement.setSinkId() on the playback
   * <audio> element. macOS ignores per-element sink without entitlements;
   * Linux + Windows honor it. */
  device_id: z.string().default(SYSTEM_DEFAULT_DEVICE),
});

export const HotkeysSettings = z.object({
  show_hide: HotkeyAccelerator.default('CommandOrControl+Shift+H'),
  // Spotlight owns Cmd+Space on macOS, and Cmd+Option+Space is also
  // taken by some macOS setups (Input Source switcher / Raycast / etc).
  // `Control+Space` (literal Ctrl on every OS, not the
  // CommandOrControl alias) is unbound by default on macOS, Win, and
  // Linux DEs. Rebindable in Settings → Hotkeys.
  typing_bar: HotkeyAccelerator.default('Control+Space'),
  // Literal Control on every OS — Cmd+Shift+Space conflicts with macOS
  // Spotlight's "Search Files Only" variant on some setups.
  push_to_talk: HotkeyAccelerator.default('Control+Shift+Space'),
  captions: HotkeyAccelerator.default('CommandOrControl+Shift+C'),
  cycle_monitor: HotkeyAccelerator.default('CommandOrControl+Shift+M'),
  replay: HotkeyAccelerator.default('CommandOrControl+Shift+R'),
  interrupt: HotkeyAccelerator.default('CommandOrControl+.'),
  // Cmd+Shift+J on macOS / Ctrl+Shift+J on Win+Linux — unbound by default
  // on all three. (Avoiding `Shift+H`, which collides with `show_hide`.)
  conversation_panel: HotkeyAccelerator.default('CommandOrControl+Shift+J'),
  // Toggles the canvas (artifact viewer) window.
  canvas: HotkeyAccelerator.default('CommandOrControl+Shift+K'),
  // "Bring everything to view" — arranges all four windows (avatar TL,
  // canvas TR, conversations BC, typing bar center) on the active display.
  // Triple-tap of `typing_bar` within 1s ALSO triggers this, so users have
  // two paths.
  show_all: HotkeyAccelerator.default('CommandOrControl+Shift+G'),
});

export const AvatarSettings = z.object({
  theme: z.string().default('robo'),
  scale: z.number().positive().default(1.0),
  // Addendum #2 + #5: single switch covers Wayland fallback and Windows
  // transparency-quirk escape hatch.
  mode: z.enum(['overlay', 'windowed']).default('overlay'),
  always_on_top: z.boolean().default(true),
  click_through_default: z.boolean().default(true),
  position: z
    .enum(['top_left', 'top_right', 'bottom_left', 'bottom_right', 'last_known'])
    .default('bottom_right'),
  /** Raise the avatar window to the front when the user submits a question
   * (typing bar, voice, etc.) so they can see the response without hunting.
   * Falls back to a gentle no-focus-steal raise if the avatar is overlay
   * + click-through. */
  raise_on_submit: z.boolean().default(true),
});

export const PrivacySettings = z.object({
  telemetry: z.boolean().default(false),
  mic_warning_shown: z.boolean().default(false),
});

/**
 * How aggressively the assistant should reach for <artifact> tags.
 *
 *   subtle     — only when the user explicitly asks for a chart / diagram /
 *                code. Most replies stay text-only.
 *   balanced   — default. Use artifacts when they materially help (data,
 *                runnable code, system flows). Skip for short answers.
 *   liberal    — proactively render artifacts whenever feasible — turn lists
 *                with comparable values into charts, system descriptions
 *                into diagrams, code mentions into code blocks, etc.
 *   aggressive — every reply that COULD have a visualization gets one,
 *                even when the prose alone would suffice.
 */
export const ArtifactsSettings = z.object({
  eagerness: z.enum(['subtle', 'balanced', 'liberal', 'aggressive']).default('balanced'),
});

export const NotificationsSettings = z.object({
  /** Master toggle. When false, no OS notifications fire regardless of mode. */
  enabled: z.boolean().default(true),
  /** Play OS notification sound. macOS uses the system default; Linux/Win
   * follow `urgency`. */
  sound: z.boolean().default(true),
  /** When to fire notifications:
   *   - 'always'              — every assistant turn completion
   *   - 'backgrounded_only'   — only when no Faceplate window is focused
   *                             (avoid double-cueing while user is reading) */
  mode: z.enum(['always', 'backgrounded_only']).default('backgrounded_only'),
  /** Do-not-disturb window. HH:mm 24h. Equal start+end disables DND. */
  dnd_start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  dnd_end: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
});

export const LinuxSettings = z.object({
  // Only consulted when XDG_SESSION_TYPE === 'wayland'. Requires app restart
  // to take effect (sets ozone-platform=x11 before app.whenReady()).
  force_x11: z.boolean().default(false),
});

export const WizardState = z.object({
  completed: z.boolean().default(false),
  /** Last step index the user reached, in case we want to resume mid-wizard. */
  last_step: z.number().int().nonnegative().default(0),
});
export type WizardState = z.infer<typeof WizardState>;

export const FaceplateSettings = z.object({
  schema_version: z.literal(1).default(1),
  hermes: HermesSettings.default({}),
  paraphrase: ParaphraseSettings.default({}),
  speech: SpeechSettings.default({}),
  notifications: NotificationsSettings.default({}),
  input: InputSettings.default({}),
  output: OutputSettings.default({}),
  hotkeys: HotkeysSettings.default({}),
  avatar: AvatarSettings.default({}),
  privacy: PrivacySettings.default({}),
  artifacts: ArtifactsSettings.default({}),
  linux: LinuxSettings.default({}),
  wizard: WizardState.default({}),
});

export type FaceplateSettings = z.infer<typeof FaceplateSettings>;
export type HermesSettings = z.infer<typeof HermesSettings>;
export type ParaphraseSettings = z.infer<typeof ParaphraseSettings>;
export type SpeechSettings = z.infer<typeof SpeechSettings>;
export type AvatarSettings = z.infer<typeof AvatarSettings>;
export type InputSettings = z.infer<typeof InputSettings>;
export type OutputSettings = z.infer<typeof OutputSettings>;
export type HotkeysSettings = z.infer<typeof HotkeysSettings>;
export type PrivacySettings = z.infer<typeof PrivacySettings>;
export type ArtifactsSettings = z.infer<typeof ArtifactsSettings>;
export type LinuxSettings = z.infer<typeof LinuxSettings>;
export type NotificationsSettings = z.infer<typeof NotificationsSettings>;

export function defaultSettings(): FaceplateSettings {
  return FaceplateSettings.parse({});
}
