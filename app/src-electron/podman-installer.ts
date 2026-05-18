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
}
