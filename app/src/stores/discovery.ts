// Cached HermesDiscovery — refresh-on-demand. The turn handler reads
// `useRuns` (true when the configured base_url responds at /v1/health and
// /v1/capabilities advertises runs support) to choose the runs-client over
// the chat-client.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { HermesDiscovery } from '../../src-electron/preload-api';
import { useSettingsStore } from './settings';

export const useDiscoveryStore = defineStore('discovery', () => {
  const discovery = ref<HermesDiscovery | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh(): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    loading.value = true;
    error.value = null;
    try {
      discovery.value = await fp.hermes.discoverConfig();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  /**
   * True when hermes' gateway is reachable AND advertises runs support
   * (or we don't know — older hermes versions without /v1/capabilities
   * still support /v1/runs since v0.10).
   */
  const useRuns = computed<boolean>(() => {
    const d = discovery.value;
    if (!d || !d.reachable) return false;
    // If we have explicit capabilities and they say no, respect that.
    const runsFlag = d.capabilities?.features?.runs;
    if (runsFlag === false) return false;
    // Need an API key — either pasted in Settings or pulled from .env.
    const settings = useSettingsStore();
    if (settings.settings.hermes.api_key) return true;
    return d.local_config?.api_key_present_in_env ?? false;
  });

  /** Local file-based bypass for paraphrase is available iff local config is readable. */
  const canBypassParaphrase = computed<boolean>(() => {
    const d = discovery.value;
    return Boolean(d?.local_config_readable && d.local_config?.llm.api_key_present);
  });

  return { discovery, loading, error, refresh, useRuns, canBypassParaphrase };
});
