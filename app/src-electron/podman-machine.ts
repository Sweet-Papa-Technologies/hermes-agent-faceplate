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
const REACHABLE_TIMEOUT_MS = 12_000;
const RECOVER_STOP_TIMEOUT_MS = 60_000;

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
export async function ensureMachine(
  onOutput?: (chunk: string) => void,
): Promise<PodmanMachineState> {
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
      { timeoutMs: INIT_TIMEOUT_MS, ...(onOutput ? { onOutput } : {}) },
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
      ...(onOutput ? { onOutput } : {}),
    });
    if (start.code !== 0) {
      const blob = `${start.stderr}\n${start.stdout}`.toLowerCase();
      if (!blob.includes('already running')) {
        throw new Error(
          `podman machine start failed (exit ${start.code}).\n\n${(start.stderr || start.stdout).trim().slice(-300)}`,
        );
      }
      // "already running" — fall through to the reachability check below,
      // since that state can itself be the wedged-VM lie.
    }
    state = await machineState();
  }

  // `machine list` only reads local state — it can report Running while the
  // VM's SSH/socket is dead (classic after the Mac sleeps). Verify with a
  // real call and recover a wedged VM; otherwise the next `podman run`
  // fails with the cryptic "ssh: handshake failed: EOF".
  if (state.running && !(await machineReachable())) {
    await runTool('podman', ['machine', 'stop'], {
      timeoutMs: RECOVER_STOP_TIMEOUT_MS,
    }).catch(() => undefined);
    const restart = await runTool('podman', ['machine', 'start'], {
      timeoutMs: START_TIMEOUT_MS,
      ...(onOutput ? { onOutput } : {}),
    }).catch(() => null);
    if (!(await machineReachable())) {
      throw new Error(
        'The Podman machine VM is wedged — it reports "running" but its ' +
          'connection is dead (common after the Mac sleeps). Auto-recovery ' +
          '(stop + start) did not fix it. In a terminal, run:\n\n' +
          '  podman machine stop && podman machine start\n\n' +
          'If `podman machine stop` hangs, clear the stale VM processes ' +
          'first: `pkill -f vfkit; pkill -f gvproxy`, then ' +
          '`podman machine start`.' +
          (restart ? `\n\n${(restart.stderr || restart.stdout).trim().slice(-200)}` : ''),
      );
    }
    state = await machineState();
  }

  return state;
}

/** A real connection test. `podman machine list` reads only host-side
 *  state; `podman ps` must actually reach the VM — exit 0 ⇒ connected,
 *  non-zero ⇒ dead socket/SSH. */
async function machineReachable(): Promise<boolean> {
  try {
    const r = await runTool('podman', ['ps', '-q'], { timeoutMs: REACHABLE_TIMEOUT_MS });
    return r.code === 0;
  } catch {
    return false;
  }
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
