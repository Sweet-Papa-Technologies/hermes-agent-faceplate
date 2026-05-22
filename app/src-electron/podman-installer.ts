// Podman detection + guided install + machine controls (M2).
//
// Mirrors the agent-push-installer UX contract: read-only status the
// Settings panel polls, plus explicit user-triggered actions. We NEVER
// silently escalate privilege — on Linux we surface the exact `sudo`
// command for the user to run; on macOS we prefer Homebrew (already a repo
// dependency, per start-llm-tunnel.sh) and fall back to the official pkg.
//
// M2 deliberately does NOT change engine selection: `containerEngine()`
// still defaults to `docker` (override via FACEPLATE_CONTAINER_ENGINE).
// The persisted engine-selector Setting lands in M5. This module just
// makes Podman installable + the VM manageable from the GUI.

import { ipcMain } from 'electron';

import {
  containerEngine,
  runTool,
  invalidateRuntimeReady,
} from './container-runtime';
import { ensureMachine, machineState, stopMachine } from './podman-machine';
import {
  IPC,
  type PodmanStatus,
  type PodmanInstallResult,
  type PodmanMachineState,
  type LegacyDockerScan,
  type LegacyOffboardResult,
} from './preload-api';

const PKG_URL = 'https://github.com/containers/podman/releases/latest';

async function toolAvailable(binary: string): Promise<boolean> {
  try {
    const r = await runTool(binary, ['--version'], { timeoutMs: 5_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function podmanVersion(): Promise<string | null> {
  try {
    const r = await runTool('podman', ['--version'], { timeoutMs: 5_000 });
    if (r.code !== 0) return null;
    // "podman version 5.8.2"
    const m = r.stdout.trim().match(/(\d+\.\d+\.\d+\S*)/);
    return m ? m[1]! : r.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function podmanStatus(): Promise<PodmanStatus> {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';
  const engine = containerEngine();
  const version = await podmanVersion();
  const installed = version !== null;

  let machine: PodmanMachineState | null = null;
  if (installed) {
    machine = await machineState();
  }

  // "ready" means: if the user has selected podman, is it actually usable?
  const machineOk = machine ? !machine.applicable || machine.running : false;
  const ready = engine === 'podman' && installed && machineOk;

  return { platform, engine, installed, version, machine, ready };
}

async function installViaHomebrew(steps: string[]): Promise<boolean> {
  if (!(await toolAvailable('brew'))) return false;
  steps.push('Homebrew detected — running `brew install podman`…');
  const r = await runTool('brew', ['install', 'podman'], { timeoutMs: 600_000 });
  if (r.code !== 0) {
    throw new Error(
      `brew install podman failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`,
    );
  }
  steps.push('Podman installed via Homebrew.');
  return true;
}

async function installViaWinget(steps: string[]): Promise<boolean> {
  if (!(await toolAvailable('winget'))) return false;
  steps.push('winget detected — installing RedHat.Podman…');
  const r = await runTool(
    'winget',
    [
      'install',
      '-e',
      '--id',
      'RedHat.Podman',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ],
    { timeoutMs: 600_000 },
  );
  if (r.code !== 0) {
    throw new Error(
      `winget install failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`,
    );
  }
  steps.push('Podman installed via winget.');
  return true;
}

/** Pick the distro package-manager command without running it. */
async function linuxInstallCommand(): Promise<string> {
  if (await toolAvailable('apt-get')) return 'sudo apt-get update && sudo apt-get install -y podman';
  if (await toolAvailable('dnf')) return 'sudo dnf install -y podman';
  if (await toolAvailable('pacman')) return 'sudo pacman -S --noconfirm podman';
  if (await toolAvailable('zypper')) return 'sudo zypper install -y podman';
  return 'sudo apt-get install -y podman   # or your distro equivalent';
}

export async function installPodman(): Promise<PodmanInstallResult> {
  const steps: string[] = [];
  try {
    if (await toolAvailable('podman')) {
      return { ok: true, steps: ['Podman already installed — nothing to do.'] };
    }

    if (process.platform === 'darwin') {
      if (await installViaHomebrew(steps)) {
        return { ok: true, steps };
      }
      return {
        ok: false,
        steps,
        help_url: PKG_URL,
        error:
          'Homebrew not found. Install Homebrew (brew.sh) then retry, or download the official Podman .pkg.',
      };
    }

    if (process.platform === 'win32') {
      if (await installViaWinget(steps)) {
        return { ok: true, steps };
      }
      return {
        ok: false,
        steps,
        help_url: PKG_URL,
        error: 'winget not found. Download the official Podman .msi installer.',
      };
    }

    // Linux: never auto-escalate. Surface the exact command.
    const cmd = await linuxInstallCommand();
    return {
      ok: false,
      steps,
      manual_command: cmd,
      error:
        'Linux installs need root. Run the command below in a terminal, then click "Refresh".',
    };
  } catch (err) {
    return {
      ok: false,
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── migration: detect/offboard legacy Docker containers ────────────────
//
// After switching to Podman, a user's old *Docker* containers
// (hermes-personal, faceplate-sidecar, searxng…) would double-bind ports
// 8642/8080/9080. We detect them in Docker specifically (not the
// abstracted engine) and let the user remove them — confirm-gated, never
// automatic. ~/.hermes is a host bind mount so no Hermes data is lost; the
// sidecar's named volumes simply re-download once on the Podman side.

const LEGACY_NAMES = [
  'hermes-personal',
  'faceplate-sidecar',
  'searxng',
  'searxng-redis',
  'hermes-faceplate-kokoro',
];

export async function scanLegacyDocker(): Promise<LegacyDockerScan> {
  if (!(await toolAvailable('docker'))) {
    return { docker_available: false, containers: [] };
  }
  let r;
  try {
    r = await runTool(
      'docker',
      ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}'],
      { timeoutMs: 15_000 },
    );
  } catch {
    return { docker_available: true, containers: [] };
  }
  if (r.code !== 0) return { docker_available: true, containers: [] };
  const containers: LegacyDockerScan['containers'] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, image, state] = line.trim().split('\t');
    if (!name) continue;
    if (LEGACY_NAMES.includes(name)) {
      containers.push({ name, image: image ?? '', state: state ?? 'unknown' });
    }
  }
  return { docker_available: true, containers };
}

export async function offboardLegacyDocker(
  names: string[],
): Promise<LegacyOffboardResult> {
  const removed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const name of names) {
    // Only ever touch names we know are ours.
    if (!LEGACY_NAMES.includes(name)) {
      failed.push({ name, error: 'refusing to remove an unrecognized container' });
      continue;
    }
    try {
      const r = await runTool('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
      if (r.code === 0) removed.push(name);
      else failed.push({ name, error: (r.stderr || r.stdout).trim().slice(-160) });
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}

export async function ensurePodmanMachine(): Promise<PodmanMachineState> {
  const state = await ensureMachine();
  return state;
}

export async function stopPodmanMachine(): Promise<PodmanMachineState> {
  invalidateRuntimeReady();
  return stopMachine();
}

export function registerPodmanIpc(): void {
  ipcMain.handle(IPC.podman.status, () => podmanStatus());
  ipcMain.handle(IPC.podman.install, () => installPodman());
  ipcMain.handle(IPC.podman.ensureMachine, () => ensurePodmanMachine());
  ipcMain.handle(IPC.podman.stopMachine, () => stopPodmanMachine());
  ipcMain.handle(IPC.podman.legacyScan, () => scanLegacyDocker());
  ipcMain.handle(IPC.podman.offboardLegacy, (_e, names: string[]) =>
    offboardLegacyDocker(names),
  );
}
