// Active theme store. Owns the loaded manifest, viseme map, and the currently
// rendered viseme code. The viseme driver writes `currentViseme`; Avatar.vue
// reads it.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import { loadTheme, type LoadedTheme } from '../themes/loader';
import type { VisemeCode } from '../hermes/event-schema';

export const useThemeStore = defineStore('theme', () => {
  const loaded = ref<LoadedTheme | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  const currentViseme = ref<VisemeCode>('X');

  async function load(id: string): Promise<void> {
    loading.value = true;
    loadError.value = null;
    try {
      loaded.value = await loadTheme(id);
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
      console.error('[theme] load failed:', err);
    } finally {
      loading.value = false;
    }
  }

  function setViseme(code: VisemeCode): void {
    currentViseme.value = code;
  }

  const visemeFragment = computed(() => {
    const visemes = loaded.value?.visemes;
    if (!visemes) return '';
    return visemes[currentViseme.value] ?? visemes.X;
  });

  const ringTintFor = (state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error') =>
    loaded.value?.ringTints[state] ?? '#888888';

  return {
    loaded,
    loading,
    loadError,
    currentViseme,
    load,
    setViseme,
    visemeFragment,
    ringTintFor,
  };
});
