// Replay the last assistant message — re-streams it through the same TTS
// pipeline as a fresh response. Bypasses the chat client (no new LLM call).

import { speakStream, type SpeakHandle } from '../audio/tts-client';
import { startVisemeDriver, type DriverHandle } from '../audio/viseme-driver';
import { eventBus } from '../boot/event-bus';
import { useAgentStore } from '../stores/agent';
import { useConversationStore } from '../stores/conversation';
import { useSettingsStore } from '../stores/settings';
import type { TtsFormat, TtsMime } from './event-schema';

let active: { tts: SpeakHandle; driver: DriverHandle | null } | null = null;

export async function replayLastAssistant(): Promise<void> {
  const convo = useConversationStore();
  const last = convo.lastAssistant;
  if (!last || !last.text) return;

  const settings = useSettingsStore();
  const speech = settings.settings.speech;
  if (speech.sidecar_mode === 'disabled') return;

  const agent = useAgentStore();
  if (active) {
    try { active.tts.abort(); } catch { /* noop */ }
    try { active.driver?.stop(); } catch { /* noop */ }
    active = null;
  }
  if (agent.state === 'thinking' || agent.state === 'speaking') {
    // Don't fight a real turn in flight.
    return;
  }
  agent.transition('speaking', 'replay');

  let driver: DriverHandle | null = null;
  const tts = speakStream({
    baseUrl: `${speech.sidecar_url.replace(/\/+$/, '')}/v1`,
    ...(speech.sidecar_token ? { apiKey: speech.sidecar_token } : {}),
    request: {
      input: last.text,
      voice: speech.tts.voice,
      model: speech.tts.model,
      speed: speech.tts.rate,
    },
    format: speech.tts.format,
    onAnalyser: (analyser) => {
      driver = startVisemeDriver(analyser);
      eventBus.emit({
        type: 'tts.audio.start',
        ts: Date.now(),
        payload: {
          voice: speech.tts.voice,
          mime: mimeFor(speech.tts.format),
          format: speech.tts.format,
        },
      });
    },
    onEnd: (reason) => {
      driver?.stop();
      driver = null;
      eventBus.emit({ type: 'tts.audio.end', ts: Date.now(), payload: { reason } });
    },
  });
  active = { tts, driver };
  const reason = await tts.done;
  if (reason !== 'interrupt') agent.transition('idle', `replay.${reason}`);
  active = null;
}

function mimeFor(format: TtsFormat): TtsMime {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/mp4; codecs="opus"';
    case 'wav':
      return 'audio/wav';
    case 'aac':
      return 'audio/aac';
  }
}
