// Audio boot — wires the renderer-side audio pipeline:
//   - Turn handler subscribes to user input events
//   - PTT controller listens for the push_to_talk hotkey
//   - Wake-word client is started/stopped reactively per settings.input.mode
//
// Runs once per renderer (overlay window). The settings window does not
// boot the audio pipeline because there's no avatar to drive there, but
// turn-handler events are still cross-window via the preload bridge.

import { boot } from 'quasar/wrappers';
import { watch } from 'vue';

import { useSettingsStore } from '../stores/settings';
import { attachPttController, detachPttController } from '../audio/ptt-controller';
import { startWakeClient, stopWakeClient } from '../audio/wake-client';
import { attachTurnHandler, interrupt as interruptTurn } from '../hermes/turn-handler';

export default boot(({ router }) => {
  // Only run on the avatar window; other windows can route through the
  // event bus but don't need their own pipeline.
  const path = router.currentRoute.value.path;
  if (path === '/settings') return;

  attachTurnHandler();
  attachPttController();

  const settings = useSettingsStore();
  watch(
    () => settings.settings.input.mode,
    (mode, prev) => {
      if (mode === 'wake_word' && prev !== 'wake_word') {
        void startWakeClient();
      } else if (mode !== 'wake_word' && prev === 'wake_word') {
        stopWakeClient();
      }
    },
    { immediate: true },
  );

  // Hook the global hotkey for interrupt. It's also handled by ptt-controller
  // for cancelling a recording session; we forward to the turn handler too.
  const fp = window.faceplate;
  if (fp) {
    fp.hotkeys.onPress((name) => {
      if (name === 'interrupt') interruptTurn('user.interrupt');
    });
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      detachPttController();
      stopWakeClient();
    });
  }
});
