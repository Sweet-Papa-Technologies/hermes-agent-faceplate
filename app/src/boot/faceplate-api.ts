// Renderer-side entry point for the preload bridge.
//
// 1. Augments `Window` with the typed `faceplate` global so renderer code is
//    fully typed.
// 2. Boots the settings store (single load on app start).
// 3. Boots the active theme.
// 4. Wires the typed event bus to the cross-window broadcast IPC.

import { boot } from 'quasar/wrappers';

import { watch } from 'vue';

import type { FaceplatePreload } from '../../src-electron/preload-api';
import { useSettingsStore } from '../stores/settings';
import { useThemeStore } from '../stores/theme';
import { useDiscoveryStore } from '../stores/discovery';
import { useConversationsStore } from '../stores/conversations';
import { useArtifactsStore } from '../stores/artifacts';
import { eventBus, wirePreloadBridge } from './event-bus';

declare global {
  interface Window {
    faceplate?: FaceplatePreload;
  }
}

export default boot(async () => {
  const settings = useSettingsStore();
  await settings.load();

  // Wire the preload event broadcast → renderer bus before the avatar mounts.
  wirePreloadBridge(eventBus);

  const theme = useThemeStore();
  await theme.load(settings.settings.avatar.theme);

  const discovery = useDiscoveryStore();
  await discovery.refresh();
  // Re-discover when the user edits the hermes config path or base URL.
  watch(
    () => [settings.settings.hermes.config_path, settings.settings.hermes.base_url],
    () => void discovery.refresh(),
  );

  // Conversations: load list + active in every window. The audio renderer
  // additionally attaches a syncer (in audio.ts boot) that persists turns
  // and reacts to cross-window switches.
  const convs = useConversationsStore();
  await convs.load();
  // Keep every window's view of the conversation list (and the active
  // conversation's turns) in sync with disk. Broadcasts from main arrive
  // whenever any window saves, switches, edits, or deletes.
  if (window.faceplate) {
    window.faceplate.conversations.onChanged((msg) => {
      void convs.refreshList();
      convs.applyChanged(msg);
    });
    window.faceplate.conversations.onActiveChanged((msg) => {
      convs.applyActiveChanged(msg);
      void convs.refreshList();
    });
  }

  // Artifacts: load list in every window. Subscribe to broadcasts so
  // canvas + panel + overlay all stay in sync as artifacts come and go.
  const artifactsStore = useArtifactsStore();
  await artifactsStore.refreshList();
  if (window.faceplate) {
    window.faceplate.artifacts.onChanged((msg) => {
      artifactsStore.applyChanged(msg);
    });
  }

  // Console-accessible debug helper. Call `__faceplate.dump()` in the
  // DevTools console to dump in-memory conversation state alongside the
  // disk state we last got from main. Useful when chasing save bugs.
  (window as unknown as { __faceplate?: unknown }).__faceplate = {
    dump: async () => {
      const a = convs.active;
      const live = (await import('../stores/conversation')).useConversationStore();
      const onDisk = await window.faceplate?.conversations.getActive();
      const out = {
        active_id: convs.activeId,
        active_title: a?.title,
        active_session: a?.hermes_session_id,
        active_last_response: a?.hermes_last_response_id,
        in_memory_history: live.history.map((t) => ({
          role: t.role,
          textLen: t.text.length,
          arts: (t.artifact_ids ?? []).length,
          tools: (t.tool_calls ?? []).length,
        })),
        in_memory_currentTurn: live.currentTurn
          ? { role: live.currentTurn.role, textLen: live.currentTurn.text.length }
          : null,
        on_disk_turns: onDisk?.turns.map((t) => ({
          role: t.role,
          textLen: t.text.length,
          arts: (t.artifact_ids ?? []).length,
          tools: (t.tool_calls ?? []).length,
        })) ?? [],
      };
      console.table(out.in_memory_history);
      console.table(out.on_disk_turns);
      console.log(out);
      return out;
    },
  };
});
