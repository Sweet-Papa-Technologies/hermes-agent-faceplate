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
] as const;
export type HotkeyName = (typeof HotkeyNames)[number];

export const HermesSettings = z.object({
  base_url: z.string().url().default('http://127.0.0.1:8642/v1'),
  api_key: z.string().default(''),
  config_path: z.string().default('~/.hermes/config.yaml'),
  install_shell_hook: z.boolean().default(false),
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

export const ParaphraseSettings = z.object({
  enabled: z.boolean().default(true),
  trigger_chars: z.number().int().nonnegative().default(280),
  target_words: z.number().int().positive().default(25),
  model: paraphraseModelInput.default('local_litert'),
  /** Endpoint the local_litert mode posts to. Defaults to the litert-lm
   *  serve port set by scripts/start-litert.sh. */
  litert_lm_url: z.string().url().default('http://127.0.0.1:7860/v1'),
  system_prompt: z
    .string()
    .default(
      'Rewrite the following assistant message as natural spoken English in <= 25 words. Preserve meaning, drop code blocks and URLs.',
    ),
});

export const TtsSettings = z.object({
  model: z.string().default('piper:en_US-amy-medium'),
  voice: z.string().default('en_US-amy-medium'),
  rate: z.number().positive().default(1.0),
  // Addendum #1: pinned to MP3 for v1 (MSE).
  format: z.enum(['mp3', 'opus', 'wav', 'aac']).default('mp3'),
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

export const InputSettings = z.object({
  mode: z.enum(['push_to_talk', 'wake_word', 'off']).default('push_to_talk'),
  ptt_hotkey: HotkeyAccelerator.default('CommandOrControl+Shift+Space'),
  wake: WakeSettings.default({}),
});

export const HotkeysSettings = z.object({
  show_hide: HotkeyAccelerator.default('CommandOrControl+Shift+H'),
  // Spotlight owns Cmd+Space on macOS, and Cmd+Option+Space is also
  // taken by some macOS setups (Input Source switcher / Raycast / etc).
  // `Control+Space` (literal Ctrl on every OS, not the
  // CommandOrControl alias) is unbound by default on macOS, Win, and
  // Linux DEs. Rebindable in Settings → Hotkeys.
  typing_bar: HotkeyAccelerator.default('Control+Space'),
  push_to_talk: HotkeyAccelerator.default('CommandOrControl+Shift+Space'),
  captions: HotkeyAccelerator.default('CommandOrControl+Shift+C'),
  cycle_monitor: HotkeyAccelerator.default('CommandOrControl+Shift+M'),
  replay: HotkeyAccelerator.default('CommandOrControl+Shift+R'),
  interrupt: HotkeyAccelerator.default('CommandOrControl+.'),
});

export const AvatarSettings = z.object({
  theme: z.string().default('default-svg'),
  scale: z.number().positive().default(1.0),
  // Addendum #2 + #5: single switch covers Wayland fallback and Windows
  // transparency-quirk escape hatch.
  mode: z.enum(['overlay', 'windowed']).default('overlay'),
  always_on_top: z.boolean().default(true),
  click_through_default: z.boolean().default(true),
  position: z
    .enum(['top_left', 'top_right', 'bottom_left', 'bottom_right', 'last_known'])
    .default('bottom_right'),
});

export const PrivacySettings = z.object({
  telemetry: z.boolean().default(false),
  mic_warning_shown: z.boolean().default(false),
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
  input: InputSettings.default({}),
  hotkeys: HotkeysSettings.default({}),
  avatar: AvatarSettings.default({}),
  privacy: PrivacySettings.default({}),
  linux: LinuxSettings.default({}),
  wizard: WizardState.default({}),
});

export type FaceplateSettings = z.infer<typeof FaceplateSettings>;
export type HermesSettings = z.infer<typeof HermesSettings>;
export type ParaphraseSettings = z.infer<typeof ParaphraseSettings>;
export type SpeechSettings = z.infer<typeof SpeechSettings>;
export type AvatarSettings = z.infer<typeof AvatarSettings>;
export type InputSettings = z.infer<typeof InputSettings>;
export type HotkeysSettings = z.infer<typeof HotkeysSettings>;
export type PrivacySettings = z.infer<typeof PrivacySettings>;
export type LinuxSettings = z.infer<typeof LinuxSettings>;

export function defaultSettings(): FaceplateSettings {
  return FaceplateSettings.parse({});
}
