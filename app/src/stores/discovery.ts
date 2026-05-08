// Cached HermesDiscovery — refresh-on-demand. The turn handler reads
// `useRuns` (true when the configured base_url looks like hermes-agent's
// gateway with the API server enabled) to choose the runs-client over
// chat-client.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { HermesDiscovery } from '../../src-electron/preload-api';

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
   * True when the local hermes-agent gateway is reachable via the runs API:
   * config exists, API server enabled, and a key is present.
   */
  const useRuns = computed(() => {
    const d = discovery.value;
    if (!d) return false;
    return d.found && d.api_server_enabled && d.api_key_present;
  });

  return { discovery, loading, error, refresh, useRuns };
});
