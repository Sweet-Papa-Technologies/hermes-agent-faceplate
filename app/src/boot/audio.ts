// Audio boot — wires the renderer-side audio pipeline:
//   - Turn handler subscribes to user input events
//   - PTT controller listens for the push_to_talk hotkey
//   - Wake-word client is started/stopped reactively per settings.input.mode
//
// Runs once per renderer (overlay window). The settings window does not
// boot the audio pipeline because there's no avatar to drive there, but
// turn-handler events are still cross-window via the preload bridge.

import { boot } from 'quasar/wrappers';
import { Notify } from 'quasar';
import { watch } from 'vue';

import { useSettingsStore } from '../stores/settings';
import { useAgentStore } from '../stores/agent';
import { attachPttController, detachPttController } from '../audio/ptt-controller';
import { startWakeClient, stopWakeClient } from '../audio/wake-client';
import {
  attachTurnHandler,
  detachTurnHandler,
  interrupt as interruptTurn,
  setActiveTtsMuted,
} from '../hermes/turn-handler';
import {
  attachConversationSyncer,
  detachConversationSyncer,
} from '../conversations/conversation-syncer';
import {
  attachAgentPushHandler,
  detachAgentPushHandler,
} from '../agent-push/agent-push-handler';

export default boot(({ router }) => {
  // Audio pipeline must initialise in EXACTLY one renderer — the overlay /
  // test-mode window. Any other window (Settings, Wizard) that runs
  // turn-handler will fire a duplicate runTurn on every cross-window
  // user.input.text broadcast, producing two LLM calls and two TTS streams.
  //
  // Use a positive `/overlay` (or `/test`) match instead of an exclusion
  // list. At quasar boot time `router.currentRoute.value.path` may not yet
  // reflect the URL hash on Electron's file:// loads (the router is set up
  // synchronously but resolves the hash on the first navigation tick), so
  // we ALSO consult window.location.hash as a belt-and-suspenders check.
  const routerPath = router.currentRoute.value.path;
  const hashPath = (window.location.hash || '').replace(/^#/, '').split('?')[0] || '/';
  const path = routerPath === '/' ? hashPath : routerPath;
  const isAudioRenderer = path === '/overlay' || path === '/test';
  console.log(`[audio.boot] routerPath="${routerPath}" hashPath="${hashPath}" → audio renderer? ${isAudioRenderer}`);
  if (!isAudioRenderer) return;

  attachTurnHandler();
  attachPttController();
  // Conversation persistence: hydrate the live buffer from the active
  // conversation on disk, persist on every finalize, follow cross-window
  // switches initiated by the conversation panel.
  attachConversationSyncer();
  // Subscribe to unprompted Hermes-initiated messages (Phase 6). The
  // main-process WebSocket bridge owns the connection; this handler
  // injects incoming frames into the dedicated "Hermes pings"
  // conversation and fires an OS notification.
  attachAgentPushHandler();

  const settings = useSettingsStore();
  watch(
    () => settings.settings.input.mode,
    (mode, prev) => {
      if (mode === 'wake_word' && prev !== 'wake_word') {
        void startWakeClient();
      } else if (mode !== 'wake_word' && prev === 'wake_word') {
        stopWakeClient();
      }
      // Show the mic-always-on banner once, no matter where the toggle
      // happens (Settings, wizard, tray menu, programmatic edit).
      if (
        prev === 'off' &&
        mode !== 'off' &&
        !settings.settings.privacy.mic_warning_shown
      ) {
        void settings.patch({ privacy: { mic_warning_shown: true } });
        Notify.create({
          type: 'warning',
          icon: 'mic',
          message: 'Microphone will open whenever this mode is active. The avatar\'s halo shows a green LED while the mic is live.',
          timeout: 8000,
          position: 'top',
        });
      }
    },
    { immediate: true },
  );

  // Mute toggle drives the live <audio> element's .muted property — same
  // semantic as the OS mute or YouTube's mute button. The captions, the
  // assistant turn, the viseme animation, and the natural speaking→idle
  // transition all continue uninterrupted; the user just doesn't hear it.
  // Aborting the turn here (as STOP does) would feel like "stop response,"
  // not "mute," and would clobber the in-flight text.
  watch(
    () => useAgentStore().muted,
    (muted) => setActiveTtsMuted(muted),
  );

  // The interrupt hotkey has TWO concurrent handlers, intentionally:
  //   - ptt-controller cancels a live ASR recording session (if any).
  //   - here, the turn handler aborts the in-flight chat/TTS turn.
  // Both no-op if there's nothing to do, so they compose cleanly.
  const fp = window.faceplate;
  if (fp) {
    fp.hotkeys.onPress((name) => {
      if (name === 'interrupt') interruptTurn('user.interrupt');
    });
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      // Tear down EVERYTHING on hot reload. Without detachTurnHandler
      // here, every save+reload cycle in dev leaves the prior module's
      // user.input.text listener alive — so the next user message fires
      // runTurn TWICE, producing the [user, user] disk state we saw
      // (each duplicate barges in before the assistant turn finalizes).
      detachPttController();
      stopWakeClient();
      detachConversationSyncer();
      detachAgentPushHandler();
      detachTurnHandler();
    });
  }
});
