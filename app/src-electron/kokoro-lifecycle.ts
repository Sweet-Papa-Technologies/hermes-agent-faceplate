// Kokoro-FastAPI Docker lifecycle.
//
// Settings → Speech Sidecar → Kokoro engine surfaces a status card with
// a one-click "Install + start" button so users don't have to remember the
// `docker run …` incantation. This module owns the container lifecycle:
//
//   - status():  is docker available? does the container exist? running? reachable?
//   - ensure():  start (or pull + run) the container, then poll for readiness
//   - stop():    docker stop the container (no remove — `ensure` next time
//                will `docker start` instantly)
//
// Container name is fixed (`hermes-faceplate-kokoro`) so this module owns
// it cleanly. If the user already runs Kokoro under a different name on
// the same port, status() reports unreachable-via-our-name but the engine
// itself works fine — they just don't get the lifecycle buttons.

import { ipcMain, net } from 'electron';
import { spawn } from 'node:child_process';

import { IPC, type KokoroStatus } from './preload-api';
import { getSettings } from './settings-store';

const CONTAINER_NAME = 'hermes-faceplate-kokoro';
const IMAGE = 'ghcr.io/remsky/kokoro-fastapi-cpu:latest';
const READY_TIMEOUT_MS = 90_000; // generous: first run pulls ~340 MB
const POLL_INTERVAL_MS = 1_000;

interface DockerRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runDocker(args: string[], timeoutMs = 120_000): Promise<DockerRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* noop */
      }
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Pattern-match the most common Docker Desktop failures and rewrite the
 * raw daemon error into something the user can actually act on. Falls
 * back to the raw message when nothing matches. */
function diagnoseDockerError(action: string, r: DockerRun): string {
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
  const tail = (r.stderr || r.stdout).trim().slice(-280);
  // containerd metadata DB corruption / I/O error — by far the most common
  // Docker Desktop bug in this codepath. Restart fixes it ~80% of the time.
  if (blob.includes('io.containerd.metadata') || blob.includes('temporary lease')) {
    return (
      `${action} failed: Docker Desktop's image store hit an I/O error. ` +
      `This is a Docker bug, not a Faceplate one. Fix: quit Docker Desktop fully (whale-icon → Quit), wait 5 seconds, relaunch, then retry. ` +
      `If that doesn't help: Docker Desktop → Settings → Troubleshoot → "Clean / Purge data".\n\nRaw error: ${tail}`
    );
  }
  if (blob.includes('cannot connect to the docker daemon') || blob.includes('is the docker daemon running')) {
    return (
      `${action} failed: Docker daemon is not running. Start Docker Desktop and retry.\n\nRaw error: ${tail}`
    );
  }
  if (blob.includes('no space left on device')) {
    return (
      `${action} failed: Docker is out of disk space. Free space (or bump Docker Desktop's disk image size in Settings → Resources).\n\nRaw error: ${tail}`
    );
  }
  if (blob.includes('permission denied') && blob.includes('docker.sock')) {
    return (
      `${action} failed: you're not in the docker group. Linux: \`sudo usermod -aG docker $USER\`, log out, log back in.\n\nRaw error: ${tail}`
    );
  }
  if (blob.includes('manifest unknown') || blob.includes('manifest for ghcr.io')) {
    return (
      `${action} failed: GHCR couldn't find the Kokoro image. Network issue or rate-limit. Retry in a minute, or pull manually: \`docker pull ${IMAGE}\`.\n\nRaw error: ${tail}`
    );
  }
  if (blob.includes('conflict') && blob.includes('already in use')) {
    return (
      `${action} failed: another container is using port 8880 or the name "${CONTAINER_NAME}". \`docker ps -a\` to investigate; \`docker rm -f ${CONTAINER_NAME}\` if you want us to manage it.\n\nRaw error: ${tail}`
    );
  }
  return `${action} failed (exit ${r.code}): ${tail}`;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await runDocker(['--version'], 5_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

async function containerState(): Promise<'running' | 'exited' | 'missing'> {
  try {
    const r = await runDocker(
      ['inspect', '--format', '{{.State.Status}}', CONTAINER_NAME],
      8_000,
    );
    if (r.code !== 0) return 'missing';
    const s = r.stdout.trim();
    if (s === 'running') return 'running';
    return 'exited'; // 'exited' / 'paused' / 'created' / etc. — all "not running"
  } catch {
    return 'missing';
  }
}

function kokoroBaseUrl(): string {
  // Mirror the URL rewrite paraphrase-bridge uses: when the user has set
  // host.docker.internal in their config (because Hermes is in a
  // container), the host can reach 127.0.0.1 instead.
  const raw = getSettings().speech.tts.kokoro_url || 'http://127.0.0.1:8880';
  try {
    const u = new URL(raw);
    if (u.hostname === 'host.docker.internal' || u.hostname === 'gateway.docker.internal') {
      u.hostname = '127.0.0.1';
      return u.toString().replace(/\/+$/, '');
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:8880';
  }
}

async function reachable(): Promise<boolean> {
  // Try a sequence of probes — kokoro-fastapi has shifted endpoints
  // across versions. Any 2xx from any of these means the server is up.
  // We don't treat 4xx as "up" because some Docker proxies return a
  // canned 404 page even when nothing's listening.
  const base = kokoroBaseUrl();
  const probes = ['/health', '/v1/models', '/v1/audio/voices'];
  for (const path of probes) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_500);
    try {
      const res = await net.fetch(`${base}${path}`, { signal: ctrl.signal });
      if (res.ok) return true;
    } catch {
      /* try next probe */
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function pollReady(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

export async function getKokoroStatus(): Promise<KokoroStatus> {
  const dock = await dockerAvailable();
  if (!dock) {
    return {
      docker_available: false,
      container_state: 'missing',
      reachable: await reachable(), // someone might run kokoro outside our container
      base_url: kokoroBaseUrl(),
    };
  }
  const [state, reach] = await Promise.all([containerState(), reachable()]);
  return {
    docker_available: true,
    container_state: state,
    reachable: reach,
    base_url: kokoroBaseUrl(),
  };
}

export async function ensureKokoroRunning(): Promise<KokoroStatus> {
  const before = await getKokoroStatus();
  if (before.reachable) return before; // already up — even if not via our container
  if (!before.docker_available) {
    throw new Error('Docker is not available on this machine — install Docker Desktop and retry.');
  }

  if (before.container_state === 'missing') {
    console.log(`[kokoro] creating ${CONTAINER_NAME} from ${IMAGE}`);
    const run = await runDocker(
      [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '-p', '8880:8880',
        '--restart', 'unless-stopped',
        IMAGE,
      ],
      // First run pulls the image (~340 MB) — be patient.
      300_000,
    );
    if (run.code !== 0) {
      throw new Error(diagnoseDockerError('docker run', run));
    }
  } else {
    console.log(`[kokoro] starting existing container ${CONTAINER_NAME}`);
    const start = await runDocker(['start', CONTAINER_NAME], 30_000);
    if (start.code !== 0) {
      throw new Error(diagnoseDockerError('docker start', start));
    }
  }

  // Container is up; wait for the FastAPI to actually answer.
  console.log('[kokoro] polling for /v1/voices…');
  const ready = await pollReady();
  if (!ready) {
    throw new Error(
      `Kokoro container is running but not reachable at ${kokoroBaseUrl()} after ${READY_TIMEOUT_MS / 1000}s. ` +
      `Check container logs: docker logs ${CONTAINER_NAME}`,
    );
  }
  return getKokoroStatus();
}

export async function stopKokoro(): Promise<KokoroStatus> {
  const dock = await dockerAvailable();
  if (!dock) return getKokoroStatus();
  const state = await containerState();
  if (state === 'running') {
    await runDocker(['stop', CONTAINER_NAME], 30_000).catch((err) => {
      console.warn('[kokoro] stop failed:', err);
    });
  }
  return getKokoroStatus();
}

export function registerKokoroIpc(): void {
  ipcMain.handle(IPC.kokoro.status, () => getKokoroStatus());
  ipcMain.handle(IPC.kokoro.ensure, () => ensureKokoroRunning());
  ipcMain.handle(IPC.kokoro.stop, () => stopKokoro());
}
