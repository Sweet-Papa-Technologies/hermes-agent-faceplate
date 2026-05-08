<template>
  <g
    v-if="fragment"
    class="viseme-mouth"
    v-html="fragment"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useThemeStore } from '../stores/theme';

const theme = useThemeStore();
const fragment = computed(() => theme.visemeFragment);
</script>

<style scoped>
.viseme-mouth {
  /* Quick fade between viseme swaps so mouth swaps don't pop. */
  transition: transform 60ms linear;
}
</style>
