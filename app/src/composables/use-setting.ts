// Two-way binding helper for individual settings fields.
//
// Usage:
//   const baseUrl = useSetting('hermes.base_url');
//   <q-input v-model="baseUrl" />
//
// Reads from the Pinia settings store; writes via .patch() so the change is
// validated, persisted to disk, and broadcast back to all windows.

import { computed, type WritableComputedRef } from 'vue';

import { useSettingsStore } from '../stores/settings';
import type { FaceplateSettings } from '../stores/settings-schema';
import type { DeepPartial } from '../../src-electron/preload-api';

type Path<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends object
    ? Path<T[K], `${P}${K}.`> | `${P}${K}`
    : `${P}${K}`;
}[keyof T & string];

type ValueAt<T, P extends string> = P extends `${infer Head}.${infer Tail}`
  ? Head extends keyof T
    ? ValueAt<T[Head], Tail>
    : never
  : P extends keyof T
    ? T[P]
    : never;

export type SettingsPath = Path<FaceplateSettings>;

function getDeep(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setDeepPatch<T>(path: string, value: unknown): DeepPartial<T> {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
  return root as DeepPartial<T>;
}

export function useSetting<P extends SettingsPath>(
  path: P,
): WritableComputedRef<ValueAt<FaceplateSettings, P>> {
  const store = useSettingsStore();
  return computed({
    get: () => getDeep(store.settings, path) as ValueAt<FaceplateSettings, P>,
    set: (value) => {
      void store.patch(setDeepPatch<FaceplateSettings>(path, value));
    },
  });
}
