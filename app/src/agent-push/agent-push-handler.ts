// Renderer-side handler for unprompted Hermes-initiated messages.
//
// Flow:
//   main process WS → preload bridge → onFrame() →
//     1. ensure a single dedicated "Hermes pings" conversation exists
//     2. append the message as an assistant turn (saved via existing
//        conversation persistence pipeline)
//     3. fire an OS notification (Phase 4 plumbing)
//     4. optionally speak via TTS (off by default)
//
// Design notes:
//   - Dedicated conversation keeps unprompted pings out of whatever the
//     user is actively chatting in. They can be promoted/moved later if
//     we want to attach to a specific chat.
//   - Speaking is opt-in because most pings are quiet "FYI" messages and
//     the user may not be at the keyboard.
//   - The notification's click handler routes to the avatar window
//     (Phase 4 default for `agent_initiated` kind), so the user can hit
//     CMD+Shift+J to see the conversation.

import type { AgentPushFrame } from '../../src-electron/preload-api';
import { useConversationStore } from '../stores/conversation';
import { useConversationsStore } from '../stores/conversations';
import { useSettingsStore } from '../stores/settings';

const PINGS_TITLE = 'Hermes pings';
let detach: (() => void) | null = null;
let attached = false;

async function ensurePingsConversation(): Promise<string | null> {
  const convs = useConversationsStore();
  // Look for an existing conversation named PINGS_TITLE (case-sensitive).
  const existing = convs.list.find((c) => c.title === PINGS_TITLE);
  if (existing) return existing.id;
  const created = await convs.createNew(PINGS_TITLE);
  return created?.id ?? null;
}

async function handleFrame(frame: AgentPushFrame): Promise<void> {
  if (frame.type !== 'message') return;
  if (!frame.text || !frame.text.trim()) return;

  const settings = useSettingsStore();
  if (!settings.settings.agent_push.enabled) return;

  const convs = useConversationsStore();
  const convo = useConversationStore();

  // 1. Switch to / create the dedicated pings conversation.
  const pingsId = await ensurePingsConversation();
  if (!pingsId) {
    console.warn('[agent-push] failed to ensure pings conversation, dropping frame');
    return;
  }
  // If we're not currently on it, switch — switchTo broadcasts via main
  // and the conversation-syncer hydrates the in-memory buffer.
  if (convs.activeId !== pingsId) {
    await convs.switchTo(pingsId);
  }

  // 2. Append as a synthesized assistant turn. Bypass the usual run
  // pipeline (no LLM call, no thinking state) by directly start →
  // setText → finalize on the in-memory store. The syncer's $onAction
  // will persist it via saveActive.
  convo.startTurn('assistant');
  convo.setText(frame.text);
  convo.finalizeTurn();

  // 3. Fire OS notification (Phase 4). 'agent_initiated' kind bypasses
  // the foregrounded-suppression gate so the user sees it even if the
  // app is up.
  const preview = frame.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  void window.faceplate?.notify.show({
    id: `agent-push:${frame.ts}`,
    title: 'Hermes',
    body: preview,
    kind: 'agent_initiated',
  });

  // 4. Optional TTS. Off by default — the captions panel + notification
  // already surface the message. Users on a call / away from the
  // keyboard generally don't want autoplay audio.
  if (settings.settings.agent_push.speak) {
    // Re-use the standard turn machinery is overkill for a pre-baked
    // message; instead emit the same event the typing bar uses, but
    // tagged so turn-handler knows to skip the LLM call. v1 keeps it
    // simple: just play TTS via the same speakAndAnimate function.
    // For now, the captions render the text (since it's now in the
    // conversation history), and the user can replay via the UI.
    // A full TTS-only path can be added in a follow-up.
    console.log('[agent-push] speak=true but TTS replay not wired in v1');
  }
}

export function attachAgentPushHandler(): void {
  if (attached) return;
  const fp = window.faceplate;
  if (!fp) return;
  attached = true;
  detach = fp.agentPush.onFrame((frame) => {
    void handleFrame(frame).catch((err) => {
      console.warn('[agent-push] handleFrame threw:', err);
    });
  });
}

export function detachAgentPushHandler(): void {
  detach?.();
  detach = null;
  attached = false;
}
