<template>
  <div>
    <h2>Canvas / Artifacts</h2>
    <p class="muted">
      Controls how aggressively Hermes reaches for the canvas. Every reply gets the artifact protocol injected as a system instruction; this slider tells the model how eager it should be to actually use it.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <div class="row q-col-gutter-md">
          <q-btn
            v-for="opt in options"
            :key="opt.value"
            :class="['eager-card col', eagerness === opt.value ? 'eager-card-active' : '']"
            flat
            no-caps
            stack
            @click="eagerness = opt.value"
          >
            <q-icon :name="opt.icon" size="28px" />
            <div class="eager-label">{{ opt.label }}</div>
            <div class="eager-caption">{{ opt.caption }}</div>
          </q-btn>
        </div>
      </q-card-section>
      <q-separator />
      <q-card-section class="muted-banner">
        <q-icon name="info" />
        Changes apply on the next message. The skill at <code>~/.hermes/skills/faceplate-canvas/</code> stays installed regardless — eagerness only changes the per-request preamble.
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { useSetting } from '../../composables/use-setting';
import type { ArtifactsSettings } from '../../stores/settings-schema';

const eagerness = useSetting('artifacts.eagerness');

interface Option {
  value: ArtifactsSettings['eagerness'];
  label: string;
  caption: string;
  icon: string;
}

const options: Option[] = [
  { value: 'subtle',     label: 'Subtle',     icon: 'tune',          caption: 'Only when explicitly asked.' },
  { value: 'balanced',   label: 'Balanced',   icon: 'balance',       caption: 'When it materially helps.' },
  { value: 'liberal',    label: 'Liberal',    icon: 'auto_awesome',  caption: 'Whenever feasible.' },
  { value: 'aggressive', label: 'Aggressive', icon: 'whatshot',      caption: 'Every reply that can.' },
];
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; font: 12px/1 'JetBrains Mono', ui-monospace, monospace; }

.eager-card {
  padding: 16px 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 10px;
  background: #fff;
  color: #1a1a1a;
  transition: border-color 120ms ease, background 120ms ease;
}
.eager-card:hover {
  border-color: rgba(34, 197, 94, 0.4);
}
.eager-card-active {
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
}
.eager-label {
  font: 600 14px/1.2 system-ui, sans-serif;
  margin-top: 6px;
}
.eager-caption {
  font: 12px/1.4 system-ui, sans-serif;
  color: #666;
  margin-top: 2px;
  text-align: center;
}

.muted-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  font: 13px/1.5 system-ui, sans-serif;
  color: #666;
}
</style>
