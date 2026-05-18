// `podman machine` lifecycle — macOS / Windows only.
//
// Podman has no always-on daemon. On macOS/Windows it runs containers
// inside a small Linux VM ("podman machine"); on Linux it's native
// (rootless namespaces, no VM) so every function here is a no-op there.
//
// M0 spike (docs/v1/podman-migration-plan.md) validated 4 CPU / 4096 MB
// for Hermes + sidecar on macOS arm64; we init with those.
//
// This module never selects the engine — it's only reached when the
// resolved engine is already `podman` (via container-runtime.ts
// `ensureRuntime()`), so it always talks to the `podman` binary directly.

import { runTool } from './container-runtime';
import type { PodmanMachineState } from './preload-api';

export type { PodmanMachineState };

const MACHINE_NAME = 'podman-machine-default';
const INIT_CPUS = 4;
const INIT_MEMORY_MB = 4096;

// `podman machine init` downloads a ~1 GB CoreOS image on first run.
const INIT_TIMEOUT_MS = 600_000;
const START_TIMEOUT_MS = 180_000;
const QUERY_TIMEOUT_MS = 15_000;

function isVmPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

interface MachineListEntry {
  Name?: string;
  Running?: boolean;
  LastUp?: string;
}

/** Inspect the default machine. Linux → applicable:false, running:true
 *  (treated as always-ready since containers run natively). */
export async function machineState(): Promise<PodmanMachineState> {
  if (!isVmPlatform()) {
    return { applicable: false, exists: true, running: true, name: '' };
  }
  try {
    const r = await runTool('podman', ['machine', 'list', '--format', 'json'], {
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    if (r.code !== 0) {
      return { applicable: true, exists: false, running: false, name: MACHINE_NAME };
    }
    let list: MachineListEntry[] = [];
    try {
      const parsed = JSON.parse(r.stdout.trim() || '[]') as unknown;
      list = Array.isArray(parsed) ? (parsed as MachineListEntry[]) : [];
    } catch {
      list = [];
    }
    const entry =
      list.find((m) => (m.Name ?? '').replace(/\*$/, '') === MACHINE_NAME) ??
      list[0];
    if (!entry) {
      return { applicable: true, exists: false, running: false, name: MACHINE_NAME };
    }
    return {
      applicable: true,
      exists: true,
      running: entry.Running === true,
      name: (entry.Name ?? MACHINE_NAME).replace(/\*$/, ''),
    };
  } catch {
    return { applicable: true, exists: false, running: false, name: MACHINE_NAME };
  }
}

/** Ensure the machine exists and is running. Idempotent.
 *  Linux → no-op. Throws with an actionable message on failure. */
export async function ensureMachine(): Promise<PodmanMachineState> {
  if (!isVmPlatform()) {
    return { applicable: false, exists: true, running: true, name: '' };
  }

  let state = await machineState();

  if (!state.exists) {
    const init = await runTool(
      'podman',
      [
        'machine',
        'init',
        '--cpus',
        String(INIT_CPUS),
        '--memory',
        String(INIT_MEMORY_MB),
      ],
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    if (init.code !== 0) {
      throw new Error(
        `podman machine init failed (exit ${init.code}). This downloads a ~1 GB VM image — check disk space (M0: ~14 GB used) and network.\n\n${(init.stderr || init.stdout).trim().slice(-300)}`,
      );
    }
    state = await machineState();
  }

  if (!state.running) {
    const start = await runTool('podman', ['machine', 'start'], {
      timeoutMs: START_TIMEOUT_MS,
    });
    if (start.code !== 0) {
      const blob = `${start.stderr}\n${start.stdout}`.toLowerCase();
      if (blob.includes('already running')) {
        return machineState();
      }
      throw new Error(
        `podman machine start failed (exit ${start.code}).\n\n${(start.stderr || start.stdout).trim().slice(-300)}`,
      );
    }
    state = await machineState();
  }

  return state;
}

/** Stop the VM (used by an explicit Settings action). Linux → no-op. */
export async function stopMachine(): Promise<PodmanMachineState> {
  if (!isVmPlatform()) {
    return { applicable: false, exists: true, running: true, name: '' };
  }
  await runTool('podman', ['machine', 'stop'], { timeoutMs: START_TIMEOUT_MS }).catch(
    () => undefined,
  );
  return machineState();
}
